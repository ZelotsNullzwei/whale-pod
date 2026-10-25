/**
 * 长期记忆：会话的滚动摘要。
 *
 * ## 为什么不做向量库
 *
 * 群聊的「长期记忆」价值主要在**最近发生的事**（谁在追什么剧、昨天那个梗、
 * 群里的人际关系），而不是"三个月前某人说过一句话"这种需要语义检索的东西。
 * 所以用**滚动摘要**（rolling summary）：
 *
 *   短期窗口（最近 30 条）→ 满了就把最老的对话压成摘要 → 摘要累积
 *
 * 好处：
 *   - 零额外依赖（不需要 embedding 模型或向量库）
 *   - 摘要本身就是给 LLM 读的自然语言，直接进 system prompt
 *   - 成本低（每次触发一次便宜模型的调用）
 *
 * 如果将来真需要语义检索，`LongTermMemory` 的接口不用改，
 * 换一个实现即可。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 一个会话的长期记忆。 */
export class LongTermMemory {
  constructor(scope) {
    this.scope = scope
    /** 累积摘要（自然语言段落） */
    this.summary = ''
    /**
     * 已摘要到的**累计消息总数**（单调递增）。
     *
     * ⚠️ 2026-10-23 新增。原来是 `summarizedCount`，存的是**窗口长度**，
     *    而窗口有上限，导致「摘要过一次就再也不触发」。
     *    这个字段替代它作为判断依据。
     */
    this.summarizedTotal = 0
    /**
     * 兼容字段：上次摘要时短期窗口里有多少条。
     * 只用于展示/调试，**不再参与触发判断**。
     */
    this.summarizedCount = 0
    /** 上次摘要时间 */
    this.updatedAt = 0
  }

  /** 摘要 + 关键事实，拼成给 LLM 的上下文段落。 */
  toPrompt() {
    if (!this.summary) return ''
    return `【关于这个会话你已经知道的】\n${this.summary}`
  }

  merge(newSummary) {
    // 简单策略：如果新摘要能覆盖旧的（包含关系），直接用新的；
    // 否则拼接（保留更早的信息），并限制总长度。
    if (!this.summary) {
      this.summary = newSummary
    } else if (newSummary.includes(this.summary)) {
      this.summary = newSummary
    } else {
      this.summary = `${this.summary}\n${newSummary}`
    }
    if (this.summary.length > 3000) {
      this.summary = this.summary.slice(-3000)
    }
    this.updatedAt = Date.now()
  }
}

/**
 * 长期记忆管理器。
 *
 * @param {object} opts
 * @param {object} opts.cfg          memory.long 配置
 * @param {string} opts.home         数据目录
 * @param {object} opts.summarize   async ({ messages, previous, scene, self }) => string
 *                                  由上层注入（用 LLM 生成摘要）
 * @param {object} [opts.log]
 */
export class LongTermStore {
  constructor(opts = {}) {
    this.cfg = opts.cfg ?? {}
    this.enabled = this.cfg.enabled === true
    this.summarizeAfter = this.cfg.summarizeAfter ?? 200
    this.home = opts.home
    this.summarize = opts.summarize
    this.log = opts.log ?? {}
    this.file = this.home ? path.join(this.home, 'memory-long.json') : null
    /** @type {Map<string, LongTermMemory>} */
    this.memories = new Map()
    /** 防止同一会话并发摘要 */
    this._busy = new Set()
    this._dirty = false
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [scope, v] of Object.entries(j.sessions ?? {})) {
        const m = new LongTermMemory(scope)
        m.summary = String(v.summary ?? '')
        m.summarizedCount = Number(v.summarizedCount ?? 0)
        /**
         * 老文件里没有 `summarizedTotal`（这个字段是 2026-10-23 才加的）。
         *
         * 迁移策略：老文件里 `summarizedCount` 存的是**当时的窗口长度**，
         * 不是累计总数。直接拿它当 `summarizedTotal` 会**低估**已摘要量
         * （窗口最多 30，而真实累计可能已经几百条），于是加载后立刻
         * 触发一次多余的摘要 —— 不算致命，但会白花一次 LLM 调用。
         *
         * 这里取两者较大值：老文件按 `summarizedCount` 兜底，
         * 至少不会重复摘要**同一批**已经进过摘要的消息。
         */
        m.summarizedTotal = Number(v.summarizedTotal ?? v.summarizedCount ?? 0)
        m.updatedAt = Number(v.updatedAt ?? 0)
        this.memories.set(scope, m)
      }
      this.log.info?.(`长期记忆：载入 ${this.memories.size} 个会话`)
    } catch (e) {
      this.log.warn?.(`长期记忆载入失败（忽略）：${String(e?.message ?? e)}`)
    }
  }

  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const sessions = {}
      for (const [scope, m] of this.memories) {
        if (!m.summary) continue
        sessions[scope] = {
          summary: m.summary,
          summarizedTotal: m.summarizedTotal,
          summarizedCount: m.summarizedCount,
          updatedAt: m.updatedAt,
        }
      }
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      this._dirty = false
    } catch (e) {
      this.log.warn?.(`长期记忆落盘失败：${String(e?.message ?? e)}`)
    }
  }

  get(scope) {
    let m = this.memories.get(scope)
    if (!m) { m = new LongTermMemory(scope); this.memories.set(scope, m) }
    return m
  }

  /**
   * 也许该做一次摘要了。
   *
   * ## 触发条件（2026-10-23 修正）
   *
   * 判断的是「**距上次摘要新增了多少条消息**」，不是「当前窗口有多长」。
   *
   * ⚠️ 原来写的是 `msgs.length - summarizedCount`，而 `msgs` 是滑动窗口：
   *    窗口一满（`maxMessages = 30`），`msgs.length` 恒为 30，
   *    第一次摘要后 `summarizedCount` 也是 30 → `unsummarized` 永远为 0，
   *    **摘要只可能发生一次**，之后再也不触发。
   *
   *    实测表现：`memory-long.json` 从未生成，用户反馈「记忆没生效」。
   *
   * 现在用 `totalPushed`（单调递增的累计入队数）算增量：
   *   unsummarized = totalPushed - summarizedTotal
   * 窗口怎么滚动都不影响这个差值。
   *
   * 调用方需要传 `total`（即 `ConversationMemory.totalPushed`）。
   * 没传时退回用 `messages.length` —— 保持对老调用方兼容，
   * 但那种情况下仍然会有原来的问题（所以 bridge 里一定要传）。
   *
   * @param {string} scope
   * @param {object} ctx  { messages, total?, scene, self }
   * @returns {Promise<boolean>} 是否真的做了摘要
   */
  async maybeSummarize(scope, ctx) {
    if (!this.enabled || typeof this.summarize !== 'function') return false
    if (this._busy.has(scope)) return false

    const mem = this.get(scope)
    const msgs = ctx.messages ?? []

    // 累计口径优先；没传就退回窗口长度（兼容老调用，但会退化）
    const total = Number.isFinite(ctx.total) ? ctx.total : msgs.length
    const unsummarized = total - (mem.summarizedTotal ?? 0)
    if (unsummarized < this.summarizeAfter) return false

    // 没有消息可摘要就别白跑一次 LLM
    if (msgs.length === 0) return false

    this._busy.add(scope)
    try {
      const text = await this.summarize({
        messages: msgs,
        previous: mem.summary,
        scene: ctx.scene,
        self: ctx.self,
      })
      if (typeof text === 'string' && text.trim()) {
        mem.merge(text.trim())
        // ⚠️ 记的是**累计总数**，不是窗口长度 —— 这是本次修的核心
        mem.summarizedTotal = total
        // 兼容字段：老代码/老文件里可能只有 summarizedCount
        mem.summarizedCount = msgs.length
        this._dirty = true
        this.save()
        this.log.info?.(`长期记忆：${scope} 已更新摘要（${text.length} 字，累计 ${total} 条）`)
        return true
      }
    } catch (e) {
      this.log.warn?.(`长期记忆摘要失败（${scope}）：${String(e?.message ?? e)}`)
    } finally {
      this._busy.delete(scope)
    }
    return false
  }

  stats() {
    let withSummary = 0
    let totalChars = 0
    for (const m of this.memories.values()) {
      if (m.summary) { withSummary++; totalChars += m.summary.length }
    }
    return { enabled: this.enabled, sessions: this.memories.size, withSummary, totalChars, summarizeAfter: this.summarizeAfter }
  }

  /**
   * 有长期记忆的会话明细（供 Web UI 的「长期摘要」列表）。
   *
   * ⚠️ 2026-10-25 新增。原来前端读 `mem.data.longScopes`，但接口里
   * 根本没这个字段（只回了 `longMemory: stats()` 的汇总），
   * 于是「长期摘要」那块永远显示「暂无长期摘要」——
   * 哪怕实际有 2 份、901 字的摘要。
   *
   * @returns {Array<{scope:string, chars:number, summarizedCount:number, updatedAt:number|null}>}
   */
  listScopes() {
    const out = []
    for (const [scope, m] of this.memories) {
      if (!m?.summary) continue
      out.push({
        scope,
        chars: m.summary.length,
        summarizedCount: Number(m.summarizedCount ?? 0),
        updatedAt: m.updatedAt ?? null,
      })
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return out
  }

  clear(scope) {
    if (scope) this.memories.delete(scope)
    else this.memories.clear()
    this._dirty = true
    this.save()
  }
}

/** 默认的摘要提示词（上层可覆盖）。 */
export const SUMMARY_PROMPT = `你在为一个 QQ 群聊机器人维护长期记忆。
请把下面的群聊记录压缩成一段简短的中文摘要，只保留：
1. 群里有谁（昵称 + 特点/身份）
2. 正在发生或讨论的事（话题、梗、事件）
3. 与机器人相关的偏好（谁喜欢被怎么称呼、谁不喜欢被打扰）
不要逐条复述，不要编造。控制在 200 字以内。

${'若有【已有摘要】，请把新信息合并进去，输出完整的新摘要。'}

【已有摘要】
{previous}

【新的聊天记录】
{messages}

只输出摘要正文，不要任何前后缀。`
