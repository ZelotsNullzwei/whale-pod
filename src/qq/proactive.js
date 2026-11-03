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
 * 主动发言后，等多久来判断「有人接没接」（2026-10-31 加）。
 *
 * 30 分钟：太短会把"对方在忙"误判成"没人理"；太长则反馈太迟。
 */
const ACK_WINDOW_MS = 30 * 60_000

/**
 * 多久之内有人说过话，就算「场子活了」—— 顺手清掉"碰壁"计数。
 * 5 分钟够用：真人不会在 5 分钟内连续吃两次闭门羹。
 */
const FRESH_ACK_MS = 5 * 60_000

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
    /*
     * 「说了没人接」的连续次数（2026-10-31 加，参考麦麦的 idle_backoff）。
     *
     * ## 为什么要它
     * 原来的主动发言是**纯定时**：安静够 45 分钟就开口，一天 3 次配额
     * 用完为止。结果是「到点就必须说一句」—— 而真人不是这样：
     * **真人说了一句没人接，第二次就不太想说了。**
     *
     * ## 判定
     * 主动发言后开一个 30 分钟的观察窗：
     *   · 窗内有人说话 → 说明有人接 → streak 归零
     *   · 窗内没人说话 → streak + 1
     * `streak >= 2` 时**当天不再主动开口** —— 连说两次都没人理，还说什么？
     *
     * 这是"最像人"的那一维：**不是越闲越想说话，是没人理就更不想说。**
     */
    this.ignoredStreakGroup = 0
    this.ignoredStreakPrivate = 0
    /** 刚说完、还在观察窗里（等到点再结算，避免重复计） */
    this.pendingAckGroup = false
    this.pendingAckPrivate = false
    /*
     * 下一次**最早**什么时候可以说 —— 发言时**掷一次随机**定下来（2026-10-31 加）。
     *
     * ## 为什么不留固定冷却
     * 用户原话：「定时发言就不要了，改成随机发言？群里和私聊都是」。
     *
     * 固定的 `cooldownMinutes: 180` 意味着"每天差不多同样的时刻冒泡"，
     * 很机械。现在改成 `cooldownMinutes ~ cooldownMinutes + cooldownJitterMinutes`
     * 之间**均匀随机**（默认 180 ~ 300 分钟）。
     *
     * ⚠️ **只在发言后掷一次**并存下来 —— 不能每个 tick 重掷，
     *    否则就变成"每次 tick 都有概率"（累积概率暴涨，又回到"到点必说"）。
     */
    this.nextSpeakAtGroup = 0
    this.nextSpeakAtPrivate = 0
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
      // 「说了没人接」的连续计数（2026-10-31 加）
      if (Number.isFinite(d?.ignoredStreakGroup)) this.ignoredStreakGroup = d.ignoredStreakGroup
      if (Number.isFinite(d?.ignoredStreakPrivate)) this.ignoredStreakPrivate = d.ignoredStreakPrivate
      if (d?.pendingAckGroup === true) this.pendingAckGroup = true
      if (d?.pendingAckPrivate === true) this.pendingAckPrivate = true
      // 随机冷却的下次可发言时间（2026-10-31 加）
      if (Number.isFinite(d?.nextSpeakAtGroup)) this.nextSpeakAtGroup = d.nextSpeakAtGroup
      if (Number.isFinite(d?.nextSpeakAtPrivate)) this.nextSpeakAtPrivate = d.nextSpeakAtPrivate
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
        // 「说了没人接」的连续计数（2026-10-31 加）
        ignoredStreakGroup: this.ignoredStreakGroup,
        ignoredStreakPrivate: this.ignoredStreakPrivate,
        pendingAckGroup: this.pendingAckGroup,
        pendingAckPrivate: this.pendingAckPrivate,
        // 随机冷却的下次可发言时间（2026-10-31 加）
        nextSpeakAtGroup: this.nextSpeakAtGroup,
        nextSpeakAtPrivate: this.nextSpeakAtPrivate,
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
    /*
     * ★ **按会话的静默**（2026-11-03 加）。
     *
     * 上面那个 `idleMs()` 是**候选会话里最长的静默** —— 于是
     * 「群安静 3 小时、私聊 2 分钟前还在聊」也算"够安静"，
     * 而 `_doSpeak` 接着**随机挑一个会话**开口，就可能挑中**刚聊过天的那个**。
     *
     * 实测现场（2026-11-03 22:32）：日志写「plan → 群里安静够久了」，
     * 真正发出去的却是**私聊**（那个会话几分钟前才说过话）——
     * 用户报「自动发言没生效」，这就是其中一个原因：群里等不到，私聊还被插话。
     *
     * 没注入就退回全局值 —— 老调用点/老测试的行为完全不变。
     */
    this.idleMsOf = opts.idleMsOf ?? (() => this.idleMs())
    /** 随机源（测试可注入，保证"随机冷却"可复现） */
    this._random = opts.random ?? Math.random
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
  /**
   * 结算「上一次主动发言有没有人接」（2026-10-31 加）。
   *
   * ## 为什么需要
   * 主动发言原来是纯定时的 —— "安静够了就开口"。结果是**到点必须说**，
   * 哪怕说了根本没人理，下一次照旧说。真人不是这样：
   * **说了一句没人接，第二次就不太想说了。**
   *
   * ## 判定
   * 发言后开一个 {@link ACK_WINDOW_MS} 的观察窗：
   *   · 窗内有人说话 → `streak = 0`（有人接，正常）
   *   · 窗内没人说话 → `streak += 1`
   * `streak >= 2` 时 {@link plan} 会当天闭嘴（"连着两次没人理，还说什么"）。
   *
   * `idleMs()` = 「距上次有人说话多久」。所以：
   *   · 发言后有人说过话 → `idleMs() < 距发言的时间`
   *   · 发言后一直没人说 → `idleMs() >= 距发言的时间`
   *
   * 另外：只要有人刚说过话（`idleMs` 很小），就顺手把 streak 清掉 ——
   * 场子活了，它的"碰壁感"也该消。
   *
   * @param {Date} [now]
   */
  settleAck(now = new Date()) {
    const t = now.getTime()
    const idle = this.idleMs()
    /*
     * ⚠️ 这些字段都在 **`this.state`** 上，不在调度器自己身上。
     *    第一版写成 `this.pendingAckGroup` → 恒 undefined → 整个结算
     *    静默不生效（探针里 streak 一直是 0，就是它）。
     */
    const st = this.state

    // 有人刚说过话 → 场子活了，把碰壁感清掉
    if (idle < FRESH_ACK_MS) {
      if (st.ignoredStreakGroup > 0) st.ignoredStreakGroup = 0
      if (st.ignoredStreakPrivate > 0) st.ignoredStreakPrivate = 0
    }

    for (const kind of ['Group', 'Private']) {
      const pendKey = `pendingAck${kind}`
      const streakKey = `ignoredStreak${kind}`
      const atKey = `lastSpeakAt${kind}`
      if (st[pendKey] !== true) continue
      const spokeAt = Number(st[atKey] ?? 0)
      if (!spokeAt) { st[pendKey] = false; continue }
      // 观察窗还没结束 —— 再等等
      if (t - spokeAt < ACK_WINDOW_MS) continue
      if (idle < t - spokeAt) {
        st[streakKey] = 0
      } else {
        st[streakKey] += 1
        this.log.info?.(
          `proactive：${kind === 'Group' ? '群' : '私聊'}上次主动发言 ${Math.round((t - spokeAt) / 60_000)} 分钟没人接`
          + ` → 连续 ${st[streakKey]} 次`,
        )
      }
      st[pendKey] = false
    }
  }

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
    /** 真要发言时用它解释「是哪儿安静了」—— 按**实际**候选会话算，不写死"群里"。 */
    let speakWhy = ''
    if (this.cfg.enabled === true && this.onSpeak) {
      // ★ 先结算「上一次主动发言有没有人接」
      this.settleAck(now)
      /*
       * ⚠️ 额度和冷却都按**类别**算（群/私聊各 3 次、各 3 小时冷却）。
       *    `usableScopes` 已同时过滤「还有额度」和「不在冷却」，
       *    所以这里不再单独判全局 cooled —— 那正是
       *    「私聊说一次、群里哑三小时」的元凶。
       */
      /*
       * ⚠️ 2026-11-03：这里从 `usableScopes` 换成 `speakableScopes` ——
       *    静默必须**按会话**算。原来门槛用全局「最长静默」（群静 3 小时就算过），
       *    而 `_doSpeak` 随机挑会话，于是会挑中**刚聊过天**的那个去开口；
       *    群的静默反而不保证轮得到它。详情见 `speakableScopes` 的注释。
       */
      const speakable = this.speakableScopes(t)
      /*
       * ★ 「说了没人接，就别再说了」（2026-10-31 加）。
       *
       * 原来的逻辑是纯定时：安静够 45 分钟就开口，3 次配额用完为止 ——
       * **"到点必须说"**。而真人不是：说了一句没人接，第二次就不太想说了。
       *
       * 连续 2 次主动发言的观察窗里都没人接 → 当天不再主动开口。
       * 只要有人说话了（idleMs 归零过），streak 会自动清掉。
       */
      const muted = this.state.ignoredStreakGroup >= 2
      if (speakable.length > 0 && !muted) {
        wantSpeak = true
        /*
         * 标签要**老实说**是哪个会话安静了。
         *
         * 原来这里写死「群里安静够久了」，而真正发到哪是 `_doSpeak` 随机挑的 ——
         * 2026-11-03 22:32 的日志就是这么骗人的：写着"群里"，发给了私聊。
         * 看日志的人（包括我）会据此以为群那条链路坏了。
         */
        const kinds = new Set(speakable.map((s) => this.kindOf(s)))
        speakWhy = kinds.size > 1
          ? '会话都安静够久了'
          : (kinds.has('group') ? '群里安静够久了' : '私聊安静够久了')
      }
    }

    // 讨钱优先：它是「有实际用处的」；主动发言是锦上添花，让路。
    if (wantBeg) return { beg: true, speak: false, reason: '余额检查到期' }
    if (wantSpeak) return { beg: false, speak: true, reason: speakWhy || '安静够久了' }

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

  /** 某类"下次最早什么时候可以说"（发言时掷的随机冷却；0 = 还没掷过）。 */
  nextSpeakAtOf(kind) {
    return kind === 'private' ? this.state.nextSpeakAtPrivate : this.state.nextSpeakAtGroup
  }

  /**
   * 「这一 tick 要不要冒泡」—— **掷骰子，不看冷却**。
   *
   * ## 2026-11-02：随机**间隔** → 全随机
   *
   * 用户原话：「之前不是说取消冷却器吗」「改成全随机发言」。
   *
   * 之前是**发言后掷一次间隔**（180~300 分钟）存进 `nextSpeakAt*`，
   * 到点才允许说。但那仍然是"到点必说"的**定时器**，只是把固定周期
   * 换成了随机周期 —— 观感还是机械，日志里整天刷「冷却中」，
   * 实测她自己几乎冒不出来（一直卡在群剩 2 / 私聊剩 2 冷却中）。
   *
   * 现在：**每一 tick 独立掷一次**，概率 `speakChance`。
   * 默认 0.004、tick 60 秒 → 期望约每 4 小时一次；
   * 白天窗口 15 小时 ≈ 3.6 次/天（还有 maxPerDay 兜底）。
   * 嫌少就调大（0.01 ≈ 每 100 分钟期望一次）。
   *
   * ## ⚠️ 同一 tick 内**只掷一次**（这是关键，不是优化）
   *
   * `usableScopes()` 在一轮里会被调用好几次（`planSpeak` 一次、
   * `_doSpeak` 再一次、日志文案里还有）。如果每次调用都重掷，
   * 一轮的实际概率就是 `1-(1-p)^n` —— **累积暴涨，又变回"到点必说"**。
   * 旧的冷却写法正是为了躲这个才"掷一次存下来"。
   *
   * 所以这里按 **60 秒桶**缓存结果：同一个 tick 内怎么问都是同一个答案。
   *
   * @param {number} [t] 当前时间戳
   * @returns {boolean}
   */
  maySpeakNow(t = Date.now()) {
    const p = Number(this.cfg.speakChance ?? 0.004)
    if (!(p > 0)) return false
    if (p >= 1) return true
    // 同一 tick（60 秒桶）只掷一次
    const bucket = Math.floor(t / 60_000)
    if (this._rollBucket === bucket) return this._rollResult === true
    const rnd = (this._random ?? Math.random)()
    this._rollBucket = bucket
    this._rollResult = rnd < p
    return this._rollResult
  }

  /**
   * 现在真的能说话的会话（**额度 + 这一 tick 掷中**）。
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
      return this.speakLeft(k) > 0 && this.maySpeakNow(t)
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

  /** 单个会话的静默，写成给日志看的人话（`∞` = 真的不知道多久没说话）。 */
  idleTextOf(scope) {
    const i = this.idleMsOf(scope)
    return i === Infinity ? '∞' : `${Math.round(i / 60_000)}分`
  }

  /** 这个会话**自己**安静够久了吗（拿它自己的静默比门槛）。 */
  quietScope(scope, idleNeed) {
    const idle = this.idleMsOf(scope)
    return idle === Infinity || idle >= idleNeed
  }

  /**
   * 真的能开口的会话：**额度 + 这一 tick 掷中 + 这个会话自己安静够久**。
   *
   * ## 为什么静默必须按会话算（2026-11-03）
   * 事故：22:32 日志写「plan → 群里安静够久了」，实际发到了**私聊**。
   * 因为门槛用的是全局「最长静默」（群静了 3 小时就算过），而选场是**随机**抽的。
   * 两个口径不一致，两个方向都出问题：
   *   · 抽中**刚聊过天的会话** → 打断人家正说着的话（就是用户说的"乱接"）
   *   · 群明明最安静，却被抽到私聊 → 群里永远等不到她开口
   *   用户报「自动发言感觉没生效」，这就是其中一半。
   *
   * 所以静默也按会话各算各的：**不安静的会话不进候选**。
   *
   * @param {number} [t]
   * @returns {Array<string>}
   */
  speakableScopes(t = Date.now()) {
    const idleNeed = Math.max(1, Number(this.cfg.idleMinutes ?? 45)) * 60_000
    return this.usableScopes(t).filter((s) => this.quietScope(s, idleNeed))
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
    /*
     * ★ **三道闸门无条件分开报**（2026-11-03 修）。
     *
     * ## 原来为什么看不出来
     * 老写法是"先判额度+骰子，不中就 return" —— 于是日志里 684 行全是
     * 同一句「没有可用会话（群：剩 3 等骰子(0.004) / 私聊：剩 3 等骰子(0.004)）」，
     * **静默状态根本不打印**（静默那一判在它后面，永远走不到）。
     *
     * 用户报「自动发言感觉没生效」时，光看日志分不清撞的是哪一道：
     *   ① 今天说满了（没额度）  ② 这一 tick 没掷中（骰子）  ③ 这个会话还不够安静
     * 我这次实际排查只能去翻 `proactive.json` + 反推概率 —— 这就是要修的病。
     * （和这里原来那条 `⚠️ 分开报数 / 不说数值等于没说` 是同一条原则，只是当时没做全。）
     */
    const p = Number(this.cfg.speakChance ?? 0.004)
    const g = this.speakLeft('group')
    const p2 = this.speakLeft('private')
    const gTxt = g > 0 ? `剩 ${g} 等骰子(${p})` : '剩 0 已满'
    const pTxt = p2 > 0 ? `剩 ${p2} 等骰子(${p})` : '剩 0 已满'
    const all = this.scopes()
    const hit = this.usableScopes(t)                  // 额度 + 骰子
    const idleTxt = all.length === 0
      ? '没有候选会话'
      : all.map((s) => `${this.kindOf(s) === 'group' ? '群' : '私聊'}=${this.idleTextOf(s)}`).join(' ')
    const detail = `群：${gTxt} / 私聊：${pTxt}`
      + `；这一 tick ${hit.length ? `掷中了 ${hit.length} 个` : '没掷中'}`
      + `；静默 ${idleTxt}（需要 ${Math.round(idleNeed / 60_000)} 分）`

    const speakable = this.speakableScopes(t)         // 再加"它自己安静够久"
    if (speakable.length === 0) return { ok: false, reason: `发言没到时机（${detail}）` }
    return {
      ok: true,
      reason: `可以发言（${speakable.length} 个会话能开口；${detail}）`,
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
     * 只从**这个会话自己安静够久**的候选里挑（2026-11-03 改）。
     *
     * ⚠️ 原来用的是 `usableScopes`（只过滤额度 + 骰子），于是可能挑中
     * **刚刚还在聊天**的会话去开口 —— 因为门槛判的是全局「最长静默」，
     * 两处口径不一致。用户报的"乱接"和"群里等不到她开口"都出在这。
     * 详见 `speakableScopes` 的注释。
     *
     * 注意：`speakableScopes` 内部已经把**额度**过滤过了
     * （群/私聊各算各的，见 `speakLeft`），所以不会超发。
     */
    const list = this.speakableScopes(t)
    if (list.length === 0) return
    const scope = list[Math.floor(Math.random() * list.length)]
    const kind = this.kindOf(scope)
    const ok = await this.onSpeak(scope)
    if (ok) {
      /*
       * ⚠️ **这里原来会掷一次"下次最早可发言时间"**（cooldownMinutes ~ +jitter）。
       *
       * 2026-11-02 去掉了 —— 改成「每 tick 独立掷骰子」（见 `maySpeakNow`）。
       * 冷却器的问题是它仍然是"攒够时间必然说"，只是周期随机；
       * 而现在没有"必然说"这回事，也就不需要记 nextSpeakAt 了。
       *
       * `nextSpeakAtGroup/Private` 这两个 state 字段**保留不写**：
       * 老 state 文件里还有值，读出来也没人看了（`nextSpeakAtOf` 还在，
       * 但只给老数据/日志用），不迁移、不清空 —— 免得动到用户的存档。
       */
      // 按**实际**发到哪一类来计数（scope 是字符串，必须用 kindOf 解析）
      if (kind === 'private') {
        this.state.speakCountPrivate += 1
        this.state.lastSpeakAtPrivate = t
        // ★ 开观察窗：30 分钟后结算"有没有人接"
        this.state.pendingAckPrivate = true
      } else {
        this.state.speakCountGroup += 1
        this.state.lastSpeakAtGroup = t
        this.state.pendingAckGroup = true
      }
      this.log.info?.(
        `proactive：说了（${kind === 'private' ? '私聊' : '群'}）`
        + `—— 下一 tick 重新掷（概率 ${Number(this.cfg.speakChance ?? 0.004)}）`,
      )
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
