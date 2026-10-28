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
    /*
     * 每日主动发言次数 —— **群聊和私聊分开算**（2026-10-27 用户要求）。
     *
     * 原来是一个全局 `speakCount`，群和私聊共用 maxPerDay（3 次）。
     * 问题：它早上在群里冒过两次泡，下午想找你时额度已经用完了 ——
     * 而这两个场景根本不是一回事：
     *   · 群里冒泡是「维持存在感」，额度该小一点
     *   · 私聊找你是「主动联系熟人」，不该被群聊的消耗挤掉
     *
     * 所以拆成两份各自计数、各自封顶 3 次。
     */
    this.speakCountGroup = 0
    this.speakCountPrivate = 0
    /** 旧字段名，只为了读老 state.json 时迁移，见构造函数里的反序列化 */
    this.speakCount = 0
    /** 这两个计数属于哪一天 */
    this.day = dayKey()
    /** 上次讨钱的时间戳 */
    this.lastBegAt = 0
    /*
     * 上次主动发言的时间戳 —— **群聊和私聊分开记**（2026-10-28 修）。
     *
     * 原来是一个全局 `lastSpeakAt` + 统一的 cooldown（3 小时）。
     * 后果：**私聊主动说了一次，群里就 3 小时开不了口**。
     * 实测：11:44 私聊主动发言 → 群里到 14:44 一直「冷却中」，
     *       用户报「群里的主动发言还是没有触发」。
     *
     * 群冒泡和私聊找人本来就该分开计时。
     */
    this.lastSpeakAtGroup = 0
    this.lastSpeakAtPrivate = 0
    /** 老字段，只用于读旧 state 时迁移 */
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
    if (Number.isFinite(d?.speakCountGroup)) this.speakCountGroup = d.speakCountGroup
    if (Number.isFinite(d?.speakCountPrivate)) this.speakCountPrivate = d.speakCountPrivate
    /*
     * ⚠️ 向后兼容：老 state.json 只有一个 `speakCount`，分不清群还是私聊。
     *
     * 保守做法 —— 把它算进**群**：
     *   · 群额度本来就更容易用完，算错方向影响小
     *   · 反过来把未知消耗算到私聊，会让「主动找你」在升级当天就失效
     */
    if (Number.isFinite(d?.speakCount) && !Number.isFinite(d?.speakCountGroup)) {
      this.speakCountGroup = d.speakCount
    }
    this.speakCount = this.speakCountGroup + this.speakCountPrivate
      if (typeof d?.day === 'string') this.day = d.day
      if (Number.isFinite(d?.lastBegAt)) this.lastBegAt = d.lastBegAt
      if (Number.isFinite(d?.lastSpeakAtGroup)) this.lastSpeakAtGroup = d.lastSpeakAtGroup
      if (Number.isFinite(d?.lastSpeakAtPrivate)) this.lastSpeakAtPrivate = d.lastSpeakAtPrivate
      /*
       * ⚠️ 老 state 只有一个 `lastSpeakAt`，分不清是哪一类。
       *
       * 迁移策略：**算进群**（和 speakCount 的迁移方向一致 —— 群更容易被卡住，
       * 宁可让群多等一会儿，也不要把「主动找你」立刻放开导致重复说话）。
       * 这次的真实数据里 11:44 那次其实是私聊，但代码没法从旧字段反推；
       * 错判方向是「更保守」，安全。
       */
      if (Number.isFinite(d?.lastSpeakAt) && !Number.isFinite(d?.lastSpeakAtGroup)) {
        this.lastSpeakAtGroup = d.lastSpeakAt
      }
      this.lastSpeakAt = Math.max(this.lastSpeakAtGroup, this.lastSpeakAtPrivate)
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
      speakCountGroup: this.speakCountGroup,
      speakCountPrivate: this.speakCountPrivate,
        lastBegAt: this.lastBegAt,
        lastSpeakAtGroup: this.lastSpeakAtGroup,
        lastSpeakAtPrivate: this.lastSpeakAtPrivate,
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
    this.speakCountGroup = 0
    this.speakCountPrivate = 0
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
    /*
     * ⚠️ 不要在这里把配置**拷贝**下来。
     *
     * `bridge.cfg` 是启动时的快照，而设置页的热更新只推部分字段
     * （allow/model/maxTokens/effort/reply），`proactive` 和 `beg` 不在其中。
     * 更关键的是：如果这里 `this.cfg = opts.cfg` 存的是「值」而不是
     * 「取配置的函数」，那么即使热更新推了，调度器看到的还是旧值。
     *
     * 所以这里存的是 **getter**，每轮 plan 时现取。
     */
    this._cfgSrc = typeof opts.cfgSource === 'function' ? opts.cfgSource : () => (opts.cfg ?? {})
    this._begCfgSrc = typeof opts.begCfgSource === 'function' ? opts.begCfgSource : () => (opts.begCfg ?? {})
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

  /** 实时读 proactive 配置（每次现取，不吃启动快照）。 */
  get cfg() { return this._cfgSrc() ?? {} }

  /** 实时读 beg 配置。 */
  get begCfg() { return this._begCfgSrc() ?? {} }

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
      /*
       * ⚠️ 额度和冷却都按**类别**算（群/私聊各 3 次、各 3 小时冷却）。
       *    `usableScopes` 已同时过滤「还有额度」和「不在冷却」，
       *    所以这里不再单独判全局 cooled —— 那正是
       *    「私聊说一次、群里哑三小时」的元凶。
       */
      const usable = this.usableScopes(t)
      const quietEnough = this.idleMs() >= idleNeed
      if (quietEnough && usable.length > 0) wantSpeak = true
    }

    // 讨钱优先：它是「有实际用处的」；主动发言是锦上添花，让路。
    if (wantBeg) return { beg: true, speak: false, reason: '余额检查到期' }
    if (wantSpeak) return { beg: false, speak: true, reason: '群里安静够久了' }

    /*
     * 都不满足时，把每一项的实际值打进 reason ——
     * 只说「条件不满足」的话，排查得靠猜，而猜错过好几次。
     */
    const sp = this.planSpeak(now)
    const begWhy = this.begCfg.enabled !== true
      ? '讨钱未开启'
      : (!this.checkBalance ? '没注入查余额' : `讨钱：${Math.round((t - this.state.lastBalanceCheckAt) / 60_000)} 分钟前查过`)
    return { beg: false, speak: false, reason: `${begWhy}；发言：${sp.reason}` }
  }

  /** 执行一轮（plan + 真的去做）。 */
  async tick(now = new Date()) {
    if (this._busy) return
    this._busy = true
    try {
      const p = this.plan(now)
      // 每轮都留一行判断结果 —— 不打印的话「为什么没触发」只能靠猜。
      // 用 info 而不是 debug：默认日志级别会把 debug 过滤掉。
      this.log.info?.(`proactive：plan → ${p.reason}`)
      if (p.beg) {
        const didBeg = await this._doBeg(now)
        /*
         * 讨钱没做成（余额查不到 / 余额正常 / 没有白名单群）时，
         * **同一轮里让发言顶上** —— 否则每次到点都先跑讨钱，
         * 而讨钱因为没配 searchKey 必然失败，发言就永远轮不到。
         */
        if (!didBeg && this.cfg.enabled === true && this.onSpeak) {
          const sp = this.planSpeak(now)
          if (sp.ok) await this._doSpeak(now)
        }
      } else if (p.speak) {
        await this._doSpeak(now)
      }
    } catch (e) {
      this.log.warn?.(`proactive：执行出错（忽略）— ${String(e?.message ?? e)}`)
    } finally {
      this._busy = false
    }
  }

  /**
   * 某类会话今天还能说几次。
   *
   * @param {'group'|'private'} kind
   * @returns {number}
   */
  speakLeft(kind) {
    const max = Math.max(0, Number(this.cfg.maxPerDay ?? 3))
    const used = kind === 'private' ? this.state.speakCountPrivate : this.state.speakCountGroup
    return Math.max(0, max - used)
  }

  /**
   * 会话是群还是私聊。
   *
   * ⚠️ **`scopes()` 返回的是字符串**（`group:123` / `private:456`），不是对象！
   *    原来这里写 `s.kind === 'private'` —— 字符串上没有 `kind`，恒为 undefined，
   *    于是**一切都当群处理**：
   *      · 私聊主动发言被记进 `speakCountGroup`
   *      · 群额度用完时，连私聊会话也被过滤掉
   *    实测症状：`speakCountGroup=1 / speakCountPrivate=0`，而那次其实是私聊。
   *
   * @param {string} scope
   * @returns {'group'|'private'}
   */
  kindOf(scope) {
    return String(scope ?? '').startsWith('private:') ? 'private' : 'group'
  }

  /** 某类上次主动发言的时间戳。 */
  lastSpeakAtOf(kind) {
    return kind === 'private' ? this.state.lastSpeakAtPrivate : this.state.lastSpeakAtGroup
  }

  /** 某类是否已经过了冷却（按类别各算各的）。 */
  isCooled(kind, t) {
    const cooldown = Math.max(1, Number(this.cfg.cooldownMinutes ?? 180)) * 60_000
    return t - this.lastSpeakAtOf(kind) >= cooldown
  }

  /**
   * 现在真的能说话的会话（**额度 + 冷却都满足**）。
   *
   * ⚠️ 必须按**具体会话**判断，不能只看「还有没有额度」——
   *    否则会出现「群额度用完了、说没有会话可发」但它其实还能找你。
   *
   * @param {number} [t] 当前时间戳
   * @returns {Array<string>} 过滤后的 scope 列表（字符串）
   */
  usableScopes(t = Date.now()) {
    return this.scopes().filter((s) => {
      const k = this.kindOf(s)
      return this.speakLeft(k) > 0 && this.isCooled(k, t)
    })
  }

  /**
   * 只看额度的过滤（不含冷却）。保留给测试和老调用方。
   *
   * @returns {Array<string>}
   */
  scopesWithQuota() {
    return this.scopes().filter((s) => this.speakLeft(this.kindOf(s)) > 0)
  }

  /**
   * 单独判断「现在能不能发言」。
   *
   * 抽出来是为了在讨钱失败时复用 —— 否则那段条件得写两遍。
   *
   * @param {Date} now
   * @returns {{ok:boolean, reason:string}}
   */
  planSpeak(now = new Date()) {
    const t = now.getTime()
    if (this.cfg.enabled !== true || !this.onSpeak) return { ok: false, reason: '发言未开启' }
    if (!inActiveHours(this.cfg.hours, now)) return { ok: false, reason: '不在时段' }
    const idleNeed = Math.max(1, Number(this.cfg.idleMinutes ?? 45)) * 60_000
    const usable = this.usableScopes(t)
    if (usable.length === 0) {
      /*
       * 分开报数 —— 只说「今日已说满」会让人以为两类都用完了。
       * 同时把「额度」和「冷却」两件事都说清楚，排查才不用猜。
       */
      const g = this.speakLeft('group')
      const p2 = this.speakLeft('private')
      const gTxt = g > 0 ? (this.isCooled('group', t) ? '可发' : '冷却中') : '已满'
      const pTxt = p2 > 0 ? (this.isCooled('private', t) ? '可发' : '冷却中') : '已满'
      return { ok: false, reason: `没有可用会话（群：剩 ${g} ${gTxt} / 私聊：剩 ${p2} ${pTxt}）` }
    }
    const idle = this.idleMs()
    const idleMin = idle === Infinity ? '∞' : Math.round(idle / 60_000)
    if (!(idle >= idleNeed)) {
      // 「还不够安静」必须带数字 —— 不说数值等于没说，排查只能靠猜。
      return {
        ok: false,
        reason: `还不够安静（静默 ${idleMin} 分钟 / 需要 ${Math.round(idleNeed / 60_000)}）`,
      }
    }
    return {
      ok: true,
      reason: `可以发言（静默 ${idleMin} 分钟，${usable.length} 个会话还有额度）`,
    }
  }

  /**
   * 跑一次讨钱。
   *
   * @param {Date} now
   * @returns {Promise<boolean>} 真的发出去了才 true
   */
  async _doBeg(now) {
    const t = now.getTime()
    this.state.lastBalanceCheckAt = t
    try {
      const low = await this.checkBalance()
      if (!low) {
        this.log.info?.('proactive：余额正常或查不到，不用讨')
        return false
      }
      const ok = await this.onBeg()
      if (ok) {
        this.state.begCount += 1
        this.state.lastBegAt = t
        return true
      }
      return false
    } finally {
      this.state.save()
    }
  }

  async _doSpeak(now) {
    const t = now.getTime()
    /*
     * 只从**还有额度**的会话里挑（群/私聊各算各的）。
     *
     * 随机挑是为了不让第一个群觉得它在盯人；但随机范围要先按额度过滤，
     * 否则会挑到「这一类今天已经说满」的会话，发出去就超了。
     */
    const list = this.usableScopes(t)
    if (list.length === 0) return
    const scope = list[Math.floor(Math.random() * list.length)]
    const kind = this.kindOf(scope)
    const ok = await this.onSpeak(scope)
    if (ok) {
      // 按**实际**发到哪一类来计数（scope 是字符串，必须用 kindOf 解析）
      if (kind === 'private') {
        this.state.speakCountPrivate += 1
        this.state.lastSpeakAtPrivate = t
      } else {
        this.state.speakCountGroup += 1
        this.state.lastSpeakAtGroup = t
      }
      this.state.speakCount = this.state.speakCountGroup + this.state.speakCountPrivate
      this.state.lastSpeakAt = Math.max(this.state.lastSpeakAtGroup, this.state.lastSpeakAtPrivate)
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
