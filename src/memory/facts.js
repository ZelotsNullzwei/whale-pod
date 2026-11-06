/**
 * 长期记忆档案（2026-11-06）——「一直记得住」的那一半。
 *
 * ## 为什么不用摘要
 * 摘要是**覆盖式**的：每次重写，旧细节就被挤掉（`maxChars` 一压更明显）。
 * 用户要的是「以后能一直记着你说的」—— 那就得有一条**只增不减**的档案。
 *
 * ## 为什么要可见性
 * 人格是分开的（群 default / 私聊 close）。私聊里的话不能原样进群，
 * 所以每条都带 `scope`：
 *   · `private` —— 只在私聊可见（亲密内容、只对一个人说的话）
 *   · `group`   —— 只在群里可见（群友的事、群内梗）
 *   · `shared`  —— 两边都能看（他本人的事实、跨场合的事）
 *
 * 注入规则：私聊看全部；**群只看 group + shared**。
 *
 * 文件：`<数据目录>/memory-facts.json`
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let HOME = process.env.WHALE_POD_HOME
  || path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'whale-pod')

const MAX_ITEMS = 300
const SCOPES = new Set(['private', 'group', 'shared'])

let _cache = { mtime: -1, items: [] }

export function configureFacts({ home } = {}) {
  if (typeof home === 'string' && home.trim()) HOME = home.trim()
  _cache = { mtime: -1, items: [] }
}

export function factsPath() {
  return path.join(HOME, 'memory-facts.json')
}

function readAll() {
  const file = factsPath()
  let st
  try { st = fs.statSync(file) } catch { _cache = { mtime: -1, items: [] }; return [] }
  if (_cache.mtime === st.mtimeMs) return _cache.items
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const items = Array.isArray(j?.items) ? j.items : []
    const clean = items
      .filter((x) => x && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({
        text: String(x.text).trim(),
        scope: SCOPES.has(String(x.scope)) ? String(x.scope) : 'shared',
        at: Number(x.at ?? 0),
      }))
    _cache = { mtime: st.mtimeMs, items: clean }
    return clean
  } catch {
    _cache = { mtime: st.mtimeMs, items: [] }
    return []
  }
}

function writeAll(items) {
  const file = factsPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
    _cache = { mtime: -1, items }
    return { ok: true, file, count: items.length }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * 追加几条。
 * @param {Array<{text:string, scope?:string, at?:number}>} list
 */
export function addFacts(list = []) {
  const incoming = (Array.isArray(list) ? list : [])
    .map((x) => ({ text: norm(x?.text), scope: SCOPES.has(String(x?.scope)) ? String(x.scope) : 'shared', at: Number(x?.at ?? Date.now()) }))
    .filter((x) => x.text.length >= 2)
  if (!incoming.length) return { ok: true, added: 0 }
  const items = [...readAll()]
  const seen = new Set(items.map((x) => norm(x.text)))
  let added = 0
  for (const it of incoming) {
    if (seen.has(it.text)) continue
    seen.add(it.text)
    items.push(it)
    added++
  }
  // 太多就丢最早的（仍保留最近的 300 条）
  const trimmed = items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items
  writeAll(trimmed)
  return { ok: true, added, total: trimmed.length }
}

/**
 * 某个会话能看到的条目（新的在前）。
 *
 * @param {string} scope 'private:xxx' / 'group:yyy'
 * @param {number} [limit]
 */
export function factsFor(scope, limit = 40) {
  const s = String(scope ?? '')
  const isGroup = s.startsWith('group:')
  const items = readAll()
    .filter((x) => (isGroup ? x.scope === 'group' || x.scope === 'shared' : true))
  return items.slice(-limit).reverse()
}

/** 渲染成提示词块（没有就返回空串）。 */
export function renderFacts(scope, limit = 30) {
  const items = factsFor(scope, limit)
  if (!items.length) return ''
  const lines = items.map((x) => `- ${x.text}`)
  return '## 你记得的事（长期档案，不会因为摘要重写而丢）\n' + lines.join('\n')
}

/** 测试/维护用：清空。 */
export function clearFacts() {
  return writeAll([])
}
