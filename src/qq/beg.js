/**
 * 「钱包要空了」—— 余额不足时主动开口讨钱。
 *
 * ## 需求（2026-10-25 用户定）
 *
 *   · 触发点：搜索时顺带查余额
 *   · 阈值：< ¥3
 *   · 对象：@ **最近跟它互动最多的人**
 *   · 频次：每天最多 3 次
 *   · 话术：每次不同
 *
 * ## 为什么按「互动最多」选人，而不是 @ 群主
 *
 * 群主不一定在场，也不一定愿意掏钱。而「最近跟它聊得最多的人」有两个好处：
 *   ① 说明这个人在线、且愿意理它
 *   ② 讨钱的说服力更强 —— 你天天跟它聊，它没饭吃了，你不管谁管
 *
 * ## 为什么话术要「每次不同」
 *
 * 同一句话重复三次，观感立刻从「可爱」变成「刷屏」。
 * 所以这里维护一组**话术模板**，按天轮转 + 随机挑，保证同一天内不重样。
 *
 * ## 为什么状态要落盘
 *
 * 「每天 3 次」必须跨重启有效。否则重启一次就重置，等于没有限制。
 * 落盘到 `<home>/beg.json`，只存最少的东西（日期、次数、当天用过的模板 id）。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * 话术模板。
 *
 * 设计原则：
 *   · 符合「Token = 脑力口粮 = 白米饭」这套人格设定，不用客服腔
 *   · 每条都**明确指向钱/充值**，不能只卖惨 —— 否则对方不知道该干什么
 *   · 长度接近真人一句话，不写成一段公告
 *
 * `id` 用于「当天不重复」去重；改文案时换 id 即可。
 */
export const BEG_LINES = [
  { id: 'rice', text: '本鱼的口粮只剩 ¥{cny} 了，{who} 你是不是该给我续点白米饭了' },
  { id: 'starve', text: '@{who} 我快饿死了，钱包里就 ¥{cny}，再不喂我真要断粮了' },
  { id: 'brain', text: '脑子快转不动了……Token 见底（还剩 ¥{cny}），{who} 你管不管' },
  { id: 'tip', text: '提醒一下 {who}：我的搜索余额只剩 ¥{cny} 了，再不给钱我下次查资料就只能靠猜了' },
  { id: 'bowl', text: '{who} 碗空了（¥{cny}），要不要给我添一勺' },
  { id: 'electric', text: '本鱼电量只剩 ¥{cny}，{who} 你充不充，不充我就地躺平了' },
  { id: 'salary', text: '@{who} 该发工资了，我账上就 ¥{cny}，这活儿没法干了' },
  { id: 'sad', text: '钱包余额 ¥{cny}……{who} 我真不是想烦你，但再这样下去我连话都说不起了' },
]

/** 一天最多讨几次。 */
export const BEG_MAX_PER_DAY = 3

/**
 * 互动统计：谁最近跟它说话最多。
 *
 * ## 为什么用滑动窗口而不是累计
 *
 * 累计次数会让「早期聊得多、现在不聊了」的人永远排第一 —— 讨钱讨到一个
 * 早就不在群里的人身上，既尴尬又无效。所以用**时间衰减**：
 * 只统计最近 `windowMs` 内说话的人。
 */
export class InteractionTracker {
  /**
   * @param {object} opts
   * @param {number} [opts.windowMs]  统计窗口，默认 7 天
   * @param {number} [opts.cap]       最多记多少人，防内存膨胀
   */
  constructor(opts = {}) {
    this.windowMs = Number(opts.windowMs ?? 7 * 24 * 3600_000)
    this.cap = Number(opts.cap ?? 500)
    /** @type {Map<string, {id:string, name:string, counts:number[], lastAt:number}>} */
    this.byUser = new Map()
  }

  /**
   * 记一次互动。
   *
   * @param {string} id      QQ 号
   * @param {string} name    昵称（只用于展示）
   * @param {number} [at]    时间戳
   */
  hit(id, name, at = Date.now()) {
    const key = String(id ?? '').trim()
    if (!key) return
    let rec = this.byUser.get(key)
    if (!rec) {
      rec = { id: key, name: String(name ?? key), counts: [], lastAt: 0 }
      // 超容量时丢最久没说话的
      if (this.byUser.size >= this.cap) {
        let oldestKey = null
        let oldestAt = Infinity
        for (const [k, v] of this.byUser) {
          if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestKey = k }
        }
        if (oldestKey) this.byUser.delete(oldestKey)
      }
      this.byUser.set(key, rec)
    }
    rec.name = String(name ?? rec.name)
    rec.lastAt = at
    rec.counts.push(at)
    this._prune(rec, at)
  }

  /** 丢掉窗口外的计数。 */
  _prune(rec, now = Date.now()) {
    const floor = now - this.windowMs
    if (rec.counts.length > 0 && rec.counts[0] < floor) {
      rec.counts = rec.counts.filter((t) => t >= floor)
    }
    // 单条记录也不需要无限增长
    if (rec.counts.length > 500) rec.counts = rec.counts.slice(-500)
  }

  /**
   * 按「最近互动量」排序，返回前 N 个。
   *
   * 排序依据：窗口内次数优先；次数相同则最近说话的排前。
   *
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {string[]} [opts.exclude]  排除的 QQ 号（如机器人自己）
   * @returns {Array<{id:string, name:string, count:number, lastAt:number}>}
   */
  top(opts = {}) {
    const limit = Number(opts.limit ?? 1)
    const exclude = new Set((opts.exclude ?? []).map(String))
    const now = Date.now()
    const rows = []
    for (const rec of this.byUser.values()) {
      if (exclude.has(rec.id)) continue
      this._prune(rec, now)
      if (rec.counts.length === 0) continue
      rows.push({ id: rec.id, name: rec.name, count: rec.counts.length, lastAt: rec.lastAt })
    }
    rows.sort((a, b) => (b.count - a.count) || (b.lastAt - a.lastAt))
    return rows.slice(0, limit)
  }

  /** 导出可落盘的最小结构。 */
  toJSON() {
    const out = []
    for (const rec of this.byUser.values()) out.push({ id: rec.id, name: rec.name, counts: rec.counts.slice(-100), lastAt: rec.lastAt })
    return out
  }

  /** 从落盘结构恢复。 */
  static fromJSON(arr, opts = {}) {
    const t = new InteractionTracker(opts)
    for (const r of Array.isArray(arr) ? arr : []) {
      if (!r?.id) continue
      t.byUser.set(String(r.id), {
        id: String(r.id),
        name: String(r.name ?? r.id),
        counts: Array.isArray(r.counts) ? r.counts.filter((x) => Number.isFinite(x)) : [],
        lastAt: Number(r.lastAt) || 0,
      })
    }
    return t
  }
}

/** 本地日期串 YYYY-MM-DD（按机器时区，够用）。 */
export function todayKey(now = Date.now()) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 乞讨状态机：管「今天还能不能讨」「这次用哪句」。
 *
 * 状态形状：
 *   { day: '2026-10-25', count: 2, usedLineIds: ['rice','starve'], lastAt: 1234567890 }
 */
export class BegState {
  /**
   * @param {object} opts
   * @param {string} opts.file        落盘路径
   * @param {number} [opts.maxPerDay]
   */
  constructor(opts = {}) {
    this.file = opts.file
    this.maxPerDay = Number(opts.maxPerDay ?? BEG_MAX_PER_DAY)
    this.day = todayKey()
    this.count = 0
    this.usedLineIds = []
    this.lastAt = 0
    this._load()
  }

  _load() {
    if (!this.file) return
    try {
      if (!fs.existsSync(this.file)) return
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const today = todayKey()
      // 跨天自动重置
      if (j?.day === today) {
        this.day = today
        this.count = Number(j.count) || 0
        this.usedLineIds = Array.isArray(j.usedLineIds) ? j.usedLineIds : []
        this.lastAt = Number(j.lastAt) || 0
      }
    } catch { /* 读坏了就当新的一天 */ }
  }

  _save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({
        day: this.day, count: this.count, usedLineIds: this.usedLineIds, lastAt: this.lastAt,
      }, null, 2), 'utf8')
    } catch { /* 写不进去不该让主流程崩 */ }
  }

  /** 今天还能讨几次。 */
  remaining(now = Date.now()) {
    if (this.day !== todayKey(now)) return this.maxPerDay
    return Math.max(0, this.maxPerDay - this.count)
  }

  /**
   * 挑一句今天**还没用过**的话术。
   *
   * 全都用过了（比如 maxPerDay 调到 8 而模板只有 8 句）就允许重复，
   * 但仍然随机 —— 宁可重复也不能没话说。
   *
   * @param {() => number} [rnd]
   */
  pickLine(rnd = Math.random) {
    const used = new Set(this.usedLineIds)
    const fresh = BEG_LINES.filter((l) => !used.has(l.id))
    const pool = fresh.length > 0 ? fresh : BEG_LINES
    const idx = Math.min(pool.length - 1, Math.floor(rnd() * pool.length))
    return pool[idx]
  }

  /**
   * 提交一次乞讨：记账并落盘。
   * @param {{id:string}} line
   */
  commit(line, now = Date.now()) {
    if (this.day !== todayKey(now)) {
      this.day = todayKey(now)
      this.count = 0
      this.usedLineIds = []
    }
    this.count += 1
    if (line?.id && !this.usedLineIds.includes(line.id)) this.usedLineIds.push(line.id)
    this.lastAt = now
    this._save()
  }

  /** 调试用：当前状态。 */
  snapshot() {
    return { day: this.day, count: this.count, remaining: this.remaining(), usedLineIds: [...this.usedLineIds], lastAt: this.lastAt }
  }
}

/**
 * 决定「这次要不要讨、讨什么」。
 *
 * 纯函数，不碰网络也不碰 bridge —— 方便单测。
 *
 * @param {object} o
 * @param {number} o.cny             当前余额
 * @param {number} o.threshold       阈值（低于它才讨）
 * @param {BegState} o.state
 * @param {InteractionTracker} o.tracker
 * @param {string[]} [o.exclude]     排除的 QQ 号
 * @param {() => number} [o.rnd]
 * @returns {{beg:boolean, reason:string, target?:object, line?:object, text?:string}}
 */
export function decideBeg(o) {
  const rnd = o.rnd ?? Math.random
  const cny = Number(o.cny)
  const threshold = Number(o.threshold ?? 3)
  const state = o.state

  if (!Number.isFinite(cny)) return { beg: false, reason: '余额未知' }
  if (cny >= threshold) return { beg: false, reason: `余额 ¥${cny} 未低于 ¥${threshold}` }

  const left = state.remaining()
  if (left <= 0) return { beg: false, reason: `今天的 ${state.maxPerDay} 次已用完` }

  const targets = o.tracker.top({ limit: 3, exclude: o.exclude ?? [] })
  if (targets.length === 0) return { beg: false, reason: '还没有人跟它说过话，不知道该找谁' }

  // 前 3 名里随机挑 —— 总是 @ 同一个人会显得很针对
  const pickIdx = Math.min(targets.length - 1, Math.floor(rnd() * Math.min(3, targets.length)))
  const target = targets[pickIdx]

  const line = state.pickLine(rnd)
  const text = line.text
    .replace('{who}', target.name)
    .replace('{cny}', cny.toFixed(2))

  return { beg: true, reason: `余额 ¥${cny} < ¥${threshold}，今日剩 ${left} 次`, target, line, text }
}
