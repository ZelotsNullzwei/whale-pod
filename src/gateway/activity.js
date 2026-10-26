// @ts-check
/**
 * 活跃天数记录 —— 数「真正有消息往来的日子」。
 *
 * ## 为什么不直接用 usage.json 的 startedAt
 *
 * `startedAt` 是**首次启动时刻**，算出来的是「装了多久」。
 * 用户要的是「活跃了几天」：关机一周再开，不该把那一周算进去。
 *
 * 所以这里记一份**日期集合**（本地时区，`YYYY-MM-DD`）：
 * 只要当天有群聊或私聊消息进入，就把日期写进去，跨天自动 +1。
 *
 * ## 落盘
 *
 * `<home>/activity.json`：
 * ```json
 * { "days": ["2026-10-24", "2026-10-25"], "firstAt": 1792469874091 }
 * ```
 *
 * 只存日期字符串，一年也就 365 条 × 11 字节 ≈ 4KB，不用考虑裁剪。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 本地时区的日期串 `YYYY-MM-DD`。
 *
 * ⚠️ 不能用 `toISOString()` —— 它是 UTC，东八区凌晨 0-8 点会被算成前一天，
 *    用户看到的「活跃天数」就会比预期少一天。
 *
 * @param {Date} [d]
 * @returns {string}
 */
export function localDayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export class ActivityTracker {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] 数据目录。给了就落盘到 `<home>/activity.json`；
   *   不给是纯内存（测试用）。
   * @param {() => Date} [opts.now] 时间源，测试时可注入固定时间。
   */
  constructor(opts = {}) {
    this.file = opts.home ? path.join(opts.home, 'activity.json') : null
    /** @type {Set<string>} 有活动的本地日期 */
    this.days = new Set()
    /** @type {number|null} 第一次记录到活动的时刻 */
    this.firstAt = null
    this._now = opts.now ?? (() => new Date())
    if (this.file) this.load()
  }

  /**
   * 从磁盘恢复。
   *
   * 读失败（文件不存在 / 损坏 / 字段类型不对）就当空的重新开始 ——
   * 这个统计是锦上添花，不值得因为它阻断启动。
   */
  load() {
    if (!this.file) return
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw)
      if (Array.isArray(data?.days)) {
        for (const d of data.days) {
          // 只认 `YYYY-MM-DD`，挡掉手改坏的数据
          if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) this.days.add(d)
        }
      }
      if (Number.isFinite(data?.firstAt)) this.firstAt = data.firstAt
    } catch {
      // 首次运行 / 文件坏了 —— 从零开始
    }
  }

  /** 原子写盘（先写 .tmp 再 rename），避免中途断电留半截文件。 */
  save() {
    if (!this.file) return
    try {
      const payload = JSON.stringify({
        days: [...this.days].sort(),
        firstAt: this.firstAt,
      })
      const tmp = `${this.file}.tmp`
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload, { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch {
      // 写不进去不影响主流程（内存里的计数还在，下次再试）
    }
  }

  /**
   * 记一次活动。**同一天重复调用是幂等的**，只有跨天才会真的写盘，
   * 所以可以放心地在每条消息入口调。
   *
   * @param {Date} [at]
   * @returns {boolean} 是否新开了一天（true = 刚跨天）
   */
  touch(at = this._now()) {
    const key = localDayKey(at)
    if (this.days.has(key)) return false
    this.days.add(key)
    if (this.firstAt === null) this.firstAt = at.getTime()
    this.save()
    return true
  }

  /**
   * 给界面用的快照。
   *
   * @param {Date} [at] 以哪天为准判断「今天」
   * @returns {{
   *   totalDays: number,
   *   firstDay: string|null,
   *   lastDay: string|null,
   *   todayActive: boolean,
   *   days: string[],
   * }}
   */
  stats(at = this._now()) {
    const days = [...this.days].sort()
    return {
      totalDays: days.length,
      firstDay: days[0] ?? null,
      lastDay: days[days.length - 1] ?? null,
      todayActive: this.days.has(localDayKey(at)),
      days,
    }
  }
}

export default ActivityTracker
