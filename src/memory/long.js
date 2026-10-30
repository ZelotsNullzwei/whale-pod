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
  /**
   * @param {string} scope
   * @param {{total?:number, topic?:number, self?:number, gloss?:number, inject?:number}} [limits]
   *        存储/注入上限。由 `LongTermStore` 从配置传入；**不传用默认值**。
   */
  constructor(scope, limits) {
    this.scope = scope
    /** 存储侧 + 注入侧的上限（见 `DEFAULT_LIMITS`） */
    this.limits = normLimits(limits)
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

  /**
   * 摘要 + 关键事实，拼成给 LLM 的上下文段落。
   *
   * ⚠️ 这里按 **`limits.inject`（注入预算）** 裁剪，**不动 `this.summary`** ——
   * 超出的部分只是这一轮没带上，存储里还在（2026-10-30 拆开）。
   */
  toPrompt() {
    if (!this.summary) return ''
    const text = clipForPrompt(this.summary, this.limits.inject)
    if (!text) return ''
    return `【关于这个会话你已经知道的】\n${text}`
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

    /*
     * 不是新格式（老版本调用，或模型没按格式答）→ 原来直接「替换整个摘要」。
     *
     * ⚠️ 但**单纯替换是危险的**（2026-10-28 改，用户报「老是记小事」）。
     *
     * 实测：模型的输出**长期只有【事】、完全没有【人】**（因为摘要输入里
     * 没带 QQ 号 —— 见 index.js 的 summarize），于是每次都走这个分支 →
     * 每次摘要都把上一次的内容整段冲掉 → 长期记忆里永远只剩
     * 「最近在聊什么」，人物印象一条都攒不下来。
     * 用户看到的就是：**只记小事，记不住人**。
     *
     * 现在：新摘要没给【人】时，**保留旧的【人】行**，只用新的【事】更新话题。
     *   · 有旧人像 → 人像留着，话题换新
     *   · 本来就没有人像（全新会话）→ 仍然退化为整段替换
     *
     * 这同时是对「模型偶尔忘格式」的兜底 —— 不该因为一次格式失误
     * 就把攒了几周的印象全丢掉。
     */
    if (!incoming.includes('【人】')) {
      const keepPeople = parsePeople(this.summary)
      const topics = parseTopics(incoming) || parseTopics(this.summary)
      /*
       * 【我】也要保住 —— 和【人】同理：
       * 模型偶尔忘格式，不该把攒了几周的「我说话方式变了」整段冲掉。
       */
      const selfNote = parseSelf(incoming) || parseSelf(this.summary)
      /*
       * 【梗】同样要保住 —— 术语库是"这个群怎么说话"，
       * 一次格式失误丢掉，等于它又开始听不懂黑话。
       */
      const gloss = parseGloss(incoming) || parseGloss(this.summary)
      this.summary = keepPeople.size > 0
        ? renderPeople(keepPeople, topics, selfNote, gloss, this.limits)
        : incoming.slice(-this.limits.total)
      this.updatedAt = Date.now()
      return
    }

    const prev = parsePeople(this.summary)
    const next = parsePeople(incoming)

    // 按 QQ 号覆盖：新的一行胜过旧的一行
    for (const [id, line] of next) prev.set(id, line)

    const topics = parseTopics(incoming) || parseTopics(this.summary)
    const selfNote = parseSelf(incoming) || parseSelf(this.summary)
    const gloss = parseGloss(incoming) || parseGloss(this.summary)
    this.summary = renderPeople(prev, topics, selfNote, gloss, this.limits)
    this.updatedAt = Date.now()
  }
}

/**
 * 摘要的**存储上限**（默认 12000）。
 *
 * ## ⚠️ 2026-10-30 从 3000 提到 12000，并和「注入预算」拆开
 *
 * 原来 3000 是**一个数管两件事**：既是存多少的上限，也是每轮塞进 prompt 的量。
 * 后果是**超了就永久裁掉**（`renderPeople` 会删最旧的人、截话题）——
 * 用户感受到的就是「它忘事」。B 站有评论直接说「3000 太小了」。
 *
 * 参考同生态的 `dsh-qqchat`（群/成员记忆各 2000 字符**注入**预算，
 * 但**数据仍存 SQLite，不因预算被删**）和 MaiBot（向量库不限、
 * `top_k` + `max_chars` 控注入）—— 两家都是**存储给足、注入给预算**。
 *
 * 所以现在：
 *   · 这个常量 = **存多少**（超了才淘汰，12000 够装几百条）
 *   · `MAX_INJECT_CHARS` = **每轮带多少**（默认 3000，跟以前一样，不涨成本）
 * 超出的部分只是「这轮没带上」，**不再从存储里删掉**。
 */
const MAX_SUMMARY_CHARS = 12000

/**
 * 每轮注入 prompt 的**预算**（默认 3000）。
 *
 * 超了按段裁剪（见 `clipForPrompt`）：
 *   · 【人】【我】【梗】**全带** —— 长期资产，砍了就真没了
 *   · 【事】**从头部砍，保留最新的** —— 话题是消耗品
 *
 * 想让记得更多就调大这个（代价是每轮多花 token），
 * 想省钱就调小 —— 但**都不影响存了多少**。
 */
const MAX_INJECT_CHARS = 3000

/**
 * 「事」段（话题）单独的上限。
 *
 * 取总预算的一半左右：人物印象是长期资产、话题是近期消耗品，
 * 不能让一段跑飞的话题把位置全占掉。
 */
const MAX_TOPIC_CHARS = 1400

/** 单条人物印象的上限。提示词要求 ≤30 字，这里放 4 倍余量容模型偶尔啰嗦。 */
const MAX_PERSON_CHARS = 120

/**
 * 「我」段（它对自己的叙述）的上限。
 *
 * 提示词只要求 1~2 句，400 字是很宽的余量。
 * 这一段**最短也最难重建** —— 所以裁剪顺序里它**最后一个让位**。
 */
const MAX_SELF_CHARS = 400

/**
 * 「梗」段（术语库）的上限。
 *
 * 提示词要求只写**这个群内部的**黑话，一行一个「词 | 意思」，10 行以内。
 * 300 字够装 10~15 条 —— 再多就说明它在抄网络流行语大全，
 * 而那些恰恰是最没用的（隔两周就过时）。
 */
const MAX_GLOSS_CHARS = 300

/**
 * 默认的四个上限（存储侧）。
 *
 * 单独抽出来是为了让 `renderPeople` 能在**不传** limits 时用默认值 ——
 * 这样既有调用方和三个测试（`long-trim` / `selfnote` / `glossary`）
 * 的行为**逐字节不变**。
 */
export const DEFAULT_LIMITS = Object.freeze({
  total: MAX_SUMMARY_CHARS,
  topic: MAX_TOPIC_CHARS,
  self: MAX_SELF_CHARS,
  gloss: MAX_GLOSS_CHARS,
  inject: MAX_INJECT_CHARS,
})

/** 把外部传进来的 limits 补成完整的四个（缺的用默认）。 */
function normLimits(x) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  return {
    total: n(x?.total, DEFAULT_LIMITS.total),
    topic: n(x?.topic, DEFAULT_LIMITS.topic),
    self: n(x?.self, DEFAULT_LIMITS.self),
    gloss: n(x?.gloss, DEFAULT_LIMITS.gloss),
    inject: n(x?.inject, DEFAULT_LIMITS.inject),
  }
}

/**
 * 从 `memory.long` 配置推出四个上限（构造时 + 热更新时共用）。
 *
 * ⚠️ 抽成函数是为了**配置热更新**（2026-10-30）：
 * 原来这段逻辑只写在构造函数里，于是面板改了 `maxChars` / `injectChars`
 * 只有**重启**才生效 —— 界面上回读的还是旧值，用户以为「改不了」。
 *
 * @param {object} cfg memory.long 配置
 */
function deriveLimits(cfg) {
  const c = cfg ?? {}
  const pos = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  /** 夹到合理范围 —— 防止手改 config 填个 1e9 把 prompt 撑爆。 */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)))
  return normLimits({
    // 存：1500 ~ 50000（12000 约等于几百条人物印象）
    total: clamp(pos(c.maxChars, DEFAULT_LIMITS.total), 1500, 50000),
    topic: DEFAULT_LIMITS.topic,
    self: DEFAULT_LIMITS.self,
    gloss: DEFAULT_LIMITS.gloss,
    // 带：500 ~ 20000（3000 约 2000 token）
    inject: clamp(pos(c.injectChars, DEFAULT_LIMITS.inject), 500, 20000),
  })
}

/**
 * 话题文本的裁剪：**优先保住「我说过：」那一段**。
 *
 * 提示词要求【事】里必须有一句「我说过：…」（机器人自己表达过的立场）。
 * 它是人设连续性的核心 —— 直接从头截断很容易正好把它切掉。
 *
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function clipTopics(text, max) {
  const s = String(text ?? '').trim()
  if (s.length <= max) return s
  const at = s.indexOf('我说过：')
  if (at >= 0) {
    const said = s.slice(at).trim()
    if (said.length <= max) {
      const headKeep = max - said.length - 1
      if (headKeep > 20) return `${s.slice(0, headKeep).trim()}\n${said}`
      return said.slice(0, max)
    }
    return said.slice(0, max)
  }
  return s.slice(0, max)
}

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
 * ## 必须**保证终止**（2026-10-29 修）
 *
 * 原来是递归收缩：
 * ```js
 * const keep = [...people.entries()].slice(-Math.floor(people.size * 0.7))
 * return renderPeople(new Map(keep), topics).slice(0, MAX_SUMMARY_CHARS)
 * ```
 * 这条有两个致命问题（实测 4/4 栈溢出）：
 *
 *   ① **`slice(-0)` 就是 `slice(0)`** —— `Math.floor(0 * 0.7) === 0`，
 *      于是「保留后面 0%」被当成「保留全部」，数组**一条都没少** →
 *      同一组参数无限递归 → `RangeError: Maximum call stack size exceeded`。
 *      只要人数 < 2 就必然踩到（1 人时 `floor(0.7)=0`，2 人时收缩到 1 人后
 *      下一轮又是 0）。
 *   ② **`topics` 原样透传** —— 话题文本自己超过总上限时，递归里它永远不缩短，
 *      无论几个人都终止不了。
 *
 * 现在改成**迭代收缩**，顺序按「先砍消耗品、后砍资产」：
 *   1. 先把话题裁到 `MAX_TOPIC_CHARS`（保住「我说过：」那段）
 *   2. 再逐条移除**最旧**的人物印象（Map 保序，`shift()` 从头删）
 *   3. 人砍光了还超 → 从话题尾部精确减去超出量
 *   4. 最后再套一次硬 `slice`，兜住分隔符之类的极端情况
 *
 * 终止性：第 2 步每轮至少少一条（严格递减）；第 3、4 步是常数次操作。
 *
 * @param {Map<string, string>} people
 * @param {string} topics
 * @returns {string}
 */
export function renderPeople(people, topics, self, gloss, limits) {
  /*
   * ⚠️ 第五个参数 `limits`（2026-10-30 加）—— 让「存多少」可配。
   *
   * **不传时用 `DEFAULT_LIMITS`，输出与上一版逐字节相同** ——
   * 三个测试锁着这条（`long-trim` / `selfnote` / `glossary`），
   * 所以既有调用方一律不受影响。
   */
  const L = normLimits(limits)
  let topicText = clipTopics(topics, L.topic)
  /*
   * 「我」段（2026-10-29 加）。
   *
   * 省略 `self` 时**输出与旧版逐字节相同** —— 这条有测试锁着
   * （`check-selfnote`）。所以任何既有调用方不受影响。
   */
  let selfText = String(self ?? '').trim()
  if (selfText.length > L.self) selfText = selfText.slice(0, L.self)
  /*
   * 「梗」段（术语库，2026-10-29 加）—— 这个群的黑话。
   *
   * 同样：省略 `gloss` 时输出与上一版逐字节相同（`check-glossary` 锁着）。
   * 它排在最后，所以 `parseSelf` 要在「【梗】」处收边界。
   */
  let glossText = String(gloss ?? '').trim()
  if (glossText.length > L.gloss) glossText = glossText.slice(0, L.gloss)

  const lines = []
  for (const v of people?.values?.() ?? []) {
    const s = String(v ?? '').trim()
    if (!s) continue
    lines.push(s.length > MAX_PERSON_CHARS ? s.slice(0, MAX_PERSON_CHARS) : s)
  }

  const build = () => {
    const head = lines.length > 0 ? `【人】\n${lines.join('\n')}` : ''
    const mid = topicText ? `【事】\n${topicText}` : ''
    const tail = selfText ? `【我】\n${selfText}` : ''
    const last = glossText ? `【梗】\n${glossText}` : ''
    return [head, mid, tail, last].filter(Boolean).join('\n\n')
  }

  let body = build()

  // ① 逐条移除最旧的人（Map 保序：最早 set 的排在最前）
  while (body.length > L.total && lines.length > 0) {
    lines.shift()
    body = build()
  }

  // ② 人已经砍光 → 按超出量精确截短话题
  if (body.length > L.total && topicText) {
    const overflow = body.length - L.total
    topicText = topicText.slice(0, Math.max(0, topicText.length - overflow))
    body = build()
  }

  /*
   * ③ 【我】与【梗】最后让位。
   *
   * 顺序是刻意的：人是长期资产、话题是近期消耗品、【我】和【梗】是
   * 最难重建的东西（性格的连续性、这个群怎么说话）—— 留到最后一个动。
   * 两者都有硬上限（400 / 300 字），正常根本走不到这一步。
   */
  if (body.length > L.total && selfText) {
    const overflow = body.length - L.total
    selfText = selfText.slice(0, Math.max(0, selfText.length - overflow))
    body = build()
  }
  if (body.length > L.total && glossText) {
    const overflow = body.length - L.total
    glossText = glossText.slice(0, Math.max(0, glossText.length - overflow))
    body = build()
  }

  // ④ 硬上限兜底
  return body.length > L.total ? body.slice(0, L.total) : body
}

/**
 * 按「**注入预算**」裁剪摘要 —— **只影响这一轮喂给模型的内容，不改变存储**。
 *
 * ## 为什么需要它（2026-10-30）
 *
 * 原来 `MAX_SUMMARY_CHARS = 3000` 一个数管两件事：存多少 + 每轮带多少。
 * 结果是**超了就永久裁掉**（`renderPeople` 会删最旧的人、截话题），
 * 用户感受到的是「它忘事」。
 *
 * 参考同生态的 `dsh-qqchat`：群/成员记忆各有 2000 字符**注入**预算，
 * 但**数据仍存 SQLite、不因预算被删**。MaiBot 同理（库不限，`top_k` 控注入）。
 *
 * ## 裁剪顺序（这是「忘事先忘什么」的规则）
 *
 * | 段 | 处理 | 理由 |
 * |---|---|---|
 * | 【人】【我】【梗】 | **全带** | 长期资产，砍了就真没了 |
 * | 【事】 | **从头部砍，保留最新的** | 话题是消耗品，旧的本来也没用 |
 *
 * 预算连【人】都放不下时，才按最旧优先删人。
 *
 * @param {string} summary   存储里的完整摘要
 * @param {number} maxChars  注入预算（<=0 或不传 = 不裁）
 * @returns {string}
 */
export function clipForPrompt(summary, maxChars) {
  const s = String(summary ?? '').trim()
  if (!s) return ''
  const budget = Number(maxChars)
  if (!Number.isFinite(budget) || budget <= 0 || s.length <= budget) return s

  const sec = (name) => {
    const at = s.indexOf(name)
    if (at < 0) return ''
    const rest = s.slice(at + name.length)
    const next = rest.search(/【(人|事|我|梗)】/)
    return (next >= 0 ? rest.slice(0, next) : rest).trim()
  }
  let people = sec('【人】')
  let topics = sec('【事】')
  const self = sec('【我】')
  const gloss = sec('【梗】')

  const wrap = (n, body) => (body ? `【${n}】\n${body}` : '')
  const build = () => [
    wrap('人', people), wrap('事', topics), wrap('我', self), wrap('梗', gloss),
  ].filter(Boolean).join('\n\n')

  let out = build()

  // ① 先砍【事】的头部（保留最新的），加省略号让人看得出被截过
  while (out.length > budget && topics.length > 0) {
    const over = out.length - budget
    const keep = topics.length - over - 1
    topics = keep > 0 ? `…${topics.slice(-keep)}` : ''
    out = build()
  }

  // ② 还是超 → 按最旧优先删人
  if (out.length > budget && people) {
    const lines = people.split('\n')
    while (out.length > budget && lines.length > 0) {
      lines.shift()
      people = lines.join('\n')
      out = build()
    }
  }

  // ③ 兜底硬截
  return out.length > budget ? out.slice(0, budget) : out
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
     * 存储/注入上限（2026-10-30 可配）。
     *
     * 只暴露**两个**给用户，因为用户真正想调的就是这两个：
     *   · `memory.long.maxChars`    —— **存**多少（超了才淘汰，默认 12000）
     *   · `memory.long.injectChars` —— **每轮带**多少（默认 3000，不涨成本）
     *
     * 三个子段（事/我/梗）保持**绝对上限**（1400/400/300）：
     * 它们各自有天然的合理长度（话题 2~3 句、自我叙述 1~2 句、黑话 10 行），
     * 按比例放大会让它们跑飞。**总上限涨出来的空间全部给【人】** ——
     * 那才是「存得多」真正该受益的地方（能记住更多人、更细的印象）。
     */
    this.limits = deriveLimits(this.cfg)
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
        const m = new LongTermMemory(scope, this.limits)
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
    if (!m) { m = new LongTermMemory(scope, this.limits); this.memories.set(scope, m) }
    return m
  }

  /**
   * 已知会话 id（来自持久化的长期记忆）。
   *
   * ## 为什么需要
   *
   * 短期记忆是纯内存的，重启后清零。而主动发言要枚举「跟谁说过话」——
   * 只靠短期记忆的话，重启后一个会话都没有，永远不开口。
   *
   * 长期记忆是落盘的（`memory-long.json`），重启后仍在，正好补这个缺口。
   *
   * @returns {string[]}
   */
  scopes() {
    return [...this.memories.keys()]
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

    /*
     * ⚠️ **计数回退就重置基线**（2026-10-28 修，用户报「记不住事」）。
     *
     * ## 现象
     *
     * `memory-long.json` 整整 24 小时没更新过 —— 昨天下午到今天说的所有事，
     * 长期记忆里一个字都没有。
     *
     * 实测数值：短期 `totalPushed = 37`，长期 `summarizedTotal = 60`：
     *
     *     unsummarized = 37 - 60 = -23   ← 负数，永远 < summarizeAfter(20)
     *
     * ## 根因
     *
     * `total` 来自**短期**记忆的 `totalPushed`，`summarizedTotal` 存在**长期**记忆里。
     * 两个计数器不在一个对象里，生命周期也不一样：
     *
     *   · 短期记忆有 6 小时过期（`maxAgeMs`）。隔一夜之后重启，
     *     所有消息都过期 → 那个会话**整个不恢复**（`short.js` 里
     *     `if (m.messages.length > 0) sessions.set(...)`）→ `totalPushed` 归零
     *   · 长期记忆的 `summarizedTotal` **不会跟着归零**（它没这个感知）
     *
     * 于是每天早上的第一次聊天，`unsummarized` 就是一个大负数，
     * 而且**要等新消息累计超过 `summarizedTotal + 20` 才可能回正** ——
     * 以 60 为例要 80 条，实际等于「记忆永久冻结」。
     *
     * ## 修法
     *
     * `total < summarizedTotal` 只可能意味着「短期那边重置过」。
     * 这时把基线拉回 0，让增量重新从当前累计数算起。
     *
     * ⚠️ 不能简单 `Math.max(0, total - summarizedTotal)` —— 那样结果是 0，
     *    照样到不了阈值，等于没修。
     * ⚠️ 也不能把短期记忆的 `totalPushed` 持久化跨过期 —— 那会让
     *    「昨天说了 500 句」的账算到今天头上，一次重启就误摘要。
     */
    const prevTotal = mem.summarizedTotal ?? 0
    if (total < prevTotal) {
      /*
       * ⚠️ 回退有**两种**成因，处理方式相反，不能一概归零（2026-10-29 补）。
       *
       * ① **短期记忆重置**（过夜过期后重建）：`totalPushed` 归零再累计，
       *    `summarizedTotal` 是"上个会话"的账 → 该归零，让新内容尽快摘要。
       *
       * ② **丢增量**（被硬杀/崩溃，2 秒防抖还没落盘）：`totalPushed` 少了十几个，
       *    但**那批刚刚已经摘要过** → 归零就会把同一批内容**再摘一遍**。
       *    实测：41 分钟里摘要跑了两次（23:14:44、23:15:55）。
       *
       * ## 判据：看**摘要发生在哪个会话里**
       *
       *   · `summarizedAt >= sessionAt` → 摘要在**本会话内**发生
       *     → 回退只可能是丢增量 → **对齐基线，不重摘**
       *   · `summarizedAt < sessionAt` → 摘要属于**上一个**会话
       *     → 归零，尽快摘
       *   · `sessionAt` 未知（老调用 / 老文件没有 createdAt）
       *     → 保守按"重置"处理（宁可多摘一次，也别把新内容冻住）
       *
       * ⚠️ **不能用"回退了多少比例"判断** —— 过夜后聊几十句，比例同样高。
       *    实测那个真实案例是 `60 → 37`（剩 62%），而它其实是过夜重置。
       */
      const summarizedAt = Number(mem.updatedAt ?? 0)
      const sessionAt = Number(ctx.sessionStartedAt ?? 0)
      const lostIncrements = sessionAt > 0 && summarizedAt >= sessionAt
      if (lostIncrements) {
        this.log.info?.(
          `长期记忆：${scope} 的累计计数回退（${total} < ${prevTotal}）`
          + ` —— 判断为"丢了未落盘的增量"（摘要在本会话内），基线对齐到 ${total}，不重复摘要`,
        )
        mem.summarizedTotal = total
      } else {
        this.log.info?.(
          `长期记忆：${scope} 的累计计数回退（${total} < ${prevTotal}）`
          + ' —— 判断为"短期记忆重置"（摘要属于上个会话），重置摘要基线',
        )
        mem.summarizedTotal = 0
      }
      this._dirty = true
    }

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

  /**
   * **热更新**存储/注入上限（2026-10-30）。
   *
   * ⚠️ 为什么需要：`limits` 原来只在构造时算一次，而 `/api/config` 的 POST
   * 只会热更新 `bridge.cfg`（白名单 / 模型 / effort …）—— **没人管 longMemory**。
   * 于是面板改完 `maxChars` / `injectChars`：
   *   · 文件是改对了 ✅
   *   · 但运行中的 store 还是旧值 ❌ → `/api/memory` 回读旧值 → **看着像"改不了"**
   *
   * 现在 web 层的 POST 在写完配置后调这里，立刻对齐**运行中**的上限，
   * 已存在的会话实例也一起换掉。
   *
   * @param {object} cfg 新的 `memory.long` 配置
   */
  applyLimits(cfg) {
    this.cfg = cfg ?? {}
    this.limits = deriveLimits(this.cfg)
    for (const m of this.memories.values()) m.limits = this.limits
    this.log.info?.(
      `长期记忆：上限已更新 — 存 ${this.limits.total} 字 / 每轮带 ${this.limits.inject} 字`,
    )
    return this.limits
  }

  stats() {
    let withSummary = 0
    let totalChars = 0
    for (const m of this.memories.values()) {
      if (m.summary) { withSummary++; totalChars += m.summary.length }
    }
    /*
     * ⚠️ 带上 `limits`（2026-10-30）—— 面板要显示「存多少 / 每轮带多少」
     * 两个输入框的**当前值**，只能从这儿读。
     */
    return {
      enabled: this.enabled,
      sessions: this.memories.size,
      withSummary,
      totalChars,
      summarizeAfter: this.summarizeAfter,
      limits: { ...this.limits },
    }
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
export const SUMMARY_PROMPT = `你在维护一个 QQ 群聊机器人的长期记忆。目标**不是复述聊天，而是记住人**。

按下面的格式输出，一共四部分（【人】【事】【我】【梗】）：

【人】
每行一个人，格式：QQ号 | 昵称 | 一句话印象
- QQ 号在聊天记录的「昵称(数字)」里，**照抄那串数字**
- 只写**能长期成立**的特征：他是谁、做什么的、性格、说话风格、在意什么、常做什么
- 不要写「他刚才说了xxx」这种一次性的内容
- 印象要短，一句话，不要超过 30 字
- 昵称变了以 QQ 号为准，同一个人只写一行
- 没变化的人可以省略；但**别整段空着** —— 只要聊过，至少要有几行

【事】
这个会话最近在聊什么，2-3 句以内。**只写明天还有用的**：
- 约好的事情、正在推进的事
- 反复出现的梗 / 内部玩笑
- 关系变化（谁跟它熟了、谁怼过它）

⚠️ **【事】里必须包含一段「我说过什么」** —— 用「我说过：」开头，一句话：
你自己（机器人）最近明确表达过的立场、承诺、说法。
例如：「我说过：我不承认自己是肥鱼，只认是鲸」/「我说过：那游戏平衡我懒得管」。
这条**很重要**：明天有人追问「你昨天不是这么说的吗」，
你得能想起自己说过什么。没说过就别硬编。

【我】
**你自己**最近有什么变化、对自己有什么认识。1~2 句，写「我」：

- 说话方式 / 态度上的变化（例如：「我好像越来越会等对方把话说完再接了」）
- 对什么开始有反应了、学会了什么、改掉了什么毛病
- 跟不同的人相处，方式上有区别吗

⚠️ **这一段只写你自己**，别写成【人】或【事】：
  · 「番茄爱揪年份」 → 那是【人】
  · 「今天聊完了渲染图」 → 那是【事】
  · 「我发现被揪年份时我会先认，而不是硬编」 → **这才是【我】**

没变化就照抄上一次的；**别为了填满而硬编**。写不出来就整段留空。

【梗】
**这个群内部**的黑话 / 叫法。一行一个，格式：词 | 一句话意思

- 只写**你们群里真在用**的：给谁起的绰号、内部才懂的说法、反复玩的梗
- 例：减速器 | 丢包的加速器，反着加速　／　睡鲸 | 睡过头，我自己也认了
- ⚠️ **不写网络上烂大街的流行语**（「绝绝子」「YYDS」这类）——
  那不用记，你本来就知道；记下来只会让你显得像在学舌
- 过时的就删掉，别攒着。**最多 10 行**

【不要做的事】
- 不要复述对话，不要点名谁说了哪句话
- 不要编造没人提过的事
- 不要写「群成员：xxx、xxx」这种罗列
- ⚠️ **下面这些是「小事」，一律不记** —— 记下来只会显得絮叨：
  · 钱 / 余额 / 钱包的数字（例如「钱包剩一块七」）
  · 当天的日常琐事（吃了什么、买了什么、天气、路上发生的事）
  · 一次性的吐槽、情绪片段、斗嘴过程（例如「我被怼『杂鱼』」）
  · 某条消息的具体措辞
- 能进【事】的只有**明天以后还用得上**的东西；拿不准就别写。
- 总长度控制在 300 字以内

${'【已有印象】是上一次的结论。请在此基础上**更新**：\n- 印象变了就整行替换，不要叠加\n- 事实没有变化的人可以省略不写\n- 已经明显过时的内容直接删掉\n- 「我说过：」那一段也要更新 —— 旧说法被推翻就换成新的\n- 【我】那一段：变了就换，没变就**照抄上一次的**（别为了填满硬编）\n- 【梗】那一段：**过时的直接删**，别攒着；最多 10 行'}

【已有印象】
{previous}

【新的聊天记录】
{messages}

只输出上述四部分，不要任何前后缀。`

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
 * ⚠️ **必须在 `【我】` 处停下**（2026-10-29 加）。
 * 摘要末尾多了一段【我】（它对自己的叙述），而它排在【事】后面 ——
 * 不收边界的话【我】会被整段当成话题吞掉。
 *
 * 顺序是 `【人】→【事】→【我】`，这样 `parsePeople`（取【人】..【事】）
 * 和 `parsePersonLines` 都不用改。（反过来把【我】插在中间会同时破坏两者。）
 *
 * @param {string} text
 * @returns {string}
 */
export function parseTopics(text) {
  const s = String(text ?? '')
  const start = s.indexOf('【事】')
  if (start < 0) return ''
  const selfAt = s.indexOf('【我】', start + 3)
  const seg = selfAt > start ? s.slice(start + 3, selfAt) : s.slice(start + 3)
  return seg.trim()
}

/**
 * 解析摘要输出里的「【我】」段 —— **它对自己的叙述**。
 *
 * 前三段记的都是「你」（谁是谁、在聊什么、我说过什么），这一段记「它」：
 * 说话方式有没有变、对什么开始有反应、学到了什么。
 *
 * 参考 `qq-dsh-bridge` 的 selfNote：
 * > 以前它记得「你常熬夜」，但不记得「我好像越来越会等你说完再回了」。
 * > 前者是资料，后者才是性格的连续性。
 *
 * @param {string} text
 * @returns {string}
 */
export function parseSelf(text) {
  const s = String(text ?? '')
  const at = s.indexOf('【我】')
  if (at < 0) return ''
  // ⚠️ 必须在「【梗】」处停下 —— 它排在【我】后面，
  //    不收边界的话术语库会被当成自我叙述吞掉。
  const end = s.indexOf('【梗】', at + 4)
  return (end > at ? s.slice(at + 4, end) : s.slice(at + 4)).trim()
}

/**
 * 解析摘要输出里的「【梗】」段 —— **这个群里的黑话/术语**。
 *
 * 前三段记的是「谁」「聊什么」「我自己」，这一段记**这个群怎么说话**：
 * 哪个词是他们内部的黑话、什么意思。
 *
 * 为什么独立成段而不是塞进【事】：
 *   · 【事】是"最近在聊什么" = **近期消耗品**，会被新话题冲掉、会被裁剪
 *   · 术语是**结构化的词→释义**，不是散文
 *   · 同一个梗第二次出现时，它需要的是"这词什么意思"，不是"上周聊过"
 *
 * @param {string} text
 * @returns {string}
 */
export function parseGloss(text) {
  const s = String(text ?? '')
  const at = s.indexOf('【梗】')
  if (at < 0) return ''
  return s.slice(at + 4).trim()
}
