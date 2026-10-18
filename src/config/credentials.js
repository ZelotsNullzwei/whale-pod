/**
 * 凭据层：读 DSH 的 ~/.dsh/.credentials.yaml，写 WhalePod 自己的 overlay。
 *
 * ## 文件形状（DSH 侧，实测）
 *
 *   version: 1
 *   records:
 *     client-connection/browser-session:
 *       kind: grant
 *       payload:
 *         secret: xxx
 *   refs: {
 *     DEEPSEEK_API_KEY: sk-xxx,
 *     GEMINI_ACCOUNT_A8AA3E4F: '{"access_token":"...",...,"scope":"..."}',
 *   }
 *
 * 关键点：`refs` 是 **YAML 流式 map**（flow style，`{ ... }` 跨多行），
 * 值是单引号字符串，且内部含换行/逗号/花括号。
 * 所以不能按行解析 —— 必须先抽出 `refs: { ... }` 整块，再在块内按
 * 「顶层逗号 + 键名」切分，最后去引号。
 *
 * ## 写策略：overlay（零冲突）
 *
 * DSH 和 WhalePod 可能同时活着。若两边都写同一个 .credentials.yaml，
 * 会互相覆盖（DSH 用 SettingsStore 异步 replace，WhalePod 用原子 rename，
 * 谁后写谁赢，先写的续期结果直接丢）。
 *
 * 所以：
 *   - **读**：overlay 优先，缺失则回落到 DSH 文件（合并视图）
 *   - **写**：只写 ~/.whale-pod/credentials-overlay.json，绝不碰 DSH 文件
 *
 * 好处：两边各管各的，卸载时删 ~/.whale-pod 即可，DSH 完全不受影响。
 * 代价：同一 refresh_token 可能被两边各刷一次；Gemini 的 refresh_token
 * 可重复使用，且 WhalePod 是常驻方（overlay 保持最新），实际无影响。
 *
 * ## 模式
 *
 *   overlay （默认）—— 读合并、写 overlay
 *   direct          —— 读写都走 DSH 文件（原子写 + 备份；用户显式选择才用）
 *   readonly        —— 只读，写操作抛错（最保守）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function defaultCredentialsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, '.credentials.yaml')
}

/** WhalePod 的 overlay 文件位置。 */
export function defaultOverlayPath() {
  const home = process.env.WHALE_POD_HOME || path.join(os.homedir(), '.whale-pod')
  return path.join(home, 'credentials-overlay.json')
}

/**
 * 抽出 `key: { ... }` 流式块的完整文本（括号配对，忽略引号内的括号）。
 * @param {string} text
 * @param {string} key 例如 'refs'
 * @returns {string|null} 花括号内的内容（不含最外层括号）
 */
function extractFlowBlock(text, key) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*\\{`, 'm')
  const m = re.exec(text)
  if (!m) return null
  let i = m.index + m[0].length   // 指向 '{' 之后
  const start = i
  let depth = 1
  let quote = null
  for (; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) {
        // YAML 单引号里 '' 是转义的单引号
        if (quote === "'" && text[i + 1] === "'") { i++; continue }
        quote = null
      }
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(start, i)
    }
  }
  return null
}

/**
 * 把流式 map 的内容切成 [key, rawValue] 对。
 * 在「顶层逗号」处切分（不在引号内、不在嵌套括号内）。
 */
function splitFlowEntries(body) {
  const out = []
  let i = 0
  const n = body.length
  while (i < n) {
    // 跳过分隔（逗号、空白、换行）
    while (i < n && /[\s,]/.test(body[i])) i++
    if (i >= n) break

    // 读键：到 ':' 为止（键可能被引号包着）
    let key = ''
    if (body[i] === "'" || body[i] === '"') {
      const q = body[i++]
      while (i < n) {
        if (body[i] === q) {
          if (q === "'" && body[i + 1] === "'") { key += "'"; i += 2; continue }
          i++
          break
        }
        key += body[i++]
      }
    } else {
      while (i < n && body[i] !== ':') key += body[i++]
    }
    // 跳过冒号
    while (i < n && body[i] === ':') i++
    while (i < n && (body[i] === ' ' || body[i] === '\t')) i++

    // 读值：到顶层逗号为止
    let value = ''
    let depth = 0
    let quote = null
    while (i < n) {
      const c = body[i]
      if (quote) {
        value += c
        if (c === quote) {
          if (quote === "'" && body[i + 1] === "'") { value += body[i + 1]; i += 2; continue }
          quote = null
        }
        i++
        continue
      }
      if (c === "'" || c === '"') { quote = c; value += c; i++; continue }
      if (c === '{' || c === '[') { depth++; value += c; i++; continue }
      if (c === '}' || c === ']') { depth--; value += c; i++; continue }
      if (c === ',' && depth === 0) { i++; break }
      value += c
      i++
    }
    out.push([key.trim(), value.trim()])
  }
  return out
}

/** 去掉 YAML 引号包装。 */
export function unquote(value) {
  let v = String(value ?? '').trim()
  if (v.length >= 2) {
    const q = v[0]
    if ((q === "'" || q === '"') && v.endsWith(q)) {
      let inner = v.slice(1, -1)
      // YAML 折叠标量：换行 + 缩进会被折成单个空格。
      // 多行凭据（buddy/workbuddy/gemini）就是这种形状，不折叠会留下裸换行，
      // 导致 JSON.parse 报 Bad control character。
      inner = inner.replace(/\n[ \t]+/g, ' ')
      if (q === "'") inner = inner.replace(/''/g, "'")
      else inner = inner.replace(/\\"/g, '"').replace(/\\n/g, '\n')
      return inner
    }
  }
  // 引号未闭合（被截断的多行值）：至少剥掉开头的引号，让 JSON.parse 有机会成功
  if (v.length > 0 && (v[0] === "'" || v[0] === '"')) {
    const q = v[0]
    return v.slice(1).replace(/\n[ \t]+/g, ' ').replace(q === "'" ? /''/g : /\\"/g, q === "'" ? "'" : '"')
  }
  return v
}

/**
 * 修复 JSON 字符串里的裸控制字符。
 *
 * 为什么需要：凭据文件里的某些值（典型是 Gemini 的 `scope`）在 YAML
 * 里是**多行单引号标量** —— YAML 会把换行折叠进值里，于是 JSON 字符串
 * 内部出现**裸换行**。JSON 规范不允许字符串里有裸控制字符，
 * `JSON.parse` 会报 `Bad control character in string literal`。
 *
 * DSH 写文件时用的是转义形式（`\n`），但一旦经过某些编辑器/YAML 往返，
 * 就可能变成裸字符。这里做防御性修复：把字符串字面量内部的裸控制字符
 * 转成对应转义，其它位置不动。
 *
 * @param {string} raw
 * @returns {string}
 */
export function repairJsonControlChars(raw) {
  const s = String(raw)
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (escaped) { out += c; escaped = false; continue }
    if (c === '\\') { out += c; escaped = true; continue }
    if (c === '"') { inString = !inString; out += c; continue }
    if (inString && c.charCodeAt(0) < 0x20) {
      // 字符串内部的裸控制字符 → 转义
      if (c === '\n') { out += '\\n'; continue }
      if (c === '\r') { out += '\\r'; continue }
      if (c === '\t') { out += '\\t'; continue }
      // 其它控制字符直接丢弃（它们在凭据里没有意义）
      continue
    }
    out += c
  }
  return out
}

/**
 * 解析凭据文件。
 * @param {string} text
 * @returns {{refs: Record<string,string>, records: Record<string,any>}}
 */
export function parseCredentialsYaml(text) {
  const refs = {}
  const records = {}

  // ── refs：流式 map ───────────────────────────────────────────
  const refBody = extractFlowBlock(text, 'refs')
  if (refBody !== null) {
    for (const [k, v] of splitFlowEntries(refBody)) {
      if (k) refs[k] = unquote(v)
    }
  } else {
    // 退路：块式（`refs:` 换行 + 缩进键值）
    //
    // ⚠️ 必须支持**多行标量**。DSH 写的凭据里有两种形状：
    //     1. 单行：   NAME: '{"access_token":"..."}'
    //     2. 多行：   NAME: '{"access_token":"...",
    //                    profile offline_access
    //                    email","domain":"..."}'
    //    第 2 种是 YAML 的折叠标量 —— 引号**不闭合在同一行**，后续
    //    缩进行都是值的一部分。早期实现只取第一行，于是 buddy/workbuddy/
    //    gemini 的凭据被截断成半截 JSON：
    //      · JSON.parse 失败 → resolveCredentialByRef 返回 undefined
    //      · hasLoggedInAccount 误报 false
    //      · listModels 走 providerCatalogVisible 闸门 → 返回空数组
    //      · 侧栏模型列表因此看不到这些渠道的任何模型（实测踩过）
    //    cline/opencode 的凭据恰好是单行，所以只有它们显示正常。
    const lines = text.split(/\r?\n/)
    let inRefs = false
    let pendingName = null
    let pendingValue = null
    /** 把待处理的多行值收尾（剥引号、折叠换行）。 */
    const flushPending = () => {
      if (pendingName === null) return
      refs[pendingName] = unquote(pendingValue)
      pendingName = null
      pendingValue = null
    }
    for (const line of lines) {
      if (/^\s*refs\s*:\s*$/.test(line)) { inRefs = true; continue }
      if (inRefs && /^\S/.test(line)) { inRefs = false; flushPending() }
      if (!inRefs) continue
      // 键的正则必须**排除续行**。
      //
      // ⚠️ 多行标量的续行长这样：`    https://www.googleapis.com/auth/cclog`
      //    —— 它含冒号，会被 `^\s{2,}(\w+)\s*:` 误判成新键 `https`，
      //    于是上一个值被提前 flush（截断），gemini 的 JSON 就是这么坏的。
      //    真正的键是**大写字母/数字/下划线**（DSH 的 ref 命名规范），
      //    且冒号后必须是行尾或空格（不能是 `//` 这种 URL 片段）。
      const m = /^\s{2,}([A-Z][A-Z0-9_]*)\s*:\s?(.*)$/.exec(line)
      if (m) {
        // 新的键开始 → 先把上一项收尾
        flushPending()
        pendingName = m[1]
        pendingValue = m[2]
        // 判断值是否已在本行闭合。
        //
        // ⚠️ 判据是「**行尾**是闭合引号」，不是「本行出现过两个引号」。
        //    多行标量的中间行经常含有引号字符（gemini 的 scope 里就有
        //    `"https://…"` 这样的子串），数引号个数会误判成已闭合，
        //    于是后面的续行被丢掉 → JSON 截断 → parse 失败。
        //    正确做法：只有 `v` 以引号结尾、且该引号未被反斜杠转义时才算闭合。
        const v = m[2].trim()
        if (v === '') { flushPending(); continue }
        const q = v[0]
        if (q !== "'" && q !== '"') {
          // 无引号：单行标量（如 `DEEPSEEK_API_KEY: sk-xxx`）
          flushPending()
          continue
        }
        // 结尾是否是该引号（且不是 `\'` 转义）
        const endsWithQuote = v.length >= 2 && v.endsWith(q) && v[v.length - 2] !== '\\'
        if (endsWithQuote) flushPending()
        continue
      }
      // 非键行：属于上一个值的延续（折叠标量的后续行）
      if (pendingName !== null) pendingValue += '\n' + line
    }
    flushPending()
  }

  // ── records：块式（嵌套两级），只取结构用于诊断，不常用 ────────
  const recLines = text.split(/\r?\n/)
  let inRec = false
  let curName = null
  for (const line of recLines) {
    if (/^\s*records\s*:\s*$/.test(line)) { inRec = true; continue }
    if (/^\s*refs\s*:/.test(line)) { inRec = false; curName = null }
    if (!inRec) continue
    const nameM = /^\s{2}([^\s:][^:]*):\s*$/.exec(line)
    if (nameM) { curName = nameM[1].trim(); records[curName] = {}; continue }
    const kvM = /^\s{4,}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line)
    if (kvM && curName) records[curName][kvM[1]] = unquote(kvM[2])
  }

  return { refs, records }
}

/**
 * Overlay 存储：WhalePod 自己续期出来的凭据。
 *
 * 形状：{ version: 1, refs: { NAME: '<值>' }, updatedAt: { NAME: ms } }
 * 只写这个文件，绝不碰 DSH 的 .credentials.yaml。
 */
export class CredentialOverlay {
  constructor(file) {
    this.file = file ?? defaultOverlayPath()
    this._data = null
  }

  load() {
    if (this._data) return this._data
    if (!fs.existsSync(this.file)) {
      this._data = { version: 1, refs: {}, updatedAt: {} }
      return this._data
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this._data = {
        version: 1,
        refs: parsed.refs ?? {},
        updatedAt: parsed.updatedAt ?? {},
      }
    } catch (err) {
      // 坏文件不致命：备份后当空处理，避免整个网关起不来。
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* ignore */ }
      this._data = { version: 1, refs: {}, updatedAt: {} }
    }
    return this._data
  }

  get(name) { return this.load().refs[name] }
  has(name) { return this.load().refs[name] !== undefined }
  names() { return Object.keys(this.load().refs) }

  /** 写入一条并原子落盘。 */
  set(name, value) {
    const d = this.load()
    d.refs[name] = String(value)
    d.updatedAt[name] = Date.now()
    this.save()
  }

  delete(name) {
    const d = this.load()
    delete d.refs[name]
    delete d.updatedAt[name]
    this.save()
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this._data, undefined, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}

/**
 * 凭据门面。
 *
 * 读：overlay 优先，回落 DSH 文件（合并视图，带缓存）
 * 写：按 mode 决定（overlay / direct / readonly）
 */
export class Credentials {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file]      DSH 凭据文件
   * @param {string} [opts.overlay]   overlay 文件
   * @param {'overlay'|'direct'|'readonly'} [opts.mode]
   * @param {number} [opts.ttlMs]
   */
  constructor(opts = {}) {
    this.file = opts.file ?? defaultCredentialsPath()
    this.mode = opts.mode ?? 'overlay'
    this.overlay = new CredentialOverlay(opts.overlay)
    this._cache = null
    this._cacheAt = 0
    this._ttlMs = opts.ttlMs ?? 5000
  }

  reload() { this._cache = null; this.overlay._data = null; return this.load() }

  /** 读 DSH 文件（不带 overlay）。 */
  _loadDsh() {
    if (!fs.existsSync(this.file)) return { refs: {}, records: {}, missing: true }
    const text = fs.readFileSync(this.file, 'utf8')
    const parsed = parseCredentialsYaml(text)
    parsed.missing = false
    return parsed
  }

  /**
   * 合并视图：DSH 为底，overlay 覆盖。
   * 缓存 TTL 很短（5s），因为 DSH 可能随时更新凭据。
   */
  load() {
    const now = Date.now()
    if (this._cache && now - this._cacheAt < this._ttlMs) return this._cache

    const dsh = this._loadDsh()
    const ov = this.overlay.load()
    const refs = { ...dsh.refs, ...ov.refs }
    this._cache = {
      refs,
      records: dsh.records,
      missing: dsh.missing && Object.keys(ov.refs).length === 0,
      fromOverlay: new Set(Object.keys(ov.refs)),
      dshMissing: dsh.missing,
    }
    this._cacheAt = now
    return this._cache
  }

  listRefs() { return Object.keys(this.load().refs).sort() }
  getRaw(name) { return this.load().refs[name] }

  /** 该 ref 的值是否来自 overlay（用于状态展示）。 */
  isFromOverlay(name) { return this.load().fromOverlay.has(name) }

  /** 取引用名并尝试 JSON 解析（凭据常是 JSON 字符串）。 */
  get(name) {
    const raw = this.getRaw(name)
    if (raw === undefined) return undefined
    const trimmed = raw.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return JSON.parse(trimmed) } catch { /* 试修复 */ }
      try { return JSON.parse(repairJsonControlChars(trimmed)) } catch { /* 放弃 */ }
      return raw
    }
    return raw
  }

  /**
   * 取原始字符串（供需要自己 JSON.parse 的调用方使用）。
   * 会先做控制字符修复 —— pack.js 自己 parse，所以必须在这里修好。
   */
  getRepaired(name) {
    const raw = this.getRaw(name)
    if (raw === undefined) return undefined
    return repairJsonControlChars(raw)
  }

  has(name) { return this.getRaw(name) !== undefined }
  findByPrefix(prefix) { return this.listRefs().filter((r) => r.startsWith(prefix)) }

  /**
   * 写入凭据（pack.js 的续期会调这里）。
   *
   * overlay 模式：写 WhalePod 自己的文件，不动 DSH。
   * direct 模式：原子写 DSH 文件（先备份）。
   * readonly 模式：抛错。
   */
  async set(name, value) {
    if (this.mode === 'readonly') {
      throw new Error('凭据为只读模式（credentials.mode=readonly）')
    }
    if (this.mode === 'direct') {
      this._writeDsh(name, value)
    } else {
      this.overlay.set(name, value)
    }
    // 让下一次读取拿到新值
    this._cache = null
  }

  async unset(name) {
    if (this.mode === 'readonly') throw new Error('凭据为只读模式')
    if (this.mode === 'direct') throw new Error('direct 模式不支持删除凭据（请用 DSH 的凭据管理）')
    this.overlay.delete(name)
    this._cache = null
  }

  /** 直接改写 DSH 文件：这是 destructive 的，所以先备份再原子写。 */
  _writeDsh(name, value) {
    const file = this.file
    if (fs.existsSync(file)) {
      const bak = `${file}.whale-pod-bak-${Date.now()}`
      fs.copyFileSync(file, bak)
    }
    const dsh = this._loadDsh()
    dsh.refs[name] = String(value)
    // 重建整个文件会丢 records —— 所以只做最小改动：替换/追加 refs 行。
    // 为安全起见，这里改用「重写 refs 流式块」的方式。
    const text = fs.readFileSync(file, 'utf8')
    const rebuilt = replaceRefsBlock(text, dsh.refs)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, rebuilt, { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  static redact(value) {
    const s = String(value ?? '')
    if (s.length <= 6) return '***'
    return `${s.slice(0, 6)}…(${s.length})`
  }
}

/**
 * 把 `refs: { ... }` 块替换成给定的 refs。
 * 保留文件其它部分（version / records）原样。
 */
export function replaceRefsBlock(text, refs) {
  const re = /^(\s*)refs\s*:\s*\{/m
  const m = re.exec(text)
  const entries = Object.entries(refs)
    .map(([k, v]) => `  ${k}: '${String(v).replace(/'/g, "''")}'`)
    .join(',\n')
  const block = `refs: {\n${entries}\n}`

  if (!m) {
    // 没有 refs 块：追加
    return `${text.replace(/\s*$/, '')}\n${block}\n`
  }
  // 找到块的结束（括号配对）
  let i = m.index + m[0].length
  let depth = 1
  let quote = null
  for (; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) {
        if (quote === "'" && text[i + 1] === "'") { i++; continue }
        quote = null
      }
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) { i++; break } }
  }
  return text.slice(0, m.index) + block + text.slice(i)
}
