// @ts-check
/**
 * 主动行为调度器 —— 让机器人「不用被叫也会开口」。
 *
 * ## 管两件独立的事
 *
 *   1. **讨钱**（`beg`）—— 定期查搜索余额，低于阈值就主动发一条
 *   2. **主动发言**（`proactive`）—— 群里安静够久就自己冒个泡
 *
 * 两者各有一个开关，互不影响：只想让它讨钱、不想让它没话找话，
 * 就把 `proactive.enabled` 关掉。
 *
 * ## 为什么不用 setInterval 一把梭
 *
 * 两个任务的周期差一个数量级（讨钱 1 小时、发言 45 分钟起），
 * 而且都想「重启后不要立刻触发」（否则每次重启它就冒一句）。
 * 所以用一个低频 tick（默认 60 秒）轮询，每次只判断「现在该不该做」——
 * 状态（上次做了什么、今天做了几次）自己记，落盘后重启也能延续。
 *
 * ## 安全边界
 *
 * 主动发言是最容易招人烦的功能，所以这里做了几道闸：
 *   · 时段限制（半夜不说话）
 *   · 每日上限
 *   · 全局冷却（不在每个群轮番冒泡）
 *   · 群聊/私聊分别开关
 *   · 只在**白名单内**的会话里说话
 */

/**
 * 本地时区的「今天」——用来重置每日计数。
 *
 * ⚠️ 不能用 `toISOString()`（UTC）：东八区凌晨会被算成前一天，
 *    每日上限就会提前重置。
 *
 * @param {Date} [d]
 * @returns {string}
 */
export function dayKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 现在是不是允许说话的时段。
 *
 * `hours = [8, 23]` 表示 8:00 到 22:59 允许（右开区间）。
 * 支持跨夜（如 `[22, 6]` 表示 22 点到次日 5:59）。
 * 空数组 = 不限时段。
 *
 * @param {number[]} hours
 * @param {Date} [now]
 * @returns {boolean}
 */
export function inActiveHours(hours, now = new Date()) {
  if (!Array.isArray(hours) || hours.length !== 2) return true
  const [from, to] = hours
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true
  if (from === to) return false
  const h = now.getHours()
  // 跨夜：22 → 6 是 h >= 22 || h < 6
  return from < to ? (h >= from && h < to) : (h >= from || h < to)
}

/** 调度器的持久状态（`<home>/proactive.json`）。 */
export class ProactiveState {
  /**
   * @param {object} [opts]
   * @param {import('node:fs')} [opts.fs] 测试可注入
   * @param {string} [opts.file]
   */
  constructor(opts = {}) {
    this.file = opts.file ?? null
    this.fs = opts.fs ?? null
    /** 今天讨了几次 */
    this.begCount = 0
    /** 今天主动说了几次 */
    this.speakCount = 0
    /** 这两个计数属于哪一天 */
    this.day = dayKey()
    /** 上次讨钱的时间戳 */
    this.lastBegAt = 0
    /** 上次主动发言的时间戳 */
    this.lastSpeakAt = 0
    /** 上次查余额的时间戳 */
    this.lastBalanceCheckAt = 0
    /** 最近一次查到的余额（人民币），null = 还不知道 */
    this.lastBalanceCny = null
    if (this.file && this.fs) this.load()
  }

  load() {
    try {
      const raw = this.fs.readFileSync(this.file, 'utf8')
      const d = JSON.parse(raw)
      if (Number.isFinite(d?.begCount)) this.begCount = d.begCount
      if (Number.isFinite(d?.speakCount)) this.speakCount = d.speakCount
      if (typeof d?.day === 'string') this.day = d.day
      if (Number.isFinite(d?.lastBegAt)) this.lastBegAt = d.lastBegAt
      if (Number.isFinite(d?.lastSpeakAt)) this.lastSpeakAt = d.lastSpeakAt
      if (Number.isFinite(d?.lastBalanceCheckAt)) this.lastBalanceCheckAt = d.lastBalanceCheckAt
      if (Number.isFinite(d?.lastBalanceCny)) this.lastBalanceCny = d.lastBalanceCny
    } catch {
      // 首次运行 / 文件坏了 —— 从零开始
    }
  }

  save() {
    if (!this.file || !this.fs) return
    try {
      const payload = JSON.stringify({
        day: this.day,
        begCount: this.begCount,
        speakCount: this.speakCount,
        lastBegAt: this.lastBegAt,
        lastSpeakAt: this.lastSpeakAt,
        lastBalanceCheckAt: this.lastBalanceCheckAt,
        lastBalanceCny: this.lastBalanceCny,
      })
      const tmp = `${this.file}.tmp`
      this.fs.writeFileSync(tmp, payload, { mode: 0o600 })
      this.fs.renameSync(tmp, this.file)
    } catch {
      // 写不进去不影响本次行为
    }
  }

  /**
   * 跨天就把每日计数清零。
   *
   * @param {Date} [now]
   * @returns {boolean} 是否发生了重置
   */
  rollDay(now = new Date()) {
    const today = dayKey(now)
    if (this.day === today) return false
    this.day = today
    this.begCount = 0
    this.speakCount = 0
    return true
  }
}

/**
 * 主动行为调度器。
 *
 * 它**不直接发消息** —— 通过注入的回调发，这样 bridge 那边可以复用
 * 自己的日志、统计和错误处理，调度器本身只做「该不该」的判断。
 */
export class ProactiveScheduler {
  /**
   * @param {object} opts
   * @param {object} [opts.cfg]       `proactive` 配置段
   * @param {object} [opts.begCfg]    `beg` 配置段
   * @param {ProactiveState} opts.state
   * @param {() => number} [opts.now]
   * @param {object} [opts.log]
   * @param {(cny:number) => Promise<boolean>} [opts.checkBalance] 查余额，返回是否偏低
   * @param {() => Promise<void>} [opts.onBeg]      执行一次讨钱
   * @param {(scope:string) => Promise<boolean>} [opts.onSpeak]  在某个会话说一句
   * @param {() => string[]} [opts.scopes]          可主动发言的会话列表
   * @param {() => number} [opts.idleMs]            当前最长静默时长（毫秒）
   */
  constructor(opts) {
    this.cfg = opts.cfg ?? {}
    this.begCfg = opts.begCfg ?? {}
    this.state = opts.state
    this._now = opts.now ?? (() => Date.now())
    this.log = opts.log ?? {}
    this.checkBalance = opts.checkBalance ?? null
    this.onBeg = opts.onBeg ?? null
    this.onSpeak = opts.onSpeak ?? null
    this.scopes = opts.scopes ?? (() => [])
    this.idleMs = opts.idleMs ?? (() => 0)
    this._timer = null
    this._busy = false
  }

  /**
   * 跑一轮判断。**纯逻辑，不发消息**（除非回调真的发了）。
   *
   * 单独抽出来是为了能测：给定状态和时间，判断结果必须可预测。
   *
   * @param {Date} [now]
   * @returns {{beg:boolean, speak:boolean, reason:string}}
   */
  plan(now = new Date()) {
    this.state.rollDay(now)
    const t = now.getTime()

    // ── 时段闸门：两个功能共用 ────────────────────────────────
    if (!inActiveHours(this.cfg.hours, now)) {
      return { beg: false, speak: false, reason: '不在允许的时段' }
    }

    // ── 讨钱 ──────────────────────────────────────────────────
    let wantBeg = false
    if (this.begCfg.enabled === true && this.checkBalance) {
      const interval = Math.max(1, Number(this.begCfg.checkIntervalMinutes ?? 60)) * 60_000
      const due = t - this.state.lastBalanceCheckAt >= interval
      const left = Math.max(0, Number(this.begCfg.maxPerDay ?? 3) - this.state.begCount)
      // 同一轮里不同时做两件事 —— 观感上会像刷屏
      if (due && left > 0) wantBeg = true
    }

    // ── 主动发言 ──────────────────────────────────────────────
    let wantSpeak = false
    if (this.cfg.enabled === true && this.onSpeak) {
      const idleNeed = Math.max(1, Number(this.cfg.idleMinutes ?? 45)) * 60_000
      const cooldown = Math.max(1, Number(this.cfg.cooldownMinutes ?? 180)) * 60_000
      const left = Math.max(0, Number(this.cfg.maxPerDay ?? 3) - this.state.speakCount)
      const quietEnough = this.idleMs() >= idleNeed
      const cooled = t - this.state.lastSpeakAt >= cooldown
      const hasScope = this.scopes().length > 0
      if (quietEnough && cooled && left > 0 && hasScope) wantSpeak = true
    }

    // 讨钱优先：它是「有实际用处的」；主动发言是锦上添花，让路。
    if (wantBeg) return { beg: true, speak: false, reason: '余额检查到期' }
    if (wantSpeak) return { beg: false, speak: true, reason: '群里安静够久了' }
    return { beg: false, speak: false, reason: '条件不满足' }
  }

  /** 执行一轮（plan + 真的去做）。 */
  async tick(now = new Date()) {
    if (this._busy) return
    this._busy = true
    try {
      const p = this.plan(now)
      if (p.beg) await this._doBeg(now)
      else if (p.speak) await this._doSpeak(now)
    } catch (e) {
      this.log.warn?.(`proactive：执行出错（忽略）— ${String(e?.message ?? e)}`)
    } finally {
      this._busy = false
    }
  }

  async _doBeg(now) {
    const t = now.getTime()
    this.state.lastBalanceCheckAt = t
    try {
      const low = await this.checkBalance()
      if (!low) {
        this.log.info?.('proactive：余额正常，不用讨')
        return
      }
      const ok = await this.onBeg()
      if (ok) {
        this.state.begCount += 1
        this.state.lastBegAt = t
      }
    } finally {
      this.state.save()
    }
  }

  async _doSpeak(now) {
    const t = now.getTime()
    const list = this.scopes()
    if (list.length === 0) return
    // 随机挑一个 —— 总挑第一个的话，第一个群会以为它在盯人
    const scope = list[Math.floor(Math.random() * list.length)]
    const ok = await this.onSpeak(scope)
    if (ok) {
      this.state.speakCount += 1
      this.state.lastSpeakAt = t
    }
    this.state.save()
  }

  /** 启动低频 tick。默认 60 秒一次 —— 够精确，也不费电。 */
  start(intervalMs = 60_000) {
    if (this._timer) return
    this._timer = setInterval(() => { void this.tick() }, intervalMs)
    // 不要因为这个定时器阻止进程退出
    this._timer.unref?.()
    this.log.info?.(`proactive：调度器已启动（每 ${Math.round(intervalMs / 1000)} 秒检查一次）`)
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
  }
}
