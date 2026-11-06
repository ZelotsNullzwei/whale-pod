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
// 读的时候要对一次衣柜（见 wearingFor 的注释）
import { resolveOutfitText } from './wardrobe.js'

/** 数据目录（`configureWearState` 会覆盖） */
let HOME = path.join(
  process.env.WHALE_POD_HOME
  ?? path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'whale-pod'),
)

/** 文件名 */
export const WEAR_FILE = 'wearing.json'

/**
 * 到这些**时段**临时那套自动作废（该换睡衣了）。
 *
 * ⚠️ 这里**只剩 night**（2026-11-06 修）。
 *
 * 原来是 `['evening','night']`，而 `currentSlot()` 的 evening 是
 * **18:00–次日 05:00** —— 等于「晚上六点就算该穿睡衣」，临时那套全部作废。
 *
 * 实测代价（群 704291282，2026-11-06）：
 * ```
 * 19:32:53  他「我要看女仆装」
 * 19:35:15  她（冷场补话）「…[换装:白色系女仆装长款…]」   ← 标记还漏到了群里
 * 19:35:22  wearing.json 写入成功（kind=signature）
 * 19:39:39  生图 → wearingFor(day, 'evening') 返回 null → 用日程表的家居服
 * 19:41     群里：「而且衣服没换过来」
 * ```
 * 也就是说：**晚上是群里最活跃的时段，恰恰是换装唯一不生效的时段**。
 * 现在改成按钟点判（见 SLEEP_HOUR），时段只留 night 兜底。
 */
const SLEEP_SLOTS = ['night']

/**
 * 到几点算「该换睡衣了」（本地时间）。
 *
 * 22 点前临时换的那套一律有效；22 点之后 / 凌晨 0–5 点让位给睡裙
 * （她总不能穿着女仆装睡觉）。用户口径也是「到了晚上换睡衣的时候再换」——
 * 那个"到点"指的是真去洗漱睡觉，不是六点。
 */
const SLEEP_HOUR = 22
const WAKE_HOUR = 5

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
 * ② 现在是**真的该穿睡衣的时候**：钟点 ≥ 22:00 或 < 05:00
 *    （只按 slot 判会把 18:00–22:00 这段最活跃的时间一起判掉，见 SLEEP_SLOTS 的注释）
 *
 * @param {string} dayKey  今天
 * @param {string} [slotId] 当前时段（只有 night 会让位）
 * @param {Date}   [now]    注入当前时间（测试用；缺省 new Date()）
 * @returns {null|{text:string, kind:string, at:number, note:string}}
 */
export function wearingFor(dayKey, slotId = '', now = new Date()) {
  const k = String(dayKey ?? '').trim()
  if (!k) return null
  const rec = readAll()[k]
  if (!rec || !String(rec.text ?? '').trim()) return null
  // 该换睡衣了 → 临时那套不再生效（按钟点，不按时段）
  const hour = (now instanceof Date ? now : new Date(now)).getHours()
  if (SLEEP_SLOTS.includes(String(slotId ?? '')) || hour >= SLEEP_HOUR || hour < WAKE_HOUR) return null
  /*
   * ★★ **读的时候再对一次衣柜**（2026-11-06 实测）。
   *
   * 现场：她 16:31 写的是
   *   [换装:短款女仆装，藏青连身裙加白蕾丝围裙，裙摆到膝上]
   * 这句**没有过膝白丝**（衣柜里那套有）。写进文件之后，
   * 后面每次生图都读这句残缺版 —— 腿上就是光腿。
   *
   * 写入口已经会解析（resolveOutfitText），但**历史记录**还在文件里，
   * 所以读取时也解析一遍：能对上衣柜就用衣柜原文。
   * ⚠️ 解析失败（她自己编的）就原样返回，不硬套。
   */
  let text = String(rec.text)
  try {
    const r = resolveOutfitText(text)
    if (r.matched && r.text) text = r.text
  } catch { /* 解析失败不影响主流程 */ }
  return {
    text,
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
