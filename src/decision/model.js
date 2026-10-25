/**
 * 模型自主判断「这条要不要接」。
 *
 * ## 为什么要有这个
 *
 * 原来的 `rule.js` 是个**概率打分器**：一路 `p *= 1.5`、`p = Math.max(p*4, 0.65)`，
 * 最后掷一次骰子。它能调，但永远调不到「像人」——因为它不知道语境，
 * 只知道长度、有没有 @、上一条隔了多久。
 *
 * 实测暴露的两个硬伤（2026-10-25 群里的真实对话）：
 *
 *   ① 冷却把真实对话吃掉了
 *      13:56:08 「神志不清」→ 沉默（冷却 0s）
 *      13:56:18 「？」    → 沉默（冷却 10s）
 *      13:56:25 「你不管」 → 沉默（无 @）
 *      用户连发 5 条，机器人一条没回。
 *
 *   ② p=0.04 却发言
 *      「大会A」→ 发言 (p=0.04, 随机插话命中)
 *      0.04 意味着「极不想说」，但它说了 —— 掷骰子恰好落在 4% 里。
 *
 * 这两件事都不是「参数没调好」，是**架构决定的**：
 * 打分器分不清「用户在跟我续话」和「群里在闲聊」。
 *
 * ## 这个 provider 怎么做
 *
 * 把最近 N 条对话（带「谁在跟谁说话」的标记）交给模型，让它三选一：
 *
 *   reply —— 现在该接
 *   wait  —— 现在别接，但这段对话我还在跟（下次有新消息再看）
 *   stop  —— 这段跟我无关，别再@我了（本次不接，且降低后续概率）
 *
 * 三个值的差别很重要：
 *   · wait 和 stop 都是「不说」，但态度不同 —— wait 是「在听，只是插不上」，
 *     stop 是「这事我不参与」。前者后续新消息仍会重新判断，后者会退避。
 *
 * ## 成本与延迟
 *
 * 每次判断 = 一次 LLM 调用。所以：
 *   · 被 @ / 被叫名字 → **不走模型**，直接必回（在 index.js 的 order 里，
 *     rule 是最后兜底，但 @ 的判定我们放在调用模型**之前**，见 decide()）
 *   · 纯表情包 → 不走模型（emojiReply 已经处理）
 *   · 其余才问模型
 *
 * 用哪个模型由配置决定（`decision.model.model`），没配就用调用方的默认。
 * 判断「要不要说话」是简单任务，建议用便宜的模型。
 */

import { DecisionProvider } from './provider.js'

/** 提示词要求的输出格式 —— 只要一个词，便于解析也省 token。 */
const VERDICTS = ['reply', 'wait', 'stop']

/**
 * 构造给模型的对话上下文。
 *
 * 关键：标清楚「谁在跟谁说话」。模型只有看到这个才能判断该不该接。
 *
 * @param {object} input DecisionInput
 * @param {object} opts
 * @returns {string}
 */
export function buildContext(input, opts = {}) {
  const maxMessages = Number(opts.maxMessages ?? 15)
  const msgs = (input.messages ?? []).slice(-maxMessages)
  const selfName = input.self?.nickname ?? '己方'

  // ⚠️ 用「己方」而不是「你自己」。
  //
  // 「你自己」「你说的话」这种第二人称会把模型拉进角色里 ——
  // 实测它开始回「哼」「瞅瞅」。决策层是分类器，标注要中性：
  // 己方 / 他人，而不是 你 / 他。
  const lines = msgs.map((m) => {
    const who = m.isMe ? `${selfName}（己方）` : (m.senderName ?? m.sender ?? '某人')
    let text = String(m.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length > 120) text = text.slice(0, 120) + '…'
    const flags = []
    if (m.mentionsMe) flags.push('@己方')
    if (m.isMe) flags.push('己方发言')
    const flag = flags.length > 0 ? `[${flags.join('、')}]` : ''
    return `${who}${flag}: ${text}`
  })

  return lines.join('\n')
}

/**
 * 判断用的系统提示词。
 *
 * 刻意写得**短**：判断任务不需要长人设，长了反而让它开始扮演。
 * 人设是生成层的事，这里只要它做个「要不要开口」的决定。
 */
export function buildSystemPrompt(input, opts = {}) {
  const isGroup = input.scene?.kind === 'group'

  const since = Number(input.sinceMyLastMessage)
  const sinceText = Number.isFinite(since)
    ? `${Math.round(since / 1000)} 秒前`
    : '还没说过话'
  const turns = Number(input.consecutiveTurns) || 0

  // ── 私聊：**只允许 reply** ────────────────────────────────────
  //
  // 2026-10-25 实测：私聊里模型大量回 wait/stop ——
  //   17:18:45 「看到了」     → wait
  //   17:18:54 「有别的事」    → wait
  //   17:19:06 「没来得及回你」 → wait
  // 用户连说三句、一句没回，然后问「怎么不回消息了」。
  //
  // 根因不是模型笨，是**提示词给了它不该有的选项**：
  // 一对一私聊里不存在「插不上嘴」和「这段跟我无关」——
  // 对方每句话都是在跟你说。给它 wait/stop 就等于给它装死的许可。
  //
  // 所以私聊用一套极简提示词：没有 wait，没有 stop，只有 reply。
  // 「要不要回」在私聊里根本不是问题，问题只在「回什么」——
  // 那是生成层的事，不该让决策层再纠结一次。
  if (!isGroup) {
    return `你是一个消息分流器。任务：判断给定私聊消息是否需要回复。

私聊场景下，答案恒为 reply。

只输出 reply 这一个词。不要解释，不要标点，不要输出其他任何内容。

当前状态（仅供日志参考）：距上次发言 ${sinceText}，已连续发言 ${turns} 轮。`
  }

  // ── 群聊：三选一（这里判断「要不要插嘴」才是真问题）─────────
  //
  // ⚠️ 提示词刻意**去人格化**（2026-10-25）。
  //
  // 原来写的是「扮演一个普通群友」，结果模型真的开始扮演 ——
  // 判断层吐出「哼」「瞅瞅」「那当然」，44 次解析失败。
  // 人格是**生成层**的事（persona/roles/*.md，可改），
  // 决策层是**基础逻辑**（定死），两者不能混。
  //
  // 所以这里把它写成纯分类任务：没有角色、没有语气、没有「你」，
  // 只有「这条消息属于哪一类」。分类器不该有性格。
  return `你是一个消息分流器。任务：把给定的群聊消息分类，判断是否需要回应。

群${input.scene?.groupName ? `「${input.scene.groupName}」` : ''}。只输出一个词，不要解释，不要标点。

## 三个类别

reply —— 这条消息需要回应
wait  —— 这条消息不需要回应，但话题仍相关，后续可能回应
stop  —— 这条消息与己方完全无关

## 判据

reply（满足任一）：
- 消息中 @ 了己方，或直接叫了己方的名字/外号
- 消息在接着己方刚才说的话（追问、反驳、用「你」指代己方）
- 群内长时间无人发言，且该消息是开放性问题

wait（满足任一）：
- 他人在互相交谈，未涉及己方，但话题己方可以参与
- 己方刚发言不久，再次发言会显得刷屏

stop（满足任一）：
- 话题与己方完全无关（他人私事、工作汇报、技术争论）
- 内容涉及争吵或敏感话题
- 己方无法提供有价值的回应

## 状态

距己方上次发言：${sinceText}
己方已连续发言：${turns} 轮${turns >= 3 ? '（已偏多，除非被直接点名，倾向 stop）' : ''}

## 硬性要求

- 他人互相交谈且未点名己方 → 输出 stop 或 wait，不要 reply
- 被明确点名或被 @ → 必须输出 reply
- 只输出那一个英文词`
}

/**
 * 从模型输出里取出 verdict。
 *
 * ## 为什么「从尾部找」而不是「从头部找」
 *
 * 实测（2026-10-25）：判断用的模型是**推理模型**，输出结构是
 *
 *     reasoning_content: "我们需要回答用户中文问题…应该回 wait…"
 *     content:           "wait"
 *
 * 也就是**答案永远在最后**。推理内容里会反复提到所有三个词
 * （"该不该 reply？…应该 wait…"），从头部找必然抓错。
 *
 * 所以优先取**最后一个** verdict 词。只有在完全找不到时，
 * 才退回「出现次数最多」的判断。
 *
 * @param {string} text
 * @returns {'reply'|'wait'|'stop'|null}
 */
export function parseVerdict(text) {
  const s = String(text ?? '').toLowerCase().trim()
  if (!s) return null

  // ① 精确匹配（最理想：模型老老实实只回一个词）
  for (const v of VERDICTS) {
    if (s === v) return v
  }

  // ② 从尾部找：答案在最后。
  //
  //    取**最后 200 字符**再找 —— 推理内容可能很长，但结论一定在末尾。
  //    限定窗口是为了避免把前面 reasoning 里提到的词误当成答案。
  const tail = s.slice(-200)
  let lastHit = null
  let lastAt = -1
  for (const v of VERDICTS) {
    const re = new RegExp(`\\b${v}\\b`, 'g')
    for (const m of tail.matchAll(re)) {
      const at = m.index ?? 0
      if (at >= lastAt) { lastAt = at; lastHit = v }
    }
  }
  if (lastHit) return lastHit

  // ③ 全文里出现次数最多的（并列时取句尾）
  const counts = VERDICTS.map((v) => {
    const re = new RegExp(`\\b${v}\\b`, 'g')
    const hits = [...s.matchAll(re)].map((m) => m.index ?? 0)
    return { v, n: hits.length, lastAt: hits.length > 0 ? hits[hits.length - 1] : -1 }
  })
  const maxN = Math.max(...counts.map((c) => c.n))
  if (maxN > 0) {
    const tied = counts.filter((c) => c.n === maxN)
    // 并列 → 取句尾出现的那个（「不是 X，而是 Y」的结论在 Y）
    tied.sort((a, b) => b.lastAt - a.lastAt)
    return tied[0].v
  }

  // ④ 中文兜底（有些模型会翻译）
  if (/不接|别说|别插|沉默|等着|等等/.test(s)) return 'wait'
  if (/该说|要回|接话|回复/.test(s)) return 'reply'

  return null
}

export class ModelDecisionProvider extends DecisionProvider {
  id = 'model'
  label = '模型自主判断（按配置选模型）'

  /**
   * @param {object} cfg
   * @param {string} [cfg.model]        判断用的模型（provider/model 形式）；留空用默认
   * @param {number} [cfg.maxMessages]  上下文条数，默认 15
   * @param {number} [cfg.timeoutMs]    超时，默认 8000
   * @param {number} [cfg.maxTokens]    输出上限，默认 8（只要一个词）
   * @param {number} [cfg.temperature]  默认 0（判断要稳定）
   * @param {number} [cfg.retryOnBad]   解析失败时重试次数，默认 1
   * @param {object} deps
   * @param {object} deps.llm           ctx.llm 兼容对象
   */
  constructor(cfg = {}, deps = {}) {
    super()
    this.cfg = cfg ?? {}
    this.llm = deps.llm ?? null
    this.log = deps.log ?? {}
    /** 最近一次判断的原始输出，给 UI/日志用 */
    this.lastRaw = null
    /** 统计，便于看成本 */
    this.stats = { calls: 0, failed: 0, reply: 0, wait: 0, stop: 0, badParse: 0 }
  }

  /** 有没有配置好（没模型/没 llm 就用不了）。 */
  async probe() {
    if (!this.llm) return { ok: false, detail: '没有可用的 LLM' }
    if (typeof this.llm.stream !== 'function') return { ok: false, detail: 'llm 没有 stream 方法' }
    return { ok: true, detail: this.cfg.model ? `用 ${this.cfg.model} 判断` : '用默认模型判断' }
  }

  /**
   * 跑一次模型，拿到 verdict。
   *
   * ## 四个踩过的坑
   *
   * 1) **system 不能当顶层参数传**。`fallback.js` 的 `buildBody` 只读
   *    `o.messages`，根本没有 `o.system` —— 传了会被静默丢弃。
   *    正确做法是把 system 作为一条 role:'system' 的消息放进 messages。
   *
   * 2) **provider 必须显式给**。`fallback.js` 用 `byId.get(o.provider)`
   *    找渠道，给 undefined 就是「未配置的渠道」。
   *
   * 3) **maxTokens 不能给小**（2026-10-25 实测踩到，最坑的一个）。
   *    判断用的常常是**推理模型**：它先写一大段 `reasoning_content`，
   *    然后才吐正文。原来给 `maxTokens: 8`，8 个 token 全被推理吃光，
   *    `content` 一个字都没输出 —— 流里只收到 reasoning-delta，
   *    拼出来是空字符串，于是「解析不出 verdict」→ 次次降级到 rule。
   *
   *    症状极具误导性：日志只说「返回无法解析」，看着像模型不听话，
   *    实际是**预算不够它把话说完**。所以这里给足 512。
   *
   * 4) **用 stream 而不是非流式**。WhalePod 的 llm 接口只承诺 `stream()`
   *    （见 gateway/fallback.js），没有 chat()。这里把流拼起来当整段文本用。
   *    注意只收 `text-delta`；`reasoning-delta` 是模型的草稿，不要。
   */
  async _ask(input) {
    const system = buildSystemPrompt(input, this.cfg)
    const user = buildContext(input, this.cfg)
    const model = this.cfg.model || undefined

    // ⚠️ provider 必须能从模型名推出来，不能依赖外部传 providerId。
    //
    // 2026-10-25 实测踩到：`cfg.providerId` **从来没被赋过值** ——
    // createDecisionLayer 只把 cfg.model 透传进来，没人填 providerId。
    // 于是 `provider: undefined` → fallback 的 `byId.get(undefined)`
    // → 走「未配置的渠道」分支 → 吐一行 error chunk → 我拼出来是空字符串
    // → 次次判定失败、次次降级到 rule。
    //
    // 症状极具误导性：配置明明写了 `magpie/auto/deepseek-v4.1-flash`，
    // 日志却只说「解析不出 verdict」，完全看不出是 provider 没传。
    //
    // 现在从模型名里取第一段（`magpie/auto/…` → `magpie`）。
    // 显式配置 providerId 仍然优先，方便测试注入。
    const providerId = this.cfg.providerId
      ?? (model && model.includes('/') ? model.slice(0, model.indexOf('/')) : undefined)

    const chunks = []
    const stream = this.llm.stream({
      provider: providerId,
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // 512 而不是 8：推理模型的草稿可能吃掉几百 token，正文还没开始就截断了
      maxTokens: Number(this.cfg.maxTokens ?? 64),
      temperature: Number(this.cfg.temperature ?? 0),
      signal: AbortSignal.timeout(Number(this.cfg.timeoutMs ?? 8000)),
    })

    for await (const c of stream) {
      // 只收正文。reasoning-delta 是草稿，里面三个词都可能出现，收了必误判。
      if (c?.type === 'text-delta' && c.text) chunks.push(c.text)
      else if (c?.type === 'text' && c.text) chunks.push(c.text)
      else if (c?.type === 'error') throw new Error(c.message ?? c.error ?? 'llm error')
    }

    return chunks.join('')
  }

  async decide(input) {
    // ── 快速路径：这几种情况不问模型 ─────────────────────────
    //
    // 被 @ / 被叫名字 = 最明确的召唤，没有判断余地。
    // 走模型反而是浪费（还要多等 1-3 秒）。
    const last = input.messages?.[input.messages.length - 1]
    if (last?.mentionsMe) {
      return {
        reply: true,
        probability: 0.95,
        reason: '被 @ 了（不判断，直接回）',
        provider: this.id,
        delayMs: this._delay(600, 1800),
      }
    }

    // ── 正常路径：问模型 ─────────────────────────────────────
    let verdict = null
    let raw = ''
    const retries = Number(this.cfg.retryOnBad ?? 1)

    for (let attempt = 0; attempt <= retries; attempt++) {
      this.stats.calls++
      try {
        raw = await this._ask(input)
      } catch (e) {
        this.stats.failed++
        // 抛出去让注册表降级到 rule —— 不自己兜底，避免两套逻辑
        throw new Error(`模型判断失败：${String(e?.message ?? e)}`)
      }
      verdict = parseVerdict(raw)
      if (verdict) break
      this.stats.badParse++
      this.log.warn?.(`decision/model：解析不出 verdict（原始=${JSON.stringify(raw.slice(0, 60))}），重试 ${attempt + 1}/${retries}`)
    }

    this.lastRaw = raw

    // ⚠️ 私聊里解析失败也当 reply。
    //
    // 实测（2026-10-25）模型偶尔不按格式回，吐出「确实」「真的」这种词 ——
    // 群聊里解析失败降级到 rule 是合理的（rule 会重新判断该不该说），
    // 但**私聊里降级毫无意义**：私聊本来就要回，绕一圈只会多等几秒，
    // 还可能被 rule 的冷却逻辑吃掉。
    //
    // 所以私聊直接认定 reply，不抛错。
    const isPrivateScene = input.scene?.kind !== 'group'
    if (!verdict) {
      if (isPrivateScene) {
        this.stats.badParse++
        this.stats.forcedReply = (this.stats.forcedReply ?? 0) + 1
        this.log.info?.(`decision/model：私聊解析失败（原始=${JSON.stringify(raw.slice(0, 30))}），按必回处理`)
        return {
          reply: true,
          probability: 1,
          reason: '私聊必回（模型输出无法解析，按必回处理）',
          provider: this.id,
          raw: { verdict: 'reply', modelSaid: null, text: raw.slice(0, 200) },
          delayMs: this._delay(800, 2500),
          definitive: true,
        }
      }
      // 群聊解析失败抛错，交给 rule 兜底。这比瞎猜一个 verdict 安全。
      throw new Error(`模型返回无法解析：${JSON.stringify(raw.slice(0, 80))}`)
    }

    this.stats[verdict] = (this.stats[verdict] ?? 0) + 1

    // ⚠️ 私聊里**强制回复**。
    //
    // 提示词已经把 wait/stop 从私聊拿掉了，但模型不老实的时候还是会吐出来
    // （实测 2026-10-25：私聊里连回三次 wait，用户以为机器人死了）。
    // 这里再兜一道：私聊收到 wait/stop 一律当 reply。
    //
    // 为什么敢这么硬：私聊是**一对一**，对方每句话都是在跟你说，
    // 不存在「插不上嘴」。真不想说也应该是「回一句冷淡的」，
    // 而不是不吭声 —— 不吭声在私聊里的语义就是「没收到/坏了」。
    let effective = verdict
    const isPrivate = input.scene?.kind !== 'group'
    if (isPrivate && verdict !== 'reply') {
      this.stats.forcedReply = (this.stats.forcedReply ?? 0) + 1
      this.log.info?.(`decision/model：私聊收到 ${verdict}，强制改为 reply`)
      effective = 'reply'
    }

    const reply = effective === 'reply'
    const reasonMap = {
      reply: '模型判断：该接',
      wait: '模型判断：先不接，还在听',
      stop: '模型判断：这段跟我无关',
    }
    const reason = isPrivate && verdict !== 'reply'
      ? `私聊必回（模型原判 ${verdict}，已强制）`
      : reasonMap[effective]

    return {
      reply,
      // 模型给的是布尔判断，不是概率；这里回 1/0 便于统计口径统一，
      // 也让 applyThreshold 不会误伤（见 index.js 里对 model 的说明）
      probability: reply ? 1 : 0,
      reason,
      provider: this.id,
      raw: { verdict: effective, modelSaid: verdict, text: raw.slice(0, 200) },
      // 真人打字有延迟。reply 时给一点；wait/stop 不需要延迟
      delayMs: reply ? this._delay(800, 2500) : undefined,
      // 让调用方知道这是硬判断还是软概率
      definitive: true,
    }
  }

  _delay(min, max, rnd = Math.random) {
    return Math.round(min + (max - min) * rnd())
  }
}
