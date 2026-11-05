/**
 * 通过 Magpie 的 MCP 服务生图（2026-11-04）。
 *
 * ## 为什么不是走 LLM 网关
 * magpie 的 `/v1/images/generations` **没有可用模型**：42 个模型的
 * `modalities.output` 里一个 image 都没有，各个 provider 的报错分别是
 * 「model X is not supported on image endpoint」/「param is invalid」。
 * 真正能出图的是它注册成 **MCP 工具**的那套（`minimax` 服务器里的 `generate_image`）。
 *
 * ## 协议（实测）
 * ```
 * POST <mcpUrl>  {"jsonrpc":"2.0","id":1,"method":"initialize",...}
 *      → 响应头带 `mcp-session-id`
 * POST 同址（带 mcp-session-id）
 *      {"method":"tools/call","params":{"name":"generate_image",
 *        "arguments":{"requests":[{"prompt":"…","aspect_ratio":"1:1","resolution":"1K"}]}}}
 *      → content[0].text = {"code":0,"success_items":[{"node_id":"…"}]}
 * POST {"name":"get_asset_url","arguments":{"node_id":"…"}}
 *      → content[0].text = {"download_url":"https://…jpg"}
 * ```
 * 一次大约 **20 秒**，所以只在明确要图时才调。
 *
 * ## 认证
 * magpie 的 key 在 DSH 凭据库里（`MAGPIE_GATEWAY_KEY`），用仓库现成的
 * `Credentials` 懒加载，不走配置文件 —— 免得把 key 抄进 config.json。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Credentials } from '../config/credentials.js'

const DEFAULT_URL = 'http://127.0.0.1:3425/mcp/magpie/tools/minimax'

let credsPromise = null
/**
 * 从 DSH 凭据库读一个键（key 从不落配置文件）。
 * 2026-11-05 泛化：原来写死 MAGPIE_GATEWAY_KEY，现在按 `keyEnv` 传名字，
 * 这样接别的生图服务（`MY_IMAGE_KEY` 之类）也能复用同一条路。
 */
async function readCred(name, home) {
  if (!name) return ''
  if (!credsPromise) {
    credsPromise = (async () => {
      const c = new Credentials({ home: home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), mode: 'overlay' })
      try { await c.init?.() } catch { /* 尽力 */ }
      return c
    })()
  }
  const c = await credsPromise
  return String(c.get?.(name) ?? process.env[name] ?? '')
}

/** 兼容旧调用（MCP 那条通道的鉴权）。 */
async function magpieKey(home) {
  return readCred('MAGPIE_GATEWAY_KEY', home)
}

/** 每个 endpoint 的 MCP 会话（initialize 一次，后续复用）。 */
const sessions = new Map()

async function rpc(url, key, body, sid) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    accept: 'application/json, text/event-stream',
  }
  if (sid) headers['mcp-session-id'] = sid
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await r.text()
  // SSE 形态：取最后一条 data:
  const line = text.includes('data:') ? text.split('\n').filter((l) => l.startsWith('data:')).pop()?.slice(5) : text
  let j = null
  try { j = JSON.parse(line) } catch { /* 非 JSON */ }
  return { status: r.status, sid: r.headers.get('mcp-session-id'), j, raw: text.slice(0, 300) }
}

async function ensureSession(url, key, log) {
  const hit = sessions.get(url)
  if (hit) return hit
  const r = await rpc(url, key, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'whale-pod', version: '1' } },
  })
  const sid = r.sid || ''
  if (r.status !== 200) throw new Error(`MCP initialize 失败（${r.status}）：${r.raw}`)
  const s = { sid, at: Date.now() }
  sessions.set(url, s)
  log?.info?.('mcp-image：MCP 会话已建立')
  return s
}

/**
 * 生成一张图。
 *
 * @param {object} o
 * @param {string} o.prompt      画面描述（中文/英文都行）
 * @param {string} [o.aspect]    1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 21:9
 * @param {string} [o.resolution] 1K / 2K / 4K
 * @param {string} [o.url]       MCP endpoint（默认 magpie 的 minimax 那台）
 * @param {string} [o.home]      DSH home（读凭据用）
 * @param {object} [o.log]
 * @returns {Promise<{ok:boolean, url?:string, error?:string, ms:number}>}
 */
export async function generateImage({
  provider = 'magpie-mcp', prompt, aspect, resolution, refUrls = [], url = DEFAULT_URL,
  baseUrl, apiKeyEnv, model, size, refImage, home, log = {},
} = {}) {
  /*
   * ★ **两条通道并列**（2026-11-05 用户要求「画图 api 应该有单独渠道」）：
   *   · 'magpie-mcp'   —— Magpie 插件暴露的 MCP 工具（minimax 的 generate_image）
   *   · 'openai-images' —— 任何兼容 `/v1/images/generations` 的服务
   *     （大多数生图 API 都是这个形状；没装 Magpie 的人也能用）
   *   · 'none' / 其他   —— 不画
   */
  if (provider === 'openai-images') {
    return generateOpenAIImage({ prompt, baseUrl, apiKeyEnv, model, size, aspect, resolution, refImage, home, log })
  }
  if (provider && provider !== 'magpie-mcp') {
    return { ok: false, error: `未知的生图渠道：${provider}`, ms: 0 }
  }
  const t0 = Date.now()
  const text = String(prompt ?? '').trim()
  if (!text) return { ok: false, error: 'prompt 是空的', ms: 0 }
  /** 参考图（图生图）—— 让"同一间屋子/同一个人"多次画出来不跑偏。 */
  const refs = (Array.isArray(refUrls) ? refUrls : []).map(String).filter(Boolean).slice(0, 3)
  const requestOf = () => ({
    prompt: text,
    ...(aspect ? { aspect_ratio: aspect } : {}),
    ...(resolution ? { resolution } : {}),
    ...(refs.length ? { input_urls: refs } : {}),
  })
  try {
    const key = await magpieKey(home)
    if (!key) return { ok: false, error: '没取到 MAGPIE_GATEWAY_KEY', ms: Date.now() - t0 }
    let s = await ensureSession(url, key, log)

    const callTool = async (name, args) => rpc(url, key, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args },
    }, s.sid)

    let r = await callTool('generate_image', { requests: [requestOf()] })
    // 会话过期（重新 initialize 一次再试）
    if (r.status === 404 || r.status === 400) {
      sessions.delete(url)
      s = await ensureSession(url, key, log)
      r = await callTool('generate_image', { requests: [requestOf()] })
    }
    /*
     * ⚠️ 协议端**不保证**回 JSON（2026-11-05 实测）：
     * 有一次返回的是纯文本（开头 `generate_i…`，像是"还在生成/排队"的提示），
     * 直接 JSON.parse 抛 `Unexpected token`，整条回复就没了。
     * 所以认不出 JSON 就当成一次失败，把原文带回去。
     */
    const rawText = String(r.j?.result?.content?.[0]?.text ?? '')
    let inner = null
    try { inner = JSON.parse(rawText) } catch { /* 下面统一处理 */ }
    if (!inner) {
      return {
        ok: false,
        error: `协议端返回非 JSON：${(rawText || r.raw || '').slice(0, 120)}`,
        ms: Date.now() - t0,
      }
    }
    if (r.j?.result?.isError || inner.code !== 0) {
      return { ok: false, error: String(inner.message ?? r.raw).slice(0, 160), ms: Date.now() - t0 }
    }
    const nodeId = inner.success_items?.[0]?.node_id
    if (!nodeId) return { ok: false, error: '没拿到 node_id', ms: Date.now() - t0 }

    const a = await callTool('get_asset_url', { node_id: String(nodeId) })
    const asset = JSON.parse(a.j?.result?.content?.[0]?.text ?? '{}')
    const dl = String(asset.download_url ?? '')
    if (!dl) return { ok: false, error: '没拿到 download_url', ms: Date.now() - t0 }
    log?.info?.(`mcp-image：生成完成（${Math.round((Date.now() - t0) / 1000)}s）${nodeId}`)
    return { ok: true, url: dl, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160), ms: Date.now() - t0 }
  }
}

/**
 * 裁掉图片底部一条（去「MiniMax AI 生成」水印）（2026-11-05）。
 *
 * 那行水印是**平台烧进像素的**，提示词怎么写都去不掉，只能裁。
 * 做法：生成时用竖幅 9:16（比需要的更高），裁完仍然是正常竖屏比例。
 *
 * 实现用 Python + Pillow（DSH 自带的那套）：Node 侧没有可用的图像库，
 * 为了裁一下引 sharp 太重。找不到 python 就**原样返回**并 warn 一次 ——
 * 绝不能因为裁图失败把整条图丢了。
 *
 * @param {Buffer} buf
 * @param {number} [ratio] 从底部裁掉的比例（0.1 = 10%）
 * @param {object} [log]
 * @returns {Promise<Buffer>}
 */
/**
 * 探一下「现在能不能生图」（2026-11-05）。
 *
 * 侧栏面板要靠它决定显不显示风格开关：**没装 Magpie 的人不该看见**。
 * 结果缓存 5 分钟 —— MCP initialize 一次几十毫秒，但没必要每刷新都打一遍。
 *
 * @param {object} [o]
 * @param {string} [o.url]
 * @param {string} [o.home]
 * @param {boolean} [o.force] 跳过缓存
 * @returns {Promise<{ok:boolean, reason?:string, checkedAt:number, cached:boolean}>}
 */
const probeCache = new Map()
export async function probeImage({ url = DEFAULT_URL, home, force = false } = {}) {
  const hit = probeCache.get(url)
  if (!force && hit && Date.now() - hit.checkedAt < 5 * 60_000) {
    return { ...hit, cached: true }
  }
  let out = { ok: false, reason: 'unknown', checkedAt: Date.now(), cached: false }
  try {
    const key = await magpieKey(home)
    if (!key) out.reason = '没有可用的 API key（MAGPIE_GATEWAY_KEY）'
    else {
      const r = await rpc(url, key, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'whale-pod-probe', version: '1' } },
      })
      if (r.status === 200) {
        out = { ok: true, checkedAt: Date.now(), cached: false }
      } else {
        out.reason = `MCP 返回 ${r.status}`
      }
    }
  } catch (e) {
    out.reason = String(e?.message ?? e).slice(0, 120)
  }
  probeCache.set(url, out)
  return out
}

/**
 * **只擦右下角水印**，不裁整条底边（2026-11-05）。
 *
 * 全身照里脚就在画面最底部，`cropBottom(0.1)` 会连脚一起切掉。
 * 这里换思路：把右下角那块（水印所在）用**正上方的像素**盖过去 ——
 * 角落一般就是地板/墙，克隆上去看不出，脚和拖鞋因此能保住。
 */
export async function eraseCornerWatermark(buf, log = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 1024) return buf
  const candidates = [
    process.env.WHALEPOD_PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-next-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ].filter(Boolean)
  const stamp = `${process.pid}-${Date.now()}`
  const tmpIn = path.join(os.tmpdir(), `wp-wm-${stamp}.img`)
  const tmpOut = path.join(os.tmpdir(), `wp-wm-${stamp}-out.jpg`)
  const script = [
    'import sys',
    'from PIL import Image, ImageFilter',
    'im = Image.open(sys.argv[1]).convert("RGB")',
    'w, h = im.size',
    'cw, ch = int(w * 0.14), int(h * 0.032)',
    'patch = im.crop((w - cw, h - ch * 2, w, h - ch))',
    'patch = patch.filter(ImageFilter.GaussianBlur(6))',
    'im.paste(patch, (w - cw, h - ch))',
    'im.save(sys.argv[2], quality=92)',
  ].join('\n')
  try {
    fs.writeFileSync(tmpIn, buf)
    for (const py of candidates) {
      try {
        execFileSync(py, ['-c', script, tmpIn, tmpOut], { timeout: 25000, stdio: 'ignore' })
        const out = fs.readFileSync(tmpOut)
        if (out.length > 2048) {
          log.info?.(`mcp-image：右下角水印已擦（克隆上方像素，脚没被裁），${Math.round(out.length / 1024)}KB`)
          return out
        }
      } catch { /* 换下一个解释器 */ }
    }
    log.warn?.('mcp-image：擦水印失败（没找到 python+Pillow），图原样发')
    return buf
  } finally {
    try { fs.unlinkSync(tmpIn) } catch {}
    try { fs.unlinkSync(tmpOut) } catch {}
  }
}

export async function cropBottom(buf, ratio = 0.1, log = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 1024) return buf
  if (!(ratio > 0 && ratio < 0.4)) return buf
  const candidates = [
    process.env.WHALEPOD_PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-next-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ].filter(Boolean)
  const stamp = `${process.pid}-${Date.now()}`
  const tmpIn = path.join(os.tmpdir(), `wp-crop-${stamp}.img`)
  const tmpOut = path.join(os.tmpdir(), `wp-crop-${stamp}-out.jpg`)
  const script = [
    'import sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGB")',
    'w, h = im.size',
    'im.crop((0, 0, w, max(1, int(h * (1 - float(sys.argv[3])))))).save(sys.argv[2], quality=92)',
  ].join('\n')
  try {
    fs.writeFileSync(tmpIn, buf)
    for (const py of candidates) {
      try {
        execFileSync(py, ['-c', script, tmpIn, tmpOut, String(ratio)], { timeout: 25000, stdio: 'ignore' })
        const out = fs.readFileSync(tmpOut)
        if (out.length > 2048) {
          log.info?.(`mcp-image：裁掉底部 ${Math.round(ratio * 100)}%（去水印），${Math.round(out.length / 1024)}KB`)
          return out
        }
      } catch { /* 换下一个解释器 */ }
    }
    log.warn?.('mcp-image：没找到能用的 python+Pillow，水印没裁（图原样发）')
    return buf
  } finally {
    try { fs.unlinkSync(tmpIn) } catch { /* 清理失败无所谓 */ }
    try { fs.unlinkSync(tmpOut) } catch { /* 同上 */ }
  }
}

/**
 * 兼容 API 通道的可用性（只看配置是否齐，不打网络）。
 * 真正能不能出图要发一次请求才知道 —— 面板刷新时不该为此花 30 秒。
 */
export async function probeOpenAI({ baseUrl, apiKeyEnv = 'IMAGE_API_KEY', home } = {}) {
  const checkedAt = Date.now()
  if (!baseUrl) return { ok: false, reason: '没配 baseUrl', checkedAt, cached: false }
  const key = await readCred(apiKeyEnv, home)
  if (!key) return { ok: false, reason: `没取到凭据 ${apiKeyEnv}`, checkedAt, cached: false }
  const model = readMagpieSettings().imageGen || '(未配置模型)'
  return { ok: true, reason: '', checkedAt, cached: false, model }
}

/**
 * 读 Magpie 自己配的**生图/识图模型**（2026-11-05）。
 *
 * Magpie 的设置就放在 `~/.config/magpie/settings.json`：
 * ```
 * "vision":  "auto/deepseek-v4.1-flash"
 * "imageGen": "workbuddy/hunyuan-image-alpha"
 * ```
 * 这样机器人用的模型**跟用户在 Magpie 界面里选的那个自动一致** ——
 * 不用把模型名抄进 config.json，也不会出现"界面上是 A、机器人用的是 B"。
 *
 * @returns {{imageGen:string, vision:string}} 读不到就给空串
 */
export function readMagpieSettings() {
  try {
    const f = path.join(os.homedir(), '.config', 'magpie', 'settings.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    return {
      imageGen: String(j?.imageGen ?? ''),
      vision: String(j?.vision ?? ''),
    }
  } catch {
    return { imageGen: '', vision: '' }
  }
}

/**
 * 兼容 OpenAI 形状的生图通道（2026-11-05）。
 *
 * 绝大多数生图服务都实现 `POST /v1/images/generations`：
 * ```
 * { model, prompt, n: 1, size, response_format: 'url' }
 * → { data: [{ url }] }  或  { data: [{ b64_json }] }
 * ```
 * 所以只要按这个形状发，接别家（或自建）都不用改代码 —— 换个 baseUrl 就行。
 *
 * 鉴权：`apiKeyEnv` 是**凭据名**（DSH 凭据库里的键，或同名环境变量），
 * key 永远不写进 config.json。
 *
 * ⚠️ 尺寸：各家支持的 size 不一致（有的只认 1024x1024 / 1024x1536 / 1024x1792）。
 *    默认按比例推一个安全的（竖幅 → 1024x1792），要别的就在配置里写 `size`。
 */
export async function generateOpenAIImage({
  // ⚠️ 默认必须是**空串**：写了 'gpt-image-1' 这类默认值，`model || ''` 就永远不为空，
  //    下面"跟随 Magpie imageGen"的兜底就永远走不到（实测踩过：发出 gpt-image-1 → 404）。
  prompt, baseUrl, apiKeyEnv = 'IMAGE_API_KEY', model = '', size, aspect, resolution, refImage, home, log = {},
} = {}) {
  const t0 = Date.now()
  const text = String(prompt ?? '').trim()
  if (!text) return { ok: false, error: 'prompt 是空的', ms: 0 }
  if (!baseUrl) return { ok: false, error: '没配 baseUrl（qq.image.baseUrl）', ms: 0 }
  /*
   * 模型没填 → **自动用 Magpie 里配的那个**（settings.json 的 imageGen）。
   * 这样用户在 Magpie 界面换模型，机器人这边不用改任何配置。
   */
  const effModel = String(model || '').trim() || readMagpieSettings().imageGen || 'gpt-image-1'
  const key = await readCred(apiKeyEnv, home)
  if (!key) return { ok: false, error: `没取到 API key（${apiKeyEnv}）`, ms: Date.now() - t0 }
  const px = String(size ?? guessSize(aspect, resolution))
  /*
   * ★ **有基准图就走 images/edits**（2026-11-05 用户要「保住头部特征」）。
   *
   * `/v1/images/generations` 只吃文字，每次重新发明她长什么样；
   * `/v1/images/edits` 吃「一张参考图 + 一句指令」，实测能保住**头部特征**
   * （同一张脸、同一头蓝发、同一个白蕾丝头饰），服装场景照样能换。
   * 所以：`refImage` 配了就用 edits，没配就还是纯文生图。
   */
  const refPath = refImage ? String(refImage) : ''
  const useEdits = refPath && fs.existsSync(refPath)
  const url = String(baseUrl).replace(/\/+$/, '') + (useEdits ? '/images/edits' : '/images/generations')
  try {
    let r
    if (useEdits) {
      const fd = new FormData()
      fd.append('model', effModel)
      fd.append('prompt', text)
      fd.append('image', new Blob([fs.readFileSync(refPath)]), 'ref.png')
      fd.append('n', '1')
      if (px) fd.append('size', px)
      r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}` },
        body: fd,
        signal: AbortSignal.timeout(300_000),
      })
    } else {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: effModel, prompt: text, n: 1, size: px, response_format: 'url' }),
        signal: AbortSignal.timeout(180_000),
      })
    }
    const txt = await r.text()
    let j = null
    try { j = JSON.parse(txt) } catch { /* 下面统一报错 */ }
    if (!r.ok || !j) {
      return { ok: false, error: `HTTP ${r.status}：${(j?.error?.message ?? txt).slice(0, 160)}`, ms: Date.now() - t0 }
    }
    const item = j.data?.[0] ?? {}
    const got = item.url ? String(item.url)
      : item.b64_json ? `data:image/png;base64,${String(item.b64_json)}`
        : ''
    if (!got) return { ok: false, error: '返回里没有 url / b64_json', ms: Date.now() - t0 }
    log.info?.(`image/openai：出图完成（${Math.round((Date.now() - t0) / 1000)}s）`)
    return { ok: true, url: got, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160), ms: Date.now() - t0 }
  }
}

/** 按比例 + 分辨率猜一个 size（只在配置没写死时用）。 */
function guessSize(aspect, resolution) {
  const big = resolution === '4K' ? 2 : 1
  const a = String(aspect ?? '9:16')
  const w = 1024 * big
  if (a === '16:9') return `${1024 * 2 * big}x${1024 * big}`
  if (a === '1:1') return `${w}x${w}`
  if (a === '3:4') return `${w}x${Math.round(w * 4 / 3)}`
  if (a === '4:3') return `${Math.round(w * 4 / 3)}x${w}`
  if (a === '2:3') return `${w}x${Math.round(w * 3 / 2)}`
  // 默认竖幅
  return `${w}x${Math.round(w * 16 / 9)}`
}