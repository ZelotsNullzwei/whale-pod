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

  /**
   * 合并新摘要。
   *
   * ⚠️ **2026-10-26 重写**。原来的实现是：
   *
   * ```js
   * this.summary = `${this.summary}\n${newSummary}`       // 直接拼
   * if (this.summary.length > 3000) this.summary = this.summary.slice(-3000)
   * ```
   *
   * 后果（实测 `memory-long.json`）：
   *   · 同一件事（「风宝爱攒抽」「机器人自称本鱼」）被反复写进去
   *   · 摘要越来越长，最后靠 `slice(-3000)` 硬截 —— 截掉的正好是
   *     **最早、最该保留**的那部分
   *   · 3000 字里可能一半是重复内容，真正有效的印象被稀释
   *
   * 现在改成**按人替换**：新摘要里的人如果是「已经认识的人」，
   * 用新印象**覆盖**旧的；话题部分同理整段替换。
   *
   * 判断「是同一个」的依据是 QQ 号（见 `person.js`），不是昵称 ——
   * 昵称会变，用来比对必然对不上。
   *
   * @param {string} newSummary LLM 输出的「【人】…【事】…」格式
   */
  merge(newSummary) {
    const incoming = newSummary
    if (!incoming) return

    // 不是新格式（老版本调用，或模型没按格式答）→ 退化成「替换整个摘要」
    //
    // 为什么不是退回「拼接」：拼接正是要修的问题。宁可丢掉旧细节，
    // 也不该让摘要无限膨胀 —— 最近的印象比三个月前的一句话更有用。
    if (!incoming.includes('【人】')) {
      this.summary = incoming.slice(-MAX_SUMMARY_CHARS)
      this.updatedAt = Date.now()
      return
    }

    const prev = parsePeople(this.summary)
    const next = parsePeople(incoming)

    // 按 QQ 号覆盖：新的一行胜过旧的一行
    for (const [id, line] of next) prev.set(id, line)

    const topics = parseTopics(incoming) || parseTopics(this.summary)
    this.summary = renderPeople(prev, topics)
    this.updatedAt = Date.now()
  }
}

/** 摘要总长上限。够装 ~40 个人 + 话题，再多说明该淘汰了。 */
const MAX_SUMMARY_CHARS = 3000

/**
 * 从摘要文本里取出「【人】→ QQ号 → 那一行」的映射。
 *
 * 提取不出 QQ 号的行会被**丢掉** —— 没有 QQ 号就没法判断是不是同一个人，
 * 留着只会在下次合并时制造重复。
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parsePeople(text) {
  /** @type {Map<string, string>} */
  const out = new Map()
  const s = String(text ?? '')
  const start = s.indexOf('【人】')
  if (start < 0) return out
  const end = s.indexOf('【事】')
  const seg = end > start ? s.slice(start + 3, end) : s.slice(start + 3)
  for (const raw of seg.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/(\d{4,12})/)
    if (!m) continue
    out.set(m[1], line)
  }
  return out
}

/**
 * 把「人 + 话题」渲染回摘要文本。
 *
 * @param {Map<string, string>} people
 * @param {string} topics
 * @returns {string}
 */
export function renderPeople(people, topics) {
  const lines = [...people.values()]
  const head = lines.length > 0 ? `【人】\n${lines.join('\n')}` : ''
  const tail = topics ? `【事】\n${topics}` : ''
  const body = [head, tail].filter(Boolean).join('\n\n')
  // 兜底：真超了就砍最早的人（Map 保序，前面的最先加）
  if (body.length > MAX_SUMMARY_CHARS) {
    const keep = [...people.entries()].slice(-Math.floor(people.size * 0.7))
    return renderPeople(new Map(keep), topics).slice(0, MAX_SUMMARY_CHARS)
  }
  return body
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
    /*
     * 落盘目录。
     *
     * `opts.dir` 来自 `memory.dir` 配置 —— 用户可以把记忆单独放到
     * 另一个盘或同步盘，不必搬整个数据目录（config、日志、附件都在
     * 那儿）。留空就跟着 home，跟以前完全一样。
     *
     * 写不进去时 `_save()` 会静默放弃（不阻断主流程），
     * 所以即使配了个非法路径，最坏情况是「记忆不落盘」，不会崩。
     */
    const dir = typeof opts.dir === 'string' && opts.dir.trim() ? opts.dir.trim() : this.home
    this.file = dir ? path.join(dir, 'memory-long.json') : null
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
export const SUMMARY_PROMPT = `你在维护一个 QQ 群聊机器人的长期记忆。目标不是复述聊天，而是**留下印象**。

按下面的格式输出，一共两部分：

【人】
每行一个人，格式：QQ号 | 昵称 | 一句话印象
- 只写**能长期成立**的特征：性格、说话风格、在意什么、常做什么
- 不要写「他刚才说了xxx」这种一次性的内容
- 印象要短，一句话，不要超过 30 字
- 昵称变了以 QQ 号为准，同一个人只写一行

【事】
这个会话最近在聊什么，2-3 句以内。只写**还需要记住的**：正在推进的事、
反复出现的梗、约好的事情。一次性的闲聊不用记。

【不要做的事】
- 不要复述对话，不要点名谁说了哪句话
- 不要编造没人提过的事
- 不要写「群成员：xxx、xxx」这种罗列
- 总长度控制在 300 字以内

${'【已有印象】是上一次的结论。请在此基础上**更新**：\n- 印象变了就整行替换，不要叠加\n- 事实没有变化的人可以省略不写\n- 已经明显过时的内容直接删掉'}

【已有印象】
{previous}

【新的聊天记录】
{messages}

只输出上述两部分，不要任何前后缀。`

/**
 * 解析摘要输出里的「【人】」段。
 *
 * 格式容错做得比较宽 —— 模型经常自由发挥（用 `|`、`：`、`-` 混着写），
 * 硬解析会大面积丢数据。这里只要能认出「QQ号 + 印象」就收。
 *
 * @param {string} text LLM 输出
 * @returns {Array<{id:string, name:string, impression:string}>}
 */
export function parsePersonLines(text) {
  const out = []
  const s = String(text ?? '')
  // 只取【人】到【事】（或结尾）之间
  const start = s.indexOf('【人】')
  if (start < 0) return out
  const end = s.indexOf('【事】')
  const seg = end > start ? s.slice(start + 3, end) : s.slice(start + 3)

  for (const rawLine of seg.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*·]\s*/, '')
    if (!line) continue
    // 找行里的 QQ 号（5-12 位数字）。找不到就跳过 —— 没 QQ 号认不了人
    const m = line.match(/(\d{4,12})/)
    if (!m) continue
    const id = m[1]
    // 去掉 id 之后剩下的部分里，取最后一个分隔符之后的作为印象
    let rest = line.replace(m[0], '').trim()
    rest = rest.replace(/^[|｜:：\-\s]+/, '')
    // 昵称 | 印象  →  按第一个分隔符切开
    const parts = rest.split(/[|｜]/).map((x) => x.trim()).filter(Boolean)
    let name = ''
    let impression = ''
    if (parts.length >= 2) {
      name = parts[0]
      impression = parts.slice(1).join(' ')
    } else {
      // 没有分隔符：整段当印象，昵称留空（展示时回退到 QQ 号）
      impression = rest.replace(/^[|｜:：\-\s]+/, '')
    }
    if (!impression) continue
    out.push({ id, name, impression })
  }
  return out
}

/**
 * 解析摘要输出里的「【事】」段。
 *
 * @param {string} text
 * @returns {string}
 */
export function parseTopics(text) {
  const s = String(text ?? '')
  const start = s.indexOf('【事】')
  if (start < 0) return ''
  return s.slice(start + 3).trim()
}
