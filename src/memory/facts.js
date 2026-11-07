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
 * 近似重复判定（2026-11-07 加）。
 *
 * ## 现场
 * 私聊档案里同一条事攒了 **14 份**：
 *   「说定了：他明天下午打卫戍协议，本鲸蹲旁边当观众…」
 *   「说定的事没变：他明天下午打卫戍协议…」
 *   「说定的事没变：…这回本鲸把日子记岔成今天，被他点出来，当场认了。」
 *   ……
 * 因为 `merge()` 每次摘要都把**旧【事】整段**归档进来，而原来只挡
 * **完全一样**的字符串 —— 措辞差几个字就全进来了。
 *
 * 代价不只是占地方：`renderFacts` 会把它们全渲染进提示词，
 * 于是「打卫」这件事在她眼前重复十几遍，她就一直惦记着提。
 *
 * 用 4-gram Jaccard 判近似（阈值 0.6）：这几条互相都在 0.8 以上，
 * 而「他说白色吊带好看」和「他半夜常来缠」这种不同的事在 0.2 以下。
 */
const NEAR_DUP = 0.35

/**
 * 判定阈值是**量出来的**（2026-11-07，用线上 118 条真实档案）：
 *   · 同一件事的 13 个变体之间，最小相似度 **0.42**
 *   · 与不相干主题的最大相似度 **0.27**
 * 取 0.35 落在中间，两边都有余量。改动前先重跑一次这个测量（见提交说明），
 * 不要凭感觉调。
 */

function shingles(s, n = 4) {
  const t = String(s ?? '').replace(/[\s\p{P}]/gu, '')
  const set = new Set()
  if (!t) return set
  if (t.length <= n) { set.add(t); return set }
  for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n))
  return set
}

function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/**
 * 合并近似重复时留哪条：**信息更多的**（长度优先）。
 *
 * 为什么要合而不是简单丢一条：这些变体常各有各的补充
 * （「他纠正了我一次：他说的"一起"是指聊更新公告」）。
 * 全丢会丢细节，全留就是十几条重复占提示词 —— 留最长那条最划算。
 */
const longer = (a, b) => (String(b ?? '').length > String(a ?? '').length ? b : a)

/**
 * 两段话是不是「同一件事」（给 `merge()` 判断旧话题有没有被真的换掉）。
 * @param {string} a
 * @param {string} b
 * @param {number} [threshold]
 */
export function isNearDup(a, b, threshold = NEAR_DUP) {
  return jaccard(shingles(a), shingles(b)) >= threshold
}

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
  const grams = items.map((x) => shingles(x.text))
  let added = 0
  let merged = 0
  for (const it of incoming) {
    if (seen.has(it.text)) continue
    const sh = shingles(it.text)
    // ★ **近似重复也要挡**（措辞差几个字不算新事，见上面 NEAR_DUP 的说明）
    const i = grams.findIndex((g) => jaccard(g, sh) >= NEAR_DUP)
    if (i >= 0) {
      const better = longer(items[i].text, it.text)
      if (better !== items[i].text) {
        items[i] = { ...items[i], text: better }
        grams[i] = shingles(better)
        seen.add(better)
        merged++
      }
      continue
    }
    seen.add(it.text)
    grams.push(sh)
    items.push(it)
    added++
  }
  // 太多就丢最早的（仍保留最近的 300 条）
  const trimmed = items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items
  writeAll(trimmed)
  return { ok: true, added, merged, total: trimmed.length }
}

/**
 * 把已有的近似重复合并掉（维护用，2026-11-07）。
 * 合并规则见 `longer`：留信息更多的那个，`at` 用更早的。
 * @returns {{ok:boolean, removed:number, merged:number, total:number}}
 */
export function dedupeFacts() {
  const items = [...readAll()]
  const kept = []
  const grams = []
  let merged = 0
  for (const it of items) {
    const sh = shingles(it.text)
    const i = grams.findIndex((g) => jaccard(g, sh) >= NEAR_DUP)
    if (i >= 0) {
      const better = longer(kept[i].text, it.text)
      if (better !== kept[i].text) {
        kept[i] = { ...kept[i], text: better }
        grams[i] = shingles(better)
        merged++
      }
      continue
    }
    grams.push(sh)
    kept.push(it)
  }
  const removed = items.length - kept.length
  if (removed > 0 || merged > 0) writeAll(kept)
  return { ok: true, removed, merged, total: kept.length }
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
