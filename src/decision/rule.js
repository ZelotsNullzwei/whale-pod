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
      /**
       * 私聊专用的冷却（ms）。
       *
       * ## 为什么私聊要单独一个（2026-10-23 实机测试发现）
       *
       * 群聊冷却的目的是**防刷屏**：群里别人在聊，机器人别一直插嘴。
       * 但私聊里**所有消息都是对机器人一个人说的**，不存在"刷屏"——
       * 用户连发几条（补充、追问、改口）是再正常不过的对话方式。
       *
       * 实测症状：沿用 15000ms 后，全日志「冷却中」出现 **193 次**，
       * 用户每发一句都要等十几秒才回，感受到的是「它答的是我上一条」。
       *
       * 所以私聊默认给一个很短的冷却（1500ms），只防「同一句话被连点」，
       * 正常连发完全不受影响。设成 0 则私聊完全不冷却。
       */
      privateCooldownMs: cfg.privateCooldownMs ?? 1500,
      maxConsecutiveTurns: cfg.maxConsecutiveTurns ?? 8,
      mentionProbability: cfg.mentionProbability ?? 0.95,
      idleChatterProbability: cfg.idleChatterProbability ?? 0.04,
      shortMessagePenalty: cfg.shortMessagePenalty ?? 0.25,
      /**
       * 群友发纯表情/纯图片时，回一个表情的概率（0 = 完全关闭）。
       *
       * ⚠️ 这个字段必须在这里显式登记 —— 构造函数是**白名单**，
       *    没登记的配置项在 this.cfg 里永远是 undefined，
       *    下游的 `?? 0.25` 会把用户的设置（包括 0）整个吞掉。
       *    （2026-10-24 就是漏了这一条，导致 mediaEmojiProbability=0
       *      关不掉、maxConsecutiveTurns 的门槛也读不到。）
       */
      mediaEmojiProbability: cfg.mediaEmojiProbability ?? 0.12,
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
    // 场景判定：私聊 / 群聊。多处要用（冷却、表情、加成都不同）。
    const isPrivate = input.scene?.kind !== 'group'

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

    // ── 3. 私聊 → 默认要回（用**独立**的短冷却） ──────────────
    //
    // ⚠️ 2026-10-23：私聊不再共用群聊的 cooldownMs（15s）。
    //
    //    群聊冷却防的是「别人在聊，别一直插嘴」；私聊里所有消息都是
    //    对机器人一个人说的，连发几条（补充、追问、改口）是正常对话，
    //    不存在刷屏问题。实测沿用 15s 后全日志「冷却中」出现 193 次，
    //    用户每句都要等十几秒，感受到的是「它答的是我上一条」。
    //
    //    现在用 privateCooldownMs（默认 1500ms），只防「同一句被连点」。
    if (input.scene?.kind === 'private') {
      const pc = Number(this.cfg.privateCooldownMs ?? 1500)
      if (pc > 0 && input.sinceMyLastMessage < pc) {
        const wait = Math.max(0, pc - input.sinceMyLastMessage)
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
    //
    // ⚠️ 但**「明确在问它」要豁免冷却**（2026-10-23 加，实测驱动）。
    //
    //    数据：群 704291282 历史上「冷却中」179 次，其中 21 次是带问句特征的。
    //    典型误伤（日志原文）：
    //      「肥鱼还活着吗」  距上次发言 2s  → 被拦
    //      「你能看到？」    距上次发言 ?s  → 被拦
    //    这些明显是在叫它，冷却不该拦 —— 用户看到的是「叫了它不应」。
    //
    //    但**不能直接调小 cooldownMs**：被拦的 179 条里 70 条是图片/表情、
    //    51 条是 ≤4 字短句，这些本来就不值得接，冷却在这里是**帮了忙**。
    //    所以只豁免「问句 + 在说它」这一种，其余照旧。
    //
    //    判据收得紧（两个条件都要满足），避免把普通闲聊也放进来：
    //      ① 在说它：mentionsSelf（名字/别名/@）或 detectFollowUp 命中
    //      ② 是问句：问号，或句尾疑问词
    const cooldownExempt = this._isAskingMe(last, msgs, input)
    if (input.sinceMyLastMessage < this.cfg.cooldownMs && !cooldownExempt) {
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
    if (cooldownExempt && input.sinceMyLastMessage < this.cfg.cooldownMs) {
      this._logCooldownExempt = (this._logCooldownExempt ?? 0) + 1
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

    // ⚠️ **追问：我刚说完话，别人接着说 → 大概率是在对[/我]说。**
    //
    //    实测踩过（2026-10-18）：群里刚问完它一个问题、它答了，紧接着
    //    有人问「你最喜欢的ai是谁」—— 日志打出 p=0.04 然后沉默。
    //    用户看到的是"我明明在问它，它却不理我"。
    //
    //    人不会这样。真人刚说完话，紧接着有人开口，默认是接自己的话茬；
    //    只有明显在跟别人聊时才会退出去。所以这里把"我上一条之后的第一句"
    //    当作强信号。
    //
    //    判据（任一成立即可，都要在"上一条是我"的前提下）：
    //      ① 消息里有第二人称（你/您/你们）→ 直接在对我说
    //      ② 是问句 / 招呼 / 祈使 → 在追问我
    //      ③ 与我上一条的内容有实词重叠 → 在接我的话
    //
    //    ⚠️ 只在"我上一条之后**没有别人插话**"时才算。如果中间已经有
    //       第三人说了话，那就不是追问了，交给常规规则判断。
    //
    //    ⚠️ 2026-10-23：现在**先判对象**（resolveAddressee）再看痕迹。
    //       实测「小红：你今天怎么了？」（在问另一个群友）原来也判成
    //       追问、p=0.97，机器人会抢答不属于它的话。现在这种明确在跟
    //       别人说的直接不算；对象不明的只给弱信号，不抬到追问档。
    const myLast = (() => {
      for (let i = msgs.length - 2; i >= 0; i--) if (msgs[i]?.isMe === true) return msgs[i]
      return null
    })()
    const followUp = detectFollowUp(msgs, input.self, {
      peers: input.peers,
      // 距我上次发言的间隔 —— 隔太久就不算「接着我的话」
      gapMs: myLast ? (Number(last.at ?? 0) || 0) - (Number(myLast.at ?? 0) || 0) || undefined : undefined,
    })
    if (followUp.hit) {
      // ⚠️ 2026-10-18 从 0.85 提到 0.97。
      //
      //    0.85/0.9 有个实际观测到的问题：**连着两次都掷不中**。
      //    日志证据：同一句「你最喜欢的ai是谁」，先 p=0.06 沉默（判据没生效），
      //    再 p=0.90 又沉默（判据生效了但没掷中）。用户体验上这就是
      //    "我问了两遍它都不理我"，而背后的概率是 10% —— 单看一次没问题，
      //    但人力感知只认"我问了它没答"这个事实。
      //
      //    追问不同于随机插话：它是**明确的对话邀请**。对这种信号留 10%
      //    装死概率没有收益，只有伤害。留 3% 只是为了避免极端情况
      //    （有人恶意连刷几十遍）下每条都秒回，显得像机器。
      //
      //    ⚠️ 2026-10-23：只有**强信号**（紧接着我、中间没人、对象明确
      //       是我）才给 0.97。隔了几句的弱信号给 0.85 —— 它更可能是
      //       在跟别人聊，给满档会抢话。
      const pFollow = followUp.strength === 'strong' ? 0.97 : 0.85
      p = Math.max(p, pFollow)
    }

    // ── 纯媒体消息（只有图/表情包/语音/视频，没有任何实际文字）──────────
    //
    // ⚠️ 2026-10-24 修 bug：群里每发一个表情包它就回话。
    //
    // 踩过的坑：parseMessage 会把非文本 segment 归一化成占位标记
    // （[图片] / [表情包] / [表情包:名字] / [表情:N] / [表情] / [语音] / [视频]），
    // 于是 "「[表情包]」图×1" 这种文本**既不是 Emoji 也不是语气词**，
    // 下面那条 isPureFiller 正则完全匹配不到 —— 压制规则形同虚设，
    // 紧接着又被「带图片 → 抬高意愿」那条乘 4 抬到 0.65~0.9。
    //
    // 日志实证（群 704291282）：表情包 255 次决策里 100 次走了「随机插话命中」
    // = 39.2%，而普通文本只有 13.4%，是 2.9 倍。
    //
    // 判据：把占位标记全部剥掉后，若**剩下的实际文字 ≤ 4 个字符**，
    // 就算纯媒体消息 —— 和 isPureFiller 的口径保持一致。
    const MEDIA_MARKER_RE = /\[(?:图片|表情包(?::[^\]]*)?|表情(?::\d+)?|语音|视频)\]/g
    const rawText = String(text ?? '')
    // ⚠️ 带 g 的正则用 test() 会保留 lastIndex，第二次调用结果会错。
    //    这里用 match() 一次拿到全部匹配，避免状态污染。
    const mediaMatches = rawText.match(MEDIA_MARKER_RE)
    const hasMediaMarker = (mediaMatches?.length ?? 0) > 0
    const textWithoutMedia = rawText.replace(MEDIA_MARKER_RE, '').trim()
    const isPureMedia = hasMediaMarker && textWithoutMedia.length <= 4

    // ── 纯媒体消息 → **用表情回应**，而不是用文字接话 ─────────────
    //
    // ⚠️ 2026-10-24 改：原来这里是「压制概率」（让它沉默），
    //    但用户提出更符合群聊习惯的做法 —— **别人发梗图，回个表情**。
    //
    //    为什么这个更好：
    //      · 回文字 = 插嘴（抢了别人的话，还要调模型烧 token）
    //      · 回表情 = 附和（和真人刷梗图一样，零 token 成本）
    //      · 群聊里真人就是这么参与的：发图 → 回个表情，谁也不觉得被打扰
    //
    //    所以这里不再走「发言/沉默」的二选一，而是给出第三个结果：
    //    `emojiReply: true` —— 由 bridge 直接发一个收藏表情，**不调模型**。
    //
    //    仍然保留门槛，不能变成群里最爱发表情的人：
    //      · 被点名 → 不走这条路（要正常说话，见上面的 @ 分支）
    //      · 追问中 → 不走（有人在等它回话）
    //      · 已经连续发过言 → 不走（避免刷屏）
    //      · 冷却中 → 不走（交给冷却逻辑）
    //      · 概率：mediaEmojiProbability（默认 0.25）
    //
    // ⚠️⚠️ 2026-10-24 第二次修：**去掉了原来的 `&& !thread.hit`**。
    //
    //    原来的想法是「话题连续时别打断，交给正常流程」，方向搞反了：
    //    话题连续 = 群里正连着刷梗图，**这恰恰是最容易刷屏的场景**。
    //    实测（重启后 30 条表情包决策）有 8 条绕过了这里，落到下面的
    //    「话题连续加成」：
    //        p = Math.max(p * 2.5, 0.8)   → p=0.80
    //    然后用**文字**接了表情包 —— 正是这次要修的那个 bug。
    //
    //    现在：纯媒体消息**永远不走文字路**。要么 emojiReply，要么沉默。
    //    话题连续时反而**提高**表情概率（大家都刷图，跟着附和张表情最自然）。
    if (isPureMedia
      && !last.mentionsMe
      && !followUp.hit
      && !isPrivate
      && input.consecutiveTurns < (this.cfg.maxConsecutiveTurns ?? 8)
      && !(input.sinceMyLastMessage < (this.cfg.cooldownMs ?? 15000))) {
      const base = Number(this.cfg.mediaEmojiProbability ?? 0.12)
      // 话题连续（在刷梗图）→ 参与意愿更高，但上限 0.6，别喧宾夺主
      const pEmoji = thread.hit ? Math.min(base * 1.5, 0.6) : base
      if (rnd() < pEmoji) {
        return {
          reply: true,
          emojiReply: true,
          probability: pEmoji,
          reason: thread.hit
            ? '纯表情/图片（在刷梗图）→ 回一个表情（不调模型）'
            : '纯表情/图片 → 回一个表情（不调模型）',
          // 表情回应要更快 —— 真人在群里刷表情是即时的，等 3 秒就错过了
          delayMs: this._delay(400, 1400, rnd),
        }
      }
      // 没掷中 → 沉默（不再走后面的随机插话，纯媒体消息不该用文字接）
      return {
        reply: false,
        probability: pEmoji,
        reason: '纯表情/图片 → 本次不回应（避免刷表情）',
      }
    }

    // 纯语气词/表情符号：确实没什么可接的。
    // 这里用**直接封顶**而不是乘系数 —— 系数法只降 15%，和正常短句
    // 几乎拉不开差距（实测 28% vs 40%，区分度不足）。
    //
    // ⚠️ 2026-10-24：把 isPureMedia 也并进来 —— 纯表情包消息和纯语气词
    //    在「没什么可接的」这件事上是同一类，之前漏掉了。
    const isPureFiller = (/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}哈哈嘿嗯哦喔噢额呃唉诶草6啊?？!！。.~～]+$/u.test(text)
      && text.replace(/[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').length <= 4)
      || isPureMedia
    // ⚠️ 话题连续 / 正在追问我时不压 —— 大家都在发梗图，单看一条是"纯表情"，
    //    放在连续语境里恰恰是"该接话"的信号；追问时发的表情也是如此。
    if (isPureFiller && !nickHit && !thread.hit && !followUp.hit) {
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
    //
    // ⚠️⚠️ 2026-10-24 修 bug：**纯媒体消息不再享受这个加成**。
    //
    //    这条规则的本意是「别人发了图 + 说了话，机器人可以就着话和图接一句」，
    //    但之前它连「只有图、一个字没有」的消息也一起抬到 0.65~0.9，
    //    等于把上面 isPureFiller 的压制整个推翻。
    //
    //    为什么纯图不该接：
    //      · 表情包在群聊里主要是"情绪回声"，不是"求回应"。连发表情包时
    //        每张都接一句，观感就是刷屏。
    //      · 模型有视觉能力（实测能准确描述青蛙/鲸鱼娘/猫的睡姿），
    //        所以一旦放行就会给出很贴切的吐槽 —— 质量越高越显得"它又在插嘴"。
    //      · 产品卖点就是「分得清在跟谁说话」，纯图没有任何指向它的信号。
    //
    //    保留的情形：带文字 + 带图（"看我这张图"）、被点名、追问、话题连续。
    if (!isPureMedia
      && (/\[图片\]|\[表情包|\[表情:/.test(text) || (last.images ?? []).length > 0)) {
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
    //
    // ⚠️ 追问（followUp）同理，而且要**排在最高**：它是「有人在对我说话」
    //    的明确信号，上面抬到 0.97 若被这里削回 0.9，等于白改 ——
    //    这个 bug 被概率分布测试抓出来过（200 次全是 0.9，没有一次 0.97）。
    //
    // ⚠️ 2026-10-23：弱追问只给 0.85，所以封顶也要跟着分档 ——
    //    否则弱信号会被削到 0.9 以下，和普通插话拉不开差距。
    p = followUp.hit
      ? Math.min(p, followUp.strength === 'strong' ? 0.97 : 0.85)
      : (nickHit ? Math.min(p, 0.95) : Math.min(p, 0.9))

    // ── @ 了**别人** → 几乎必定是在跟别人说话，压到近乎沉默 ──────────
    //
    // ⚠️ 2026-10-24 修 bug：实测机器人在别人 @ 别人时抢答。
    //
    //    日志证据（群 704291282）：
    //      「@2854197266 /国际服千里眼」
    //        → 决策 → 发言 (p=0.06, 来源=rule, 群聊中随机插话命中)
    //      LYFan 是在 @ 另一个 bot 问卡池，我们的机器人却接了话。
    //      群历史原文：机器人随后说「千里眼？本鱼要是有这本事，早自己去抽卡了」
    //
    //    统计：12 条「@ 别人」的消息里 2 条抢答（另一条是 followUp，判对了）。
    //
    //    这正是 v0.2.5 的卖点「分得清在跟谁说话」—— 视频 n2 那个场景
    //    （小红问小明，机器人在线但不动）讲的就是这个。
    //    但代码里**一直缺这条规则**：原来只知道「mentionsMe=false → 当普通群聊」，
    //    于是 @ 别人的消息走进了随机插话。
    //
    //    判据：消息里有 `@<QQ号>`，但 mentionsMe 为 false（= @ 的不是我）。
    //
    //    两个例外（实测都判对过，不能一刀切）：
    //      · followUp.hit —— 接着我的话 + 用了第二人称。实测
    //        「@3604321136 你要玩吗」→ p=0.97「接话（接着我的话，用了第二人称）」，
    //        虽然 @ 了别人，但那句确实是在问我，该接。
    //      · nickHit —— 同时 @ 了别人又明确叫了我的名字（罕见但存在）。
    const atOthers = !last.mentionsMe && !nickHit && /@\d{5,}/.test(text)
    if (atOthers && !followUp.hit) {
      p = Math.min(p, 0.02)
    }

    const reply = rnd() < p
    // 原因文案要能区分几种典型场景，否则调日志时只能看到一句
    // "无 @，保持沉默"，分不出是"没叫我"还是"我正在被追问"，还是"在叫别人"。
    const why = reply
      ? (followUp.hit ? `接话（${followUp.why}）` : '群聊中随机插话命中')
      : (followUp.hit
        ? `本该接话（${followUp.why}）但本次随机放弃`
        : (atOthers ? '这条 @ 的是别人，不是叫我' : '群聊中无 @，本次保持沉默'))
    return {
      reply,
      probability: Number(p.toFixed(3)),
      reason: why,
      delayMs: reply ? this._delay(1500, 5000, rnd) : undefined,
    }
  }


  /**
   * 这句话是不是**明确在问它**？（用于冷却豁免）
   *
   * ## 为什么需要
   *
   * 实测（群 704291282，日志 179 次「冷却中」）：
   *
   *   「肥鱼还活着吗」  距上次发言 2s  → 被冷却拦住 → 用户看到「叫了它不应」
   *   「你能看到？」    同样被拦
   *
   * 这类消息**明显是在叫它**，冷却拦下来是纯误伤。
   *
   * ## 但为什么不能直接调小冷却
   *
   * 同一批 179 条里，70 条是图片/表情、51 条是 ≤4 字短句 ——
   * 这些本来就不值得接，冷却在这里是**帮了忙**。
   * 缩短冷却会让机器人开始回每张表情包。
   *
   * 所以只豁免「**问句 + 在说它**」这一种，两个条件都要满足。
   *
   * ## 判据（收得紧）
   *
   *   ① 在说它：`mentionsSelf`（名字/别名/QQ号）**或** `detectFollowUp` 命中
   *      —— 后者覆盖「刚答完话、紧接着有人追问」这种没叫名字的情况
   *   ② 是问句：问号，或句尾疑问词（呢/吗/吧/啥/怎么/为什么…）
   *
   * 任一条件不满足 → 不豁免，照常冷却。
   *
   * @param {object} last  最后一条消息
   * @param {Array} msgs   历史消息
   * @param {object} input DecisionInput
   * @returns {boolean}
   */
  _isAskingMe(last, msgs, input) {
    const text = String(last?.text ?? '').trim()
    if (!text) return false

    /**
     * ① 在说它？
     *
     * ⚠️ 这里**不能直接用 `detectFollowUp().hit`** —— 两者的尺度不同：
     *
     *   · `detectFollowUp` 服务于「要不要主动插话」，所以证据不足时返回
     *     `unclear`（宁可少说，避免抢话）。
     *   · 冷却豁免服务于「本来该回的被冷却挡了」，方向相反 ——
     *     这里应该**宁可多放行**，因为漏掉一个明确召唤比多回一句更伤。
     *
     * 实测踩到：「你能看到？」（刚答完话紧接着问）被判 `unclear`，
     * 于是豁免不生效、仍被冷却拦住 —— 而这正是要修的那类误伤。
     *
     * 所以判据放宽为「**在说它**」的两种任一：
     *   a) 提到名字/别名/QQ号（最硬）
     *   b) 紧接在我发言之后（中间没人插话）+ 是问句
     *      —— 这就是「刚说完话，紧接着有人问我」，中文群里最常见的追问形态
     */
    const named = mentionsSelf(text, input.self)

    // ② 是问句？
    const isQuestion = /[?？]/.test(text)
      || /(呢|吗|吧|么|啥|怎么|为什么|为啥|哪个|哪里|多少|咋)\s*[啊呀哦噢诶]?\s*[。.!！~～]?$/.test(text)

    if (named) return isQuestion

    // 没叫名字：要求「紧接着我」+「是问句」+「有指向我的痕迹」三个都成立
    //
    // ⚠️ 只靠「紧接着 + 问句」太松了（实测反例：「吃啥？」紧接在我之后
    //    也被判成在问我）。必须再有一条**指向我**的痕迹：
    //      · 第二人称（你/您/你们）—— 中文里最直接的"对你说"
    //      · 承接词（那/所以/为什么…）—— 在接我上一句
    if (!isQuestion) return false
    const pointsAtMe = /(你|您|你们)/.test(text) || REFERENTIAL_OPENING.test(text)
    if (!pointsAtMe) return false

    /**
     * ⚠️ 还要排除「**在跟别人说话**」。
     *
     * 实测反例：「小红你今天怎么了？」—— 有第二人称「你」、紧接在我之后、
     * 是问句，三条都满足，于是被豁免。但它明明在问另一个群友。
     *
     * 判据同 `resolveAddressee`：句中出现了别的群友名字、且没提我 → 不是问我。
     */
    for (const peer of input.peers ?? []) {
      const name = String(peer?.name ?? '').trim()
      if (name.length < 2) continue
      if (String(peer?.id ?? '') === String(last?.sender ?? '')) continue  // 自己的名字不算
      if (text.includes(name)) return false
    }

    const list = msgs ?? []
    // 找「我」最后一条发言的位置（排除当前这条）
    let myIdx = -1
    for (let i = list.length - 2; i >= 0; i--) {
      if (list[i]?.isMe === true) { myIdx = i; break }
    }
    if (myIdx === -1) return false

    // 我发言之后到当前这条之间必须**没有人插话**
    const between = list.slice(myIdx + 1, list.length - 1)
    if (between.length > 0) return false

    // 间隔太久就不算「紧接着」（默认 5 分钟，与 detectFollowUp 一致）
    const myAt = Number(list[myIdx]?.at ?? NaN)
    const lastAt = Number(last?.at ?? NaN)
    if (Number.isFinite(myAt) && Number.isFinite(lastAt) && lastAt - myAt > 5 * 60_000) return false

    return true
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
 * 「承上」的起首词 —— 出现这些词说明这句话是**接上一句**说的。
 *
 * 「那你最喜欢哪个？」「为什么啊」「所以呢」都是在接话；
 * 「你今天怎么了？」是独立发问，不一定是接我的话。
 * 中文群里没有问号也能靠这些词判断承接关系，比标点可靠。
 */
const REFERENTIAL_OPENING = /^(那|那么|所以|然后|还有|可是|但是|不过|为啥|为什么|怎么|咋|为啥子)/

/**
 * 判断当前这条消息**在对谁说话**。
 *
 * ## 为什么需要（2026-10-23 实测踩过）
 *
 * 原来的 `detectFollowUp` 只要「我上一条之后」出现第二人称（你/您），
 * 就判定「在追问我」，概率直接抬到 0.97。但中文群里「你」是**最高频的
 * 人称代词之一**，绝大多数时候指向的是另一个群友：
 *
 *   机器人：我觉得 V4 快一些
 *   小红：你今天怎么了？        ← 明显在问别人，却被判成追问 → p=0.97
 *   小红：你在干嘛呢            ← 同上
 *
 * 实测这三条全部 HIT、全部 p=0.97，和真追问一模一样 —— 机器人会抢着
 * 回答本来不是问它的话。这是本次改造要修的**首要误判**。
 *
 * ## 判据（按可靠度排序，命中即返回）
 *
 *   ① 引用了谁（`replyTo`）—— 最硬的证据，QQ 的引用回复是显式的。
 *      引用我的消息 → 'me'；引用别人的 → 'other'。
 *   ② 句中出现**别人的名字**（且没提我）→ 'other'
 *   ③ 上一条是**同一个人的连续发言** → 'me'（他在补充刚才那句）
 *   ④ 紧接在我发言之后，且这句有**承接词**（那/所以/为什么…）或提了我
 *      → 'me'（明确在接我的话茬）
 *   ⑤ 其余 → 'unclear'（证据不足，不硬猜）
 *
 * ## 为什么 ⑤ 返回 'unclear' 而不是 'other' 或 'me'
 *
 * 「不确定」是真实存在的第三种状态：紧接我之后、带第二人称、但没有任何
 * 承接痕迹的句子（「你今天怎么了？」），它既可能是问我，也可能是问
 * 旁边的人。**证据不足时不该假装确定** —— 判成 'me' 会让机器人抢话
 * （这正是原来 0.97 的 bug），判成 'other' 会让它该接的时候装死。
 * 交给上层按"弱信号"处理，两边都不极端。
 *
 * @param {Array<{isMe?:boolean, sender?:string, senderName?:string, text?:string, replyTo?:string, id?:string}>} msgs
 *   历史消息（升序，最后一条是当前这条）
 * @param {object} [self] {qq, nickname, aliases}
 * @param {object[]} [peers] 已知群友 {id,name}[]（用于识别「别人的名字」）
 * @returns {{who:'me'|'other'|'unclear', why:string}}
 */
export function resolveAddressee(msgs, self, peers) {
  const list = msgs ?? []
  const last = list[list.length - 1]
  if (!last || last.isMe) return { who: 'unclear', why: '没有可判断的消息' }

  // ① 引用回复 —— 最硬的证据
  const quoteId = last.replyTo != null ? String(last.replyTo) : null
  if (quoteId) {
    const quoted = list.find((m) => m && String(m.id ?? '') === quoteId)
    if (quoted) {
      if (quoted.isMe) return { who: 'me', why: '引用了我自己的消息' }
      return { who: 'other', why: `引用了${quoted.senderName ?? '别人'}的消息` }
    }
    // 引用的那条不在记忆窗口里：没法确认是谁。
    // 不能默认是「我」—— 那会让机器人抢答别人的引用回复。
    return { who: 'unclear', why: '引用的消息已不在上下文里' }
  }

  const text = String(last.text ?? '')

  // ② 句中出现**别的群友**的名字，且没提我 → 在跟那个人说
  //
  // ⚠️ 必须排在「紧接在我之后」前面：点名别人的优先级高于相邻性。
  //    实测踩过：「小红你今天怎么了？」紧接在我发言后，被当成在追问我。
  if (text && !mentionsSelf(text, self)) {
    for (const p of peers ?? []) {
      const name = String(p?.name ?? '').trim()
      if (name.length < 2) continue
      if (String(p?.id ?? '') === String(last.sender ?? '')) continue // 自己的名字不算
      if (text.includes(name)) {
        return { who: 'other', why: `在跟「${name}」说` }
      }
    }
  }

  // 我最后一条发言的位置
  let myIdx = -1
  for (let i = list.length - 2; i >= 0; i--) {
    if (list[i]?.isMe === true) { myIdx = i; break }
  }
  if (myIdx === -1) return { who: 'unclear', why: '我还没说过话' }

  const between = list.slice(myIdx + 1, list.length - 1)
  const prev = list[list.length - 2]

  // ③ 同一个人连发（上一条也是他）→ 在补充刚才那句
  if (prev && prev.isMe !== true
    && String(prev.sender ?? '') === String(last.sender ?? '')) {
    return { who: 'me', why: '同一人连续发言，在补充刚才那句' }
  }

  // ④ 有**承接词**（那/所以/为什么…）→ 在接刚才的话
  //
  // ⚠️ 这一条**不受"中间有没有人插话"限制**：中间夹了一句「嗯」之后
  //    再说「那你最喜欢哪个？」，承接关系依然成立。原来只在紧接时
  //    才检查，导致这类最常见的交错追问被判成 unclear、p 掉回 0.12。
  if (REFERENTIAL_OPENING.test(text.trim())) {
    return { who: 'me', why: '有承接词，在接刚才的话' }
  }

  // ⑤ 紧接在我之后 + 提到我 → 在接我的话
  if (between.length === 0) {
    if (mentionsSelf(text, self)) return { who: 'me', why: '紧接在我发言之后并提到我' }
    // 只有相邻、没有承接痕迹 —— 可能是在问旁边的人。
    return { who: 'unclear', why: '紧接在我之后，但没有承接痕迹' }
  }

  return { who: 'unclear', why: '' }
}

/**
 * 判断当前这条是不是在「追问我」。
 *
 * ## 为什么需要这个
 *
 * 实测踩过（2026-10-18）：群里先是 @ 它问了句，它答了；紧接着有人问
 * 「你最喜欢的ai是谁」—— 日志打出 p=0.04 然后沉默。用户看到的是
 * "我明明在问它，它却不理我"。
 *
 * 原因：判断"在叫我吗"只看三个信号 —— 被 @、叫名字、引用我的消息。
 * 这三样都没有时，一律归到 4% 的随机插话档。可现实里**最常见的情况
 * 就是接着上一句问**，谁会每句话都重新 @ 一次？
 *
 * ## 判据
 *
 * 先用 `resolveAddressee` 判断「在跟谁说话」，**只有明确在跟我说
 * （who==='me'）才算追问**：
 *
 *   · 明确在跟别人说（other） → 不算（2026-10-23 修的首要误判）
 *   · 对象不明（unclear）      → 也不算。证据不足时宁可保守 ——
 *     原来「带个『你』就 0.97」让机器人抢答别人的对话，比漏接更伤。
 *
 * 确认是对我说之后，再看三条痕迹（任一成立）：
 *   ① 第二人称（你/您/你们）        → 直接在对我说
 *   ② 问句 / 招呼 / 祈使句          → 在追问我
 *   ③ 与我上一条有实词重叠          → 在接我的话
 *
 * @param {Array<{isMe?:boolean, text?:string}>} msgs
 * @param {object} [self]
 * @param {object} [opts]
 * @param {object[]} [opts.peers]  已知群友，用于识别「在跟别人说」
 * @param {number} [opts.gapMs]    当前消息距我上一条发言的间隔（ms）
 * @param {number} [opts.maxGapMs] 超过这个间隔就不算「紧接着」（默认 5 分钟）
 * @returns {{hit:boolean, why:string, who:'me'|'other'|'unclear', strength:'strong'|'weak'}}
 */
export function detectFollowUp(msgs, self, opts = {}) {
  const list = msgs ?? []
  const miss = { hit: false, why: '', who: 'unclear', strength: 'weak' }
  if (list.length < 2) return miss

  // 从后往前找「我」最后一条发言的位置（排除当前这条）
  let myIdx = -1
  for (let i = list.length - 2; i >= 0; i--) {
    if (list[i]?.isMe === true) { myIdx = i; break }
  }
  if (myIdx === -1) return miss

  // 我发言之后到当前这条之间的消息
  const between = list.slice(myIdx + 1, list.length - 1)

  const last = list[list.length - 1]
  const text = String(last?.text ?? '').trim()
  if (!text) return miss

  /**
   * 间隔太久就不算「接着我的话」。
   *
   * ⚠️ 实测踩过：机器人答完话 30 分钟，群里有人问「今天中午吃啥」，
   *    照样被判成追问（p=0.97）。真人不会觉得半小时后的一句话是在
   *    接自己刚才的话茬。默认 5 分钟，可用 opts.maxGapMs 覆盖。
   *
   * 没显式给 gapMs 时**从消息时间戳自己算** —— 调用方忘了传也不会漏判。
   */
  const maxGap = Number(opts.maxGapMs ?? 5 * 60_000)
  let gapMs = Number(opts.gapMs)
  if (!Number.isFinite(gapMs)) {
    const myAt = Number(list[myIdx]?.at ?? NaN)
    const lastAt = Number(last?.at ?? NaN)
    gapMs = Number.isFinite(myAt) && Number.isFinite(lastAt) ? lastAt - myAt : NaN
  }
  if (Number.isFinite(gapMs) && gapMs > maxGap) return miss

  /**
   * 判定"是不是在接我的话"。
   *
   * ⚠️ 原来要求 between 里**一个人都没有** —— 太严了。实测（2026-10-18）
   *    19:24 那次：它答完「你最喜欢的ai是谁」后隔了一分多钟，中间夹了
   *    别人的零散发言，于是判据完全失效，p 掉回 0.04。
   *
   *    现实里群聊是交错的，"我问完你、中间别人插了两句、我又追问"非常
   *    常见。所以改成按**人数与距离**分级：
   *      · 中间没人             → 强信号（原有逻辑）
   *      · 中间 ≤1 人且 ≤2 条   → 仍算追问，但理由标为"弱"
   *      · 中间 ≥2 人           → 不算（那真的是在跟别人聊）
   */
  const others = new Set(between.filter((m) => m?.isMe !== true).map((m) => m?.senderId ?? m?.sender ?? m?.senderName ?? '?'))
  const strong = between.length === 0
  const weak = between.length <= 2 && others.size <= 1
  if (!strong && !weak) return miss

  // ── 先判断在跟谁说话 ────────────────────────────────────────
  //
  // 这是 2026-10-23 加的第一道闸。原来直接看「有没有第二人称」，
  // 于是「小红：你今天怎么了？」（在问另一个群友）被判成追问、p=0.97。
  const who = resolveAddressee(list, self, opts.peers)
  if (who.who !== 'me') {
    return {
      hit: false,
      why: who.who === 'other' ? `在跟别人说（${who.why}）` : '不确定在跟谁说话',
      who: who.who,
      strength: 'weak',
    }
  }

  const tag = strong ? '' : '（隔了几句）'
  const addr = `，${who.why}`

  // ① 第二人称 —— 最直接的"在对我说"
  if (/(你|您|你们)/.test(text)) {
    return { hit: true, why: `接着我的话，用了第二人称${addr}${tag}`, who: 'me', strength: strong ? 'strong' : 'weak' }
  }

  // ② 问句 / 招呼 / 祈使
  //
  // ⚠️ 疑问语气词也算问句。中文群里大量问句不带问号：
  //    「cluade，gpt，gemini，grok四选一呢」「那你说啥」「为什么啊」
  //    只看 [?？] 会漏掉一大半，所以补上句尾的疑问词。
  //    2026-10-23：句尾的「啊/呀/哦/噢」不影响判断（「为什么啊」也是问句）。
  const looksQuestion = /[?？]/.test(text)
    || /(在吗|在么|有人吗|谁在|在不在)/.test(text)
    || /(呢|吗|吧|么|啥|怎么|为什么|为啥|哪个|哪里|多少)\s*[啊呀哦噢诶]?\s*[。.!！~～]?$/.test(text)
  if (looksQuestion) {
    return { hit: true, why: `我刚说完，紧接着发问${addr}${tag}`, who: 'me', strength: strong ? 'strong' : 'weak' }
  }

  // ③ 与我上一条有实词重叠 —— 在接我的话
  const mine = contentWords(String(list[myIdx]?.text ?? ''))
  const theirs = contentWords(text)
  const shared = [...theirs].filter((w) => mine.has(w))
  if (shared.length >= 1) {
    return { hit: true, why: `接着「${shared.slice(0, 2).join('、')}」在说${addr}${tag}`, who: 'me', strength: strong ? 'strong' : 'weak' }
  }

  return { ...miss, who: 'me' }
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
  //
  // ⚠️ 2026-10-24 修：原来是无条件 `t.includes(qq)` —— 只要 QQ 号是
  //    文本里**任意位置的子串**就算「在叫我」。短号会严重误伤：
  //    假设 bot 的 QQ 是 9，则「@2854197266」里的 '9' 也算在叫它，
  //    于是它把 @ 别人的消息当成 @ 自己。
  //    （测试用 self.qq='9' 时，三条「@别人」用例全部误判成 nickHit，
  //      这个缺陷就是这么暴露出来的。）
  //
  //    现在要求 QQ 号**前面不是数字**，即必须是一段完整的数字，
  //    而不是更长数字里的一截。生产环境 QQ 是 10 位数，
  //    这样「@2854197266」不再匹配「3039392113」，
  //    而「@3039392113」和裸写的「3039392113」仍能正常命中。
  if (self?.qq) {
    const qq = String(self.qq)
    const idx = t.indexOf(qq)
    if (idx >= 0 && !/\d/.test(t[idx - 1] ?? '')) return true
  }

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
