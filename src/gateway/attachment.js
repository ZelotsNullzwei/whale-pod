/**
 * 多模态支持：把 base64 图片存进 attachment store，产出 dsh-llm 的 ImageBlock。
 *
 * ## 为什么要单独抽出来
 *
 * 原来这段逻辑藏在 `createLlmGateway()` 里，而那个函数只有在
 * **找到 channel-pack** 时才会被调用（index.js 的 `if (appDir && pack)`）。
 * 于是没装 channel-pack 的用户（比如走 magpie 自备渠道的）就完全用不了图片 ——
 * 日志只说「attachment 服务不可用」，看着像 DSH 没装好，其实是
 * 这整段代码根本没被执行。
 *
 * 实际上 attachmentStore 只依赖两样东西：
 *   · appDir    —— 用来 import DSH 的 @deepseek-ai/dsh-attachment-local
 *   · dshHome   —— 存储目录
 * **跟 channel-pack 一点关系都没有。**
 *
 * 所以抽成独立函数，两条路径（channel-pack / fallback）都能挂。
 *
 * ## 为什么不直接用 base64 塞给上游
 *
 * 早先试过 `{ type:'image', url:'data:image/png;base64,…' }`，上游直接报
 * `content.some is not a function`。dsh-llm 的 ImageBlock 要的是
 * `{ type:'image', attachment: <ref> }`，其中 ref 是内容寻址的 id。
 *
 * ## 为什么必须走 admitEncodedImages
 *
 * 它内部会把 base64 解码成 Uint8Array 再交给 store。
 * 直接把 base64 字符串传给 saveImages 会失败 —— sharp 收到字符串会当成
 * **文件路径**去解析，报 "Unsupported or malformed image data"。
 *
 * ## 失败策略
 *
 * 整个模块失败只返回 null，**不抛错**：图是锦上添花，不能因为图片挂了
 * 让整个机器人起不来。调用方拿到 null 就退化成纯文本。
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 挂载 attachment 支持。
 *
 * @param {object} opts
 * @param {string} opts.appDir                DSH 安装目录
 * @param {object} opts.ctx                   cordis 上下文（LocalAttachmentStore 要用）
 * @param {string} [opts.dshHome]             ~/.dsh
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @returns {Promise<{makeImageBlock:Function|null, attachmentStore:any, error:string|null}>}
 */
export async function createAttachmentSupport(opts = {}) {
  const log = opts.log ?? (() => {})
  const appDir = opts.appDir
  const dshHome = opts.dshHome
    || process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')

  if (!appDir) {
    return { makeImageBlock: null, attachmentStore: null, error: '没有 DSH 安装目录' }
  }

  let attachmentStore = null
  let localMod = null    // dsh-attachment-local：LocalAttachmentStore
  let coreMod = null     // dsh-attachment：admitEncodedImages
  try {
    // ⚠️ 这里是**两个不同的包**，别搞混（2026-10-25 实测踩坑）：
    //
    //   @deepseek-ai/dsh-attachment-local  →  LocalAttachmentStore（存储实现）
    //   @deepseek-ai/dsh-attachment        →  admitEncodedImages（入库函数）
    //
    // 原来只 import 了 local 包，然后调 local.admitEncodedImages —— 报
    //   "attMod.admitEncodedImages is not a function"
    // 日志上被 catch 成「图片入库失败」，然后退化成纯文本，
    // 用户看到的是「机器人看不见图 / 回答很糊」。
    const [local, core] = await Promise.all([
      import(pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js')).href),
      import(pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-attachment', 'lib', 'index.js')).href),
    ])
    localMod = local
    coreMod = core

    if (typeof coreMod.admitEncodedImages !== 'function') {
      throw new Error('dsh-attachment 里没有 admitEncodedImages')
    }

    // ⚠️ ctx 必须是**真的 cordis Context**，不能传 {}。
    //
    // LocalAttachmentStore → AttachmentStore 基类在构造函数里调 ctx.provide/
    // ctx.effect 注册服务。传空对象会报
    //   "Cannot read properties of undefined (reading 'provide')"
    // 日志上表现为「attachment 服务不可用」，看着像 DSH 没装好。
    //
    // 这里自建一个独立 Context 就够了 —— attachment store 只做本地文件读写，
    // 不依赖 llm/credentials 那些服务。
    let ctx = opts.ctx
    if (!ctx || typeof ctx.provide !== 'function') {
      const cordis = await import(
        pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
      )
      ctx = new cordis.Context()
    }

    attachmentStore = new localMod.LocalAttachmentStore(ctx, { dshHome })
    log('info', `attachment 服务已挂载（存储目录 ${path.join(dshHome, 'attachments')}）`)
  } catch (e) {
    const msg = String(e?.message ?? e)
    log('warn', `attachment 服务不可用（图片将退化为纯文本）：${msg}`)
    return { makeImageBlock: null, attachmentStore: null, error: msg }
  }

  /** @type {(o:{base64:string,mediaType?:string,name?:string})=>Promise<object|null>} */
  async function makeImageBlock({ base64, mediaType = 'image/jpeg', name } = {}) {
    if (!attachmentStore || !base64) return null
    try {
      const refs = await coreMod.admitEncodedImages(attachmentStore, [
        { data: base64, mediaType, ...(name ? { name } : {}) },
      ])
      const ref = refs?.[0]
      if (!ref) return null
      // ⚠️ 必须同时带上 **dataUrl**。
      //
      // dsh-llm 的 ImageBlock 只认内容寻址引用（attachmentId），但
      // **OpenAI 兼容端点不认引用** —— 它要的是 image_url。
      // fallback.js 的 blocksToOpenAiContent 拿到只有 attachment 的块时
      // 无处取值，原来会拼成 `{ url: "undefined" }` 发给上游，
      // 于是「日志显示已附图，但模型看不见」（2026-10-25 实测）。
      //
      // 这里把原始 data URL 一并存进 block，转发层直接用，不必再回读 store
      // （回读是 async，而组装请求体是同步的）。
      return { type: 'image', attachment: ref, dataUrl: `data:${mediaType};base64,${base64}` }
    } catch (e) {
      log('warn', `图片入库失败：${String(e?.message ?? e).slice(0, 120)}`)
      return null
    }
  }

  return { makeImageBlock, attachmentStore, error: null }
}
