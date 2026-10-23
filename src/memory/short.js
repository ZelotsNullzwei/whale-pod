/**
 * 短期记忆：每个会话（群 / 私聊）一段环形上下文。
 *
 * 设计取舍：
 *   - **内存为主**：群聊上下文的价值随时间衰减，重启丢失可以接受；
 *     真正该持久化的是「长期摘要」（见 long.js），那是另一层。
 *   - **按会话隔离**：`group:123` 和 `private:456` 各有自己的窗口，
 *     绝不串味 —— 这是群聊机器人的基本礼仪。
 *   - **带上限**：条数 + 字符数双上限，防止大群把内存吃光，
 *     也防止把超长历史塞进 LLM 请求。
 */

/**
 * 一条消息。
 *
 * ⚠️ `provider` / `model` 是给**自己的回复**用的：往上送历史时，
 *    dsh-llm 要求 `role:'assistant'` 的消息必须带 `source`
 *    （{kind:'model', provider, model, replayState?}），否则它会
 *    读 `undefined.replayState` 直接抛错，整条请求失败。
 *    实测症状：私聊时好时坏 —— 历史里**有**自己说过的话就崩。
 */
export function makeMessage({
  id, sender, senderName, text, at, mentionsMe = false, isMe = false, images = [],
  provider = null, model = null, replyTo = null,
}) {
  return {
    id: String(id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    sender: String(sender ?? 'unknown'),
    senderName: String(senderName ?? sender ?? '群友'),
    text: String(text ?? ''),
    at: Number(at ?? Date.now()),
    mentionsMe: Boolean(mentionsMe),
    isMe: Boolean(isMe),
    images: Array.isArray(images) ? images : [],
    /** 这条回复是哪个渠道/模型生成的（仅 isMe 时有值） */
    provider: provider ?? null,
    model: model ?? null,
    /**
     * 这条消息**引用/回复**了哪条消息的 id（QQ 的引用回复）。
     *
     * 决策层靠它判断「这句话是在对我说，还是在跟别的群友说」——
     * 引用对象是别人时，第二人称指的就不是机器人（见 rule.js
     * `resolveAddressee`）。为 null 表示普通发言、没有引用。
     */
    replyTo: replyTo != null ? String(replyTo) : null,
  }
}

/**
 * 一个会话的短期记忆。
 */
export class ConversationMemory {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxMessages]  最多保留多少条
   * @param {number} [opts.maxChars]     文本总量上限
   * @param {number} [opts.maxAgeMs]     超过这个年龄的消息丢弃
   */
  constructor(opts = {}) {
    this.maxMessages = opts.maxMessages ?? 30
    this.maxChars = opts.maxChars ?? 12000
    this.maxAgeMs = opts.maxAgeMs ?? 6 * 3600_000
    /** @type {ReturnType<typeof makeMessage>[]} */
    this.messages = []
    /** 我上次发言的时间（ms）；没说过是 0 */
    this.myLastAt = 0
    /** 我连续发言的轮数 */
    this.consecutiveTurns = 0
    /** 自上次发言以来累积的他人消息数（用于判断「该不该接话」） */
    this.pendingSinceMyLast = 0
  }

  /** 追加一条消息。 */
  push(msg) {
    const m = makeMessage(msg)
    this.messages.push(m)
    if (m.isMe) {
      this.myLastAt = m.at
      this.consecutiveTurns++
      this.pendingSinceMyLast = 0
    } else {
      this.pendingSinceMyLast++
      // 注意：不在这里清零 consecutiveTurns —— 由 maybeCooldown() 按时间决定，
      // 否则别人插一句话就把我的"连说"状态抹掉，容易变成刷屏。
    }
    this._trim()
    return m
  }

  /**
   * 按时间推进"连续发言"状态：过了冷却期就重置。
   * 桥接层每轮调用一次。
   */
  tick(now = Date.now(), cooldownMs = 60000) {
    if (this.myLastAt > 0 && now - this.myLastAt > cooldownMs) {
      this.consecutiveTurns = 0
    }
  }

  /** 裁剪到上限。 */
  _trim() {
    const now = Date.now()
    // 年龄
    if (this.maxAgeMs > 0) {
      const cut = now - this.maxAgeMs
      let i = 0
      while (i < this.messages.length && this.messages[i].at < cut) i++
      if (i > 0) this.messages.splice(0, i)
    }
    // 条数
    if (this.messages.length > this.maxMessages) {
      this.messages.splice(0, this.messages.length - this.maxMessages)
    }
    // 字符数（从最旧的开始丢）
    let total = this.messages.reduce((n, m) => n + m.text.length, 0)
    while (total > this.maxChars && this.messages.length > 1) {
      const dropped = this.messages.shift()
      total -= dropped.text.length
    }
  }

  /** 最近 n 条（默认全部）。 */
  recent(n) {
    return n == null ? [...this.messages] : this.messages.slice(-n)
  }

  /** 距我上次发言多久（ms）；没说过返回 Infinity。 */
  sinceMyLast(now = Date.now()) {
    return this.myLastAt > 0 ? now - this.myLastAt : Infinity
  }

  /** 清空。 */
  clear() {
    this.messages = []
    this.myLastAt = 0
    this.consecutiveTurns = 0
    this.pendingSinceMyLast = 0
  }

  /** 导出成决策层要的 DecisionInput 片段。 */
  toDecisionInput(scene, self, now = Date.now()) {
    return {
      messages: this.recent(),
      self,
      scene,
      sinceMyLastMessage: this.sinceMyLast(now),
      consecutiveTurns: this.consecutiveTurns,
      now,
    }
  }
}

/**
 * 记忆管理器：按会话 id 维护多个 ConversationMemory。
 */
export class MemoryStore {
  /**
   * @param {object} [opts]
   * @param {object} [opts.short]  memory.short 配置
   * @param {number} [opts.maxSessions] 最多同时保留多少个会话（LRU 淘汰）
   */
  constructor(opts = {}) {
    this.shortCfg = opts.short ?? {}
    this.maxSessions = opts.maxSessions ?? 200
    /** @type {Map<string, ConversationMemory>} */
    this.sessions = new Map()
    /** 会话作用域 -> 最近活跃时间 */
    this._lru = new Map()
  }

  /**
   * @param {string} scope  形如 'group:123' / 'private:456'
   */
  get(scope) {
    let m = this.sessions.get(scope)
    if (!m) {
      m = new ConversationMemory({
        maxMessages: this.shortCfg.maxMessages,
        maxChars: this.shortCfg.maxChars,
        maxAgeMs: this.shortCfg.maxAgeMs,
      })
      this.sessions.set(scope, m)
    }
    this._lru.set(scope, Date.now())
    this._evict()
    return m
  }

  _evict() {
    if (this.sessions.size <= this.maxSessions) return
    // 按 LRU 时间淘汰最旧的
    const sorted = [...this._lru.entries()].sort((a, b) => a[1] - b[1])
    const drop = sorted.slice(0, this.sessions.size - this.maxSessions)
    for (const [scope] of drop) {
      this.sessions.delete(scope)
      this._lru.delete(scope)
    }
  }

  /** 所有活跃会话 id。 */
  scopes() {
    return [...this.sessions.keys()]
  }

  /** 汇总统计（供 Web UI）。 */
  stats() {
    let totalMessages = 0
    for (const m of this.sessions.values()) totalMessages += m.messages.length
    return {
      sessions: this.sessions.size,
      totalMessages,
      maxSessions: this.maxSessions,
    }
  }

  clear(scope) {
    if (scope) this.sessions.delete(scope)
    else this.sessions.clear()
  }
}
