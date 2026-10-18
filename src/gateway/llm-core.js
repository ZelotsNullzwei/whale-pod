/**
 * LLM 网关核心：把「宿主渠道包」装进一个独立的 cordis Context。
 *
 * ## 这个模块是做什么的
 *
 * WhalePod 不自己实现 Gemini / 各账号型渠道的适配器，而是**复用宿主已装好的
 * 渠道包**（一个 DSH 插件，导出 `apply(ctx, config)` 并注册 provider）。
 * 复用的理由很实际：那些适配器涉及各家的登录协议、续期、限流处理，
 * 重新实现一遍既容易出错也难维护。
 *
 * ## 为什么能这么干（已验证）
 *
 *   - cordis 导出真实的 Context 类，new Context() 自带 logger/reflect/fiber/events/registry。
 *   - dsh-llm 导出 LlmRuntime，new LlmRuntime(ctx) 会自动注册 ctx.llm。
 *   - 渠道包的 apply(ctx, config) 只额外需要 credentials/commands/tools 三个服务，
 *     用最小实现补足即可跑通（实测零报错，ctx.accountPool 就绪）。
 *
 * ## 依赖解析
 *
 * 渠道包 import 了 @deepseek-ai/{dsh-credentials,dsh-llm,schemastery,cordis}。
 * 这些包在 DSH 安装目录里，不在本仓库的 node_modules。
 * 解法：启动时把 DSH 的 node_modules 加入解析路径（见 linkDshModules）。
 *
 * @module gateway/llm-core.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * 找到 DSH 的安装目录（含 @deepseek-ai/* 的那一层）。
 *
 * 查找顺序：
 *   1. 环境变量 DSH_APP_DIR（显式指定）
 *   2. 常见安装位置（Windows 默认）
 *   3. 从 dsh CLI 的位置反推
 *
 * @returns {string|null}
 */
export function findDshAppDir(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_APP_DIR) candidates.push(process.env.DSH_APP_DIR)

  const platform = process.platform
  if (platform === 'win32') {
    candidates.push('D:/DSH Desktop/resources/app')
    candidates.push('C:/Program Files/DSH Desktop/resources/app')
    const local = process.env.LOCALAPPDATA
    if (local) candidates.push(path.join(local, 'Programs', 'DSH Desktop', 'resources', 'app'))
  } else if (platform === 'darwin') {
    candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app')
  } else {
    candidates.push('/opt/DSH Desktop/resources/app')
    candidates.push('/usr/lib/dsh-desktop/resources/app')
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'node_modules', '@deepseek-ai', 'cordis'))) return c
    } catch { /* ignore */ }
  }
  return null
}

/**
 * 找到宿主已安装的渠道包（pack.js）。
 *
 * ## 这是什么
 *
 * 宿主（DSH）允许插件在 profile 里装各种「渠道包」，它们负责把不同厂商的
 * 接口适配成统一的 LLM 契约。WhalePod 直接复用它们，而不是重写一遍。
 *
 * 位置在某个 profile 的 node_modules 下：
 *   <dshHome>/profiles/<name>/node_modules/<包名>/vendor/channel-pack/pack.js
 *
 * ## 为什么按「特征」找而不是按包名找
 *
 * 包名可能变。与其把某个名字写死在代码里（耦合且脆弱），不如扫所有已装
 * 插件，认 `<pkg>/vendor/channel-pack/pack.js` 这个**结构**——只要是这种
 * 布局的渠道包都能被复用来。
 *
 * @returns {{file:string, profile:string, pkg:string}|null}
 */
export function findChannelPack(opts = {}) {
  const dshHome = opts.dshHome || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const profilesDir = path.join(dshHome, 'profiles')
  if (!fs.existsSync(profilesDir)) return null

  // 优先用户指定的 profile，然后按修改时间倒序（最近用过的优先）。
  let profiles = []
  try {
    profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const dir = path.join(profilesDir, d.name)
        let mtime = 0
        try { mtime = fs.statSync(dir).mtimeMs } catch { /* ignore */ }
        return { name: d.name, dir, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch { return null }

  if (opts.profile) {
    const want = profiles.find((p) => p.name === opts.profile)
    if (want) profiles = [want, ...profiles.filter((p) => p !== want)]
  }

  const REL = path.join('vendor', 'channel-pack', 'pack.js')
  for (const p of profiles) {
    const nodeModules = path.join(p.dir, 'node_modules')
    let entries
    try { entries = fs.readdirSync(nodeModules, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      // 跳过作用域目录与明显的非插件目录
      if (e.name.startsWith('.') || e.name.startsWith('@')) continue
      const file = path.join(nodeModules, e.name, REL)
      try {
        if (fs.existsSync(file)) return { file, profile: p.name, pkg: e.name }
      } catch { /* next */ }
    }
  }
  return null
}

/**
 * 把 DSH 的 node_modules 注入模块解析路径。
 *
 * 做法：在 DSH app 目录里创建一个临时 ESM 装载器无法直接做到，
 * 所以我们用 Node 的 `--import` 不适用；改为在进程启动时通过
 * module.registerHooks / 或更简单：把 DSH node_modules 里的包
 * 用软链接暴露到本项目的 node_modules。
 *
 * 这里实现的是"软链接"方案 —— 幂等、可重复执行。
 */
export function linkDshModules(appDir, projectRoot) {
  const src = path.join(appDir, 'node_modules', '@deepseek-ai')
  const dst = path.join(projectRoot, 'node_modules', '@deepseek-ai')
  fs.mkdirSync(dst, { recursive: true })

  const NEEDED = ['cordis', 'dsh-llm', 'dsh-credentials', 'schemastery']
  const linked = []
  for (const name of NEEDED) {
    const from = path.join(src, name)
    const to = path.join(dst, name)
    if (!fs.existsSync(from)) continue
    try {
      const st = fs.lstatSync(to)
      if (st.isSymbolicLink() || st.isDirectory()) {
        linked.push({ name, status: 'exists' })
        continue
      }
    } catch { /* 不存在，继续建 */ }
    try {
      fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push({ name, status: 'linked' })
    } catch (err) {
      linked.push({ name, status: `failed: ${err.message}` })
    }
  }
  return linked
}

/**
 * 最小 credentials 服务：读 ~/.dsh/.credentials.yaml。
 *
 * 关键契约（从 pack.js 实测得出）：
 *   resolve(ref) 必须返回 **对象**，形如 { value: '<原始字符串>', ... }。
 *   pack.js 的用法是 `const resolved = await ctx.credentials.resolve(ref)`
 *   然后 `JSON.parse(resolved.value)`。返回裸字符串会让它判定"凭据未配置"。
 *
 * 同时兼容它的其它用法：describe(ref) 返回 { source } 等元信息。
 */
function makeCredentialsService(Service, creds) {
  return class MinimalCredentials extends Service {
    static provide = 'credentials'

    /** 列出某个 ref 的元信息（不返回值本身）。 */
    async describe(ref) {
      const name = refName(ref)
      const raw = creds.getRaw(name)
      if (raw === undefined) return undefined
      return {
        name,
        source: 'file',
        configured: true,
        ref: name,
        // 有些调用点会看这个
        present: true,
      }
    }

    /**
     * 解析 ref。
     *
     * 注意：返回的 `value` 必须是**已修复控制字符**的字符串。
     * pack.js 拿到后自己 `JSON.parse(resolved.value)`，而凭据文件里
     * 多行 YAML 标量会带裸换行 —— 不修就会报
     * `Bad control character in string literal`，进而误判成"凭据未配置"。
     *
     * @returns {Promise<{value:string, ref:string, name:string}|undefined>}
     */
    async resolve(ref) {
      const name = refName(ref)
      const raw = creds.getRepaired(name)
      if (raw === undefined) return undefined
      return {
        value: raw,
        ref: name,
        name,
        source: 'file',
      }
    }

    /**
     * 写入凭据（pack.js 的续期会调这里）。
     *
     * 默认 overlay 模式：写 WhalePod 自己的 credentials-overlay.json，
     * 绝不碰 DSH 的 .credentials.yaml —— 避免两边同时续期时互相覆盖。
     */
    async set(ref, value) {
      const name = refName(ref)
      await creds.set(name, typeof value === 'string' ? value : JSON.stringify(value))
    }

    async unset(ref) {
      await creds.unset(refName(ref))
    }
  }
}

/** credentialRef 可能是字符串，也可能是 { name } / { ref } 形状。 */
function refName(ref) {
  if (typeof ref === 'string') return ref
  if (ref && typeof ref === 'object') return ref.name ?? ref.ref ?? String(ref)
  return String(ref)
}

/** 最小 commands 服务。 */
function makeCommandsService(Service) {
  return class MinimalCommands extends Service {
    static provide = 'commands'
    register() { return () => {} }
  }
}

/** 最小 tools 服务。 */
function makeToolsService(Service) {
  return class MinimalTools extends Service {
    static provide = 'tools'
    register() { return () => {} }
  }
}

/**
 * 启动 LLM 网关核心。
 *
 * @param {object} opts
 * @param {string} opts.appDir        DSH 安装目录
 * @param {string} opts.packFile      pack.js 路径
 * @param {Credentials} opts.credentials
 * @param {(level:string,msg:string)=>void} [opts.log]
 * @returns {Promise<{ctx:object, llm:object, listModels:Function, chat:Function, close:Function}>}
 */
export async function createLlmGateway(opts) {
  // log 兼容两种形状：函数 (level, msg) 或对象 { info, warn, error }
  const rawLog = opts.log
  const log = typeof rawLog === 'function'
    ? rawLog
    : (level, msg) => {
      const fn = rawLog?.[level] ?? rawLog?.info
      try { fn?.call(rawLog, msg) } catch { /* ignore */ }
    }
  const { appDir, packFile, credentials } = opts

  // ── 1. 加载 cordis + dsh-llm（从 DSH 安装目录） ────────────────
  const cordis = await import(pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
  const llmMod = await import(pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')).href)
  log('info', `cordis ${typeof cordis.Context === 'function' ? 'ok' : 'MISSING'}, dsh-llm ${typeof llmMod.default === 'function' ? 'ok' : 'MISSING'}`)

  // ── 2. 建 Context，装 llm ─────────────────────────────────────
  const ctx = new cordis.Context()
  new llmMod.default(ctx)   // LlmRuntime → 自动注册 ctx.llm

  // ── 3. 补足 pack.js 需要的服务 ────────────────────────────────
  const CredSvc = makeCredentialsService(cordis.Service, credentials)
  new CredSvc(ctx)
  new (makeCommandsService(cordis.Service))(ctx)
  new (makeToolsService(cordis.Service))(ctx)

  // ── 3b. attachment 服务（多模态必需）─────────────────────────
  //
  // 为什么需要：dsh-llm 的 ImageBlock 契约是
  //     { type:'image', attachment: { attachmentId:'sha256:…', mediaType, width, height } }
  // 图片**不是**直接塞 base64，而是先存进 attachment store 拿到内容寻址的
  // attachmentId。（早先传 {type:'image', url:'data:…'} 上游直接报
  //  "content.some is not a function"。）
  //
  // LocalAttachmentStore 是官方实现，按内容寻址存到 <dshHome>/attachments/v1/。
  // 它依赖 sharp（原生模块）—— 在 DSH 自带的 Electron 里能正常工作。
  // 失败不影响文本功能：attachmentStore 为 null 时 bridge 会退化成纯文本。
  let attachmentStore = null
  try {
    const attMod = await import(pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-attachment-local', 'lib', 'index.js')).href)
    const dshHome = opts.dshHome || process.env.DSH_HOME
      || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
    attachmentStore = new attMod.LocalAttachmentStore(ctx, { dshHome })
    log('info', `attachment 服务已挂载（存储目录 ${path.join(dshHome, 'attachments')}）`)
  } catch (e) {
    log('warn', `attachment 服务不可用（图片将退化为纯文本描述）：${String(e?.message ?? e)}`)
  }

  // ── 4. 装 channel-pack（14 个免费渠道） ──────────────────────
  const pack = await import(pathToFileURL(packFile).href)
  pack.apply(ctx, {})
  log('info', `channel-pack 已装载（accountPool: ${ctx.accountPool ? 'ok' : 'missing'}）`)

  // ── 4b. 装 DSH 内置渠道 ──────────────────────────────────────
  //
  // ⚠️ 这一步以前**完全没有** —— 结果 WhalePod 只认识 channel-pack 那 14 个
  //    免费渠道，`deepseek-official` / `deepseek-account` 一个都不在。
  //    后果很具体：`gateway.fallback.provider` 默认就是 `deepseek-official`，
  //    而 router.js 里有 `known` 判断（只追加**确实已注册**的兜底），
  //    于是这条兜底永远静默失效 —— 免费渠道全挂时不会退到付费，
  //    用户只看到"所有候选渠道都失败"。
  //
  // 内置渠道分两种，挂载难度不同：
  //   · deepseek-official（API Key）：只要 credentials 服务，可直接装
  //   · deepseek-account（账号登录）：还要 ctx.get('deepseekAccount') 这个
  //     OAuth 服务，WhalePod 里没有 → 装了也只会在 discoverModels 时抛
  //     ACCOUNT_SIGN_IN_REQUIRED。所以默认不装，避免制造"渠道在列表里但永远
  //     用不了"的假象。
  //
  // 失败不影响主功能：内置渠道只是**兜底**，装不上就是没有兜底，免费渠道照跑。
  const builtin = []
  try {
    const apiKeyMod = await import(pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek-api-key', 'lib', 'index.js')).href)
    // 配置必须是 schemastery 实例（插件内部调 config.apiKeyEnv.get()），不能传裸对象
    apiKeyMod.apply(ctx, new apiKeyMod.Config({}))
    builtin.push('deepseek-official')
    log('info', '内置渠道：deepseek-official 已挂载（API Key，作为付费兜底）')
  } catch (error) {
    log('warn', `内置渠道 deepseek-official 未挂载（不影响免费渠道）：${String(error?.message ?? error)}`)
  }


  const llm = ctx.llm

  // ── 5. 记录已注册的 provider（供路由与 /v1/models 用） ────────
  let providers = []
  try {
    providers = (llm.listProviders?.() ?? []).map((p) => (typeof p === 'string' ? p : (p.id ?? p.provider))).filter(Boolean)
  } catch { /* ignore */ }
  log('info', `已注册 provider ${providers.length} 个：${providers.join(', ')}`)

  // 模型目录缓存（listModels 对每个 provider 都可能打网络，所以懒加载 + 缓存）
  let catalogCache = { at: 0, models: [] }

  return {
    ctx,
    /**
     * 真正的 LlmRuntime 实例。
     *
     * 注意：必须暴露 raw 的 ctx.llm —— `stream()` / `listModels()` 都在它上面。
     * （ctx.llm 是 cordis 服务代理，与 ctx.llm 本体不是同一引用，但方法齐全。）
     */
    llm: ctx.llm,
    pack,
    providers,
    /** attachment 服务（多模态用）。未挂载时为 null。 */
    attachmentStore,
    /**
     * 把 base64 图片存进 attachment store，返回 dsh-llm 认的 ImageBlock。
     *
     * ⚠️ 必须走 admitEncodedImages 这个入口 —— 它内部会把 base64 解码成
     *    Uint8Array 再交给 store。直接把 base64 字符串传给 saveImages 会
     *    失败：sharp 收到字符串会当成**文件路径**去解析，报
     *    "Unsupported or malformed image data"。
     *
     * @param {object} o
     * @param {string} o.base64    纯 base64（不带 data: 前缀）
     * @param {string} o.mediaType image/png | image/jpeg | image/webp | image/gif
     * @param {string} [o.name]
     * @returns {Promise<object|null>} ImageBlock，失败返回 null（不抛）
     */
    async makeImageBlock({ base64, mediaType, name }) {
      if (!attachmentStore || !base64) return null
      try {
        const attMod = await import(pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'dsh-attachment', 'lib', 'index.js')).href)
        const refs = await attMod.admitEncodedImages(attachmentStore, [
          { data: base64, mediaType, ...(name ? { name } : {}) },
        ])
        const ref = refs?.[0]
        if (!ref) return null
        return { type: 'image', attachment: ref }
      } catch (e) {
        log('warn', `图片入库失败（跳过该图）：${String(e?.message ?? e)}`)
        return null
      }
    },
    get catalog() { return catalogCache.models },
    /** 刷新模型目录（可能较慢；失败不抛错，返回已有缓存）。 */
    async refreshCatalog({ ttlMs = 60000 } = {}) {
      if (Date.now() - catalogCache.at < ttlMs && catalogCache.models.length > 0) return catalogCache.models
      const out = []
      for (const p of providers) {
        try {
          const models = await ctx.llm.listModels(p)
          for (const m of models ?? []) out.push({ provider: p, id: m.id ?? m.model, raw: m })
        } catch { /* 单个 provider 失败不影响整体 */ }
      }
      catalogCache = { at: Date.now(), models: out }
      log('info', `模型目录：${out.length} 个`)
      return out
    },
    /** 建立一条对话流（OpenAI 层调这个）。 */
    stream(options) {
      return ctx.llm.stream(options)
    },
    /** 列出某个渠道的模型。 */
    async listModels(provider) {
      if (typeof ctx.llm.listModels !== 'function') return []
      return await ctx.llm.listModels(provider)
    },
    /**
     * 取单个模型的完整信息（含 reasoning.efforts）。
     *
     * 为什么需要：`listModels()` 返回的条目**不带** reasoning —— 实测只有
     * provider/id/name/inputModalities。推理等级要单独问这个接口。
     * 侧栏显示「推理等级」时按渠道取一次代表模型即可（见 web/server.js
     * 的 effortsByProvider），不要逐模型调用。
     */
    async resolveModelInfo(provider, model) {
      if (typeof ctx.llm.resolveModelInfo !== 'function') return undefined
      try { return await ctx.llm.resolveModelInfo(provider, model) } catch { return undefined }
    },
    async close() {
      try { await ctx.fiber?.dispose?.() } catch { /* ignore */ }
    },
  }
}
