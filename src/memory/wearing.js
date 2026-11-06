/**
 * 「今天临时换上了哪套」（2026-11-06）。
 *
 * 用户口径：「有要换衣服就同步一下，临时替换？第二天或者到了晚上换睡衣的时候再换」。
 *
 * ## 要解决的冲突
 * 衣柜是**按日期算的**（`outfitForDay(dayKey)` —— 同一天永远同一套）。
 * 但聊天里她/他说「换那套」时，那是一次**临时的、当天有效**的更换：
 * ```
 * 15:16:29 他「那你换上去群里招一下人」
 * 15:16:35 她「换就换，等着」        ← 嘴上换了
 * 15:16:41 她「短的那套，本鱼正在换」
 *          → 但生图仍按日程表的家居服画，图和嘴对不上
 * ```
 *
 * ## 规则（就三条）
 * ① **临时覆盖**：只在**当天**有效，`dayKey` 一变自动作废（第二天自然恢复）。
 * ② **晚上/刚起床自动让位**：到了穿睡衣的时段，临时那套**不再生效** ——
 *    她总不能穿着女仆装睡觉（`expiresAtSlot` 就是干这个的）。
 * ③ **只覆盖"现在穿的"**，不动衣柜本身：`effectivePools()` 不受影响，
 *    面板上看到的还是那 47 套。
 *
 * ## 为什么单独一个文件
 * `wardrobe.js` 管的是**衣柜**（长期资产），这个管的是**今天穿了什么**（短命状态）。
 * 混在一起以后改衣柜容易误伤运行期状态。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 数据目录（`configureWearState` 会覆盖） */
let HOME = path.join(
  process.env.WHALE_POD_HOME
  ?? path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'whale-pod'),
)

/** 文件名 */
export const WEAR_FILE = 'wearing.json'

/** 到这些时段，临时那套自动作废（该换睡衣了） */
const SLEEP_SLOTS = ['evening', 'night']

/**
 * 告诉它数据目录在哪（启动时调一次）。
 * @param {{home?:string}} o
 */
export function configureWearState({ home } = {}) {
  if (typeof home === 'string' && home.trim()) HOME = home.trim()
  _cache.mtime = -1
}

/** 文件路径 */
export function wearingPath() {
  return path.join(HOME, WEAR_FILE)
}

const _cache = { mtime: -1, data: null }

/**
 * 读今天的临时穿着（按 mtime 缓存）。
 *
 * 形状：`{ [dayKey]: { text, kind, at, note } }`
 */
function readAll() {
  const file = wearingPath()
  let st
  try { st = fs.statSync(file) } catch {
    _cache.mtime = -1
    _cache.data = {}
    return {}
  }
  if (_cache.data && st.mtimeMs === _cache.mtime) return _cache.data
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const out = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}
    _cache.mtime = st.mtimeMs
    _cache.data = out
    return out
  } catch {
    _cache.mtime = st.mtimeMs
    _cache.data = {}
    return {}
  }
}

function writeAll(obj) {
  const file = wearingPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
    _cache.mtime = -1
    _cache.data = obj
    return { ok: true, file }
  } catch (e) {
    return { ok: false, file, error: String(e?.message ?? e) }
  }
}

/**
 * 记下「今天临时换上了这套」。
 *
 * @param {string} dayKey  YYYY-MM-DD
 * @param {object} o
 * @param {string} o.text  这套衣服的完整描述（衣柜里那条原文）
 * @param {'home'|'outing'|'sleepwear'|'signature'} [o.kind] 从哪一类来的
 * @param {string} [o.note] 一句话备注（比如「他让换的」）
 * @returns {{ok:boolean, file?:string, error?:string}}
 */
export function setWearing(dayKey, { text, kind, note } = {}) {
  const k = String(dayKey ?? '').trim()
  const t = String(text ?? '').trim()
  if (!k || !t) return { ok: false, error: 'dayKey 和 text 都要有' }
  const all = { ...readAll() }
  all[k] = { text: t, kind: String(kind ?? ''), at: Date.now(), note: String(note ?? '') }
  // 只留最近 7 天，别把文件越攒越大
  const keys = Object.keys(all).sort()
  for (const old of keys.slice(0, Math.max(0, keys.length - 7))) delete all[old]
  return writeAll(all)
}

/**
 * 取今天临时换上的那套 —— **已经过期的返回 null**。
 *
 * ## 什么时候算过期
 * ① `dayKey` 不是今天（第二天自然恢复日程表）
 * ② 现在是**该穿睡衣的时段**（`slotId` 在 SLEEP_SLOTS 里）——
 *    临时那套让位给睡衣（她总不能穿着女仆装睡觉）
 *
 * @param {string} dayKey  今天
 * @param {string} [slotId] 当前时段（evening/night → 让位）
 * @returns {null|{text:string, kind:string, at:number, note:string}}
 */
export function wearingFor(dayKey, slotId = '') {
  const k = String(dayKey ?? '').trim()
  if (!k) return null
  const rec = readAll()[k]
  if (!rec || !String(rec.text ?? '').trim()) return null
  // 该换睡衣了 → 临时那套不再生效
  if (SLEEP_SLOTS.includes(String(slotId ?? ''))) return null
  return {
    text: String(rec.text),
    kind: String(rec.kind ?? ''),
    at: Number(rec.at ?? 0),
    note: String(rec.note ?? ''),
  }
}

/** 清掉某天（或全部）的临时穿着。 */
export function clearWearing(dayKey) {
  const k = String(dayKey ?? '').trim()
  const all = { ...readAll() }
  if (k) delete all[k]
  else for (const key of Object.keys(all)) delete all[key]
  return writeAll(all)
}
