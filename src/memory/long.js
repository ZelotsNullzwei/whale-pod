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
    /** 摘要覆盖的消息数（用于判断何时再触发） */
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
        sessions[scope] = { summary: m.summary, summarizedCount: m.summarizedCount, updatedAt: m.updatedAt }
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
   * 条件是「短期窗口里累积的消息数」超过阈值 —— 用短期窗口的长度
   * 而不是总消息数，因为短期窗口本身有上限，这样触发频率自然受控。
   *
   * @param {string} scope
   * @param {object} ctx  { messages, scene, self }
   * @returns {Promise<boolean>} 是否真的做了摘要
   */
  async maybeSummarize(scope, ctx) {
    if (!this.enabled || typeof this.summarize !== 'function') return false
    if (this._busy.has(scope)) return false

    const mem = this.get(scope)
    const msgs = ctx.messages ?? []
    const unsummarized = msgs.length - (mem.summarizedCount ?? 0)
    if (unsummarized < this.summarizeAfter) return false

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
        mem.summarizedCount = msgs.length
        this._dirty = true
        this.save()
        this.log.info?.(`长期记忆：${scope} 已更新摘要（${text.length} 字）`)
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
