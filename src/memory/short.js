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

import fs from 'node:fs'
import path from 'node:path'

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
    /**
     * **累计**推入过的消息总数（单调递增，不随裁剪回退）。
     *
     * ## 为什么需要它（2026-10-23 修）
     *
     * 长期记忆原来用 `msgs.length` 当「累计条数」：
     *
     *   unsummarized = msgs.length - summarizedCount
     *
     * 但 `msgs` 是**滑动窗口**，`_trim()` 会按条数/字符/年龄裁剪。
     * 于是窗口一满（`maxMessages = 30`），`msgs.length` 恒等于 30，
     * `summarizedCount` 也变成 30，`unsummarized` **永远为 0** ——
     * 摘要只可能发生一次，之后再也不触发。
     *
     * 实测表现：`memory-long.json` 从未生成，用户反馈「记忆没生效」。
     *
     * 现在改用这个单调计数器算「新增了多少条」，窗口怎么滚都不影响。
     */
    this.totalPushed = 0
  }

  /** 追加一条消息。 */
  push(msg) {
    const m = makeMessage(msg)
    this.messages.push(m)
    this.totalPushed++
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
    // 通知宿主「有变化，该落盘了」（由 MemoryStore 挂上，见 get()）
    this.onChange?.()
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
  /**
   * 距**最后一条消息**（不管谁说的）过了多久。
   *
   * 和 sinceMyLast（距我上次发言）不同：这个衡量「群里安静了多久」，
   * 主动发言靠它判断该不该冒泡。没有任何消息时返回 Infinity。
   *
   * @param {number} [now]
   * @returns {number}
   */
  sinceLastMessage(now = Date.now()) {
    const last = this.messages[this.messages.length - 1]
    if (!last) return Infinity
    const at = Number(last.at)
    return Number.isFinite(at) ? Math.max(0, now - at) : Infinity
  }

  sinceMyLast(now = Date.now()) {
    return this.myLastAt > 0 ? now - this.myLastAt : Infinity
  }

  /** 清空。 */
  clear() {
    this.messages = []
    this.myLastAt = 0
    this.consecutiveTurns = 0
    this.pendingSinceMyLast = 0
    /**
     * ⚠️ 累计计数也要归零（2026-10-23）。
     *
     * `clear()` 的语义是「这个会话从头开始」——比如用户手动清空记忆。
     * 如果 `totalPushed` 不清零，而长期记忆那边的 `summarizedTotal` 还留着
     * 旧值（或者反过来），两边的基准就错位了：
     * 要么永远算不出增量、要么一上来就误判「攒够了该摘要」。
     *
     * 注意：**长期记忆的 `summarizedTotal` 不会自动跟着归零**
     * （它在另一个对象里）。`clear()` 只负责短期窗口这一侧，
     * 调用方如果要彻底重置，应该同时清长期记忆（`LongTermStore.clear`）。
     */
    this.totalPushed = 0
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
    this.log = opts.log ?? {}
    /*
     * 落盘位置。
     *
     * ## 为什么要落盘（2026-10-26 改）
     *
     * 原来短期记忆是**纯内存**的，重启即清零。设计初衷是「上下文价值
     * 随时间衰减，真正要持久化的是长期摘要」—— 这在**正常运行**时成立。
     *
     * 但它忽略了一件事：**调试期间重启很频繁**。实测症状：
     *   19:04:38  它: 我去吃饭了
     *   19:05:13  它: 吃了，白米饭两碗
     *   19:20:14  （重启）
     *   19:26:55  你: 我还没吃
     *   19:27:19  你: 你不是才吃过吗
     *   19:27:32  它: 谁说我吃过了……      ← 真的忘了
     *
     * 「我去吃饭了」这种**当下状态**，长期摘要不会记（它只概括人和关系），
     * 于是重启后就断片了。用户体感就是「聊天接不上」。
     *
     * 所以加一层落盘。文件很小（几十条 × 几百字），且有 `maxAgeMs`
     * 兜底 —— 太老的记录载入后会被 `_trim()` 丢掉。
     */
    const dir = typeof opts.dir === 'string' && opts.dir.trim()
      ? opts.dir.trim()
      : String(opts.home ?? '')
    this.file = dir ? path.join(dir, 'memory-short.json') : null
    this._dirty = false
    this._saveTimer = null
  }

  /**
   * 从磁盘恢复。
   *
   * 只恢复**消息本身**，不恢复 `consecutiveTurns` / `pendingSinceMyLast`
   * 这类「当前轮次状态」—— 那些描述的是「正在进行的一轮对话」，
   * 重启后重新开始更合理。
   */
  load() {
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const now = Date.now()
      const maxAge = Number(this.shortCfg.maxAgeMs ?? 0) || 6 * 3600_000
      for (const [scope, v] of Object.entries(j.sessions ?? {})) {
        const m = new ConversationMemory({
          maxMessages: this.shortCfg.maxMessages,
          maxChars: this.shortCfg.maxChars,
          maxAgeMs: this.shortCfg.maxAgeMs,
        })
        for (const raw of (v.messages ?? [])) {
          const at = Number(raw?.at ?? 0)
          // 过期的直接不要（省得载入一堆早就没用的历史）
          if (maxAge > 0 && at > 0 && now - at > maxAge) continue
          m.messages.push(makeMessage(raw))
        }
        m.totalPushed = Number(v.totalPushed ?? m.messages.length)
        m.myLastAt = Number(v.myLastAt ?? 0)
        m._trim()
        if (m.messages.length > 0) this.sessions.set(scope, m)
      }
      this.log.info?.(`短期记忆：载入 ${this.sessions.size} 个会话`)
    } catch (e) {
      this.log.warn?.(`短期记忆载入失败（忽略）：${String(e?.message ?? e)}`)
    }
  }

  /** 落盘（原子写：先写 tmp 再 rename，避免半截文件）。 */
  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const sessions = {}
      for (const [scope, m] of this.sessions) {
        if (!m.messages.length) continue
        sessions[scope] = {
          totalPushed: m.totalPushed,
          myLastAt: m.myLastAt,
          messages: m.messages,
        }
      }
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      this._dirty = false
    } catch (e) {
      this.log.warn?.(`短期记忆落盘失败：${String(e?.message ?? e)}`)
    }
  }

  /**
   * 标脏 + 延迟落盘。
   *
   * 每条消息都同步写盘太浪费（群聊一秒好几条）。这里 2 秒合并一次，
   * 进程退出前由宿主调 `save()` 兜底。
   */
  touch() {
    this._dirty = true
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      if (this._dirty) this.save()
    }, 2000)
    this._saveTimer.unref?.()
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
      /*
       * 挂落盘回调。
       *
       * 在**这里**挂而不是在 `push` 调用点改，是因为 push 有 4 处
       * （收到消息 / 自己回复 / 主动发言 / 表情回应），
       * 漏一处那条消息就不会落盘，而且很难发现。
       */
      m.onChange = () => this.touch()
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

  /**
   * 每个会话的明细（供 Web UI 的「记忆管理」列表用）。
   *
   * ⚠️ 2026-10-25 新增。原来 `/memory` 接口只回 `scopes()`（**字符串数组**），
   * 但前端读的是 `row.scope` / `row.messages` —— 对字符串取 `.scope` 得到
   * undefined，界面显示成「**undefined 条消息**」，看着像记忆功能没生效。
   *
   * 实际上记忆一直在正常工作（2 个会话 17 条消息都在）。
   *
   * 这里返回对象数组，前端就能显示「群 xxx：12 条消息」这种人话。
   *
   * @returns {Array<{scope:string, messages:number, summarized:number, unsummarized:number}>}
   */
  scopeDetails() {
    const out = []
    for (const [scope, session] of this.sessions) {
      const msgs = session.messages ?? []
      out.push({
        scope,
        messages: msgs.length,
        summarized: Number(session.summarizedCount ?? 0),
        unsummarized: Math.max(0, msgs.length - Number(session.summarizedCount ?? 0)),
      })
    }
    // 消息多的排前面 —— 用户最想清的通常是聊得最久的那个
    out.sort((a, b) => b.messages - a.messages)
    return out
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
    // 清空也要落盘 —— 否则重启后又被"恢复"回来，用户会以为清不掉
    this.save()
  }
}
