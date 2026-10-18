/**
 * 内置规则决策者（零成本兜底）。
 *
 * 它不做「智能判断」，只做**像人会做的事**：
 *   - 被 @ 了 → 几乎必回
 *   - 刚说过话 → 冷却期内不回（防刷屏）
 *   - 连续说了几轮 → 主动收尾，让别人说
 *   - 群里没人理我 → 偶尔插一句（概率很低）
 *   - 消息是别人的对话、没提到我 → 大概率不回
 *
 * 这套逻辑并不聪明，但**永远可用、零成本、不会崩**，
 * 是 Jev 未配置/失败时的安全网。
 *
 * 注意：这不是「模拟人类」的终极答案 —— 它正是 `qq-bridge` 那套
 * 状态机的同类做法，实测偏"呆"。真正的活人感来自 Jev，
 * 这一层只保证「不傻回、不刷屏」。
 */

import { DecisionProvider } from './provider.js'

export class RuleDecisionProvider extends DecisionProvider {
  id = 'rule'
  label = '内置规则（零成本兜底）'
  costPerCall = 0

  /**
   * @param {object} cfg decision.rule 配置
   * @param {object} [opts]
   */
  constructor(cfg = {}, opts = {}) {
    super()
    this.cfg = {
      cooldownMs: cfg.cooldownMs ?? 15000,
      maxConsecutiveTurns: cfg.maxConsecutiveTurns ?? 3,
      mentionProbability: cfg.mentionProbability ?? 0.95,
      idleChatterProbability: cfg.idleChatterProbability ?? 0.04,
      shortMessagePenalty: cfg.shortMessagePenalty ?? 0.25,
      // 延迟区间：由上层按人格配置传入（注意 0 是合法值，不能用 ?? 兜底）
      delayMin: cfg.delayMin,
      delayMax: cfg.delayMax,
    }
    // 随机源可注入，便于测试确定性
    this.random = opts.random ?? Math.random
  }

  async probe() {
    return { ok: true, detail: '内置规则，始终可用' }
  }

  /**
   * 决策入口。
   *
   * ⚠️ rule 的所有分支都是**最终结论** —— 要么命中硬规则（@ 我 / 冷却中 /
   *    连续发言过多），要么已经掷过骰子（`rnd() < p`）。它给出的
   *    `probability` 是"回复意愿"（掷骰子之前的权重），**不是置信度**。
   *
   *    所以标记 `decided: true`，让外层 shouldReply **不要再用阈值筛一遍**。
   *    否则会出现「p=0.8 却沉默」这种自相矛盾的显示（骰子说不中，
   *    外层又按阈值判一次），看起来像坏了。实测用户就是这么反馈的。
   */
  async decide(input) {
    const d = await this._decide(input)
    return { ...d, decided: true }
  }

  /** 真正的判断逻辑（分支很多，统一由 decide() 包一层）。 */
  async _decide(input) {
    const rnd = this.random
    const msgs = input.messages ?? []
    const last = msgs[msgs.length - 1]
    if (!last) {
      return { reply: false, probability: 0, reason: '没有可判断的消息' }
    }

    // ── 1. 是我自己发的 → 绝不回自己 ─────────────────────────
    if (last.isMe) {
      return { reply: false, probability: 0, reason: '最后一条是我自己发的' }
    }

    // ── 2. @ 我 → 几乎必回 ──────────────────────────────────
    //
    // 刻意排在**冷却检查之前**：@ 是最明确的"叫它"信号，
    // 防刷屏不该拦这个。真被刷屏时由下面的「连续发言轮数」兜住。
    if (last.mentionsMe) {
      const p = this.cfg.mentionProbability
      const reply = rnd() < p
      return {
        reply,
        probability: p,
        reason: reply ? '被 @ 了' : '被 @ 但本次随机放弃（保留一点随机性）',
        delayMs: this._delay(600, 1800, rnd),
      }
    }

    // ── 3. 私聊 → 默认要回（除非冷却） ──────────────────────
    if (input.scene?.kind === 'private') {
      if (input.sinceMyLastMessage < this.cfg.cooldownMs) {
        const wait = Math.max(0, this.cfg.cooldownMs - input.sinceMyLastMessage)
        return {
          reply: false,
          probability: 0.1,
          reason: `私聊：距我上次发言 ${Math.round(input.sinceMyLastMessage / 1000)}s，仍在冷却（${Math.ceil(wait / 1000)}s 后补回）`,
          // ⚠️ defer 表示「不是不想回，是时候未到」。
          //    bridge 看到它会**排队重试**，而不是把这条消息丢掉。
          //    没有这个标记的话，冷却期内的消息就永久沉默了 ——
          //    用户看到的是"问了它却不理我"，而其实只是晚了几秒。
          defer: { waitMs: wait },
        }
      }
      return { reply: true, probability: 0.9, reason: '私聊消息', delayMs: this._delay(500, 2000, rnd) }
    }

    // ── 4. 群里连续说了太多轮 → 收尾 ────────────────────────
    if (input.consecutiveTurns >= this.cfg.maxConsecutiveTurns) {
      return {
        reply: false,
        probability: 0.05,
        reason: `已连续发言 ${input.consecutiveTurns} 轮，主动收尾`,
      }
    }

    // ── 5. 冷却期内不回（防刷屏） ───────────────────────────
    if (input.sinceMyLastMessage < this.cfg.cooldownMs) {
      const secs = Math.round(input.sinceMyLastMessage / 1000)
      const wait = Math.max(0, this.cfg.cooldownMs - input.sinceMyLastMessage)
      return {
        reply: false,
        probability: 0.1,
        reason: `距我上次发言 ${secs}s，冷却中（${Math.ceil(wait / 1000)}s 后补回）`,
        // 同私聊：冷却不是"不理"，只是"晚点理"。见上面 defer 的说明。
        defer: { waitMs: wait },
      }
    }

    // ── 6. 群聊里没人 @ 我 → 判断"这话值不值得接" ────────────
    //
    // ⚠️ 这里**不能按长度惩罚**。实测群聊消息绝大多数都很短
    //    （「调阈值」「不知道」「？」），中文 3 个字就是一句正常的
    //    对话。原来 `length <= 3` 就压意愿，等于把大部分正常发言
    //    都判成"闲聊不值得接"，结果机器人几乎永远沉默。
    //
    //    改成看**内容特征**：
    //      想问点什么 / 在吐槽 / 发了东西 → 值得接
    //      纯语气词（哈哈、嗯、哦）         → 没啥可接的
    let p = this.cfg.idleChatterProbability
    const text = String(last.text ?? '')

    // ⚠️ **消息里提到它的名字 → 明显是在说它，必须接话。**
    //
    //    实测踩过：群里在聊「你不是蓝色🥶吗」「居然是青蛙」——
    //    这是在讨论机器人本身，但它一律沉默，因为它只在"被 @"时
    //    才意识到和自己有关。没 @ 的中文群里，提名字才是常态。
    //
    //    这段放在所有降权之前，且用 max() 抬到高位 —— 提名字就是
    //    最明确的"叫它"信号，不该被后面的短消息/语气词惩罚压回去。
    //
    //    ⚠️ 2026-10-18 改成**几乎必回**（0.95），原来是 0.75。
    //       实测症状：群里有人直接喊「大肥鱼」，日志打出 p=0.75 然后
    //       沉默 —— 用户看到的是"叫了它名字它不理"，非常伤体验。
    //       提名字是仅次于 @ 的最强召唤信号，不该有四分之一概率装死。
    //       （留 5% 是为了极端情况：连喊十几次时别每次都秒回，太假）
    const nickHit = mentionsSelf(text, input.self)
    if (nickHit) {
      p = Math.max(p, 0.95)
    }

    // ⚠️ **话题连续性：正在聊同一件事时，别装没听见。**
    //
    //    实测踩过：群里连着发了三四条同一话题（都在聊它、或者都在发同一个
    //    梗图），它却因为"每条独立掷骰子"而断续沉默 —— 看着像走神。
    //
    //    真人在这种时候几乎必接：大家围着同一个话题说，你也在这个群里，
    //    自然会插上话。所以这里检测"最近几条是不是同一个话题"，是就把
    //    意愿大幅抬起来。
    //
    //    判定线索（按可靠性排序）：
    //      ① 最近几条都是媒体（图片/表情）→ 在刷同一个梗
    //      ② 最近几条都提到了它（名字/@）  → 明显在说它
    //      ③ 最近几条互相有相同的实词片段 → 同一个话题
    const thread = detectThread(msgs, input.self)
    if (thread.hit) {
      // 抬到高位但不封顶 —— 留一点"有时也让别人说"的余地。
      // ⚠️ 用 0.8 而不是 0.65：基准已调到 0.5，0.65 拉不开差距
      //    （实测 74% → 80%，几乎看不出）。0.8 才有明显区分。
      p = Math.max(p * 2.5, 0.8)
    }

    // 纯语气词/表情符号：确实没什么可接的。
    // 这里用**直接封顶**而不是乘系数 —— 系数法只降 15%，和正常短句
    // 几乎拉不开差距（实测 28% vs 40%，区分度不足）。
    const isPureFiller = /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}哈哈嘿嗯哦喔噢额呃唉诶草6啊?？!！。.~～]+$/u.test(text)
      && text.replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').length <= 4
    // ⚠️ 话题连续时不压 —— 大家都在发梗图，单看一条是"纯表情"，
    //    放在连续语境里恰恰是"该接话"的信号。
    if (isPureFiller && !nickHit && !thread.hit) {
      p = Math.min(p, this.cfg.idleChatterProbability * 0.45)
    }

    // 群里人少（消息少）→ 更像一对一，可以稍微主动
    if (msgs.length <= 3) p *= 1.5

    // 刚有人问句（含问号）→ 提高意愿（可能是在问大家）
    if (/[?？]/.test(text)) p *= 2.0

    // 「在吗」「有人吗」「谁在」这类招呼 → 明显是在找人说话
    if (/(在吗|在么|有人吗|谁在|在不在|有人没)/.test(text)) p = Math.max(p * 3.0, 0.6)

    // 吐槽/情绪表达（语气词后缀、感叹）→ 容易接话
    if (/(死了|麻了|裂开|崩了|绝了|离谱|无语|服了|难绷|笑死|好耶|爽)/.test(text)) p *= 1.8

    // ⚠️ 带图片/表情包 → **显著**提高意愿。
    //    为什么：发图通常是"想让人看这个"，纯文本规则看不到图片内容，
    //    只看到 "[图片]" 三个字。不特判的话，别人发图它一律沉默 ——
    //    而"看图说话"恰恰是它最该表现的场景。
    //    （注意 text 里的 [图片]/[表情包]/[表情:N] 是 parseMessage 填的标记）
    if (/\[图片\]|\[表情包|\[表情:/.test(text) || (last.images ?? []).length > 0) {
      p = Math.max(p * 4.0, 0.65)
    }

    // 上限 0.9（原来是 0.8）。
    // ⚠️ 之前 0.8 的上限把"话题连续"的加成**整个吃掉了** ——
    //    基准 0.5 + 连续加成算出来 1.25 也被削到 0.8，于是
    //    "同话题"和"孤立一句"的回复率几乎一样（都是 80%），
    //    调参完全没效果。抬到 0.9 才留出区分空间。
    //
    // ⚠️ 2026-10-18：被**点名**的情况下不封顶到 0.9 —— 上面已经把
    //    nickHit 抬到 0.95，这里若按 0.9 削一刀等于白抬。
    //    点名 = 最明确的召唤，给 0.95；其余情况仍按 0.9 封顶。
    p = nickHit ? Math.min(p, 0.95) : Math.min(p, 0.9)
    const reply = rnd() < p
    return {
      reply,
      probability: Number(p.toFixed(3)),
      reason: reply ? '群聊中随机插话命中' : '群聊中无 @，本次保持沉默',
      delayMs: reply ? this._delay(1500, 5000, rnd) : undefined,
    }
  }


/** 生成一个随机延迟（像人一样别秒回）。 */
  _delay(min, max, rnd) {
    // 显式配置优先；注意 0 是合法值（测试里用它关掉延迟）
    const lo = this.cfg.delayMin !== undefined ? this.cfg.delayMin : min
    const hi = this.cfg.delayMax !== undefined ? this.cfg.delayMax : max
    if (lo === 0 && hi === 0) return 0
    return Math.round(lo + rnd() * (hi - lo))
  }
}

  /**
 * 这句话是不是在说机器人（提到它的名字 / 叫它）。
 *
 * ## 为什么要做这个
 *
 * 群里绝大多数时候不会规规矩矩地 @ 机器人，而是**直接叫名字**：
 *   「你不是蓝色🥶吗」「肥鱼出来」「WhalePod 你说呢」
 * 我们原来只在 `mentionsMe`（真 @）时才意识到跟自己有关，于是
 * 群里聊到它本人，它却一直沉默 —— 看起来像个傻子。
 *
 * ## 匹配策略
 *
 * 昵称常带符号/装饰（「蓝色大肥鱼」「🍅番茄🍅」），所以：
 *   1. 剥掉 emoji / 标点，只留中英文数字
 *   2. 整串命中 → 一定算
 *   3. 否则取**2~4 字的连续片段**去撞（如「蓝色」「肥鱼」「大肥」），
 *      且要求片段至少 2 字 —— 单字太容易误伤（"的""是"这种到处都是）
 *
 * 另外把常见的通用称呼也算上（机器人/小助手 之类），
 * 免得换个昵称就完全失效。
 *
 * @param {string} text
 * @param {object} [self]  {qq, nickname}
 * @returns {boolean}
 */
export function mentionsSelf(text, self) {
  const t = String(text ?? '')
  if (!t) return false

  // 直接叫 QQ 号
  if (self?.qq && t.includes(String(self.qq))) return true

  // 昵称里的有效片段
  for (const token of nicknameTokens(self?.nickname)) {
    if (t.includes(token)) return true
  }

  // 用户自定义别名（配置项 `decision.aliases`，默认见 DEFAULT_ALIASES）
  for (const alias of self?.aliases ?? DEFAULT_ALIASES) {
    if (matchesAlias(t, alias)) return true
  }

  // 通用称呼兜底（用户换了昵称也还能认出来）
  return /(机器人|bot|Bot|BOT|小助手|助手)/.test(t)
}

/**
 * 默认别名 —— 用户在群里实际怎么叫它。
 *
 * ## 为什么需要别名表
 *
 * 昵称切片只能覆盖「蓝色大肥鱼」里的片段（蓝色/大肥/肥鱼），而群里
 * 实际会叫 **鱼 / 鲸鱼 / 白饭** —— 这些字眼里没有一个出现在昵称中，
 * 切片永远匹配不到，机器人就一直装没听见。
 *
 * ## 为什么「鱼」放最后
 *
 * 单字「鱼」误伤率高：「摸鱼」「咸鱼」「鱼丸」「鱼香肉丝」全都不在叫它。
 * 所以短别名要求**独立成词**（前后不是中文），由 matchesAlias 判断；
 * 多字别名（鲸鱼/白饭/肥鱼）直接包含即可。
 */
export const DEFAULT_ALIASES = ['蓝色大肥鱼', '肥鱼', '鲸鱼', '白饭', '鱼']

/**
 * 别名是否命中（短别名要求独立成词，长别名直接包含）。
 *
 * ## 单字别名的难点
 *
 * 「鱼」只有 1 个字：`includes('鱼')` 会把「摸鱼」「咸鱼」「鱼香肉丝」
 * 全算进来（这些显然不是在叫它）。所以要求它**独立成词**。
 *
 * 但「独立成词」不能写成"左右都不是中文"：
 *   「鱼呢」「鱼啊」「鱼酱」「鱼你说话了」显然都是在叫它，
 *   可「鱼」后面紧跟着中文。
 *
 * 折中做法：左右不能是**构成常见词语的词素**。
 * 具体排除「X鱼」「鱼Y」这类构词：
 *   摸鱼 咸鱼 鱼丸 鱼香 鱼骨 鱼片 钓鱼 捞鱼 酸菜鱼 红烧鱼 …
 * 实现上不穷举，而是要求单字别名**前面**不是这些动词/形容词，
 * **后面**不是这些名词性后缀。
 *
 * @param {string} text
 * @param {string} alias
 * @returns {boolean}
 */
export function matchesAlias(text, alias) {
  const t = String(text ?? '')
  const a = String(alias ?? '')
  if (!t || !a) return false
  if (a.length >= 2) return t.includes(a)

  // 单字：逐个出现位置判断，命中任意一个可用的位置就算
  const NOT_BEFORE = '摸咸钓捞捕杀煎烤炖煮蒸炸酸红清糖醋剁喂养吃烧焖煸溜爆烹'
  const NOT_AFTER = '丸香骨片干汤罐头尾肚皮肉刺翅油排罐头香料'
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== a) continue
    const prev = i > 0 ? t[i - 1] : ''
    const next = i + 1 < t.length ? t[i + 1] : ''
    if (prev && NOT_BEFORE.includes(prev)) continue
    if (next && NOT_AFTER.includes(next)) continue
    // 前后都是英文/数字 → 在标识符里，不算
    if (/[A-Za-z0-9]/.test(prev) || /[A-Za-z0-9]/.test(next)) continue
    return true
  }
  return false
}

/**
 * 从昵称里切出可用来匹配的片段。
 *
 * '蓝色大肥鱼' → ['蓝色大肥鱼', '蓝色大肥', '色大肥鱼', '蓝色', '色大', '大肥', '肥鱼']
 *
 * 只保留 2~4 字且**只含中英文数字**的片段 —— 带 emoji/标点的片段
 * 撞不上正常句子，留着只会增加噪音。
 */
export function nicknameTokens(nickname) {
  const raw = String(nickname ?? '').trim()
  if (!raw) return []
  // 剥掉 emoji / 标点 / 空白，只留中英文数字
  const clean = raw.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
  if (clean.length < 2) return []
  const out = new Set()
  // 整串（>=2 字才要）
  if (clean.length >= 2) out.add(clean)
  // 2~4 字窗口
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= clean.length; i++) {
      out.add(clean.slice(i, i + len))
    }
  }
  // 太常见的片段不要（否则「今天」「什么」这类词会一直误命中）
  const STOP = new Set([
    '什么', '怎么', '这个', '那个', '今天', '明天', '现在', '可以', '不是',
    '没有', '知道', '觉得', '应该', '可能', '真的', '哈哈', 'the', 'and',
  ])
  return [...out].filter((x) => x.length >= 2 && !STOP.has(x.toLowerCase()))
}


/**
 * 检测"最近几条是不是在聊同一个话题"。
 *
 * ## 为什么需要
 *
 * 决策层是**逐条独立**掷骰子的。群里连着三四条同一话题时，它会
 * 一条接一条地沉默（每次都有 40~60% 概率不回），看起来像走神。
 * 真人不会这样 —— 大家围着同一话题说，你自然会接上。
 *
 * ## 判定线索（任一命中即算"同一话题"）
 *
 *   ① 最近 3 条里有 ≥2 条带媒体（图片/表情）→ 在刷同一个梗
 *   ② 最近 3 条里有 ≥2 条提到它        → 明显在说它
 *   ③ 最近 3 条里出现重复的实词片段     → 同一个话题
 *      （去掉停用词后的 2~3 字片段，重叠 ≥2 个就算）
 *
 * 只取**最近 3 条**：范围再大就容易把无关闲聊也算进来。
 *
 * @param {Array} msgs 历史消息（升序，最后一条是当前这条）
 * @param {object} [self] {qq, nickname}
 * @returns {{hit:boolean, why:string}}
 */
export function detectThread(msgs, self) {
  const recent = (msgs ?? []).slice(-3).filter((m) => !m.isMe)
  if (recent.length < 2) return { hit: false, why: '' }

  // ① 媒体刷屏
  const mediaN = recent.filter((m) => /\[图片\]|\[表情包|\[表情:/.test(String(m.text ?? ''))).length
  if (mediaN >= 2) return { hit: true, why: `最近 ${mediaN} 条都是图/表情` }

  // ② 都在说它
  const nickN = recent.filter((m) => mentionsSelf(String(m.text ?? ''), self)).length
  if (nickN >= 2) return { hit: true, why: `最近 ${nickN} 条都在提它` }

  // ③ 实词重叠
  const bags = recent.map((m) => contentWords(String(m.text ?? '')))
  // 两两之间重叠 ≥2 个实词 → 同一话题
  for (let i = 0; i < bags.length; i++) {
    for (let j = i + 1; j < bags.length; j++) {
      const shared = [...bags[i]].filter((w) => bags[j].has(w))
      if (shared.length >= 2) return { hit: true, why: `都在说「${shared.slice(0, 2).join('、')}」` }
    }
  }
  return { hit: false, why: '' }
}

/** 常见虚词/语气词，参与"话题重叠"判断时会制造大量假阳性。 */
const THREAD_STOP = new Set([
  '这个', '那个', '什么', '怎么', '为什么', '可以', '不是', '没有', '就是',
  '还是', '但是', '因为', '所以', '如果', '已经', '现在', '今天', '明天',
  '昨天', '我们', '你们', '他们', '自己', '时候', '一直', '真的', '好像',
  '感觉', '应该', '可能', '知道', '觉得', '哈哈', '笑死', '确实', '有点',
])

/**
 * 从一句话里取"实词片段"，用来判断两条消息是不是在聊同一件事。
 *
 * 做法很朴素（没有分词器）：滑 2~3 字的窗口，滤掉停用词，
 * 留下中文/字母数字片段。对"话题是否相同"这个判断足够了 ——
 * 我们不需要词性，只要**两条消息有没有共同的具象词**。
 */
export function contentWords(text) {
  const t = String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')          // 去掉 [图片] 这类标记
    .replace(/@\d+/g, ' ')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, ' ')
  const out = new Set()
  for (const chunk of t.split(/\s+/)) {
    if (!chunk) continue
    if (chunk.length <= 3) {
      // 短词直接用（但滤掉停用词）
      if (!THREAD_STOP.has(chunk.toLowerCase()) && chunk.length >= 2) out.add(chunk)
      continue
    }
    // 长串滑 2~3 字窗口
    for (let len = 3; len >= 2; len--) {
      for (let i = 0; i + len <= chunk.length; i++) {
        const w = chunk.slice(i, i + len)
        if (!THREAD_STOP.has(w.toLowerCase())) out.add(w)
      }
    }
  }
  return out
}
