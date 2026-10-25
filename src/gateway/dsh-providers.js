/**
 * 从 DSH 的设置里自动发现模型提供商。
 *
 * ## 为什么需要这个
 *
 * WhalePod 原来只认两种来源：
 *   ① DSH 的 channel-pack —— 14 个免费渠道（已弃用，用户可能没装）
 *   ② 用户手填的 `gateway.channels`
 *
 * 但 DSH 设置页里其实**已经配好了**模型提供商：「Magpie」「DeepSeek」
 * 「Magpie · Anthropic」—— 这些是用户真正在用的东西。让他在 WhalePod
 * 里再手抄一遍 baseURL / apiKey / 模型列表，既啰嗦又容易抄错。
 *
 * 所以这里直接读 DSH 的 profile 配置，把 provider 转成 WhalePod 的
 * channel 形状，做到「DSH 里配了什么，WhalePod 就能用什么」。
 *
 * ## 配置在哪
 *
 * `<dshHome>/profiles/<profile>/cordis.patch.yml`，结构是 loader patch 数组：
 *
 *   - id: llm-pi-ai
 *     config:
 *       providers:
 *         magpie:
 *           displayName: Magpie
 *           apiKeyEnv: MAGPIE_GATEWAY_KEY
 *           api: openai-completions
 *           baseURL: http://127.0.0.1:3425/v1
 *           models:
 *             - id: auto/deepseek-v4.1-flash
 *               contextWindow: 1000000
 *
 * ## 三个设计要点
 *
 * 1) **不引第三方依赖**：YAML 解析优先用 DSH 自带的 `yaml` / `js-yaml`
 *    （动态 import，路径指向 appDir）；都拿不到就退回内置的窄解析器 ——
 *    只认 `providers:` 这一段的结构，够用且不会误伤。
 *
 * 2) **apiKeyEnv 走凭据服务**：DSH 的配置里只写环境变量**名**
 *    （如 `MAGPIE_GATEWAY_KEY`），真实值在 `~/.dsh/.credentials.yaml`。
 *    所以这里只记下名字，取值交给 credentials.resolve()。
 *
 * 3) **只转 OpenAI 兼容的**：`api: anthropic-messages` 那类（如
 *    magpie-anthropic）走的是 Anthropic 协议，WhalePod 的 fallback
 *    只说 OpenAI 协议。硬塞进去只会 400。所以跳过，并在日志里说明。
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** DSH 里 `api` 字段 → WhalePod 能否直接用。 */
const OPENAI_COMPATIBLE_APIS = new Set([
  'openai-completions',
  'openai-chat',
  'openai-responses',
  'openai',
])

/**
 * 读 profile 的 cordis.patch.yml 原文。
 *
 * 注意 patch 文件可能不存在（用户没改过配置），也可能存在多个候选位置。
 */
export function readProfilePatch(dshHome, profile) {
  const candidates = [
    path.join(dshHome, 'profiles', profile, 'cordis.patch.yml'),
    path.join(dshHome, 'profiles', profile, 'cordis.yml'),
  ]
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return { file, text: fs.readFileSync(file, 'utf8') }
    } catch { /* 下一个 */ }
  }
  return null
}

/**
 * 用 DSH 自带的 yaml 库解析；拿不到就返回 null（由调用方退回窄解析器）。
 *
 * 为什么动态 import：WhalePod 是独立包，不该硬依赖 DSH 的 node_modules；
 * 但用户装了 DSH 时它一定在，直接复用比自造解析器可靠。
 */
async function tryParseWithDshYaml(text, appDir) {
  if (!appDir) return null
  const tries = [
    [path.join(appDir, 'node_modules', 'yaml', 'dist', 'index.js'), (m) => m.parse],
    [path.join(appDir, 'node_modules', 'js-yaml', 'index.js'), (m) => m.load ?? m.default?.load],
  ]
  for (const [file, pick] of tries) {
    try {
      const mod = await import(pathToFileURL(file).href)
      const fn = pick(mod)
      if (typeof fn === 'function') {
        return fn(text)
      }
    } catch { /* 下一个 */ }
  }
  return null
}

/**
 * 窄解析器：只认 `- id: xxx` / `config:` / `providers:` / provider 字段。
 *
 * 什么时候会用到它：DSH 没装、或版本里没有 yaml 包。这种情况下能覆盖
 * 绝大多数手写配置 —— 因为结构是固定的两层缩进。
 *
 * ⚠️ 它**不是**通用 YAML 解析器。刻意做得窄：看不懂的行直接忽略，
 *    不做猜测。宁可少发现一个 provider，也不要解析出错误的值。
 */
export function parsePatchNarrow(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []          // [{ id, config: { providers: {...} } }]

  let curEntry = null     // 当前 patch 条目
  let inProviders = false
  let curProvider = null
  let curModel = null
  let provIndent = 0

  /** 去掉行尾注释与首尾空白；空行返回 ''。 */
  const clean = (s) => {
    const noComment = s.replace(/\s+#.*$/, '')
    return noComment.replace(/\s+$/, '')
  }
  const indentOf = (s) => s.match(/^ */)[0].length

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue
    const line = clean(rawLine)
    if (!line.trim()) continue

    const ind = indentOf(line)
    const body = line.trim()

    // 顶层条目：`- id: xxx`
    if (/^-\s+/.test(body) || ind === 0) {
      const m = body.match(/^-\s+id:\s*(.+)$/) || body.match(/^id:\s*(.+)$/)
      if (m) {
        curEntry = { id: m[1].trim().replace(/^["']|["']$/g, ''), config: { providers: {} } }
        out.push(curEntry)
        inProviders = false; curProvider = null; curModel = null
        continue
      }
      if (body.startsWith('-')) { curEntry = null; inProviders = false }
      continue
    }

    if (!curEntry) continue

    // 进入 providers 段
    if (/^providers:\s*$/.test(body)) {
      inProviders = true
      provIndent = ind
      continue
    }
    if (!inProviders) continue
    // 离开 providers 段（缩进回到同级或更小，且不是更深的内容）
    if (ind <= provIndent && !/^providers:/.test(body)) { inProviders = false; continue }

    // provider 名（providers 下第一层）
    const provMatch = body.match(/^([A-Za-z0-9_.-]+):\s*$/)
    if (provMatch && ind > provIndent && ind <= provIndent + 2) {
      curProvider = { id: provMatch[1], models: [] }
      curEntry.config.providers[provMatch[1]] = curProvider
      curModel = null
      continue
    }

    if (!curProvider) continue

    // `- id: <modelId>` 开一个新模型
    const modelIdMatch = body.match(/^-\s+id:\s*(.+)$/)
    if (modelIdMatch) {
      curModel = { id: modelIdMatch[1].trim().replace(/^["']|["']$/g, '') }
      curProvider.models.push(curModel)
      continue
    }

    // provider / model 的标量字段
    const kv = body.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const val = kv[2].trim().replace(/^["']|["']$/g, '')
    if (!val) continue

    if (curModel && ind > provIndent + 4) {
      if (key === 'name') curModel.name = val
      else if (key === 'contextWindow') curModel.contextWindow = Number(val)
      else if (key === 'maxTokens') curModel.maxTokens = Number(val)
      else if (key === 'input') curModel.input = val.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      if (key === 'displayName') curProvider.displayName = val
      else if (key === 'apiKeyEnv') curProvider.apiKeyEnv = val
      else if (key === 'api') curProvider.api = val
      else if (key === 'baseURL' || key === 'baseUrl') curProvider.baseURL = val
    }
  }

  return out
}

/**
 * 把解析出来的 patch 条目转成 WhalePod 的 channel 列表。
 *
 * @param {Array} entries          patch 条目数组
 * @param {object} opts
 * @param {string} [opts.providerPrefix]  给 channel 加的前缀，避免和内置渠道重名
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @returns {Array<object>} WhalePod channel 形状
 */
export function patchesToChannels(entries, opts = {}) {
  const log = opts.log ?? (() => {})
  const prefix = opts.providerPrefix ?? ''
  const out = []
  const skipped = []

  for (const entry of entries ?? []) {
    const providers = entry?.config?.providers
    if (!providers || typeof providers !== 'object') continue

    for (const [pid, prov] of Object.entries(providers)) {
      if (!prov || typeof prov !== 'object') continue

      const api = String(prov.api ?? 'openai-completions')
      if (!OPENAI_COMPATIBLE_APIS.has(api)) {
        skipped.push(`${pid}（api=${api}，非 OpenAI 协议）`)
        continue
      }

      const baseUrl = String(prov.baseURL ?? prov.baseUrl ?? '').trim()
      if (!baseUrl) {
        skipped.push(`${pid}（没有 baseURL）`)
        continue
      }

      const models = Array.isArray(prov.models) ? prov.models : []
      const ids = models
        .map((m) => (typeof m === 'string' ? m : m?.id))
        .filter((x) => typeof x === 'string' && x.trim())

      if (ids.length === 0) {
        skipped.push(`${pid}（没有模型）`)
        continue
      }

      // channel id 用 `<prefix><provider名>`，这样 `magpie/auto/xxx` 能正确
      // 解析成 provider=magpie、model=auto/xxx
      const id = `${prefix}${pid}`
      const first = ids[0]

      out.push({
        id,
        label: prov.displayName ? String(prov.displayName) : id,
        preset: 'openai',
        baseUrl,
        // ⚠️ DSH 里只写变量名，真实 key 由 credentials 服务解析。
        //    这里先记下名字，启动时再换成真值。
        apiKeyEnv: prov.apiKeyEnv ? String(prov.apiKeyEnv) : undefined,
        model: `${id}/${first}`,
        models: ids.map((m) => `${id}/${m}`),
        // 后面两个字段是给 UI 用的元信息，fallback 会忽略
        dshProvider: pid,
        dshModels: models,
      })
    }
  }

  if (skipped.length > 0) {
    log('warn', `有 ${skipped.length} 个 DSH provider 跳过：${skipped.join('；')}`)
  }
  return out
}

/**
 * 主入口：从 DSH 的 profile 配置里发现可用的模型提供商。
 *
 * @param {object} opts
 * @param {string} opts.dshHome      ~/.dsh
 * @param {string} opts.profile      desktop / web / ...
 * @param {string} [opts.appDir]     DSH 安装目录（用来借它的 yaml 库）
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @returns {Promise<{channels:Array, source:string, file:string|null}>}
 */
export async function discoverDshProviders(opts = {}) {
  const log = opts.log ?? (() => {})
  const patch = readProfilePatch(opts.dshHome, opts.profile)
  if (!patch) {
    return { channels: [], source: 'none', file: null }
  }

  let entries = null
  let source = 'narrow'

  const parsed = await tryParseWithDshYaml(patch.text, opts.appDir)
  if (Array.isArray(parsed)) {
    entries = parsed
    source = 'yaml'
  } else {
    entries = parsePatchNarrow(patch.text)
    source = 'narrow'
  }

  if (!Array.isArray(entries)) {
    log('warn', `DSH 配置解析结果不是数组，跳过自动发现：${patch.file}`)
    return { channels: [], source, file: patch.file }
  }

  const channels = patchesToChannels(entries, { log })
  return { channels, source, file: patch.file }
}

/** 从 channel 上取 apiKeyEnv 并解析成真值。改名不存在返回 undefined。 */
export function resolveChannelKey(channel, credentials) {
  const env = channel?.apiKeyEnv
  const direct = channel?.apiKey
  if (direct) return direct
  if (!env) return undefined
  try {
    const v = credentials?.get?.(env) ?? credentials?.get?.(String(env).toLowerCase())
    return typeof v === 'string' && v ? v : undefined
  } catch {
    return undefined
  }
}
