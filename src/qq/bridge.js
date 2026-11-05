/**
 * 桥接层：QQ 消息 → 决策 → LLM → 发回 QQ。
 *
 * 这是「活人感」真正落地的地方。流程：
 *
 *   1. 收到消息
 *   2. 白名单过滤（fail-closed：没配白名单就不响应）
 *   3. 存入短期记忆
 *   4. 决策层判断「该不该说话」（Jev / 规则 / 自定义）
 *   5. 决定说话 → 组装 prompt（人格 + 记忆 + 上下文）
 *   6. 调 LLM（免费渠道优先）
 *   7. 按人的方式发出（延迟、分句）
 *   8. （可选）更新长期记忆摘要
 *
 * 关键设计：
 *   - **决策与表达分离** —— 省钱的根源。判断很便宜，生成才贵。
 *   - **[SILENT] 约定** —— 模型也可以主动选择不说话。
 *   - **失败静默** —— 任何一层出问题都只记日志，不把异常抛给 QQ 侧。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { makeMessage } from '../memory/short.js'
import { resolveCandidates, openFirstAvailable, applyFreeOrder, PROVIDER_MODEL_HINTS } from '../gateway/router.js'
import { deriveRouting } from '../gateway/strategy.js'
import { needsFreshInfo, webSearch, formatSearchContext, pickCoverImage, checkBalance } from '../gateway/search.js'
import { fetchLinkPreview, fetchLinkPreviewRendered, extractLink, formatLinkContext } from '../gateway/link-preview.js'
import { detectCode, formatCodeContext } from '../gateway/codes.js'
import { fetchAlbum, formatAlbumContext, JmHostCache, JmMemoStore } from '../gateway/jm.js'
import { readJmPages, formatAlbumPagesNote } from '../gateway/jm-read.js'
import FACE_TABLE from './faces.json' with { type: 'json' }
import { InteractionTracker, BegState, decideBeg } from './beg.js'
import { ProactiveScheduler, ProactiveState } from './proactive.js'
import { extractFindImageMarkers, stripFindImageMarkers, resolveFindImage, findImageKey, isDuplicateFindImage } from './imageFindMarkers.js'
import { extractBanMarkers, stripBanMarkers, validateBan, describeBanMinutes, extractNicknameMarkers, stripNicknameMarkers, validateNickname } from './groupAdmin.js'
import { applyQuestionOverride } from './questionGate.js'
import { shouldAnswerSticker } from './stickerGate.js'
import { StickerTagStore, stickerKey, splitTags } from './sticker-tags.js'
import { extractQQMarkers, runQQMarkers, buildEmojiHint } from './qqActions.js'
import { hasBiliLink, resolveBvid, fetchVideoInfo, fetchTopComments, fetchDanmaku, fetchAudioCandidates, downloadAudio, formatVideoContext } from './bilibili.js'
import { transcribeVideoCached, transcribeVideoDetailed } from './asr.js'
// 梗百科 —— 本地词库（零成本），联网查梗之前先走它；没收录才放行联网
import { openMemeDb, memeHint } from './memewiki.js'
// 画面（分镜图）—— B 站自己的 x/player/videoshot，不用 ffmpeg
import { fetchVideoShots, formatShotsNote } from './videoshot.js'
import { buildBalanceHint } from './balanceHint.js'
import { buildVarietyHint, buildExpressionHint } from '../persona/variety.js'
import { currentSlot, renderDayPlan } from '../memory/dayPlan.js'
import { fetchHotTopics, filterTopics, fetchForum } from './hot-topics.js'

/**
 * 单张图下载上限的兜底值。
 *
 * ⚠️ 必须和 `config/store.js` 的 `reply.maxImageBytes` 默认值保持一致。
 *    原来这里写死 4MB，而线上 `config.json` 里根本没有 `reply` 段 ——
 *    所以真正生效的一直是**这个硬编码值**，改 store 的默认值等于没改。
 *    2026-10-28 实测：4.7MB 的游戏截图被这个 4MB 挡在门外，模型看不到图。
 */
const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024

/** 模型表示"不说话"的标记。 */
export const SILENT = '[SILENT]'

/**
 * 「对方在指代一张图」的**强形式**（话里带"图"字）。
 *
 * ## 起因（2026-10-30 实测）
 * ```
 * 21:19:15 「[图片]」 → 已附图 → [我]「阿哈的祝福还带图配文？这待遇不低啊」   ✅ 看了
 * 21:19:24 「[图片]」 → 已附图 → [我]「许愿阿哈不歪，结果阿哈自己出皮肤了」     ✅ 看了
 * 21:21:54 「这个」   → **没附图** → [我]「这图我这边糊成一团，看不清」   ← 用户报的问题
 * ```
 * 「这个」是**纯文本**，而附图规则只认"当前消息自带的图"—— 那条规则是
 * 2026-10-27 为了修「发过一张图之后，接下来每条纯文本都重附旧图」故意收紧的。
 * 收紧是对的，但**指代旧图时它手上就什么都没有**，只能回"看不清"。
 *
 * ## 为什么要分强弱两档
 * 裸「这个 / 那个」在群聊里太常见，而且经常指的不是图（指一段话、一个链接）。
 * 所以：
 *   · 强形式（这条正则）→ 允许往前找 **6 条**
 *   · 弱形式（`REFER_IMAGE_WEAK`）→ **只认紧挨着的前一条**
 * 宁可漏（它就老实说"看不清"），也别乱挂一张不相干的图上去。
 */
export const REFER_IMAGE_STRONG =
  /(这图|那图|这张图|那张图|这幅图|那幅图|图里|图上|看图|图片里|刚发的图|刚才那[张幅]?图|刚刚那[张幅]?图|上面那[张幅]?图|我发的[那这][张个幅])/

/**
 * 「对方在指代一张图」的**弱形式** —— 只认消息**开头**的指代词。
 *
 * 末尾的「这个」常常是语气词（「我喜欢这个」），开头的才更像"指着某样东西说"。
 * 而且弱形式**只回溯 1 条**，所以哪怕判错，挂上的也是刚刚那条，代价小。
 */
export const REFER_IMAGE_WEAK =
  /^[\s,，。:：]*[（(]?\s*(?:@\S{1,24}\s+)?(这个|那个|这张|那张|这图|那图)/

/**
 * 附的是「旧图」时的说明 —— 拼进 `extras`，排在 `mediaHint` **前面**。
 *
 * ⚠️ 为什么必须是**独立的**一段，而不是塞进 `mediaHint`：
 * `mediaHint` 的前提是 `hasMedia`，而 `hasMedia` 是从文本里的 `[图片]` 标记
 * 判出来的（见 `const hasMedia = /\[表情包|\[表情:|\[图片\]/...`）。
 * 但**指代旧图的那种消息恰恰是纯文本** —— `hasMedia` 为 false，
 * `mediaHint` 是空串。图附上去了却一句话都没交代，
 * 它就会把这张旧图当成"刚发给它的"来评论，答非所问。
 */
/**
 * ★★ 喂给模型的「提示原文」—— 注入侧和清洗侧**共用这一份**。
 *
 * ## 为什么要提出来当常量
 * 这类提示是**拼进对话记录**的，模型偶尔会照抄出来（历史上踩过好几次：
 * 媒体描述、时间戳都漏过）。所以输出侧必须能**按原文擦掉**。
 *
 * 如果原文在注入处写一遍、在清洗处再写一遍 —— 以后改了一处、另一处就失效，
 * 而失效的表现是「兜底悄悄不生效」：不报错、不告警，
 * 只能等下一次用户再撞见一句漏出来的提示。
 *
 * @type {string[]}
 */
export const PROMPT_NOTE_TEXTS = [
  /*
   * ⚠️ 2026-11-04 改：把「不要描述画面」写成**形状**，并给出可自查的一句。
   *
   * 原来只写「有字的梗图就懂意思…不要描述画面」，实测她照样描述：
   *   · 14:34:54 群「（眉头一皱）肥嘟嘟是它，不是我啊」
   *   · 14:53:32 私「笑嘻嘻举着个牌子，光笑不说话，这招可糊弄不了本鱼」
   * 第二句就是标准的"图里画了什么" —— 对方自己看得见，说一遍等于废话。
   *
   * 所以加一条自检：**这句话单独拎出来像在给盲人描述这张图 → 就是错了**。
   */
  /*
   * ⚠️ 2026-11-04 傍晚再改（用户原话）：
   * 「没有说别人发表情必须回复表情，也可以是文字，但是不要去读表情，
   *   没有人会这么做」
   *
   * ## 群日志能直接看出来（2026-11-04 当天 18 组「他发表情 → 她回」）
   * ```
   * 12:47:58  [表情包:震惊]        ← 4 秒就回，回的是图
   * 12:52:09  [表情包:震惊]
   * 12:57:47  [表情包:无语]
   * 13:39:27  [表情包:无语]
   * 16:05:56  [表情包:震惊]
   * 17:46:37  [表情包:震惊]
   * ```
   * 一是**几乎一律用图回图**（只有少数几条接的是文字），
   * 二是**反复就那两张**（震惊 4 次、无语 2 次）。
   * 群友当场问过「突然一个雷霆大头你要干嘛」—— 图不搭，对方一头雾水。
   *
   * 所以这里改成：**文字、表情都正常，没有"必须回图"这条规矩**；
   * 但"别描述画面"仍然是硬的。
   */
  '对方发表情包：**看懂意思就行** —— 接一句（用文字完全可以），或者回一个表情，都正常；'
    + '**没有"别人发表情就必须回表情"这条规矩**。\n'
    + '⚠️ **不描述、也不评价这张图**（画了什么、丑、比例歪、像不像、眼睛瞪哪儿）—— '
    + '没人会评价别人发的表情；理解它在表达什么，用你自己的话接住就行。\n'
    + '写完自查：这句话要是像在给盲人描述这张图，或者像在点评画功，那就是写错了。\n'
    + '⚠️ **也别认领这张图**（「这图看着像我」「你拿本鱼当素材了」）—— 表情就是表情，不是你的画像；\n'
    + '   只有他**明确问**「像不像你」的时候，才答一句。\n'
    + '⚠️ 也别老回同一张（连着几条都是震惊、无语，看着像你只有两张脸）。',
  // 上一版（2026-11-04 上午）的原文，老记录里可能还留着，一并擦
  '有字的梗图：懂意思就用自己的话接一句；'
    + '**别描述图里画了什么**（谁、在干什么、举着什么、什么姿势、什么表情）—— '
    + '对方自己看得见。写完自查一下：这句话要是单独拎出来像在给盲人描述这张图，'
    + '那就是写错了。纯情绪图（没字）只回一个表情，不要打字。',
  // 旧版本（2026-10-27 ~ 2026-11-03）的原文，老记录里可能还留着，一并擦
  '有字的梗图就懂意思、用自己的话接一句；纯情绪图（没字）只回一个表情，不要打字也不要描述画面',
  '纯情绪图（没字）只回一个表情，不要打字也不要描述画面',
  '只回一个表情，不要打字也不要描述画面',
]

/**
 * `[改标签:嫌弃,厌恶]`（2026-11-04）
 *
 * ## 为什么要有
 * 用户在私聊里发一张表情过来说「这个标签打错了，是嫌弃不是震惊」——
 * 她嘴上应了「改了改了」，但**代码里没有任何通道**能让这句话成真：
 * `stickerTags.set()` 全项目只有自动打标签那一处调用。
 * 结果就是连着两句谎报（"改了改了" / "标签改完了"），
 * 而 sticker-tags.json 的 mtime 停在 15:17，一个字都没动。
 *
 * 所以给她一个**真通道**：标记 → 真的改库 → 日志有记录 → 正文后面还附一句
 * 「（标签改成…）」。私聊（close）权限宽一点：可以改"刚发出去的那张"；
 * 群聊只允许改"对方这条里那张"，免得她随手改库影响群里用法。
 */
export function extractTagMarkers(text) {
  const out = []
  const re = /[\[［]\s*改标签\s*[:：]\s*([^\]］]*)[\]］]/g
  for (const m of String(text ?? '').matchAll(re)) out.push(String(m[1] ?? '').trim())
  return out
}

/** 把改标签标记从正文里剥掉（绝不能发给用户）。 */
export function stripTagMarkers(text) {
  return String(text ?? '')
    .replace(/[\[［]\s*改标签\s*[:：]\s*[^\]］]*[\]］]/g, '')
    // 剥掉标记后会留下两个连续空格 —— 收成一个，别让正文看着像缺字
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export const IMG_REFER_NOTE = `## ⚠️ 这次附的图是**旧的**

对方这条消息里**没有图**，但它的话在指代一张图（「这个 / 那张 / 图里…」），
所以我把**上面某条消息里发过的那张图**一起给你了。

- 先确认它指的就是这张 —— 对得上就正常接话
- **对不上就直说**「没看到你说的那张图」，别硬凑
- 别把这张图当成"刚发给你的"去评论`

/**
 * 把系统提示 + 历史，组装成 dsh-llm 认的 messages 数组。
 *
 * 抽成独立函数是为了**能被直接测试** —— 这里踩过两个导致"全渠道失败"的坑：
 *
 *  ① `system` 的 content 必须是**数组块**，不能是裸字符串。
 *     上游判"这条请求有没有图片"时会遍历所有消息调
 *     `content.some(b => b.type === 'image')` —— 字符串没有 .some，
 *     直接抛 "content.some is not a function"。纯文本时不走这个检查，
 *     所以只在**带图**时暴露（症状：一发图所有渠道全失败）。
 *
 *  ② `role:'assistant'` 的消息**必须带 source**。
 *     dsh-llm 的 forAdapter() 会读 `message.source.replayState`，
 *     source 为 undefined 就抛 "Cannot read properties of undefined
 *     (reading 'replayState')" —— 同样是全渠道失败。
 *     症状更迷惑：**只在多轮对话时崩**（历史里有自己的回复），
 *     单条消息测不出来，看起来像随机故障。
 *
 * @param {object} o
 * @param {string} o.system          系统提示（纯文本）
 * @param {Array}  o.history         记忆里的消息（makeMessage 结构）
 * @param {Map}    [o.imageCache]    图片 ref → ImageBlock
 * @param {object} [o.lastRoute]     本次路由 {provider,model}，兜底用
 * @returns {Array} messages
 */
export function buildChatMessages({ system, history = [], imageCache = new Map(), lastRoute = null, selfId = '', selfName = '' }) {
  /*
   * 把历史里出现的 `@<QQ号>` 换成昵称，并标出「这是你自己」。
   *
   * ## 为什么需要
   *
   * onebot 解析 at 段时只能拿到 QQ 号，所以消息文本里是 `@123450003`。
   * 模型看到一串裸数字根本不知道在 @ 谁 —— 实测回过
   * 「艾特谁呢，数字直接甩出来了」，而且认不出那个号就是自己。
   *
   * 这里用**历史消息里已经出现过的 sender/senderName** 建一张映射表，
   * 能查到的换成昵称；查不到但等于 selfId 的标成「@你(机器人)」。
   */
  const nameOf = new Map()
  for (const m of history) {
    const id = String(m.sender ?? '').trim()
    const name = String(m.senderName ?? '').trim()
    if (id && name) nameOf.set(id, name)
  }
  const atToName = (text) => String(text ?? '').replace(/@(\d{5,12})/g, (all, id) => {
    if (selfId && String(id) === String(selfId)) return `@${selfName || '你'}（就是你自己）`
    const n = nameOf.get(String(id))
    return n ? `@${n}` : `@某群友(${id})`
  })
  /*
   * 给每条历史标上**相对时间**。
   *
   * ## 为什么需要
   *
   * 没有时间戳时，模型不知道两条消息隔了多久 —— 实测翻过车：
   *   它: ……我又不去医院 / 我去吃饭了      (19:04:38)
   *   你: [表情包]
   *   它: [表情包]
   *   你: 吃
   *   它: 吃了，白米饭两碗                  (19:05:13)
   *
   * 「我去吃饭了」到「吃了，白米饭两碗」只隔 **35 秒**，
   * 但它以为过了很久，把「吃」（=去吧）读成「你吃了吗」，
   * 回出一个自相矛盾的答案。
   */
  const nowMs = Date.now()
  const fmtGap = (ms) => {
    const sec = Math.max(0, Math.round(ms / 1000))
    if (sec < 60) return sec + ' 秒'
    const min = Math.round(sec / 60)
    if (min < 60) return min + ' 分钟'
    const hr = Math.floor(min / 60)
    if (hr < 24) return hr + ' 小时'
    return Math.floor(hr / 24) + ' 天'
  }
  // 最新一条给「X 前」（相对现在）；更早的给「+X」（距下一条）
  /*
   * ⚠️ 渲染前把 `at` **单调化**（2026-10-31 修）。
   *
   * ## 问题
   * `[我]` 的 `at` 是**推送完成时间**，`[他]` 是**收到时间** —— 两个基准混用。
   * 而生成要几秒，于是时间会**倒流**（实测）：
   * ```
   * 13:27:33 [他] 吃这么好
   * 13:27:50 [我] 吃得好点怎么了…     ← 回复
   * 13:27:47 [他] 我就只吃了…         ← 用户消息，比回复更早，却排在后面
   * ```
   * 后果：`stamp()` 里 `nextAt > at` 不成立 → `gap = 0` → **那条消息没有时间标签**
   * （实测 3/16 条自己的消息没标签），模型对节奏的感知是错的。
   *
   * ## 为什么不排序
   * **数组顺序本身是对的** —— 它就是处理顺序 = 对话顺序。
   * 按 `at` 排序反而会把对话打乱。所以只让**用于算间隔的时间序列**单调，
   * 原数据一个字不动。
   *
   * ## 代价
   * 极少数倒流的地方真实间隔会被压成 1ms —— 但总比"没有标签"好。
   */
  const monoAt = (() => {
    let prev = 0
    return history.map((m) => {
      const v = Math.max(Number(m.at ?? 0), prev + 1)
      prev = v
      return v
    })
  })()
  const stamp = (m, idx) => {
    const at = monoAt[idx]
    if (!at) return ''
    if (idx === history.length - 1) return '（' + fmtGap(nowMs - at) + '前）'
    const nextAt = monoAt[idx + 1] ?? 0
    const gap = nextAt > at ? nextAt - at : 0
    if (gap <= 0) return ''
    // 单调化之后会出现 1ms 的间隔 —— 写成「+0 秒」像 bug，用「紧接着」更准
    if (gap < 1000) return '（紧接着）'
    return '（+' + fmtGap(gap) + '）'
  }

  /*
   * 把「这条在引用哪句话」渲染出来（2026-11-01）。
   *
   * ## 为什么必须进提示词
   *
   * 原来被引用消息的**内容**从来没进过 prompt —— `replyTo` 只有 id，
   * 而这里一次都没读过它。于是：
   *   · 引用的是窗口内的消息 → 那条本来就在上下文里，看着"能看见"
   *   · 引用的是窗口外的消息 → 只剩一串数字，**完全不知道在说什么**
   * 第二种就是用户反馈的「引用功能它看不见」。
   *
   * ## 放在哪
   *
   * 放在**说话人之后、正文之前**：引用是「他说的话」的一部分，
   * 不是上一句。放到时间戳前面会让模型以为是另一个人插的嘴。
   *
   * ## 长度
   *
   * 截到 60 字。引用是**提示**不是正文，太长会挤掉真正要回答的内容。
   */
  const quoteLine = (m) => {
    const q = m?.quote
    if (!q) {
      /*
       * ⚠️ 有 replyTo 但取不到内容 —— 必须**如实说**，别当没发生。
       *
       * 照抄「图没加载出来」那条教训（见 _generate 里的说明）：
       * 模型不知道自己在漏什么，就会把引用当普通发言答，答非所问。
       * 告诉它"看不到了"，它至少会问一句「引用的是哪条」。
       */
      return m?.replyTo ? '（引用了一条消息，但内容没取到）' : ''
    }
    const body = String(q.text ?? '').replace(/\s+/g, ' ').trim()
    const shown = body.length > 60 ? body.slice(0, 60) + '…' : body
    // 引用自己的话要说「你」，和 describeMedia 里的称呼保持一致
    const who = q.isMe ? '你自己' : (q.sender ? `${q.sender}` : '某人')
    /*
     * ⚠️ 引用**别人**的话时要标清「说话的是他」（2026-11-04）。
     *
     * 原来渲染成 `（引用2129024700：…）` / `（引用番茄：…）`，紧跟着正文里又是
     * 「我说新发群里的视频」—— 两处「我」指向两个人，中间没有任何分界。
     * 实测她把这句接成了「我说的那个新盟约视频」，然后连解释三句，
     * 群友连发两个问号。
     */
    if (!shown) return `（引用${who}）`
    /*
     * 「的话」两个字不是装饰：它把"引用的是**那个人说的话**"这件事点出来，
     * 配合 system prompt 里那句「消息里的『我』指说话的人，不是指你」，
     * 才不会把别人说的「我说的是那个视频」接成「我说的」。
     * 加得太长会挤占正文，所以只加这两个字。
     */
    return q.isMe
      ? `（引用你自己的话：${shown}）`
      : `（引用${who}的话：${shown}）`
  }

  return [
    // ① system 用数组块（见上）
    { role: 'system', content: [{ type: 'text', text: String(system ?? '') }] },
    ...history.map((m, idx) => {
      const mine = m.isMe
      const label = mine ? '' : `${m.senderName}: `
      const blocks = [{ type: 'text', text: stamp(m, idx) + label + quoteLine(m) + atToName(describeMedia(m)) }]
      for (const ref of (m.images ?? [])) {
        const blk = imageCache.get(ref)
        if (blk) blocks.push(blk)
      }
      if (!mine) return { role: 'user', content: blocks }
      // ② assistant 必须带 source（见上）。provider/model 用当时生成那条回复的渠道；
      //    拿不到就填占位值 —— 我们不设 replayState，上游会原样放行。
      return {
        role: 'assistant',
        content: blocks,
        source: {
          kind: 'model',
          provider: m.provider || lastRoute?.provider || 'whale-pod',
          model: m.model || lastRoute?.model || 'auto',
        },
      }
    }),
  ]
}

/**
 * 把消息正文里"媒体标记"改写成**给模型的说明**。
 *
 * ## 为什么不能直接用 `[表情包:猫猫]`
 *
 * 那个标记本来是给自己解析/记录用的，直接喂给模型会**诱导它去解说**：
 * 实测它收到猫的震惊表情后回「这猫是被吓到了还是被丑到了」——
 * 真人不会这么说话，对方当然知道图里是什么。
 *
 * 所以要把它换成一个明确的**行为指令**：
 *   - 表情包 → 「（对方发了一个表情包）」，并提示"回个表情就好，别描述它"
 *   - 图片   → 「（对方发了一张图）」，图片本体另外以 ImageBlock 附上
 *
 * 注意：**只在送给模型的副本里改**，记忆里存的还是原标记
 *（否则界面和日志会看不懂）。
 */
/**
 * QQ 系统小黄脸 id → 名字（标准表，0~99）。
 *
 * ⚠️ 为什么需要它（2026-10-31）：
 * 原来只把 `[表情:5]` 渲染成 `id=5`，**模型根本不知道 5 是"流泪"**，
 * 只能盲选。实测：对方发表情包，它回了一个流泪脸，用户问「哭啥」。
 *
 * 有了名字，它才知道自己发的是哭脸、对方的情绪是什么。
 * 表是 QQ 官方那套固定顺序（0=惊讶、5=流泪、14=微笑…），不会变。
 */
const QQ_FACE_NAMES = (
  '惊讶 撇嘴 色 发呆 得意 流泪 害羞 闭嘴 睡 大哭 尴尬 发怒 调皮 呲牙 微笑 难过 酷 冷汗 抓狂 吐 '
  + '偷笑 可爱 白眼 傲慢 饥饿 困 惊恐 流汗 憨笑 大兵 奋斗 咒骂 疑问 嘘 晕 折磨 衰 骷髅 敲打 再见 '
  + '擦汗 抠鼻 鼓掌 糗大了 坏笑 左哼哼 右哼哼 哈欠 鄙视 委屈 快哭了 阴险 亲亲 吓 可怜 菜刀 西瓜 啤酒 篮球 乒乓 '
  + '咖啡 饭 猪头 玫瑰 凋谢 示爱 爱心 心碎 蛋糕 闪电 炸弹 刀 足球 瓢虫 便便 月亮 太阳 礼物 拥抱 强 弱 握手 胜利 抱拳 '
  + '勾引 拳头 差劲 爱你 NO OK 爱情 飞吻 跳跳 发抖 怄火 转圈 磕头 回头 跳绳 挥手'
).split(/\s+/)

/** QQ 表情 id → 可读名字（认不出来就退回 id）。 */
function faceName(id) {
  const n = QQ_FACE_NAMES[Number(id)]
  return n ? `${n}（id=${id}）` : `id=${id}`
}

export function describeMedia(m) {
  let t = String(m?.text ?? '')
  /*
   * ★ **自己发的要说「你」，不能一律「对方」**（2026-10-31 修）。
   *
   * 原来三个替换全写死「对方」—— 于是历史里**机器人自己发的表情也标成
   * "对方发的"**。实测事故：
   * ```
   * 18:59:04 他「[表情包]」
   * 18:59:06 我「[表情:5]」          ← 流泪
   * 18:59:27 他「哭啥」
   * 18:59:29 我「那表情是你发的吧」  ← 指着自己发的说"你发的"
   * ```
   * 根因就是这里没区分 `isMe`。
   */
  const who = m?.isMe ? '你' : '对方'
  /*
   * 表情包：换成一句话说明 + **明确的行为指引**。
   *
   * ⚠️ 光说「（对方发了一个表情包）」不够 —— 模型会去猜「这表情什么意思」
   *    「图里是谁」，然后一本正经地分析起来。实测它回过「这谁啊，又不是本鱼」。
   *
   * 所以这里直接把「该怎么应对」写进去：别解读、别描述画面，
   * 回个表情或者接一句情绪话就够了。真人就是这么反应的。
   */
  t = t.replace(/\[表情包(?::([^\]]*))?\]/g, (_all, name) => {
    const n = String(name ?? '').trim()
    /*
     * 表情包：说明是表情，并要求「有字接梗、没字只回表情」。
     *
     * ⚠️ 这里千万不能说「把图上的字读出来」—— 那种引导会让它把字
     *    念一遍当回复（「图里写着『今天又加班』」），等于废话。
     *    用户的要求是「懂意思、接梗、不复述」。
     */
    const tail = PROMPT_NOTE_TEXTS[0]
    /*
     * ★★ 2026-11-02：提示改用 `〔提示：…〕` 记号 —— 它**一眼就不是台词**。
     *
     * ## 出过的事故（用户实测报的）
     * 私聊里连发**两张表情包** → 拼出两段括号注 → 模型**照着吐了出来**：
     *     12:33:42 [我]「只回一个表情，不要打字也不要描述画面） 只回一个表情，不要打字也不要描述画面）
     *
     *                  喏，说好两张就是两张。」
     * **把给模型的指令直接发给用户了，而且发了两遍**（两张表情包各拼一段）。
     * 她随后还自己圆场：「那行字漏出来了…我写着写着把提示也打出去了」。
     *
     * ## 为什么会漏
     * 提示是**拼进对话记录**里的，而且原来用 `（…）` ——
     * 那正是**她自己写动作/舞台提示**的格式。模型分不清
     * "这是给我的要求" 还是 "这是要我说的话"，就照着念了。
     *
     * 所以把它换成 `〔提示：…〕`：方括号 + 「提示」两个字，
     * 在记录里跟任何人的发言、任何动作描述**都不同形**。
     *
     * ⚠️ 但光换记号**不够** —— 措辞再怎么改都可能被念。所以还有第二层：
     *    发送前用 `stripPromptLeak()` 把这几段**原文擦掉**（见那个函数的说明）。
     */
    return n
      ? `（${who}发了一个表情包，关于「${n}」）〔提示：${tail}〕`
      : `（${who}发了一个表情包）〔提示：${tail}〕`
  })
  /*
   * 系统小黄脸：**给出名字**，不再只给 id（2026-10-31）。
   *
   * 原来写的是 `id=${id}` —— 模型根本不知道 5 是"流泪"，只能**盲选**，
   * 于是可能出现"对方发情绪图、它回一个哭脸"这种驴唇不对马嘴。
   * 现在直接给名字；而且是它自己发的时，明确说「你的」。
   */
  /*
   * ★ 2026-11-03：**光板的 `[表情]` 也要改写**（原来只改写 `[表情:数字]`）。
   *
   * ## 出的事故（用户截图，2026-11-03 21:19）
   * 群里出现一条**内容是「[表情]」的文字消息**。往回查：
   * 输入侧在 id 缺失时产出的占位标记就是 '[表情]'（onebot.js），
   * 而这条正则不管它 → 光板标记**原样留在模型的对话记录里** →
   * 模型照抄进回复 → 群友看到一串方括号。
   *
   * ⚠️ 关键点：`[表情包]` 那一支名字是可选的（`(?::…)?`），所以抄它没事；
   *    **只有 `[表情]` 这一支会被抄成文字**。两处口径必须对齐，
   *    否则解析面放宽了、模型这边还在教它写光板形式。
   *
   * 认不出 id 就说不出名字，所以只能给"发了个QQ表情"这种笼统说明；
   * 有 id 的仍然带名字（faceName 的表在上面）。
   */
  t = t.replace(/\[表情(?::(\d+))?\]/g, (_all, id) =>
    (id ? `（${who}发了个QQ表情：${faceName(id)}）` : `（${who}发了个QQ表情）`))
  // 图片：说明是图，本体由 ImageBlock 承载
  t = t.replace(/\[图片\]/g, `（${who}发了一张图）`)
  return t
}

/**
 * 可 await 的 sleep。
 *
 * ⚠️ 不要给这个定时器加 `.unref()` —— unref 的定时器不阻止进程退出，
 * 但 `await` 它仍然要等它触发；而如果进程里没有其它活跃 handle，
 * Node 会在 await 期间直接退出（表现为测试里"unsettled top-level await"）。
 * 所以这里刻意保留 ref。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 在 QQ 内置表情表里按名字找表情 —— 这就是"用 QQ 的表情库搜索"。
 *
 * ## 为什么是本地表而不是联网搜
 *
 * QQ **没有公开的表情搜索 API**（实测候选接口全 404，NapCat 也没暴露）。
 * 但 NapCat 内嵌了 QQ 完整的 face_config，我们导出成 faces.json
 * （见 scripts/extract-faces.mjs），于是能在本地完成"按关键词找表情"。
 *
 * ## 匹配策略（从精确到宽松）
 *
 *   ① 完全同名             「大笑」→ 「大笑」
 *   ② 表名含关键词 / 关键词含表名（按名字**从长到短**试，长匹配更准）
 *   ③ 单字兜底（仅关键词很短时）
 *
 * ⚠️ 第 ② 档必须从长到短：「大笑」要先命中「大笑」而不是「笑」。
 *    第 ③ 档很容易撞错，所以只在关键词 ≤2 字时才用。
 *
 * @param {string} key 模型给的感觉词（如「猫猫」「大笑」「无语」）
 * @returns {{name:string, kind:'face'|'mface', id?:number, ani?:number, pack?:number, by:'exact'|'fuzzy'}|null}
 */
export function lookupFace(key) {
  const k = String(key ?? '').trim()
  if (!k) return null
  const names = Object.keys(FACE_TABLE)

  // ① 完全同名
  if (FACE_TABLE[k] !== undefined) return packFace(k, 'exact')

  // 归一化：去掉常见修饰词，提高命中率（「超级大笑」→「大笑」）
  const stripped = k.replace(/^(超级|非常|特别|有点|好|很|超)/, '').replace(/(了|的|呀|啊|吧)$/, '')

  // ② 模糊匹配。按名字长度**从长到短**试 —— 长匹配更精确。
  const sorted = names.slice().sort((a, b) => b.length - a.length)
  for (const cand of [k, stripped].filter(Boolean)) {
    if (cand.length < 2) continue
    for (const n of sorted) {
      if (n.includes(cand) || cand.includes(n)) return packFace(n, 'fuzzy')
    }
  }

  // ③ 单字兜底：只在关键词本身很短时用（否则「笑」会乱撞）
  if (k.length <= 2) {
    for (const n of sorted) {
      if (n.length === 2 && (n.includes(k) || k.includes(n))) return packFace(n, 'fuzzy')
    }
  }
  return null
}

/** 把 faces.json 里的一条包装成统一结果。 */
function packFace(name, by) {
  const v = FACE_TABLE[name]
  if (typeof v === 'number') return { name, kind: 'face', id: v, by }
  if (v && typeof v === 'object') return { name, kind: 'mface', ani: v.ani, pack: v.pack, by }
  return null
}

/** 表情表里有多少个名字（给 UI/调试用）。 */
export function faceTableSize() {
  return Object.keys(FACE_TABLE).length
}

/**
 * 字符串 → 稳定的非负整数（djb2）。
 *
 * 用途：收藏表情不带名字，只能按模型给的名字做**确定性挑选** ——
 * 同一个名字每次发同一张，比"每次随机"更像有意图的选择。
 * 用 djb2 而不是简单的 h*31：后者对短中文串容易聚到同一档。
 */
function hashStr(s) {
  let h = 5381
  const t = String(s)
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h + t.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * 清掉模型输出里的"工具调用/特殊标记"残留。
 *
 * 为什么需要：这些免费渠道的模型常被微调成会输出**工具调用语法**
 * （DeepSeek 的 `<｜｜DSML｜｜ calls>` 等）。那本来是该被 harness 解析
 * 成 tool_call 的结构，但我们只是把它当纯文本收下来 —— 结果原样发给
 * 群友，看起来就是一堆乱码标签。实测出现过：
 *
 *   "？\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"get_weather\">…"
 *
 * 这里做两件事：
 *   1. 整段都是工具调用（清完没有实质内容）→ 返回空串，让上层按"没话说"处理
 *   2. 只有部分残留 → 只留下自然语言部分
 */
export function cleanModelText(raw) {
  let s = String(raw ?? '')
  // ★ 剥「停顿旁白」：她把这当舞台指示反复发（2026-11-05）
  s = s.replace(/[（(]\s*(顿了下|顿了一下|停顿了一下|沉默了几秒|沉默了一下|想了想|停了一下)\s*[）)]/g, '')

  // ① 成对的工具调用块（含各种全角竖线/尖括号变体）整块删掉
  //    形如 <｜｜DSML｜｜ calls> … </｜｜DSML｜｜ calls>
  s = s.replace(/<[｜|]{0,4}[^>]*?(?:DSML|tool_call|tool_calls|function_calls)[^>]*>[\s\S]*?<\/[｜|]{0,4}[^>]*?(?:DSML|tool_call|tool_calls|function_calls)[^>]*>/gi, '')
  // ② 未闭合的，删到行尾/结尾
  s = s.replace(/<[｜|]{0,4}[^>]*?(?:DSML|tool_call|tool_calls|function_calls)[^>]*>[\s\S]*$/gi, '')
  // ③ 裸的 invoke / parameter 标签
  s = s.replace(/<\/?[｜|]{0,4}[^>]*?(?:invoke|parameter|tool_use)[^>]*>/gi, '')
  // ④ 常规的特殊 token（如 <|end_of_sentence|>）
  s = s.replace(/<\|[^|>]{1,40}\|>/g, '')
  // ⑤ 全角竖线的同类残留
  s = s.replace(/<｜[^｜>]{1,40}｜>/g, '')

  // ⑥ 修补**被截断的表情标记**。
  //
  //    实测踩过：群里发了「[表情:」这一串字面文本 —— 因为生成被截断
  //    （流提前结束 / 上游把输出砍在标记中间），留下的残缺标记既不匹配
  //    发送时的正则，又被当普通文本发出去，用户看到的就是一串方括号。
  //
  //    能补的就补全，补不了（只有前缀、没有 id）就删掉：
  //      '[表情:4'        → '[表情:4]'
  //      '[表情包:猫猫'    → '[表情包:猫猫]'
  //      '[表情:'         → 删掉（没有 id，无法还原）
  s = repairTruncatedMarkers(s)

  // ⑦ 归一化 [SILENT]（大小写/全角括号/夹在中间的空白）。
  //
  //    模型有时写成 `[ silent ]`、`[Silent]`、`［SILENT］`（全角），
  //    下游按字面量比对就会漏判 —— 那就会把 "SILENT" 这几个字母
  //    当正文发到群里。统一成标准写法，由调用方判断"剥掉后还剩什么"。
  s = s.replace(/[\[［]\s*silent\s*[\]］]/gi, '[SILENT]')

  // ⑧ 剥掉「媒体描述」——**这是喂给模型看的内部标注，绝不能出现在回复里**。
  //
  //    实测踩过（2026-10-19，用户截图）：群里发了个表情，模型回：
  //      「那本鱼继续吃饭（对方发了个QQ表情，id=20）」
  //    括号里那串是 `describeMedia()` 给输入消息加的**说明**（见本文件
  //    第 101 行），目的是让模型知道"对方发的是表情而不是文字"。
  //    但模型有时会把它当正文复述出来 —— 群友看到的就是一句机械旁白。
  //
  //    这类描述只在**输入侧**有意义。输出侧必须一律剥掉：
  //      （对方发了个QQ表情，id=20）      → 删
  //      （对方发了一个表情包，关于「猫猫」）→ 删
  //      （对方发了一张图）                → 删
  //
  /*
   * ⚠️ **锚点要同时覆盖「对方」和「你」**（2026-10-31 修）。
   *
   * 上面第 291 行改了格式：自己发的表情现在写「（你发了个QQ表情：流泪（id=5））」，
   * 不再一律「对方」。而这里原来只认「对方发了」—— **改完就漏掉了自己那半边**，
   * 模型一旦照抄注解就会直接发到群里。
   *
   * 所以锚点改成 `(对方|你)发(了个QQ表情|了一个表情包|了一张图)`，
   * 比「括号内任意内容」精准（后者会误伤「（笑）」「（认真脸）」）。
   */
  /*
   * ★★ 2026-11-02：**原来那条正则会剥一半、把提示留在正文里**（用户实测报的）。
   *
   * ## 病因：`[^）)]*` 不许出现右括号，而这些注记里**本来就有内层括号**
   * 原写法：`[（(]…[^）)]*[）)]`。两类注记都踩：
   *
   * ```
   * （对方发了一个表情包，关于「猫猫」。纯情绪图（没字）只回一个表情…）
   *                                              ↑↑↑↑↑↑ 内层括号
   * （你发了个QQ表情：流泪（id=5））
   *                      ↑↑↑↑↑↑ 内层括号
   * ```
   * 于是在**内层**那个 `）` 处提前收手：
   * ```
   * 被剥掉：（对方发了一个表情包，关于「猫猫」。纯情绪图（没字）
   * 留下来：只回一个表情，不要打字也不要描述画面）   ← 连右括号一起发给了用户
   * ```
   * 用户私聊里连发**两张**表情包 → 两段注 → **同样一句漏了两遍**，
   * 她还得自己圆场「那行字漏出来了…我写着写着把提示也打出去了」。
   *
   * ## 修法：改成「**这一行最后一个右括号**」
   * 用贪婪的 `[^\n]*` 而不是 `[^）)]*` —— 注记是**整行**注进去的，
   * 模型照抄时也基本独占一行，所以"到行尾最后一个 `）`"就是它的真实边界。
   *
   * ⚠️ 代价说清楚：如果模型在同一行里**先抄注记、后面又跟了别的括号**，
   *    会被多剥一点。这个取舍是故意的 ——
   *    **两种错法的不对称性**：漏掉注记（用户看到一句莫名其妙的话、
   *    日志里毫无异常）比多剥掉几个字难发现得多。
   *    何况下面还有一层**按原文精确擦除**兜底。
   */
  s = s.replace(
    /[（(]\s*(?:对方|你)发(?:了个QQ表情|了一个表情包|了一张图)[^\n]*[）)]/g,
    '',
  )
  /*
   * ★ 新版注记用 `〔提示：…〕`（方括号 + 「提示」两个字）——
   * 在记录里跟任何人的发言、任何动作描述**都不同形**，
   * 模型不容易当成"要我说的话"（见 describeMedia 里的说明）。
   * 它**没有嵌套**，所以一条正则就干净了。
   */
  s = s.replace(/〔\s*提示：[\s\S]*?〕/g, '')
  /*
   * ★★ **原文兜底**：把已知的提示原文**按字符串**擦掉（允许后面跟个右括号）。
   *
   * 这一层是**故意的冗余**：上面两条正则都是"按形状匹配"，
   * 形状一变（就像这次内层括号）就会漏。而这一层认的是**原文本身**，
   * 只要提示文字没改，怎么嵌套、怎么排版都跑不掉。
   * 原文跟注入侧共用 `PROMPT_NOTE_TEXTS`，不会两边走偏。
   */
  for (const frag of PROMPT_NOTE_TEXTS) {
    const esc = frag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    s = s.replace(new RegExp(esc + '[）)]?', 'g'), '')
  }
  // 擦完可能留下孤立的空格/空行
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n')

  /*
   * ⑨ 剥掉**时间戳标记**。
   *
   * ⚠️ 这是 2026-10-26 我自己引入的 bug。
   *
   * 为了修「它不知道两条消息隔了多久」，`buildChatMessages` 给每条历史
   * 加上了相对时间：最新一条 `（5 秒前）`，更早的 `（+3 秒）`。
   *
   * 结果模型**照着学**，把时间戳当成正文的一部分，回复变成：
   *   「（+3 秒）wow什么啊」
   *   「（+5 秒）真的。」
   *   「（+2 分钟）……」
   *
   * 和之前 `（对方发了个QQ表情，id=20）` 被照抄是同一类问题 ——
   * **凡是喂给模型的注解，输出侧都必须剥掉**。加输入侧标注时，
   * 一定要同时想清楚输出侧怎么清。
   */
  s = s.replace(/[（(]\s*\+\s*\d+\s*(秒|分钟|小时|天)\s*[）)]/g, '')
  s = s.replace(/[（(]\s*\d+\s*(秒|分钟|小时|天)\s*前\s*[）)]/g, '')
  /*
   * ⚠️ 第三种形态（2026-10-29 补，用户第二次截图）：
   * ```
   * （8 秒）神秘黄豆群是吧，那地方天天瞎传，你也信。      ← 既没 + 也没 前
   * （12 秒）去吧，慢慢找。
   * ```
   *
   * 输入端只生成两种（`（8 秒前）` 和 `（+8 秒）`），**是模型复述时自己丢了
   * `+` 或 `前`** —— 上面两条正则都要求那个标记，于是整段漏了出去。
   *
   * 所以这里改成**更宽的规则**：括号里只要是「可选的 +/数字 + 时间单位
   * （+ 可选的前/以前）」就整段剥掉，不再依赖那个会被丢的标记。
   *
   * ⚠️ 不会误伤正常句子 —— 正则要求括号**在时间单位处就结束**：
   *    「（2 天没睡了）」不匹配（后面还有字），只有「（2 天）」才剥。
   */
  s = s.replace(/^[ \t]*[（(]\s*[+＋]?\s*\d+\s*(秒|分钟|小时|天)\s*(前|之前|以前)?\s*[）)][ \t]*/gm, '')
  /*
   * ⚠️ 第四种形态（2026-10-31 补，日志实测）：
   * ```
   * （+几秒）这条本鱼手上什么都没有，没解析出东西来
   * ```
   *
   * 上面那条正则要求 `\d+`，而模型把数字写成了**中文/模糊说法**（「几秒」）。
   * 另外我第二轮为了修时间倒流，给历史加过 `（紧接着）` 这种**非数字**标注 ——
   * 它也会被照抄。
   *
   * 所以这里再补一条：括号里只要是**时间感的模糊词**就整段剥掉。
   */
  s = s.replace(
    /^[ \t]*[（(]\s*[+＋]?\s*(几|一|半|好几|若干)\s*(秒|分钟|小时|天|会儿)\s*(前|之前|以前)?\s*[）)][ \t]*/gm,
    '',
  )
  // 「（紧接着）」—— 我加给历史的时间标注，不是台词
  s = s.replace(/^[ \t]*[（(]\s*紧接着\s*[）)][ \t]*/gm, '')
  /*
   * 还有一种同源的注解：主动发言那条 prompt 里写着
   * `（距上次有人说话已经 18 分钟）`。它也可能被照抄。
   */
  s = s.replace(/[（(]\s*距[^）)\n]{0,16}\d+\s*(秒|分钟|小时|天)[^）)\n]{0,8}[）)]/g, '')

  /*
   * ⑨b 剥掉「**决策旁白**」——它把自己的判断当台词念出来了。
   *
   * ⚠️ 2026-10-29 实测（用户截图）：
   *   「（风堇那表情包……不回，转话题）大晚上不睡觉，都在刷图呢」
   *   「（开会还惦记着回我，挺闲啊）」
   *
   * 根因不在管道（`text-delta` / `reasoning-delta` 是分开攒的），
   * 而是**人格教它用括号写舞台提示**（persona:82「（然后小声）」），
   * 模型把这套扩展到"决策/内心话"上 —— 它分不清「（小声）」是表演、
   * 「（不回）」是思考。
   *
   * 判据（写在这里，以后加规则照这个来）：
   *   · 括号里是**说给人听的表演提示** → 留（（小声）（心虚）（护食））
   *   · 括号里是**它对自己说的判断** → 剥（（不回）（该不该）（转话题））
   *
   * 只剥**行首**、且括号内**必须命中决策词** —— 不误伤正文里的括号。
   */
  /*
   * ⚠️ 2026-11-04：补了「换个话题 / 换话题 / 聊点别的」。
   *
   * 原来的表里只有 `换话题`，而实际写出来的是「换**个**话题」—— 匹配不上。
   * 这个漏词一直没暴露，是因为老的 ⑫「整条括号一律丢」顺手也把它丢了，
   * **把漏词盖住了**（一个 bug 掩着另一个 bug）。改 ⑫ 语义之前先把词补齐，
   * 否则「（这表情包没意思，换个话题）」会从"被丢"变成"发出去"。
   */
  const DECIDE_ASIDE = /不回|别说|要说|转话题|换个话题|换话题|聊点别的|该不该|要不要|接不接|没兴趣|先不|别理|装没看见|敷衍|提一句|算了|别接/
  s = s.replace(/^[ \t]*[（(][^）)\n]{1,80}[）)][ \t]*/gm, (m) => (DECIDE_ASIDE.test(m) ? '' : m))

  /*
   * ⑩ 剥掉**「昵称: 内容」前缀**。
   *
   * ⚠️ 2026-10-26 实测踩过。
   *
   * 为了让人群聊里分得清谁在说话，`buildChatMessages` 给 user 消息加了
   * 前缀 `风堇重度依赖（狗托）: `。结果模型照着学，回复里也带上了：
   *
   *   22:58:26  [我]「GOMD是啥，我怎么没听过
   *                    风堇重度依赖（狗托）: 合成玉」   ← 这行是它复述的
   *
   * 群友看到的是一句莫名其妙的引用，像是它在念聊天记录。
   *
   * 只处理**行首**（`^` + m 标志），且形态要求较窄，避免误伤正文：
   *   · 昵称里**必须含括号**（「风堇重度依赖（狗托）」这种群名片常见形态），
   *     或者「@某人」
   *   · 不能只是一两个字的普通词（「注意: 这样」不该被删）
   */
  s = s.replace(/^(?:@\S{1,20}|[^\s：:，。！？\n]{2,24}[（(][^）)\n]{1,16}[）)])[：:]\s*/gm, '')

  /*
   * ⑪ 剥掉 emoji。
   *
   * ## 为什么要用代码拦，而不是只靠提示词
   *
   * 人格里写着「不要用 emoji」，但实测模型照样一条带好几个 ——
   * 提示词约束不住这类高频低成本的输出习惯。
   *
   * emoji 放出去观感上很假（尤其连着几条都带），而 QQ 的表情体系
   * 本来就有 `[表情:N]` / `[表情包]` 两种受控写法，够用了。
   * 所以直接在输出侧清掉，只留那两种标记。
   *
   * 覆盖范围：常见 emoji 区段（杂项符号、装饰符号、Emoji 面板、
   * 交通符号、补充符号、以及肤色/组合修饰符）。
   * 清完如果只剩空白，返回空串由调用方处理（当成"什么都没说"）。
   */
  s = stripEmoji(s)
  // 清掉 emoji 后可能留下多余空格（「好 😄」→「好 」），压一下
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/ +([，。！？、；：])/g, '$1')

  /*
   * ⑫ 整条就是一个**括号旁白** → 判断该丢还是该留。
   *
   * ⚠️ 只认「整条就是一个括号」，不做更宽的推断 ——
   *    「（小声）我不是大肥鱼」必须保住（括号只是前缀）。
   *
   * ## 2026-10-31 修：原来是一刀切丢弃，把正常台词也吃了
   * 旧行为（本轮单测才发现）：
   * ```
   * （笑）          → ""      ← 「（笑）」是说话方式，凭什么丢？
   * （2 天没睡了）   → ""
   * ```
   * 但也不能全留 —— 「（开会还惦记着回我，挺闲啊）」确实是内心旁白，
   * 留着会变成奇怪的自言自语。
   *
   * ## 所以分三类
   * ```
   * ① 命中 DECIDE_ASIDE（不回/该不该/转话题…）  → 丢（思考当台词念了）
   * ② 短动作词（笑/叹气/小声/心虚/护食…）        → 留（这是表演提示，角色风格）
   * ③ 其余（内心评价 / 带数字标点的旁白）        → 丢
   * ```
   * ② 的判据：**1~6 个汉字/字母、不含数字、不含标点** ——
   * 「（笑）」「（叹气）」「（小声）」「（边吃边说）」都符合；
   * 「（2 天没睡了）」有数字、「（开会还惦记着回我，挺闲啊）」有逗号 → 自动落到 ③。
   */
  /*
   * ⑪b **剥时间注**（2026-11-04 修 —— 用户第三次提「时间标注这个不是bug吗」）。
   *
   * ## 现场（私聊，她自己的话里）
   * ```
   * （4 秒后）没一直改？从榨到不榨，再到蹭蹭…
   * （5 秒后）嗯，早上又深喉了。
   * （（3 秒后）行吧，你不在，那我真自己来了）      ← 最坑：注和台词一起套进括号
   * ```
   * 时间注是 `buildChatMessages` 给每条消息加的（给她看节奏），她照着念了。
   * 老规则只认「（紧接着）」和 `（8 秒）/（+3 秒）` 这些形态，**数字+后/前** 漏了。
   *
   * ## 两条规则，顺序不能反
   * 1. 先处理**嵌套**：外层括号本来只是把"注 + 台词"一起兜住，脱掉正好还原台词；
   * 2. 再剥**行首 / 空白之后**的时间注。
   *
   * ⚠️ **只剥行首或空白之后的** —— 句中的 `我等了（3 分钟）就走了` 是正文，
   *    剥了等于改人家的话（check-aside 有断言锁着）。
   */
  s = s.replace(
    /^[ \t]*[（(]\s*[（(]\s*(\d{1,3}\s*(?:秒|分钟?|小时)\s*(?:后|之前|以前|前|以后|左右|多)?)\s*[）)]\s*([\s\S]*?)\s*[）)][ \t]*$/gm,
    '$2',
  )
  s = s.replace(
    /(^|[\s\n])[（(]\s*([+＋]?\s*(?:\d{1,3}|几|一|半|好几|若干|\?|？)\s*(?:秒|分钟?|小时)\s*(?:后|之前|以前|前|以后|左右|多)?|紧接着|刚刚|刚才|过了一会儿?|片刻后)\s*[）)]/gm,
    '$1',
  )
  /*
   * ⚠️ 2026-11-04 傍晚再补两种（同一天里又撞到两次，见下面清单）：
   *
   * ```
   * 17:23:52 （+? 秒）那不就得了，LYFan也这么讲…
   * 17:37:57 （+? 秒）醒醒，五点三十六了，十分钟到了。
   * 16:59:41 （-）上瘾怎么了，好东西当然得多说几遍。
   * ```
   *
   * 上面那条要求「数字或几/半/一」，而模型会把没算出来的时间写成 `?`，
   * 把"空注记"写成 `（-）`。两者形状都像时间注，就一起在这条家族里收掉。
   */
  s = s.replace(/(^|[\s\n])[（(]\s*[-—－]\s*[）)]/gm, '$1')

  const trimmed = s.trim()
  if (/^[（(][^）)\n]{1,120}[）)]$/.test(trimmed)) {
    if (DECIDE_ASIDE.test(trimmed)) return ''
    if (/^[（(][\u4e00-\u9fa5A-Za-z]{1,6}[）)]$/.test(trimmed)) return trimmed
    /*
     * ③ **动作也是内容 → 脱掉最外层括号当正文发**（2026-11-04 改语义）。
     *
     * 旧行为是「整条括号 → 返回空串（当没说）」。但人格现在要求
     * 「动作和身体感觉必须加括号」，于是一条**只有动作**的回复
     * （亲密戏里极常见）会被**整条丢掉** —— 实测
     * `cleanModelText('（手往下摸，隔着睡裤慢慢磨）')` → `''`。
     * **她写了，但没发出去** —— 这就是"身体描写不够/差点意思"的一部分根源。
     *
     * 代价：极少数"内心评价"旁白会被发出来（旧 bug 的反向）。
     * 但"丢掉她真写的东西"更糟；DECIDE_ASIDE 那一类（思考/换话题）仍然照丢。
     */
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

/**
 * 删掉文本里的 emoji（彩色小图标）。
 *
 * ## 为什么要用代码拦，而不是只靠提示词
 *
 * 人格里写着「不要用 emoji」，但模型照样一条带好几个 ——
 * 提示词约束不住这种高频低成本的输出习惯。emoji 连着几条都带很假，
 * 而 QQ 本来就有 `[表情:N]` / `[表情包]` 两种受控写法，够用了。
 *
 * ## 为什么不用正则
 *
 * `[\u1F300}-\u1FAFF}]` 这类写法要求 `u` 标志 + 花括号，
 * 手写极易漏括号而静默失配（本文件就被这个坑过）。按**码点**判断
 * 没有转义，读起来也直白。
 *
 * 保留中文标点、全角字符、以及 `[表情:N]` 这类方括号标记。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripEmoji(text) {
  const s = String(text ?? '')
  let out = ''
  // for...of 按码点迭代，代理对（emoji）会作为一个整体取出
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (isEmojiCodePoint(cp)) continue
    out += ch
  }
  return out
}

/** 这个码点是不是 emoji（含肤色修饰符、ZWJ、变体选择符）。 */
function isEmojiCodePoint(cp) {
  if (cp >= 0x1f000 && cp <= 0x1faff) return true   // 麻将/信封/补充符号/Emoji 面板/扩展A
  if (cp >= 0x2600 && cp <= 0x27bf) return true     // 杂项符号 + 装饰符号
  if (cp >= 0x2b00 && cp <= 0x2bff) return true     // 杂项符号与箭头（⭐⬆等）
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true   // 区域指示符（国旗）
  if (cp >= 0x2190 && cp <= 0x21ff) return true     // 箭头（模型爱拿来当装饰）
  if (cp >= 0x2300 && cp <= 0x23ff) return true     // 技术符号（⌚⏰等）
  if (cp >= 0x25a0 && cp <= 0x25ff) return true     // 几何图形（▪▫●）
  if (cp === 0xfe0f || cp === 0x200d || cp === 0x20e3) return true  // 变体选择符 / ZWJ / 键帽
  return false
}

/**
 * 修补/清理**残缺的表情标记**。
 *
 * 只在**文本末尾**处理 —— 中间出现残缺说明模型本来就想写这个字面量，
 * 不该擅自改。末尾残缺才是"被截断"的典型特征。
 */
export function repairTruncatedMarkers(text) {
  let s = String(text ?? '')
  // 末尾的 [表情:<数字> 缺右括号 → 补上
  s = s.replace(/\[表情[:：]\s*(\d+)\s*$/, '[表情:$1]')
  // 末尾的 [表情:<名字> 缺右括号 → 补上
  //（2026-11-03：放宽解析后 `[表情:名字]` 也合法了，截断在名字中间同样要补；
  //  不然又是一串方括号文字发进群 —— 和上面那条数字形式是同一个坑。）
  //  ⚠️ 顺序要在数字那条**之后**：'[表情:4' 已经先补完，不会走到这里。
  s = s.replace(/\[表情[:：]\s*([^\[\]\s][^\[\]]*?)\s*$/, '[表情:$1]')
  // 末尾的 [表情包:<名字> 缺右括号 → 补上
  s = s.replace(/\[表情包[:：]\s*([^\[\]]+?)\s*$/, '[表情包:$1]')
  // 末尾只剩前缀（没有 id/名字）→ 整段删掉，别把方括号发给群友
  s = s.replace(/\[表情[:：]?\s*$/, '')
  s = s.replace(/\[表情包[:：]?\s*$/, '')
  // 单独一个半开的左括号也要清（如 "好的["）
  s = s.replace(/\[$/, '')
  return s
}

/**
 * 把文本按表情标记切段。
 *
 * 输入：'你好[表情:4]再见[表情包:猫猫]'
 * 输出：[{kind:'text',text:'你好'}, {kind:'face',id:'4'},
 *        {kind:'text',text:'再见'}, {kind:'mface',name:'猫猫'}]
 *
 * 这样发送时就能把标记换成真正的 QQ 表情段，而不是把 "[表情:4]"
 * 这七个字符原样发给群友。
 *
 * ⚠️ 认的写法在 2026-11-03 **放宽过一次**（见函数内注释）：
 *    `[表情:数字]` 仍然是"按编号发内置表情"；
 *    `[表情包]` / `[表情包:标签]` / `[表情]` / `[表情:名字]` 一律交给
 *    `_pickMface(name)` —— 先从**她自己的收藏库**里挑，挑不到才退内置。
 */
export function splitFaceMarkers(text) {
  const out = []
  const s = String(text ?? '')
  /*
   * ★★ 2026-11-03：**放宽解析面**。原来是
   *      /\[表情:(\d+)\]|\[表情包(?::([^\]]*))?\]/g
   *    —— 只认 `[表情:数字]` 和 `[表情包[:名字]]`。
   *
   * ## 实测事故（用户截图 + 群里现场，2026-11-03 21:19）
   * ```
   * 21:19:25 [我] group:704291282「活着呢，玩什么
   *
   *                                [表情]」
   * ```
   * 群里第二条就是一串**方括号文字**「[表情]」。模型这一步写的是
   * **光秃秃的 `[表情]`**（不带冒号、不带名字），老正则匹配不到 →
   * 整串被当普通文本发了出去。截图里那个气泡就是它。
   *
   * ## 她为什么会写出这个形式
   * 输入侧本来就产出**同形的**占位标记：收到 id 缺失的 QQ 小黄脸时，
   * `parseMessage` 返回的就是 '[表情]'（见 onebot.js），而
   * `describeMedia` 当时只改写 `[表情:数字]` —— 于是这个光板标记
   * **原样留在模型的对话记录里**，模型照抄出来，就发进了群。
   * （`[表情包]` 那一支名字是可选的，所以抄它不会出事；只有这一支会漏。）
   *
   * ## 一次收掉的同类漏网（放宽前 → 放宽后）
   * ```
   * [表情]         → 想随手丢一张      老正则漏 → 按"没名字的表情包"处理（随机一张收藏）
   * [表情:偷笑]     → 想发个有名有姓的   老正则漏 → 进 _pickMface：先收藏按标签、再内置按名字
   * [表情：偷笑]    → 全角冒号          老正则漏（模型写中文标点是常态）
   * [表情包：猫猫]  → 全角冒号          同上
   * [表情: 4]      → 冒号后带空格       老正则漏
   * ```
   *
   * ## 口径
   * `[表情:纯数字]` 仍是"按编号点名要 QQ 内置表情"（老语义，没动）；
   * 其余一律按名字走 `_pickMface(name)`，空名字就是随机一张收藏。
   *
   * ⚠️ 为什么不干脆把漏网标记**删掉**：她的收藏表情是首选表达方式，
   *    模型写出标记 = 她**想发个表情**；删掉就等于"啥都不发"，而
   *    `_pickMface` 的注释写着"从来没有'啥都不发'这一档"。
   */
  const re = /\[(表情|表情包)(?:[:：]([^\]]*))?\]/g
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index) })
    const name = String(m[2] ?? '').trim()
    // 只有「[表情:数字]」是"点名某个内置表情"；其余按名字挑（空名字 = 随机一张）
    if (m[1] === '表情' && /^\d+$/.test(name)) out.push({ kind: 'face', id: name })
    else out.push({ kind: 'mface', name })
    last = re.lastIndex
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) })
  // 全是标记的情况（没有文本段）也要返回，不能丢
  if (out.length === 0) out.push({ kind: 'text', text: s })
  return out
}

/**
 * 抽出「约定时间」标记 `[等:N]`（分钟）并从正文里**剥掉**（2026-11-03 加）。
 *
 * ## 用途（用户确认的设计）
 * 「太安静了到时间不会催促人，只会在那里安静的等待」
 * 「前面时间是**只对话里面约定的时间**」—— 于是：
 * ```
 * 他说「我洗漱五分钟」/「等我一下」
 *   → 她在回复末尾写 [等:5]
 *   → `_send` 剥掉它（绝不发给群友）+ 记一条待催（`_scheduleNudge`）
 *   → 到点且他仍然一句话没说 → 催一句（`_tickNudges` → `_speakUp`）
 *   → 他中途说话了 → 立刻作废（`_cancelNudge`，挂在 onEvent 上）
 * ```
 *
 * ⚠️ **必须剥干净再发** —— 理由和 `[表情:]` 那一族一模一样：
 *    漏一个方括号出去，群里看到的就是字面量「[等:5]」
 *    （2026-11-03 刚从 `[表情]` 上踩过一模一样的坑）。
 *
 * ⚠️ 认三种写法：`[等:5]` / 全角冒号 `[等：5]` / 冒号后带空格；
 *    末尾**残缺**的（`[等` / `[等:` / `[等:5`）整段丢掉，不许发出去。
 *
 * @param {string} text
 * @returns {{text:string, waits:number[]}} 剥掉标记后的正文 + 抽到的分钟数
 */
export function stripWaitMarkers(text) {
  const waits = []
  let s = String(text ?? '')
  /*
   * ⚠️ 括号里**什么都剥**，不只是纯数字：
   *    `[等:abc]` / `[等]` 也是模型想表达"约定"（只是写坏了）——
   *    留着它就是把字面量发给群友。纯数字的才记进 waits。
   */
  s = s.replace(/\[等[:：]?\s*([^\[\]]*?)\s*\]/g, (_all, inner) => {
    const min = Number(String(inner ?? '').trim())
    if (Number.isInteger(min) && min >= 1) waits.push(min)
    return ''
  })
  // 末尾残缺的约定标记 → 删掉（口径同 repairTruncatedMarkers）
  s = s.replace(/\[等[:：]?\s*\d{0,3}\s*$/, '')
  return { text: s, waits }
}

export class QQBridge {
  /**
   * @param {object} opts
   * @param {object} opts.cfg         qq 配置
   * @param {object} opts.onebot      OneBotClient
   * @param {object} opts.llm         网关核心
   * @param {object} opts.decision    决策层
   * @param {object} opts.memory      MemoryStore
   * @param {object} opts.longMemory  LongTermStore
   * @param {object} opts.persona     PersonaStore
   * @param {object} opts.gatewayCfg  gateway 配置（取 fallback 等）
   * @param {object} opts.log
   */
  constructor(opts) {
    this.cfg = opts.cfg ?? {}
    /*
     * 随机源（可注入）。目前只有「等不及了插话」用（`_shouldCutIn`）——
     * 测试要固定它才能断"插话 / 不插话"，不然只能靠碰运气。
     */
    this._rand = typeof opts.random === 'function' ? opts.random : Math.random
    this.onebot = opts.onebot
    this.gateway = opts.gateway ?? opts.llm
    this.decision = opts.decision
    this.memory = opts.memory
    this.longMemory = opts.longMemory
    /**
     * 事件记忆层（2026-11-04）。可为 null（老调用/测试）。
     * 见 `src/memory/events.js` —— 注入走 `toPrompt`，
     * 收尾（强化 + 异步抽取）挂在 `_maybeSummarize` 里，见 `_touchEvents`。
     */
    this.events = opts.events ?? null
    /**
     * 今日状态（每天一份日程）。可空 —— 没有就跳过这一段提示词。
     *
     * ⚠️ 为什么单独一层而不是塞进长期摘要：
     *    摘要按 scope 存（群/私聊各一份），而「今天是几号、几点在干嘛」
     *    是**跨会话共享**的事实 —— 她在群里说自己在吃午饭，
     *    私聊里也得说在吃午饭。所以单独存。
     */
    this.dayPlan = opts.dayPlan ?? null
    /** 生成今日日程的函数（由 index.js 注入，可空） */
    this.generateDayPlan = opts.generateDayPlan ?? null
    /**
     * 免费热点源（可空）—— 今天外面在聊什么。
     *
     * ⚠️ 定位是「**接话的料**」，不是「开口的理由」：
     *    只有跟本群近期话题挂得上钩的才进提示词，挂不上就什么都不注入。
     *    群聊里最烦的是转发新闻的机器人，这条是防线。
     */
    this.hotTopics = opts.hotTopics ?? null
    /**
     * **每天搜索次数的限额**（2026-11-01）。
     *
     * ⚠️ 原来那个 `maxUses` 是**死参数** —— 传进 `webSearch()` 但那里零处实现，
     * 面板上写着「最多搜几次」却什么都不拦（实测某天搜 12 次，配置写 3）。
     * 这个 `SearchQuota` 是真计数：写盘、跨天归零。
     */
    this.searchQuota = opts.searchQuota ?? null
    /*
     * 每小时限次（2026-11-03）—— 防"某个小时连搜"。
     *
     * ⚠️ 跟 `searchQuota` 是**两个不同层级**的闸，两个都要：
     *   `searchQuota`  一天的**总账**（省钱主力，落盘，跨重启还在）
     *   `searchPacing` 一小时的**突发闸**（内存，重启即清）
     * 日上限拦不住"判据发疯" —— 实测一小时内连搜了 3 次「能看吗」，
     * 那种情况下判据明显失灵，限一下比事后看账单强。
     */
    this.searchPacing = opts.searchPacing ?? null
    this.persona = opts.persona
    /**
     * 人物档案（可空）—— 按 **QQ 号**认人，昵称只当别名。     *
     * 为什么单独一层而不是塞进会话记忆：一个人会出现在多个群和私聊里，
     * 但「他是谁」这件事跨会话只有一个答案。会话记忆回答「这里发生过什么」，
     * 档案回答「这个人是谁」。
     */
    this.people = opts.people ?? null
    /**
     * 收藏表情的**标签库**（2026-10-31）。
     *
     * `fetch_custom_face` 只给 URL（没有名字/描述）→ 她发表情是闭眼随机甩。
     * 有了标签才知道自己有什么、才能按「[表情包:哭]」挑到真的"哭"。
     * 打标签是**批处理**：现在打一批，之后攒够 `minPending` 张再打下一批。
     */
    this.stickerTags = opts.stickerTags ?? null
    this.log = opts.log ?? {}
    /** 用量统计（可空）—— 用于总览页的 token/费用 */
    this.usage = opts.usage ?? null
    /**
     * 活跃天数统计（可空）。
     *
     * 和 `usage.startedAt` 不同：那个是「首次启动时间」，算出来是装了多久；
     * 这个数的是**真正有消息往来的日子**，关机的那几天不算。
     */
    this.activity = opts.activity ?? null
    /** DeepSeek API key —— 联网搜索用（没有就跳过搜索，不影响其它功能） */
    this.searchKey = opts.searchKey ?? null
    /** 最近一次联网搜索（给 UI 看） */
    this._lastSearch = null
    this.selfId = null
    this.selfName = 'WhalePod'
    /** 处理队列：保证同一会话串行，避免并发抢话 */
    this._queues = new Map()
    /** 最近一次回复（供 Web UI 展示） */
    this.recent = []
    this.stats = { received: 0, dropped: 0, considered: 0, replied: 0, failed: 0, silent: 0, deferred: 0 }
    /** 暂停开关（Web UI 可切） */
    this.paused = false
    /**
     * 冷却期内待补回的消息（按会话分组）。
     *
     * 同一个会话只留**最后一条** —— 冷却结束时用户想问的显然是
     * 最新那句话，把前面几条都排着回会让机器人像复读机。
     *
     * @type {Map<string, {msg:object, mem:object, scene:object, self:object, at:number, timer:any}>}
     */
    this._deferred = new Map()

    /**
     * 谁最近跟它说话最多 —— 讨钱要 @ 的人从这里选。
     *
     * 为什么要有这个：需求是「@ 最近和机器人互动多的人」，而原来
     * bridge 里没有任何按人聚合的统计（mem 是消息序列，不是计数）。
     *
     * 为什么用滑动窗口：累计次数会让「早期聊得多、现在早就不在群里」的人
     * 永远排第一 —— 讨钱讨到这种人身上既尴尬又没用。
     */
    this._interactions = InteractionTracker.fromJSON(
      opts.interactions ?? [],
      { windowMs: 7 * 24 * 3600_000 },
    )

    /**
     * 乞讨状态（今天讨了几次、用过哪些话术）。
     *
     * 落盘到 <home>/beg.json —— 「每天 3 次」必须跨重启有效，
     * 否则重启一次就重置，等于没有限制。
     */
    this._begState = new BegState({ file: opts.begFile ?? null })
  }

  /** 记一次「有人跟它说话」（供讨钱选人用）。 */
  noteInteraction(userId, userName, at = Date.now()) {
    this._interactions.hit(userId, userName, at)
  }

  /**
   * 启动主动行为调度器（讨钱 + 空闲发言）。
   *
   * ## 为什么需要它
   *
   * 原来「讨钱」挂在**搜索成功**后面：不搜索就永不查余额；
   * 而且 `_maybeBeg` 只是往回复里附带一句，她不回复时同样不触发。
   * 「空闲发言」则**完全不存在** —— 群里安静下来她就永远沉默。
   *
   * 现在两条路径都由独立定时器驱动，跟「有没有人在说话」无关。
   *
   * @param {object} [opts]
   * @param {import('node:fs')} [opts.fs]
   * @param {string} [opts.home] 数据目录（写 proactive.json）
   * @param {(scope:string) => string|null} [opts.memoryOf] 取某会话的 MemoryStore
   */
  startProactive(opts = {}) {
    if (this._proactive) return this._proactive

    const file = opts.home ? `${opts.home}/proactive.json` : null
    const state = new ProactiveState({ file, fs: opts.fs ?? null })
    const memoryOf = opts.memoryOf ?? (() => null)
    // 白名单为空时，scopes() 要靠「实际有记录的会话」来枚举 —— 由宿主注入。
    if (typeof opts.scopesSource === 'function') this._scopesSource = opts.scopesSource

    /**
     * 判断某个会话「有没有过聊天」。
     *
     * ⚠️ 不能只看短期记忆 —— 它是纯内存的，重启后清零。
     *    只查 `mem.recent(1)` 的话重启后所有会话都被过滤掉，
     *    scopes() 返回空，主动发言永不触发。
     *
     *    长期记忆是落盘的（memory-long.json），重启后仍在，
     *    所以「短期有消息 **或** 长期有摘要」都算有过聊天。
     */
    const hasHistory = (scope) => {
      try {
        if ((memoryOf(scope)?.recent?.(1)?.length ?? 0) > 0) return true
      } catch { /* ignore */ }
      try {
        const summary = this.longMemory?.get?.(scope)?.summary
        if (typeof summary === 'string' && summary.length > 0) return true
      } catch { /* ignore */ }
      return false
    }

    /**
     * 计算「可以主动发言的会话」。
     *
     * 提取成独立函数是为了让 `idleMs` 也能用 —— 它比 scheduler 先创建，
     * 拿不到 `this._proactive`。
     *
     * @returns {string[]}
     */
    const computeScopes = () => {
      const out = []
      const p = this.cfg.proactive ?? {}
      if (p.inGroups !== false) {
        const groups = (this.cfg.allow?.groups ?? []).map(String)
        if (groups.length > 0) {
          for (const g of groups) {
            const scope = `group:${g}`
            if (hasHistory(scope)) out.push(scope)
          }
        } else if (this.cfg.allow?.allowAllWhenEmpty === true) {
          // 白名单为空但允许所有人用 —— 这时「可发言的群」就是**实际有记录的群**。
          // 早先只遍历白名单，空数组时永远拿不到 scope，主动发言一次都不会触发。
          for (const scope of this._knownScopes('group')) {
            if (hasHistory(scope)) out.push(scope)
          }
        }
      }
      if (p.inPrivate === true) {
        const users = (this.cfg.allow?.private ?? []).map(String)
        if (users.length > 0) {
          for (const u of users) {
            const scope = `private:${u}`
            if (hasHistory(scope)) out.push(scope)
          }
        } else if (this.cfg.allow?.allowAllWhenEmpty === true) {
          for (const scope of this._knownScopes('private')) {
            if (hasHistory(scope)) out.push(scope)
          }
        }
      }
      return out
    }

    this._proactive = new ProactiveScheduler({
      /*
       * 传 **getter** 而不是值。
       *
       * `this.cfg` 是 bridge 启动时的配置快照，而设置页热更新只推
       * allow/model/maxTokens/effort/reply —— `proactive` 和 `beg` 不在其中。
       * 传值的话调度器永远看到 undefined，planSpeak 第一行就返回
       * 「发言未开启」，一次都不会触发。
       */
      cfgSource: () => this.cfg.proactive ?? {},
      begCfgSource: () => this.cfg.beg ?? {},
      state,
      log: this.log,
      // 查余额：只有偏低才返回 true
      checkBalance: async () => {
        if (!this.searchKey) return false
        const b = await checkBalance(this.searchKey, 8000)
        if (!b?.ok) return false
        this._balance = b
        const threshold = this.cfg.search?.lowBalanceCny ?? 3
        const low = b.cny <= threshold
        this._balanceLow = low
        this.log.info?.(`proactive：余额 ¥${b.cny}（阈值 ¥${threshold}）${low ? ' —— 偏低' : ''}`)
        return low
      },
      // 讨钱：走已有实现，但**不看 msg** —— 主动发，不依赖有人说话
      onBeg: async () => {
        const groups = (this.cfg.allow?.groups ?? []).map(String).filter(Boolean)
        if (groups.length === 0) {
          this.log.info?.('proactive：没有白名单群，不讨钱')
          return false
        }
        // 从白名单里挑一个「最近有人说过话」的群 —— 没互动过的群 @ 谁都不知道
        const picked = groups.find((g) => memoryOf(`group:${g}`)?.recent?.(1)?.length > 0) ?? null
        if (!picked) {
          this.log.info?.('proactive：白名单群都还没有聊天记录，不知道 @ 谁')
          return false
        }
        const cny = Number(this._balance?.cny)
        return await this._maybeBeg({ kind: 'group', groupId: picked, scope: `group:${picked}` }, Number.isFinite(cny) ? cny : 0)
      },
      // 主动发言：在某个会话说一句
      onSpeak: async (scope) => {
        const mem = memoryOf(scope)
        if (!mem) return false
        const kind = scope.startsWith('group:') ? 'group' : 'private'
        const id = scope.slice(scope.indexOf(':') + 1)
        this._lastSpeakScope = String(scope ?? '')   // 兼容旧字段
        // 按类型各存一份：私聊/群分别结算「没人接」，别互相覆盖
        const kk = scope.startsWith('group:') ? 'group' : 'private'
        this._lastSpeakScopeByKind = this._lastSpeakScopeByKind ?? {}
        this._lastSpeakScopeByKind[kk] = String(scope ?? '')

        return await this._speakUp({ scope, kind, groupId: kind === 'group' ? id : null, userId: kind === 'private' ? id : null }, mem)
      },
      // 可主动发言的会话：白名单内、并且「有过聊天」（短期或长期任一有记录即可）
      // 可主动发言的会话（逻辑见上方 computeScopes）
      scopes: computeScopes,

      /*

       * ★ **主动说了没人接 → 那个人 −2**（2026-11-04，好感度「减」的那半边）。

       * 只有私聊扣得到具体的人；群里不知道"该谁接"，所以不扣（避免误伤）。

       * 地板 40：普通私聊不会因为几次没接就掉到冰点。

       */

      onIgnored: ({ kind }) => {
        try {
          /*
           * ⚠️ 按类型取 scope（2026-11-04 修）：原来用共享的 `_lastSpeakScope` ——
           * 私聊发言后群里又主动说一次就会把 scope 覆盖成 group，结算时静默跳过。
           */
          const kk = String(kind ?? '').toLowerCase()
          const scope = this._lastSpeakScopeByKind?.[kk] ?? this._lastSpeakScope ?? ''
          if (!(kk === 'private' && scope.startsWith('private:'))) return
          const uid = scope.slice('private:'.length)
          this.people?.bumpAffinity?.(uid, -2, { floor: 40, reason: '主动发言没人接' })

        } catch (e) { this.log.debug?.('好感度扣分失败（忽略）：' + String(e?.message ?? e)) }

      },
      // 静默时长 = 所有候选会话里「距上次有人说话」的最大值
      idleMs: () => {
        /*
         * ⚠️ 不能用 `this._proactive.scopes()` —— `this._proactive` 在本函数
         *    返回之后才赋值，首次 tick 时还是 undefined，list 恒为空，
         *    idleMs 恒为 0，永远「还不够安静」。
         *
         * 这里用闭包捕获的 `computeScopes`，它是本作用域内的函数，
         * 构造时就已经可用。
         */
        let list = []
        try {
          list = computeScopes()
        } catch { /* 拿不到就当没有 */ }
        if (list.length === 0) return Infinity  // 没有会话 = 没人在说话 = 安静了无限久
        let max = 0
        for (const scope of list) {
          const mem = memoryOf(scope)
          const since = mem?.sinceLastMessage?.()
          /*
           * ⚠️ `Infinity` 不能直接当「安静了无限久」用。
           *
           * `sinceLastMessage()` 在**短期记忆为空**时返回 Infinity ——
           * 但短期记忆是纯内存的，重启后必然为空。于是重启后第一轮
           * idleMs 就是 Infinity，立刻触发主动发言，而此时群里
           * 明明 8 秒前还有人说话（实测：17:55:28 判定「安静够久」，
           * 上一句是 17:55:20）。
           *
           * 正确语义：**这一路取不到任何时间戳时，视为「不知道」，返回 0**
           * （= 不算安静），让调度器保守地不开口。
           * 「真的安静了很久」这种情况，短期记忆里有消息、时间戳是真实的，
           * 走下面的 Number.isFinite 分支自然能算出来。
           */
          if (Number.isFinite(since) && since > max) max = since
        }
        return max
      },
      /*
       * ★ **单个会话的静默**（2026-11-03 加）。
       *
       * 上面那个 `idleMs` 取的是"候选里最长的静默"，被当成门槛用；
       * 而真正发到哪是随机的 —— 于是会出现「群安静 3 小时，她开口时
       * 却进了 2 分钟前还在聊的私聊」。实测 22:32 那次就是这样。
       *
       * 口径和上面**完全一致**：取不到真实时间戳 → 返回 0 = "不算安静"
       * （重启后短期记忆为空时，绝不能当成"安静了无限久"，
       *  那条注释就在上面，别在这儿又踩一遍）。
       */
      idleMsOf: (scope) => {
        try {
          const since = memoryOf(scope)?.sinceLastMessage?.()
          return Number.isFinite(since) ? since : 0
        } catch { return 0 }
      },
    })

    this._proactiveScopes = () => this._proactive.scopes()
    this._proactive.start()
    /*
     * ★ 「约定时间到了就催一句」的定时器（2026-11-03）。
     * 30 秒扫一次待催表；**它和主动发言的骰子/静默/额度完全无关** ——
     * 到点就该催，不该再掷一次骰子看运气（用户要的就是这个区别）。
     */
    this._startNudgeTimer()
    /*
     * ★ 启动时顺手给**已有收藏**打一批标签（2026-10-31）。
     * 用户原话：「现在已有的表情打标签分类，以后的等积累到一定程度再次打标签」。
     * 后台跑，失败了不影响任何东西（NapCat 没起来时会自己跳过）。
     */
    setTimeout(() => { void this._tagStickerBatch?.() }, 20_000)
    return this._proactive
  }

  stopProactive() {
    this._proactive?.stop?.()
    this._proactive = null
  }

  /**
   * 列出「实际有聊天记录」的会话，按 kind 过滤。
   *
   * 白名单为空（`allowAllWhenEmpty: true`）时，主动发言需要知道**跟谁说过话** ——
   * 白名单那套拿不到任何 scope，等于永远不开口。
   *
   * @param {'group'|'private'} kind
   * @returns {string[]}
   */
  _knownScopes(kind) {
    const prefix = `${kind}:`
    return this._allScopes()
      .map(String)
      .filter((s) => s.startsWith(prefix))
  }

  /** 所有已知会话（跨 kind）。子类/宿主可通过 `_scopesSource` 覆盖。 */
  _allScopes() {
    try {
      if (typeof this._scopesSource === 'function') {
        const v = this._scopesSource()
        if (Array.isArray(v)) return v
      }
    } catch { /* 拿不到就当没有 */ }
    return []
  }

  /**
   * 判断「这张图值不值得让生成层看一眼」。
   *
   * ## 背景
   *
   * 决策层看不见图（纯文本分类器），所以纯图片消息一律被判「跟我无关」。
   * 但群友发**跟鲸鱼娘形象相近的图**时，它应该有点反应 ——
   * 实测发了一张蓝发 + 鲸鱼尾 + 女仆围裙的胖鱼图，它一声不吭。
   *
   * ## 为什么不能无脑放行
   *
   * 群聊一天几百张图。每张都过一遍 LLM（还带图）既贵又容易刷屏，
   * 而且「见啥都接」比「不接」更烦人。所以先做**零成本粗筛**。
   *
   * ## 粗筛条件（满足任一）
   *
   * ① **图是单独发的** —— 消息里除了图没有别的文字。
   *    纯图 = 对方专门在「展示」什么，多半想让人看。
   *    图文混排（「今天天气不错 [图片]」）那图是配菜，走正常决策。
   *
   * ② **最近有人提过鱼/鲸/本鱼/大肥鱼** —— 话题已经在这个方向上，
   *    这时发的图很可能是在接着聊「像不像你」。
   *
   * ③ **对方是最近跟我聊过的人** —— 熟人群里发的图更可能是给我看的。
   *    （这条放宽一点，避免只认「鱼」这个词导致漏掉真正像的图。）
   *
   * @param {object} msg  归一化消息
   * @param {object} mem  该会话的 ConversationMemory
   * @returns {boolean}
   */
  _shouldLookAtImage(msg, mem) {
    // 配置里关掉就不做这件事（默认开）
    if (this.cfg.reply?.imageJudge === false) return false

    const images = msg.images ?? []
    if (images.length === 0) return false

    /*
     * ⚠️ 表情包**排除在外**（2026-10-26 定）。
     *
     * 中途试过把表情包也放进来（因为那张最像鲸鱼娘的胖鱼图正好是表情包），
     * 但实测代价太大 —— 群里表情包频率极高，每张都过一遍模型，
     * 结果它对**每个**表情包都要硬找相似点：
     *
     *   20:48:26  「喊啥啊，这又不是本鱼」
     *   20:50:48  「蓝毛勉强沾点边」      ← 已经是在硬凑了
     *
     * 「勉强沾点边」比不接更出戏。所以只对**真正的图片**做这件事，
     * 表情包回到原来的「斗图 / 情绪信号」路径（由决策层和 mediaHint 处理）。
     */
    const stickerCount = (msg.stickerRefs ?? []).length
    const isSticker = stickerCount > 0 && stickerCount >= images.length

    /*
     * ⚠️ 表情包：**放行，让它自己看**（2026-10-27 第四次调）。
     *
     * 四次调整的完整历史，别再走回头路：
     *
     *   ① 无条件放行 → **见表情就回**
     *      群里聊显卡时它连回 4 张（用户：「检查到表情就回，不管有没有关系」）
     *   ② 整个排除 → **带字的梗图也不看了**
     *   ③ 按「群里有没有人热聊」判断 → **错得很离谱**
     *      实测 21:07~21:12 四连沉默，而群里根本没聊别的事，
     *      全在聊它自己（「这画的是我吧」「这你不禁言他」）。
     *      我把「有人在说话」当成了「话题进行中别插嘴」，
     *      但那些话**恰恰是在聊它**。用户当场指出：「没聊别的事吧」
     *   ④ **放行 + 代码只防连发** ← 现在
     *
     * ## 为什么"用上下文猜该不该看"这条路是错的
     *
     * 因为**表情包和真图片一样，决策层/代码都看不见它有没有字**。
     * 有字的梗图，字就是全部内容；没字的表情，就是纯语气。
     * 这两种的取舍**只能靠看图**，用文本上下文猜必然错。
     *
     * 所以：放行（让它看），但用**频率**防刷屏 ——
     * 这才是「见表情就回」的真正解法，不是猜内容。
     */
    if (isSticker) {
      /*
       * ⚠️ 表情包：**只在「明确在跟它互动」时才回**（2026-10-28 第五次调，用户选 B）。
       *
       * ## 为什么又调
       *
       * 实测群 123450001：同一张青蛙表情包（fileid=EhSMnq3BrcHwXn2TbGaPI）
       * 出现 **4 次，它 4 次都回了**：
       * ```
       * 15:23:34 → 15:23:37 回「[表情包]」
       * 15:24:48 → 15:24:51 回「这青蛙看着还挺心宽体胖的」
       * 16:26:42 → 16:26:58 回「[表情包]」
       * 17:45:29 → 17:45:38 回「[表情包]」
       * ```
       * 用户原话：「还是反应青蛙，为啥啊」。
       *
       * 根因：这条路径**完全没有「是不是在跟我说话」的判断**。
       * 决策层给的是 `p=0.75「纯图片 → 交给生成层看图判断像不像自己」`，
       * 唯一抑制是下面那个「最近 3 条里已有 2 条纯表情」——
       * 而青蛙前后夹着大量别人的聊天，计数器根本攒不到 2。
       *
       * ## 现在的规则（放行条件，满足其一即可）
       *   ① **@ 它**
       *   ② **引用它自己的消息**
       *   ③ **斗图**：它上一条回复就是纯表情，且这条紧随其后（≤ 60s）
       *   ④ **刚跟它说完话**：它上一条是文字，同一个人 ≤ 20s 内接着发表情
       *
       * 其余情况**一律不接** —— 表情包只是情绪信号，别人互相斗图不关它的事。
       *
       * ## 和前四次的区别（别再走回头路）
       *   ① 无条件放行 → 见表情就回
       *   ② 整个排除   → 连**跟它斗图**都不接了
       *   ③ 按「群里有没有人热聊」判断 → 错，那些话恰恰是在聊它
       *   ④ 放行 + 只防连发 → **还是每张都回**（本次要修的）
       *   ⑤ **只在明确互动时回** ← 现在
       */
      // 判定逻辑抽到 stickerGate.js（可单测，见 tests/check-sticker-gate.mjs）
      return shouldAnswerSticker({
        msg,
        selfId: this.selfId,
        recent: mem?.recent?.(20) ?? [],
      })
    }

    /*
     * ① 图是单独发的。
     *
     * 去掉图片标记后还剩多少字 —— 剩得多说明是图文混排，走正常决策。
     * ⚠️ `@某人` 这种 at 段也算「有文字」，因为「@我 + 发图」的语义是
     *    「叫你 + 给你看东西」，该由决策层按「被 @」处理。
     */
    const textOnly = String(msg.text ?? '')
      .replace(/\[图片\]/g, '')
      .replace(/\[表情包(?::[^\]]*)?\]/g, '')
      .replace(/\[表情:\d+\]/g, '')
      .replace(/\s+/g, '')
      .trim()
    if (textOnly.length === 0) return true

    /*
     * ② 最近提到过鱼/鲸/本鱼/大肥鱼。
     *
     * 只看最近 6 条 —— 太老的对话已经翻篇了，拿它当判据会误放行。
     */
    const recent = mem?.recent?.(6) ?? []
    const fishTalk = recent.some((m) => /鱼|鲸|本鱼|大肥鱼|白米饭/.test(String(m?.text ?? '')))
    if (fishTalk) return true

    /*
     * ③ 对方最近跟我说过话（不要求是鱼相关）。
     *
     * 这条放宽了范围，因为「像不像自己」是**看图才知道**的，
     * 光靠关键词会漏掉很多真正像的图。代价是偶尔多看几张无关图，
     * 但生成层有 `[SILENT]` 兜底，不会真的回出来。
     */
    const fromKnown = recent.some((m) => !m.isMe && String(m?.sender ?? '') === String(msg.sender ?? ''))
    return fromKnown
  }

  /**
   *
   * ## 为什么要把 msg 补全
   *
   * `_generate` 里用到三个字段：
   *   msg.scope   → 取长期记忆
   *   msg.sender  → 查人物档案（按 QQ 号认人）
   *   msg.text    → 判断要不要联网搜
   *
   * 早先只传了 scope/kind/id，另外两个是 undefined —— 人物档案查不到、
   * 搜索判断也失效。这里补成一条「空消息」：text 为空表示「没有新内容，
   * 你自己找话说」。
   */
  async _speakUp(msg, mem, extraHint = '') {
    try {
      /*
       * ★ **催话路径没有会话记忆**（2026-11-04 修的真 bug）。
       *
       * `_tickNudges` 传的是 `mem = null`（它在定时器里跑，拿不到
       * startProactive 里那个 `memoryOf(scope)` 闭包）。而提示词拼装里有
       * 一处直接 `mem.recent(20)` —— 于是每次"约定到点催一句"都在这里崩：
       * ```
       * 02:50:43 bridge：约定到点 —— 催一句（今天第 1 次）
       * 02:50:43 [warn] proactive：主动发言失败 — Cannot read properties of null (reading 'recent')
       * ```
       * 用户看到的就是「约定时间好像也没有生效」—— **约定记对了、到点也触发了，
       * 只是催话这一步炸掉，一个字都没发出去。**
       *
       * 修法：先按会话取回记忆（`this._memOf`，startProactive 里注册）；
       * 取不到就给一个**空壳**（`recent` 返回空数组）—— 让拼装永远有东西可读。
       * 空壳顶多催得平淡，崩掉是整条消息消失 —— 显然空壳更好。
       */
      if (!mem) {
        try { mem = this._memOf?.(msg?.scope) ?? null } catch { mem = null }
      }
      if (!mem) {
        mem = { recent: () => [], sinceLastMessage: () => Infinity, push: () => {}, tick: () => {} }
      }
      /*
       * ★ 主动发言前先确保热点是**新鲜**的（2026-10-31）。
       *
       * 主动发言不走 `_handle`，所以那条路上的 `_ensureHotTopics` 够不着它 ——
       * 实测 `hot-topics.json` 停在 00:03，18:29 还在用。
       *
       * 这里 `wait: true`：主动发言本来不急，多等 100ms 换个新榜值得。
       */
      await this._ensureHotTopics({ wait: true })
      const scene = await this.sceneOf(msg)
      const self = { id: this.selfId, name: this.selfName }
      /*
       * ── 按「距上次有人说话」分成两档 ────────────────────────
       *
       * ⚠️ 这是用户明确指出的问题（2026-10-27）：
       *
       *   16:03 主动说「显卡那事啊，我不懂行情…」
       *   而群里聊显卡是 13:xx 前后 —— **隔了两个多小时**。
       *
       * 真人不会在沉默两小时后突然接两小时前的话题，那太怪了。
       * 「接着刚才的话题」这句话在**小间隔**下是对的（补一句话），
       * 在**大间隔**下就成了「翻旧账」。
       *
       * 分界定在 20 分钟：
       *   · < 20 分钟 = 同一个话头还没散，可以接
       *   · ≥ 20 分钟 = 已经翻篇了，只能开**新**话题（今日状态里的小事）
       *
       * 触发阈值是 45 分钟，所以实际上大部分主动发言都会落在
       * 「新话题」这一档 —— 这正是想要的效果。
       */
      const idle = (() => {
        try {
          const v = mem?.sinceLastMessage?.()
          return Number.isFinite(v) ? v : Infinity
        } catch { return Infinity }
      })()
      const FRESH_MS = 20 * 60_000
      const gapText = idle === Infinity
        ? '（这个会话之前没有记录）'
        : `（距上次有人说话已经 ${Math.round(idle / 60_000)} 分钟）`

      const speakHint = idle < FRESH_MS
        ? `（没人说话，但也没多久。想接就接，不想接就输出 [SILENT]。）`
        : `（这个会话已经安静${gapText}了。

## 要不要开口，你自己定
**别因为「该说话了」就硬凑一句 —— 那比不说话更像机器。**
没有真正想说的，就输出 [SILENT]。今天一句不说也完全没问题。

## 真有想说的，按这个顺序挑（越靠前越像人）
① **共同回忆**：你记得他的事、你们最近聊过的
   （「你那个 X 后来咋样了」「宿舍断电那事解决了没」）
   ⚠️ 别用「上次」「之前」这种词 —— 像自然想起来一样说。
② **他此刻在干什么**：下课没？到家没？吃上饭没？
   这个最像人 —— 真人一开口，是先看对方在不在忙。
③ **当下的时段 / 心情**：短、口语
   （「下午好无聊」「困」「今天怎么这么安静」）
④ 自己的小情绪 —— 也行

## ⚠️ 「今天我」只是**背景**，不是台词
别人问你在干嘛，按它答；但**不要主动念日程**。
❌ 「洗漱完煮了八个速冻小馄饨，汤里放了紫菜、虾皮和几滴香油」
✅ 「刚吃了个橘子，手黏死了」

## ⚠️ 你自己说过的承诺 / 计划，不能当成已经发生的事去提
你说过「给你留一碗饭」不等于他答应了 —— 人家可能正在上课。
该问的是「下课没」，不是「我给你留了饭」。

## ⚠️ 不要没头没尾
别硬编一个开头来接话（「福是真福，就是…」这种 —— 说到最后你自己都不知道在说什么）。
说不清就别说了。`

      /*
       * ★ 把**热点**塞进来当"话头素材"（2026-10-31）。
       *
       * 原来主动发言只有 dayPlan 可讲 —— 而 dayPlan 是"日记"，
       * 念出来就是「洗漱完煮了八个馄饨，汤里放了紫菜虾皮」这种流水账
       * （实测事故：「福是真福，就是橘子吃完手黏」）。
       *
       * 热点是"外面在聊什么"，天生适合当闲聊的由头。
       *
       * ⚠️ 用 `toPromptForProactive`（**不要求**挂钩"最近消息"）——
       *    主动发言的场景就是没人在聊，要求挂钩就永远返回空。
       */
      /*
       * ★ 「**不是啥都分享**」—— 按"这个群/这个人关心什么"筛热点（2026-10-31）。
       *
       * 依据：
       *  · **群**：这个群的长期摘要【事】= 他们平时在聊什么
       *  · **私聊 / @某人**：那个人的档案（`people.json` 的 impression + facts）
       *    例：他是「在玩一款手游、周末要值班」→ 就挑游戏/校园相关的，不挑明星八卦。
       *
       * 筛不出来 → `hotHint` 为空 → 没有话头 → 它大概率沉默。
       * **这才是对的** —— 在一个技术群里聊表情包大赛，比不说话更掉价。
       */
      /*
       * ★ 关注点 = **机器人自己的兴趣（主）** + 场合（群/这个人关心什么，辅）
       *
       * 用户原话：「按照机器人人格来呢，机器人要像人肯定有自己的关注点和兴趣」。
       *
       * 真人分享的动机是「**我自己觉得这个有意思**」，不是"该投其所好了"。
       * 所以：
       *   · `cfg.proactive.interests`（从人格提炼：吃/米饭/Token/摸鱼/新番…）放**主位**
       *   · 群摘要 / 那个人的档案只做**场合校准**（在技术群就别只聊吃的）
       */
      const selfInterests = String(this.cfg.proactive?.interests ?? '').trim()
      const sceneInterest = (() => {
        try {
          const uid = msg?.userId
          if (uid) {
            const p = this.people?.get?.(uid)
            if (p) return [p.impression, ...(p.facts ?? [])].filter(Boolean).join(' ')
          }
          return String(mem?.summary ?? '')
        } catch { return '' }
      })()

      /*
       * ★ **不预筛**（2026-10-31）——
       * 用户：「现在应该要能**直接总结**一点吧，**这还是人为定的**」。
       *
       * 原来我用关键词表先过滤一遍热点，那等于把"它关心什么"替它写死了。
       * 现在：清单原样交给模型，让它按**自己的人格**挑；
       * 我只把"这个群/这个人平时关心什么"作为**参考**给出来。
       *
       * `selfInterests` 非空时才是**显式覆盖**（强行指定兴趣，一般别用）。
       */
      const hotHint = this.hotTopics?.toPromptForProactive?.({ interest: selfInterests, limit: 5 }) ?? ''
    /*
     * ★ **订阅的吧**（2026-11-01）—— 单独一段，**不过滤**。
     *
     * ## 为什么不并进 `hotHint` 一起筛
     * `hotHint` 是按「这个群/这个人关心什么」筛过的**全站热议**。
     * 而订阅的吧是**用户自己指定**的垂直源 —— 他订「明日方舟吧」就是说
     * "这个吧的内容我要"，**再按 interest 筛一遍等于把他的选择又judge了一次**。
     *
     * 实测那种筛法会把吧里的帖子筛掉大半（吧里的标题跟群摘要未必字面重合）。
     *
     * ## 但也不是无脑全给
     * `forumItems` 里已经过一遍**黑名单**（地域/时政/灾难），而且每个吧只取前几条。
     */
    const forumTopics = this.hotTopics?.forumTopics?.(this.cfg.proactive?.tiebaForums ?? [], { limit: 5 }) ?? []
    /*
     * ⚠️ **2026-11-01 从"热帖列表"改成"词频"** —— 用户看过实际效果后的判断：
     * **「热帖感觉没啥用」**。
     *
     * 对 —— 热帖排的是**累积回复数**：`[7894回复] 【记录帖】入坑五个月废新刀客塔`
     * 可能是几周前的帖子，却永远排在"最近在聊什么"的头上。**热度 ≠ 当下**。
     *
     * 而裸标题又多是碎片（`捂嘴的还能说话吗`、`到底什么情况？`），
     * 单看不知道在说什么。现在交给 `forumTopics` 压成几个词 ——
     * **一个吧此刻反复出现的名字，就是它此刻在聊的东西**：
     * ```
     * · 明日方舟吧：塔露拉 / 设计师 / 冻河
     * ```
     * 实测这就是"这个吧现在在吵什么"（新角色塔露拉强度、策划被骂、另一个角色冻河）。
     */
    const forumHint = forumTopics.length
      ? `## 你订阅的吧最近在聊什么\n`
        + forumTopics.map((x) => `· ${x.forum}吧：${x.keywords.join(' / ')}`).join('\n')
      : ''
      const sceneHint = sceneInterest
        ? `## 这个会话的人平时关心什么（挑的时候参考，别硬凑）\n${String(sceneInterest).slice(0, 240)}`
        : ''
      const hotRule = hotHint
        ? `## 怎么挑
- 挑**你自己真觉得有意思**的那条 —— 不是为了"该分享"而分享。
  这两个差别很大，后者一眼假。
- 同时看上面「这个会话的人关心什么」：**对方接不住的就别挑**。
- 用自己的话说，**别照念标题**。
  （标题是「16强开打,谁是最靓表情包」→ 你说「最近那个表情包大赛你们看了没」）
- **一条都不感兴趣 / 都不合适 → [SILENT]**。这不是失败，是正常。`
        : ''
      const hintWithHot = [extraHint, speakHint, hotHint, forumHint, sceneHint, hotRule].filter(Boolean).join('\n\n')

      // 私聊时 sender 就是对方；群里没有具体发言人，留空。
      const full = {
        ...msg,
        sender: msg.kind === 'private' ? String(msg.userId ?? '') : '',
        senderName: '',
        /*
         * ⚠️ `text` 必须留空，不能写指令。
         *
         * `_generate` 里有一句 `needsFreshInfo(msg.text)` —— 它会把 text 当成
         * **用户说的话**去判断要不要联网搜索。早先这里写了一句
         * 「（没有人在说话。你自己找个话头开口…）」，结果被当成话题
         * 直接拿去搜了（日志实测：需要联网（提到具体名字「没人说话」））。
         *
         * 场景说明改由 `speakHint` 单独传给 `_generate`，不进 text。
         */
        text: '',
        // 场景说明：按「距上次说话多久」分两档 + 热点素材
        speakHint: hintWithHot,
        isMe: false,
        at: Date.now(),
      }
      /*
       * ⚠️ `_generate` 返回 `{ text, cover }`，不是字符串。
       *    早先直接 `String(text)` 会把整个对象转成 "[object Object]"
       *    发出去 —— 实测就是这样翻的车。
       */
      const gen = await this._generate(full, mem, scene, self)
      const clean = String(gen?.text ?? '').trim()
      if (!clean || clean.includes(SILENT)) {
        this.log.info?.('proactive：模型选择不说')
        return false
      }
      /*
       * ⚠️ 走 `_send`，不要直接 `onebot.sendGroup`（2026-10-27 修）。
       *
       * 原来这里是：
       *   if (group) await this.onebot.sendGroup(msg.groupId, clean)
       *   else       await this.onebot.sendPrivate(msg.userId, clean)
       *
       * 直接发原始文本 = **绕过了 `_send` 里的所有处理**：
       *   · 分段（`splitMessage`）—— 模型输出里的空行本该拆成两条消息
       *   · 表情标记（`[表情:N]` / `[表情包]`）—— 不解析会原样发出方括号
       *   · `[SILENT]` 剥离、超长截断、引用回复
       *
       * 实测症状（群里 16:03 那条）：
       *   「显卡那事啊，我不懂行情，就知道贵，打游戏没用就是纯坑。
       *
       *    要问还得问阿乙」
       * 本该是**两条**消息（空行 = 显式分段意图），结果挤在一条里，
       * 中间一个空行，看起来像卡住了没发完。
       *
       * `_send` 的第一个参数需要 `{ scope, kind, groupId, userId }` ——
       * `full` 就是 msg 的展开，字段齐。
       */
      const sentIds = await this._send(full, clean)
      // 同上：记**剥完标记之后**的正文（`_send` 会挂 `__sentText`）
      mem.push(makeMessage({
        sender: this.selfId ?? '0',
        senderName: this.selfName,
        text: full.__sentText ?? clean,
        isMe: true,
        at: Date.now(),
      }))
      this.stats.replied++
      const where = msg.kind === 'group' ? `群` : `私聊`
      this.log.info?.(`proactive：[我主动] ${msg.scope}（${where}，${sentIds.length} 条）「${clean.slice(0, 100)}」`)
      this._rememberMyReplyIds(msg.scope, sentIds)
      return true
    } catch (e) {
      this.log.warn?.(`proactive：主动发言失败 — ${String(e?.message ?? e)}`)
      return false
    }
  }

  /** 讨钱状态快照（给 Web UI / 调试用）。 */
  begSnapshot() {
    return {
      ...this._begState.snapshot(),
      balance: this._balance ?? null,
      low: Boolean(this._balanceLow),
      candidates: this._interactions.top({ limit: 5, exclude: [this.selfId].filter(Boolean) }),
    }
  }

  /** 绑定 OneBot 事件。 */
  attach() {
    // ★ 重连后补历史（2026-11-05）：断连窗口漏掉的消息从 NapCat 拉回来，只进记忆不回复
    this.onebot.on('open', () => { void this._backfillHistory() })
    this.onebot.on('event', (ev) => { this.onEvent(ev).catch((e) => {
      this.stats.failed++
      this.log.warn?.(`bridge：处理事件失败 — ${String(e?.message ?? e)}`)
    }) })
    this.onebot.on('open', async () => {
      try {
        const info = await this.onebot.getLoginInfo()
        const d = info?.data ?? info
        this.selfId = String(d?.user_id ?? '')
        this.selfName = String(d?.nickname ?? 'WhalePod')
        this.log.info?.(`bridge：已登录为 ${this.selfName}(${this.selfId})`)
      } catch (e) {
        this.log.warn?.(`bridge：取登录信息失败 — ${String(e?.message ?? e)}`)
      }
    })
    return this
  }

  /**
   * 查询群名（带缓存）。
   *
   * 为什么要缓存：`get_group_info` 每次都要打协议端，而群名几乎不变。
   * 缓存 10 分钟，既让 prompt 里能带上群名（模型知道自己在哪个群，
   * 对判断语气有帮助），又不给协议端添压力。
   */
  async groupName(groupId) {
    if (!groupId) return undefined
    if (!this._groupNames) this._groupNames = new Map()
    const now = Date.now()
    /*
     * ★ 超过 2 分钟才轮到的消息**直接丢**（2026-11-05）：
     *   实测有 598s / 2998s 才回一句的，那是积压或补历史残留 ——
     *   隔这么久再回，对方早忘了自己在说什么。
     */
    if (Number(msg.at) && Date.now() - Number(msg.at) > 120_000) {
      this.stats.silent++
      this._record(msg, { reply: false, probability: 0, provider: 'stale-age', reason: '超过 2 分钟才轮到 → 丢弃' }, null, 'stale')
      return
    }
    const hit = this._groupNames.get(String(groupId))
    if (hit && now - hit.at < 600000) return hit.name

    try {
      const res = await this.onebot.call('get_group_info', { group_id: Number(groupId) }, 8000)
      const name = res?.data?.group_name
      if (name) {
        this._groupNames.set(String(groupId), { name, at: now })
        return name
      }
    } catch { /* 查不到不影响，用 undefined */ }
    this._groupNames.set(String(groupId), { name: undefined, at: now })
    return undefined
  }

  /** 白名单判断（fail-closed）。 */
  allowed(msg) {
    const allow = this.cfg.allow ?? {}
    const priv = allow.private ?? []
    const groups = allow.groups ?? []
    const empty = priv.length === 0 && groups.length === 0

    if (empty) return allow.allowAllWhenEmpty === true

    if (msg.kind === 'private') return priv.map(String).includes(String(msg.userId))
    return groups.map(String).includes(String(msg.groupId))
  }

  /** 处理一条消息事件。 */
  /**
   * 确保「今天」的日程存在；没有就生成一份。
   *
   * ## 为什么懒生成而不是定时任务
   *
   * 定时任务在没人说话的日子也会白花一次调用。懒生成只在
   * 「今天第一次要回复」时才跑，一天最多一次，省钱且简单。
   *
   * ⚠️ 并发保护：同一时刻多条消息进来时，不能每个都去生成
   *    （那会一天烧掉好几次调用，而且互相覆盖）。用一个
   *    in-flight promise 兜住，后来者等同一个结果。
   *
   * ## ⚠️ `wait`：别把它卡在回复路径上（2026-10-29 加）
   *
   * 这是**一次完整的模型调用**，实测**单独花了 42 秒**
   * （16:47:44 收到消息 → 16:48:26 才生成出来，那条回复在 16:48:30 才发出）。
   *
   * 它一天只跑一次，但那一次会**整整卡住当条回复 42 秒** —— 用户感受到的就是
   * 「今天第一条回得特别慢」，而且完全猜不到原因。
   *
   * 所以调用方用 `wait: false`：**把生成踢到后台，本轮不等**。
   * 这一条回复先用「今天暂无日程」（`today()` 返回 undefined，
   * 提示词里就没有今日状态那段），下一条回来时它已经就绪。
   *
   * 代价是**今天第一条**没有今日状态 —— 但比卡 42 秒好得多，
   * 而且它本来就是「随手编的日常」这种锦上添花的东西。
   */
  async _ensureDayPlan({ wait = true } = {}) {
    if (!this.dayPlan || !this.generateDayPlan) return
    if (this.dayPlan.today()) return
    if (!this._dayPlanPending) {
      this._dayPlanPending = (async () => {
        try {
          const plan = await this.generateDayPlan({ recent: this.dayPlan.recentHints() })
          if (plan) {
            this.dayPlan.setToday(plan)
            this.log.info?.(
              'bridge：今日状态已生成 — ' + [plan.morning, plan.noon, plan.afternoon].filter(Boolean).join(' / '),
            )
          }
        } catch (e) {
          this.log.warn?.('bridge：今日状态生成失败 — ' + String(e?.message ?? e))
        } finally {
          this._dayPlanPending = null
        }
      })()
    }
    // 后到者要不要一起等，也跟着调用方的意思
    if (wait) await this._dayPlanPending
  }

  /**
   * 今天第一次回复时取一次热点（一天最多一次）。
   *
   * 跟 `_ensureDayPlan` 同一套：**踢到后台、本轮不等**（`wait: false`），
   * 因为这是一次网络请求（贴吧实测 103ms，但 B站会限流、可能重试），
   * 不该让回复等它。
   *
   * 失败不影响任何东西 —— 没有热点就只是"没有料"，本来也不该硬说。
   */
  async _ensureHotTopics({ wait = true } = {}) {
    if (!this.hotTopics) return
    /*
     * ⚠️ **订阅吧要独立检查**（2026-11-01）。
     *
     * 下面那段热议逻辑会**早退**（`fresh()` 没过期就直接 return），
     * 如果把订阅吧塞在里面，热议新鲜时订阅吧就**永远不抓** ——
     * 两者刷新节奏不同（热议 30 分钟，订阅吧 1 小时/吧），必须各查各的。
     */
    const forumJob = this._ensureForumTopics()
    /*
     * ⚠️ **不是 `today()`，是 `fresh()`**（2026-10-31 改）。
     *
     * `today()` 只看「是不是今天」→ 一天只抓一次 → 实测 00:03 抓的榜，
     * 到 18:29 还在用（**18 小时前的热点**）。热点时效性最强，必须新鲜。
     * `fresh()` 默认 30 分钟，过期就重抓。
     */
    if (!(this.hotTopics.fresh?.() ?? this.hotTopics.today())) {
      if (!this._hotTopicsPending) {
        this._hotTopicsPending = (async () => {
          try {
            const r = await fetchHotTopics()
            if (!r.ok) {
              this.log.warn?.(`热点：取失败（今天先不用）— ${r.error}`)
              return
            }
            const items = filterTopics(r.items).slice(0, 30)
            if (items.length === 0) {
              this.log.warn?.('热点：过滤后一条不剩（黑名单可能太严）')
              return
            }
            this.hotTopics.setToday(r.source, items)
            this.log.info?.(`热点：已取 ${items.length} 条（${r.source}，${r.ms}ms）`)
          } catch (e) {
            this.log.warn?.(`热点：出错（今天先不用）— ${String(e?.message ?? e)}`)
          } finally {
            this._hotTopicsPending = null
          }
        })()
      }
    }
    if (wait) await Promise.all([this._hotTopicsPending, forumJob].filter(Boolean))
  }

  /**
   * 抓**订阅的贴吧**（2026-11-01）。
   *
   * ## 配置
   * `config.json` → `proactive.tiebaForums: ["明日方舟", "原神"]`（手动加）。
   *
   * ## ⚠️ 一次只抓一个吧
   *
   * 三条理由，每条都是实测出来的：
   * 1. **限频防封** —— 一条响应 386 KB，百度有反爬。抓狠了被封，
   *    这个功能就整个废了。所以一个吧一小时最多一次（`forumFresh` 管）。
   * 2. **别拖太久** —— 一个吧约 0.9s，3 个吧串行就 2.7s。
   *    一轮只补一个，几分钟内自然补齐。
   * 3. **失败不重试到底** —— 某个吧一直失败（改名/被封）也只试一次，
   *    下一轮再来，不做自动重试循环。
   *
   * 失败静默：拿不到就跳过，**绝不影响**热议那条线。
   */
  async _ensureForumTopics() {
    const forums = this.cfg.proactive?.tiebaForums
    if (!Array.isArray(forums) || forums.length === 0) return
    if (!this.hotTopics) return
    if (this._forumPending) return this._forumPending
    this._forumPending = (async () => {
      try {
        for (const name of forums) {
          if (this.hotTopics.forumFresh(name)) continue   // 这个吧还新鲜
          const r = await fetchForum(name)
          if (r.ok) {
            this.hotTopics.saveForum(r.name, r.items)
            this.log.info?.(`贴吧订阅：${r.name}吧 ${r.items.length} 条（${r.ms}ms）`)
          } else {
            this.log.warn?.(`贴吧订阅：${name} 取失败 — ${r.error}`)
          }
          break   // ★ 一轮只抓一个
        }
      } catch (e) {
        this.log.warn?.(`贴吧订阅：出错（忽略）— ${String(e?.message ?? e)}`)
      } finally {
        this._forumPending = null
      }
    })()
    return this._forumPending
  }
  async onEvent(ev) {
    this.stats.received++
    if (this.paused) return

    // 通知事件（戳一戳 / 群成员变动等）单独走：它们没有消息体。
    // 放在 __normalized 检查之前，否则会被当"没有消息内容"直接丢掉。
    if (ev?.post_type === 'notice') return this._onNotice(ev)

    // 请求事件（加好友 / 加群邀请）。同样没有消息体。
    if (ev?.post_type === 'request') return this._onRequest(ev)

    const msg = ev?.__normalized ?? null
    if (!msg) return

    if (!this.allowed(msg)) {
      this.stats.dropped++
      this.log.debug?.(`bridge：忽略 ${msg.scope}（不在白名单）`)
      return
    }

    /*
     * ★ 他说话了 → 「约定到点催一句」作废（2026-11-03）。
     *
     * 只在对方**一直没动静**时才该催 —— 人回来了还催就是骚扰。
     * 放在白名单判断之后：被忽略的会话不该因为噪音把约定取消掉。
     * 她自己发的（`isMe`）不算「他回来了」，不作废。
     */
    if (!msg.isMe) this._cancelNudge(msg.scope, '他说话了')

    // 活跃天数：白名单内的消息进来就记一天。
    //
    // 放在 allowed 之后 —— 不在白名单的噪音不该算「活跃」。
    // 放在去重之前 —— 重连重推的同一条消息不该让这一天漏记。
    // touch() 同一天幂等，只有跨天才写盘，不用担心频繁 IO。
    this.activity?.touch()

    // 人物档案：记一次「这个人又出现了」，顺带更新昵称别名。
    //
    // 认人一律按 QQ 号 —— 昵称会换、会撞，用它当 key
    // 会把同一个人拆成好几个，或把两个人的印象串在一起。
    //
    // ⚠️ **字段是 `msg.userId`，不是 `msg.sender`**（2026-10-29 修）。
    //
    // `msg` 来自 `ev.__normalized`（本函数开头 1237 行），而
    // `normalizeEvent()` 返回的字段是 `userId` —— **根本没有 `sender`**
    // （见 onebot.js:1180-1198 的返回字面量）。
    //
    // 原来这里写 `msg.sender`，于是：
    //   · `if (!msg.isMe && msg.sender)` 恒假 → `touch()` **一次都没执行过**
    //   · `touch()` 不跑 → `_dirty` 永远 false → `flush()` 什么都不写
    //   · 结果：`people.json` **从未落盘**，重启后人物档案全丢
    //     （进程内 `toPrompt()` 仍然工作，所以线上不易察觉；
    //      磁盘上连 `.tmp` 都没有，就是这么来的）
    //
    // 保留 `?? msg.sender` 只是防御：万一别处递进来的对象带 `sender`。
    if (!msg.isMe && (msg.userId || msg.sender)) {
      // 记人认 QQ 昵称（跨群稳定）；群名片只进别名。
      this.people?.touch(msg.userId ?? msg.sender, msg.senderName, undefined, { nickname: msg.nickname })
      /*
       * ★ **好感度：来了就算亲近一点**（2026-11-04，1.5 刀）。
       *
       * 口径（用户定）：私聊一来一回 +2（地板 40）；**群里被 @ 才 +1.5**（地板 20）。
       * 群里普通发言**不加** —— 否则"天天在群里刷"就能把所有人都刷成亲近，
       * 那这个分就不代表关系了。
       *
       * 这一刀只加不减；「她主动说了没人接 −2」「7 天没互动 −1/周」在下一刀。
       * 防抖（单次 ±3 / 每天净 ±10 / 同一人 60 秒内忽略）在 `bumpAffinity` 里。
       */
      if (!msg.isMe) {
        const who = String(msg.userId ?? msg.sender ?? '')
        if (who) {
          /*
           * ⚠️ `atMe` / `__atMe` / `mentionsMe` **都不在消息对象上** ——
           *    normalizeEvent 只给 `isAtMe(selfId)` 这个函数（2026-11-04 实测：
           *    群里永远判不出 @ → 好感度只有私聊在涨）。这里现算。
           */
          const atMe = Boolean(msg.mentionsMe)
            || Boolean(this.selfId && typeof msg.isAtMe === 'function' && msg.isAtMe(this.selfId))
          if (msg.kind === 'private') {
            this.people?.bumpAffinity?.(who, 2, { floor: 40, reason: '私聊互动' })
          } else if (atMe) {
            this.people?.bumpAffinity?.(who, 1.5, { floor: 20, reason: '群里被 @' })
          } else {
            /*
             * ★ 普通群发言也 +0.5（2026-11-04，用户：「别人的没涨」）。
             *   原来群里只认「被 @」—— 修好 @ 判定后群里仍没人涨，因为
             *   大家只是普通聊天。加一小档，靠 60 秒/人的防抖和 ±10/天
             *   的净值上限兜着，刷屏也刷不快。
             */
            this.people?.bumpAffinity?.(who, 0.5, { floor: 20, reason: '群里发言' })
          }
        }
      }
    }

    // ⚠️ 重复事件去重（2026-10-23 补）
    //
    // 协议端在**重连、网络重试**时会把同一条消息再推一遍（OneBot 实现里很常见）。
    // 原来只在「写记忆」那一步用 messageId 判了重（`alreadyInMemory`），
    // 但那只是防止记忆里出现两条 —— **决策和发送照样会跑第二遍**，
    // 群里看到的就是机器人把同一句话回了两次。
    //
    // 所以去重必须放在**决策之前**：同一个 (scope, messageId) 只处理一次。
    // 用 TTL + 容量上限，避免长时间运行把内存吃光。
    if (this._isDuplicate(msg)) {
      this.stats.duplicate = (this.stats.duplicate ?? 0) + 1
      this.log.info?.(`bridge：重复事件已忽略（${msg.scope} messageId=${msg.messageId}）`)
      return
    }

    // ⚠️ 入站登记（2026-10-23 补，修复过时检测看不到排队消息的 bug）
    //
    // 为什么必须在**入队之前**登记，而不是等 `_handle` 里写记忆：
    //
    //   同会话是**串行**的（见下面的 `_queues`）。第一条消息在 sleep 或
    //   等 LLM 生成时，第二、三条只是**排在 Promise 链上**，它们的
    //   `_handle` 根本还没开始跑 —— 所以还没写进 mem。
    //   而 `_checkSuperseded` 原来读的是 `mem.recent()`，于是它永远
    //   看不到这些「已到但未处理」的消息，过时检测形同虚设。
    //
    //   实测确认（tests/_probe-concurrency.mjs）：第一条生成期间连发两条，
    //   mem 里只有 1 条，`_checkSuperseded` 返回 null，三条全部照发。
    //
    // 所以这里在**入口处**就登记一条独立记录（不依赖 mem、不受串行队列
    // 阻塞），并给每个 scope 一个单调递增的序号。
    const seq = this._recordInbound(msg)

    /*
     * ⚠️ 「对方连发几条短句 = 一个意思」的**合并窗口**（2026-10-30 加）。
     *
     * 用户的原话：
     *   · 「我现在发消息习惯发几条短句表达一个意思」
     *   · 「回复太快了我打字跟不上」
     *
     * 症状（日志实测，22:43）他连发：
     *   还早吧 / 11点过再睡 / 嗯 / 嗯 / 鱼鱼晚安
     * **每一条都走了一次完整决策 + 一次回复** —— 他还在打字，它已经回了。
     *
     * 放在这里（入队之前）而不是 `_handle` 里：同会话是串行的，
     * 一旦进了队列第一条就开始生成了，那时候再合并已经晚了。
     *
     * 返回 true = 已攒着，直接 return —— 等窗口关闭后由 `_flushCoalesce` 统一处理。
     */
    if (this._coalesceInbound(msg, seq)) return

    // 记一次互动 —— 讨钱时要 @「最近跟它说话最多的人」。
    // 放在入口处（不受串行队列阻塞），这样排队中的消息也算数。
    if (!msg.isMe && msg.senderId && String(msg.senderId) !== String(this.selfId)) {
      this.noteInteraction(msg.senderId, msg.nickname || msg.senderName)
    }

    // 同会话串行，避免两条消息同时触发两条回复
    const prev = this._queues.get(msg.scope) ?? Promise.resolve()
    this._markBusy(msg.scope)
    const next = prev.then(() => this._handle(msg, seq)).catch((e) => {
      this.log.warn?.(`bridge：${msg.scope} 处理失败 — ${String(e?.message ?? e)}`)
      this.stats.failed++
    })
    next.then(() => this._unmarkBusy(msg.scope), () => this._unmarkBusy(msg.scope))
    this._queues.set(msg.scope, next)
    await next
  }

  /**
   * 登记一条**入站**消息，返回它在所属 scope 里的单调序号。
   *
   * 这份记录和 `mem`（短期记忆）是**两个东西**，职责不同：
   *
   *   · `mem`        —— 给模型看的对话上下文，按处理顺序写入，受串行队列阻塞
   *   · `_inbound`   —— 给过时检测看的「到了哪些消息」，**入口即写**，不受阻塞
   *
   * 分开是必要的：合并成一个就会出现本次的 bug（排队中的消息对检测不可见）。
   *
   * @param {object} msg
   * @returns {number} 该 scope 内的单调递增序号（从 1 开始）
   */
  /**
   * 对方**此刻是不是正在打字**。
   *
   * 由 `_onNotice` 的 `notify/input_status` 喂数据（协议端每秒推 1~2 次），
   * `_flushCoalesce` 用它决定"要不要再等等"。
   *
   * ⚠️ QQ **没有"停止输入"事件** —— 只有"正在输入"的持续推送。
   *    所以"停手了"是靠 **TTL 推断**的：最后一次推送超过 `ttlMs`
   *    没再来，就当他停下了。
   *    这意味着**他打完字后最多还要等 ttlMs**（默认 4 秒）才回。
   *    调小 → 反应快但可能又插嘴；调大 → 更稳但更慢。
   *
   * @param {string} userId 发送者 QQ 号
   * @param {number} ttlMs 多久没再收到"正在输入"就算停了
   * @returns {boolean}
   */
  _isTyping(userId, ttlMs = 4000) {
    // 0 = 关掉这个判据（和 mergeWindowMs / typingHoldMs 的约定一致）
    if (!(ttlMs > 0)) return false
    const m = this._typing
    if (!m || m.size === 0) return false
    const key = String(userId)
    const at = m.get(key)
    const now = Date.now()
    // 顺手清掉过期的（聊天的人多了不会把 Map 撑大）
    if (m.size > 20) {
      for (const [k, v] of m) if (now - v > ttlMs) m.delete(k)
    }
    if (!at) return false
    if (now - at > ttlMs) {
      m.delete(key)
      return false
    }
    return true
  }

  /**
   * 「**等不及了就插话**」的判定（2026-11-03 加）。
   *
   * ## 用户原话
   * 「用户打字的时候她等不及了可以插话，但是频率不要太多」
   * （前面还说：「太安静了到时间不会催促人，只会在那里安静的等待」）
   *
   * ## 语义
   * 他一直在打字（`input_status` 还活着），但已经等够 `typingCutInAfterMs`
   * —— 这时**掷一次骰子**，中了就按现有缓冲**先回一句**，不再等他停手。
   *
   * ## 「频率不要太多」怎么兜
   * `typingCutInMinGapMs`：**同一会话**两次插话之间的最小间隔（默认 6 分钟）。
   * 刚插过话就老实等 —— 否则每 700ms 一次判定、每次 25%，
   * 会变成"他一打字她就插"，那就不是"等不及"，是抢话。
   *
   * ⚠️ 随机源走 `this._rand`（构造时可由 `opts.random` 注入）——
   *    不然测试只能靠碰运气，写不出"必插 / 必不插"两边的用例。
   *
   * @param {string} key   会话+人（`_pending` 的键）
   * @param {number} waited 已经等了多久（毫秒）
   * @returns {boolean} true = 这次就插话（并把"插过话"的时间记下）
   */
  _shouldCutIn(key, waited) {
    const after = Number(this.cfg.reply?.typingCutInAfterMs ?? 3000)
    if (!(after > 0) || waited < after) return false
    if (!this._cutInAt) this._cutInAt = new Map()
    const now = Date.now()
    const gap = Number(this.cfg.reply?.typingCutInMinGapMs ?? 360_000)
    if (gap > 0 && now - (this._cutInAt.get(key) ?? 0) < gap) return false
    const p = Number(this.cfg.reply?.typingCutInChance ?? 0.25)
    if (!(p > 0)) return false
    if (this._rand() >= p) return false
    this._cutInAt.set(key, now)
    return true
  }

  /**
   * 「对方连发几条短句 = 一个意思」的合并窗口（2026-10-30）。
   *
   * ## 用户的原话
   *   · 「我现在发消息习惯发几条短句表达一个意思」
   *   · 「回复太快了我打字跟不上」
   *
   * ## 症状（日志实测 22:43）
   * 他连发：还早吧 / 11点过再睡 / 嗯 / 嗯 / 鱼鱼晚安
   * **每一条都走了一次完整决策 + 一次回复** —— 他还在打字，它已经回了。
   *
   * ## 做法
   * 同一个 (scope, 发送者) 的消息先攒在缓冲区，**静默 `mergeWindowMs`
   * 之后**再合并成一条处理。对方继续发就重置计时。
   *
   * ⚠️ 三个上限不能少 —— 少了会**吞消息**或**无限等**：
   *   · `mergeMaxCount`  攒够这么多条就不等了（防止对方刷一串把它拖住）
   *   · `mergeMaxWaitMs` 从**第一条**算起的总上限（对方一直发也不能一直等）
   *   · `mergeWindowMs = 0` 直接关掉这个功能（回旧行为）
   *
   * ⚠️ 只合并**同一个人**的连续消息 —— 群里别人的消息不能混进来。
   *
   * ⚠️ 被 @ 的消息用更短的窗口（`mergeAtWindowMs`）：人被叫会先看，
   *    但也不该完全不等 —— 他可能 @ 完接着补一句。
   *
   * @param {object} msg 入站消息
   * @param {number} seq 该消息的单调序号
   * @returns {boolean} true = 已缓冲，调用方应直接 return
   */
  /**
   * 这个会话**现在有没有任务在跑**（排队中或生成中）。
   *
   * `_queues` 是 Promise 链尾，看不出"还在不在跑"。所以另外记一个计数：
   * 入队 +1、落定 -1。用于 `_coalesceInbound` 判断"要不要跨人合并"。
   *
   * @param {string} scope
   * @returns {boolean}
   */
  _queueBusy(scope) {
    return Number(this._qBusy?.get(String(scope ?? '')) ?? 0) > 0
  }

  _markBusy(scope) {
    if (!this._qBusy) this._qBusy = new Map()
    const k = String(scope ?? '')
    this._qBusy.set(k, (this._qBusy.get(k) ?? 0) + 1)
  }

  _unmarkBusy(scope) {
    const k = String(scope ?? '')
    const n = (this._qBusy?.get(k) ?? 1) - 1
    if (n <= 0) this._qBusy?.delete(k)
    else this._qBusy.set(k, n)
  }

  _coalesceInbound(msg, seq) {
    /*
     * ⚠️ **代码默认 0（不合并），生产靠配置给 1500**（2026-10-30）。
     *
     * 两层默认值不一样是**故意的**：
     *   · `config/store.js` 的 DEFAULTS 里有 `qq.reply.mergeWindowMs: 1500`
     *     —— 生产一定拿得到（`deepMerge(DEFAULTS, parsed)` 会补上）
     *   · 这里默认 0 —— 直接 `new QQBridge({ cfg: {...} })` 的**测试**
     *     不会莫名其妙被攒住（原来默认 1500 时，check-qq 里 5 处裸配置
     *     全部超时，10 条断言挂掉）
     *
     * 所以"没显式配置"在**生产**里等于开、在**测试**里等于关，
     * 各自都是想要的行为。
     */
    const win = Number(this.cfg.reply?.mergeWindowMs ?? 0)
    if (!(win > 0)) return false
    if (msg.isMe) return false
    if (msg.__merged) return false

    if (!this._pending) {
      this._pending = new Map()
      this._pendingTimers = new Map()
    }
    const who = String(msg.userId ?? msg.sender ?? '?')
    /*
     * ★ **她正在生成时，群里的话并成一条**（2026-11-04）。
     *
     * ## 为什么
     * 原来只合并"同一个人连发"。群里几个人你一句我一句地刷的时候，
     * 每条都单独入队 → 单独决策 → 单独生成 → 等她生成完，
     * 后面又来了 2~4 条 → 每条都判「过时，丢弃」。
     *
     * 实测（15:14–15:16）：
     * ```
     * 15:14:23  群「[表情包]」 → 81 秒后生成完 → 群里已说 4 条 → 丢弃
     * 15:15:57  群「[表情包]」 → 立即「等待期间群里又说了 3 条」→ 放弃
     * ```
     * 结果就是：群一热闹，她**一条都发不出来**。
     *
     * ## 做法
     * 生成期间（`_queueBusy`）到达的消息，**跨人不分彼此**地并进同一个 buffer；
     * 等这群人说完（窗口 1.5s）再一起处理一次。
     * 这样"热闹"不再等于"全丢"，而是"她晚一点、接一句"。
     *
     * ⚠️ 只在**同一个会话里已经有任务在跑**时才这样并 —— 空闲时仍然按人分，
     *    否则一对一私聊的连发合并会被打乱（那条路有 check-coalesce 盯着）。
     */
    const key = this._queueBusy(msg.scope) ? `${msg.scope}::__busy` : `${msg.scope}::${who}`

    let buf = this._pending.get(key)
    if (!buf) {
      buf = { key, msgs: [], firstAt: Date.now(), lastSeq: seq, scope: msg.scope, who }
      this._pending.set(key, buf)
    }
    buf.msgs.push(msg)
    buf.lastSeq = seq
    /*
     * ★★ **他"发出这条消息"本身就说明那一次输入结束了**（2026-11-03）。
     *
     * ## 修的是什么（用户报「私聊我觉得她有点慢了」）
     * `typingHoldMs` 是个 TTL（默认 4000ms）：协议端推一次 `input_status`
     * 就记下时间戳，此后 4 秒内都算"他还在打字"。可他**发消息**的那一刻，
     * 最后一次 input_status 往往才过去一两秒 —— 于是 TTL 还没到期，
     * `_flushCoalesce` 判成"还在打字"，就一路**等到 TTL 自然过期**。
     *
     * 实测代价（2026-11-03 一整天）：
     * ```
     * 「还在打字 —— 继续等」 766 次；等待分布集中在 2~6 秒
     * ```
     * 而这 2~6 秒等的是一个**永远不会到来的"停止输入"事件** ——
     * 他已经把消息发出来了，这次输入当然结束了。
     *
     * ## 为什么清掉是对的、不会破坏"连发合并"
     * 他要是接着写下一句，协议端会**再推一次 input_status** ——
     * 那才是"他正在写下一句"的**真信号**，那时再等也不迟。
     * 所以这里清的只是"残留的旧 TTL"，不是合并窗口本身。
     *
     * ⚠️ 键必须和 `_onNotice` 存进去的那个一致（`String(userId)`，见 `_isTyping`）。
     *    `who` 在上面已经规范化成字符串了。
     */
    if (this._typing?.size) this._typing.delete(who)

    const maxCount = Number(this.cfg.reply?.mergeMaxCount ?? 6)
    const maxWaitMs = Number(this.cfg.reply?.mergeMaxWaitMs ?? 4500)
    const waited = Date.now() - buf.firstAt
    const capped = waited >= maxWaitMs || buf.msgs.length >= maxCount
    // ⚠️ 同上去：@ 只能从 isAtMe(selfId) 现算（否则这条窗口永远是普通窗口）
    const atMe = Boolean(msg.mentionsMe)
      || Boolean(this.selfId && typeof msg.isAtMe === 'function' && msg.isAtMe(this.selfId))

    /*
     * ⚠️ **自适应窗口**（2026-10-30 加）。
     *
     * `input_status` 是**主信号**（他打字就一直等，见 `_flushCoalesce`），
     * 但它有个前提：**协议端得推**。实测 NapCat 推得很勤（一晚 1894 次），
     * 可别的实现/别的客户端不一定推 —— 那时就只能靠窗口了。
     *
     * 而固定窗口猜不准节奏：实测他的间隔中位 **6 秒**，
     * 1.5 秒窗口一次都抓不到（14 次间隔里 0 次 ≤1.5s）；
     * 直接调到 6 秒又让"只发一条"也要干等 6 秒。
     *
     * 所以：
     *   · 第一条        → `mergeWindowMs`（默认 1.5s，不耽误单条）
     *   · **第二条一来** → 说明他在连发 → 换 `mergeBurstWindowMs`（默认 8s）
     * 这样"单条快、连发等"两件事同时成立，不用猜。
     */
    const burstWin = Number(this.cfg.reply?.mergeBurstWindowMs ?? 8000)
    const baseWin = buf.msgs.length >= 2 ? burstWin : win
    // 被 @ 时窗口更短 —— 但只在**还没看出他在连发**时生效
    const eff = atMe && buf.msgs.length < 2
      ? Number(this.cfg.reply?.mergeAtWindowMs ?? 600)
      : baseWin
    const delayMs = capped ? 0 : eff

    const t = this._pendingTimers.get(key)
    if (t) clearTimeout(t)
    this._pendingTimers.set(key, setTimeout(() => {
      this._flushCoalesce(key)
    }, delayMs))

    // 只有攒到第二条才值得打日志 —— 单条走的是原路径
    if (buf.msgs.length > 1) {
      this.log.info?.(
        `bridge：合并窗口 —— ${msg.scope} 的 ${who} 已连发 ${buf.msgs.length} 条`
        + `${capped ? '（到上限，立即处理）' : `（静默 ${delayMs}ms 后一起处理）`}`,
      )
    }
    return true
  }

  /**
   * 把缓冲区里攒的消息合并成**一条**，走原来的入队路径处理。
   * 由 `_coalesceInbound` 的定时器触发。
   */
  _flushCoalesce(key) {
    const buf = this._pending?.get(key)
    /*
     * ⚠️ **先取缓冲、但别急着删**（2026-10-30 修）。
     *
     * 第一版把 `this._pending.delete(key)` 写在这儿 —— 也就是**在
     * "他还在打字"判断之前**。于是要走"继续等"分支时缓冲已经空了，
     * 重排的定时器醒来发现没东西 → **消息被悄悄丢掉**。
     *
     * 这正是"合并改主路径、丢消息风险最大"的那个风险，
     * 被 `check-coalesce` 的「★ 他还在打字 → 不处理，继续等」抓到
     * （断言"缓冲里还要有 1 条" → 0 !== 1）。
     *
     * 现在只在**真的要处理**时才删。
     */
    if (!buf || buf.msgs.length === 0) {
      this._pending?.delete(key)
      const t0 = this._pendingTimers?.get(key)
      if (t0) clearTimeout(t0)
      this._pendingTimers?.delete(key)
      return
    }
    const t = this._pendingTimers?.get(key)
    if (t) clearTimeout(t)
    this._pendingTimers?.delete(key)

    /*
     * ⚠️ **他还在打字 → 继续等**（2026-10-30）。
     *
     * 这是「回复太快了我打字跟不上」的正解。固定窗口猜不准节奏
     * （实测他的间隔中位 6 秒：1.5 秒窗口一次都抓不到，调到 6 秒
     * 又让"只发一条"也等 6 秒），但协议端一直在推 `input_status`。
     *
     * 所以：窗口到点后**先看他还打不打字** —— 还在打就再排一次，
     * 直到他停手（受 `typingMaxWaitMs` 保护，不会无限等）。
     *
     * ⚠️ QQ 没有"停止输入"事件，靠 TTL 推断（`typingHoldMs`，默认 4 秒）。
     *    也就是说他打完字后最多再等 4 秒才回 —— 加上正常延迟档位，
     *    观感上是"停手了才接话"。
     */
    const holdMs = Number(this.cfg.reply?.typingHoldMs ?? 4000)
    if (holdMs > 0 && buf.who && this._isTyping(buf.who, holdMs)) {
      const waited = Date.now() - buf.firstAt
      const cap = Number(this.cfg.reply?.typingMaxWaitMs ?? 20000)
      /*
       * ★★ 「**等不及了就插话**」（2026-11-03 加）。
       *
       * 用户原话：「用户打字的时候她等不及了可以插话，但是频率不要太多」。
       *
       * 以前这里只有"继续等"一条路：他一直在打字，她就一路等到
       * `typingMaxWaitMs`（默认 20 秒）为止 —— 用户看到的就是
       * 「太安静了…只会在那里安静的等待」。
       *
       * 现在：等够 `typingCutInAfterMs` 之后**掷一次骰子**，中了就按现有缓冲
       * 先回一句（不再等他停手）。「频率不要太多」由 `typingCutInMinGapMs`
       * 兜底 —— 同一会话刚插过话就老实等，不许连着插（判定在 `_shouldCutIn`）。
       */
      const cutIn = waited < cap && this._shouldCutIn(key, waited)
      if (waited < cap && !cutIn) {
        const t = this._pendingTimers.get(key)
        if (t) clearTimeout(t)
        this._pendingTimers.set(key, setTimeout(() => this._flushCoalesce(key), 700))
        this.log.info?.(
          `bridge：${buf.who} 还在打字 —— 继续等（已等 ${Math.round(waited / 1000)}s / 上限 ${Math.round(cap / 1000)}s）`,
        )
        return
      }
      if (cutIn) {
        const gapMin = Math.round(Number(this.cfg.reply?.typingCutInMinGapMs ?? 360_000) / 60_000)
        this.log.info?.(
          `bridge：${buf.who} 还在打字，但已等 ${Math.round(waited / 1000)}s —— **插话**`
          + `（同一会话最快 ${gapMin} 分钟才允许再插一次）`,
        )
      } else {
        this.log.info?.(`bridge：${buf.who} 打字超过 ${Math.round(cap / 1000)}s，不再等`)
      }
    }

    // ⚠️ 到这里才**真的**把缓冲取走 —— 上面"继续等"的分支必须保留它，
//    否则重排的定时器醒来会发现缓冲空了，消息就被丢掉了。
    this._pending?.delete(key)
    const msgs = buf.msgs
    const merged = msgs.length === 1 ? msgs[0] : this._mergeBurst(msgs)
    const seq = buf.lastSeq

    if (msgs.length > 1) {
      this.log.info?.(
        `bridge：合并 ${msgs.length} 条 → 一条处理（${buf.scope}）「${String(merged.text ?? '')
          .replace(/\n/g, ' / ').slice(0, 60)}」`,
      )
    }

    const prev = this._queues.get(merged.scope) ?? Promise.resolve()
    this._markBusy(merged.scope)
    const next = prev.then(() => this._handle(merged, seq)).catch((e) => {
      this.log.warn?.(`bridge：${merged.scope} 处理失败 — ${String(e?.message ?? e)}`)
      this.stats.failed++
    })
    next.then(() => this._unmarkBusy(merged.scope), () => this._unmarkBusy(merged.scope))
    this._queues.set(merged.scope, next)
    return next
  }

  /**
   * 把连发的几条并成一条消息对象。
   *
   * 文本用**单个换行**连接（不是空行）—— 空行在 `splitMessage` 里是
   * 「显式分段意图」，会被切成两条发出去，那就白合并了。
   * 图片/表情取并集（去重），所以「说一句 + 发张图」也会被一起理解。
   *
   * 其余字段以**最后一条**为准（时间、messageId、@ 状态）。
   */
  _mergeBurst(msgs) {
    const last = msgs[msgs.length - 1]
    /*
     * ⚠️ **跨人合并时要带名字**（2026-11-04）。
     *
     * 原来只按"同一个人连发"合并，一条 buffer 里必然是同一个人，不用带名字。
     * 现在多了一条路：**她正在生成时，群里别人说的话也并进同一条**
     * （见 `_coalesceInbound` 里的 `__busy`）。那时 buffer 里是不同人说的，
     * 不带名字拼成一行，模型会把 A 的话当成 B 说的。
     */
    const senders = new Set(msgs.map((m) => String(m.userId ?? m.sender ?? '')))
    const crossSender = senders.size > 1
    const texts = msgs
      .map((m) => {
        const t = String(m.text ?? '').trim()
        if (!t) return ''
        const name = String(m.senderName ?? '').trim()
        return crossSender && name ? `${name}: ${t}` : t
      })
      .filter(Boolean)
    const images = []
    const stickerRefs = []
    for (const m of msgs) {
      for (const r of m.images ?? []) if (!images.includes(r)) images.push(r)
      for (const r of m.stickerRefs ?? []) if (!stickerRefs.includes(r)) stickerRefs.push(r)
    }
    return {
      ...last,
      text: texts.join('\n'),
      images,
      ...(stickerRefs.length ? { stickerRefs } : {}),
      __merged: msgs.length,
    }
  }

  _recordInbound(msg) {
    const scope = String(msg.scope ?? 'unknown')
    if (!this._inbound) this._inbound = new Map()
    let rec = this._inbound.get(scope)
    if (!rec) {
      rec = { seq: 0, entries: [] }
      this._inbound.set(scope, rec)
    }
    const seq = ++rec.seq
    // ⚠️ mentionsMe 在规范化消息里**不是现成字段** —— 它是由
    //    `isAtMe(selfId)` 现算的（见 onebot.js normalizeEvent）。
    //    这里必须自己算一次：入口处拿不到 _handle 里那个
    //    `(isAtMe) || quotedMine` 的组合值，但「@ 我」这一半足够
    //    作为「有人在等我」的判据了。
    let mentionsMe = Boolean(msg.mentionsMe)
    if (!mentionsMe && this.selfId && typeof msg.isAtMe === 'function') {
      try { mentionsMe = Boolean(msg.isAtMe(this.selfId)) } catch { /* 算不出就当没提 */ }
    }
    rec.entries.push({
      seq,
      messageId: msg.messageId != null ? String(msg.messageId) : null,
      at: Number(msg.at ?? Date.now()),
      text: String(msg.text ?? ''),
      // 这两个字段是「有人在等我」的判据，入口处就要拿到 ——
      // 不能等 _handle 里算（那时已经太晚）。
      mentionsMe,
      replyTo: msg.replyTo != null ? String(msg.replyTo) : null,
      sender: String(msg.userId ?? ''),
    })

    // 只保留最近一段：过时检测只关心「我之后」的，留太多没意义。
    // 按条数裁剪，避免长期运行把内存吃光（大群一天几万条）。
    const cap = Number(this.cfg.inboundKeep ?? 50)
    if (rec.entries.length > cap) {
      rec.entries.splice(0, rec.entries.length - cap)
    }
    return seq
  }

  /**
   * 取某个 scope 里**序号大于 afterSeq** 的入站记录。
   *
   * @param {string} scope
   * @param {number} afterSeq
   * @returns {Array<object>}
   */
  _inboundAfter(scope, afterSeq) {
    const rec = this._inbound?.get(String(scope ?? 'unknown'))
    if (!rec) return []
    return rec.entries.filter((e) => e.seq > afterSeq)
  }

  /**
   * 这条消息是不是**已经处理过**的重复事件？
   *
   * 判据：同 scope 下相同 messageId。
   *
   * ⚠️ 必须带 scope：不同群的 messageId 是各自编号的，
   *    只按 id 判重会把另一个群里的正常消息误杀。
   *
   * @param {object} msg
   * @returns {boolean} true = 重复，应当直接丢弃
   */
  _isDuplicate(msg) {
    const id = msg?.messageId
    if (id === undefined || id === null || String(id) === '') {
      // 没有 messageId 的消息无法判重 —— 宁可放行也不要误杀
      return false
    }
    if (!this._seenIds) this._seenIds = new Map()

    const key = `${msg.scope}|${id}`
    const now = Date.now()
    const ttl = Number(this.cfg.dedupeTtlMs ?? 20 * 60_000)
    const cap = Number(this.cfg.dedupeMaxEntries ?? 5000)

    const hit = this._seenIds.get(key)
    if (hit !== undefined && now - hit < ttl) return true

    // 记下这一次
    this._seenIds.set(key, now)

    // 定期清理：超过容量就按时间淘汰最旧的一批
    if (this._seenIds.size > cap) {
      const sorted = [...this._seenIds.entries()].sort((a, b) => a[1] - b[1])
      const drop = sorted.slice(0, this._seenIds.size - cap)
      for (const [k] of drop) this._seenIds.delete(k)
    }
    return false
  }

  /**
   * 处理通知事件 —— 目前主要是**戳一戳**。
   *
   * NapCat 的结构（实测确认）：
   *   { post_type:'notice', notice_type:'notify', sub_type:'poke',
   *     group_id, user_id:<戳的人>, target_id:<被戳的人> }
   *
   * 别人戳它，最自然的反应就是**戳回去**（而不是回一句话）——
   * 群里戳一戳本来就是个互动动作，回文字反而突兀。
   * 所以默认戳回去，并按概率偶尔配一句话，保留"真人有时懒得理"的感觉。
   */
  /**
   * 请求事件：好友申请 / 加群邀请。
   *
   * OneBot v11 的形状：
   *   { post_type:'request', request_type:'friend', user_id, comment, flag }
   *   { post_type:'request', request_type:'group',  group_id, user_id, comment, flag }
   *
   * ## 只做「被动同意」
   *
   * 用户明确要求：「不主动加人，只被动被加」。
   * 这也正好符合 OneBot 的能力边界 —— QQ **没有**「主动加好友」的 API，
   * 只有「处理别人发来的申请」。所以这里只能被动。
   *
   * ## 为什么默认自动同意
   *
   * 用户要的就是这个效果（「加好友也加上」）。
   * 但加了几个闸：
   *    · 只处理 request_type === 'friend'
   *    · 同一个人一小时只处理一次（防刷）
   *    · 配置可关（groupAdmin.friendRequest = false）
   *    · 同意后给对方设个备注，方便以后认人
   *
   * ⚠️ 加群邀请**不自动同意** —— 那等于让机器人随便进群，
   *    和"被动被加好友"是两件完全不同的事。
   */
  async _onRequest(ev) {
    const rt = String(ev?.request_type ?? '?')
    const flag = ev?.flag
    const userId = String(ev?.user_id ?? ev?.sender_id ?? '')
    const comment = String(ev?.comment ?? '').replace(/\s+/g, ' ').slice(0, 60)
    this.log.info?.(
      `bridge：收到请求 ${rt}（来自 ${userId || '-'}，flag ${flag ? '有' : '无'}）` +
      (comment ? ` — 附言「${comment}」` : ''),
    )

    if (rt !== 'friend') {
      // 加群邀请：只记日志，不自动同意
      if (rt === 'group') this.log.info?.('bridge：加群邀请不自动同意（需要人手动处理）')
      return
    }
    if (!flag) {
      this.log.warn?.('bridge：好友申请没有 flag，无法处理')
      return
    }
    if (this.cfg.groupAdmin?.friendRequest === false) {
      this.log.info?.('bridge：好友申请自动同意已关闭')
      return
    }

    // 频率：同一个人一小时只处理一次
    const now = Date.now()
    if (!this._friendReqAt) this._friendReqAt = new Map()
    const last = Number(this._friendReqAt.get(userId) ?? 0)
    if (last > 0 && now - last < 3600_000) {
      this.log.info?.(`bridge：${userId} 一小时内申请过，这次跳过`)
      return
    }

    try {
      // 备注用对方的申请附言（他要是说了自己是谁，以后好认）
      await this.onebot.handleFriendRequest(flag, true, comment || undefined)
      this._friendReqAt.set(userId, now)
      this.log.info?.(`bridge：已同意 ${userId} 的好友申请`)
      // 通过后打个招呼 —— 刚加好友一句话都不说挺冷的
      if (this.cfg.groupAdmin?.friendGreeting !== false) {
        const name = this.selfName ?? '蓝色大肥鱼'
        try {
          await this.onebot.sendPrivate(userId, `${name}同意了你的好友申请。有事说事，没事别戳。`)
        } catch { /* 打招呼失败不影响"已同意"这件事 */ }
      }
    } catch (e) {
      this.log.warn?.(`bridge：同意好友申请失败 — ${String(e?.message ?? e)}`)
    }
  }

  async _onNotice(ev) {
    // 先把收到的**所有**通知记一条 —— 排查"为什么戳一戳没反应"时，
    // 第一件要知道的事就是"协议端到底有没有把通知推过来"。
    // 没有这条日志的话，只能靠猜（实测踩过：反复等也不确定是没推还是没处理）。
    const nt = ev?.notice_type ?? '?'
    const st = ev?.sub_type ?? ''

    /*
     * ⚠️ **`notify/input_status` = 对方"正在输入"**（2026-10-30 接上）。
     *
     * ## 为什么这是最理想的信号
     * 用户的原话：「回复太快了我打字跟不上」。
     * 实测他打字**间隔中位 6 秒**，而机器人 4~5 秒就回了 ——
     * 正好插在他打字的过程中。固定窗口猜不准这个节奏：
     * 1.5 秒**抓不到任何一次**（14 次间隔里 0 次 ≤1.5s），
     * 调到 6 秒又让"只发一条"也要等 6 秒。
     *
     * 但协议端**一直在推**这个状态：实测 23:38:18~23:38:27 连着推了
     * 十几条（正好是他打字的那 10 秒），那一晚一共 **1894 次**。
     * `_onNotice` 原来只处理 `poke`，这个信号**全被丢掉了** ——
     * 所以 23:38:24 在他打字期间插了句「（点头）嗯，晚安」。
     *
     * 现在：记下"某人最后输入的时刻"，flush 前检查 ——
     * **他还在打字就继续等，停手了才回**。
     *
     * ⚠️ QQ 只推"正在输入"，**没有"停止输入"事件** → 靠 TTL 推断
     *    （见 `_isTyping`）。
     *
     * ⚠️ **这条必须放在下面那条通用日志之前**：它每秒推 1~2 次，
     *    走 info 级会把日志刷爆（实测光这一个就是 3788 行）。
     */
    if (nt === 'notify' && st === 'input_status') {
      const uid = String(ev?.user_id ?? ev?.operator_id ?? '')
      if (uid) {
        if (!this._typing) this._typing = new Map()
        this._typing.set(uid, Date.now())
        this.log.debug?.(`bridge：${uid} 正在输入`)
      }
      return
    }

    // 先把收到的**其他**通知记一条 —— 排查"为什么戳一戳没反应"时，
    // 第一件要知道的事就是"协议端到底有没有把通知推过来"。
    // 没有这条日志的话，只能靠猜（实测踩过：反复等也不确定是没推还是没处理）。
    //
    // ⚠️ 2026-10-30：加 input_status 分支时**误删了这两行**（替换那段时
    //    new_string 只留了注释）。后果是 poke 等通知不再留痕 ——
    //    正是这条日志要解决的"只能靠猜"。已补回，并有源码锁守着顺序。
    this.log.info?.(`bridge：收到通知 ${nt}${st ? '/' + st : ''}` +
      `（群 ${ev?.group_id ?? '-'}，操作者 ${ev?.user_id ?? '-'}，目标 ${ev?.target_id ?? '-'}）`)

    if (nt !== 'notify' || st !== 'poke') return

    const targetId = String(ev.target_id ?? '')
    const fromId = String(ev.user_id ?? ev.sender_id ?? '')
    const groupId = ev.group_id != null ? String(ev.group_id) : null

    // 只理"戳我"的；别人互相戳不关我事
    if (!this.selfId || targetId !== String(this.selfId)) return
    // 不戳自己（有些客户端会回环）
    if (fromId === String(this.selfId)) return

    // 白名单：不在允许的群里就不理
    const fake = { scope: groupId ? `group:${groupId}` : `private:${fromId}`, kind: groupId ? 'group' : 'private', groupId, userId: fromId }
    if (!this.allowed(fake)) {
      this.stats.dropped++
      this.log.debug?.(`bridge：忽略来自 ${fake.scope} 的戳一戳（不在白名单）`)
      return
    }

    const cfg = this.cfg.poke ?? {}
    if (cfg.enabled === false) return
    this.stats.received++

    // 概率：不是每次戳都理 —— 真人也有懒得回的时候
    //
    // ⚠️ 2026-10-18 默认从 0.75 提到 0.95。
    //    实测：群里有人专门戳它，日志打出「本次随机不理」，
    //    用户看到的就是"戳了它没反应，是不是坏了"。
    //    戳一戳本身是**明确的定向互动**（比在群里说话强得多），
    //    只有 75% 回应等于四分之一概率装死。
    //    要更懒就改配置 qq.poke.chance。
    const chance = typeof cfg.chance === 'number' ? cfg.chance : 0.95
    if (Math.random() > chance) {
      this.stats.silent++
      this.log.info?.(`bridge：被 ${fromId} 戳了，本次随机不理（概率 ${Math.round(chance * 100)}%）`)
      this._recordPoke(groupId, fromId, null, 'poke-silent')
      return
    }

    // 延迟一下再戳回去，避免"秒回"的机械感
    const delay = 400 + Math.random() * 1200
    await sleep(delay)

    let ok = false
    try {
      ok = await this.pokeBack(groupId, fromId)
    } catch (e) {
      this.log.warn?.(`bridge：戳回去失败 — ${String(e?.message ?? e)}`)
    }

    // 有时再加一句话（默认 25%），纯戳回去更像是"懒得打字"
    const textChance = typeof cfg.textChance === 'number' ? cfg.textChance : 0.25
    let said = null
    if (cfg.text !== false && Math.random() < textChance) {
      const lines = Array.isArray(cfg.lines) && cfg.lines.length
        ? cfg.lines
        : ['别戳了别戳了', '干嘛', '戳我干嘛', '在的在的', '哎哟', '有事说事']
      said = lines[Math.floor(Math.random() * lines.length)]
      try {
        if (groupId) await this.onebot.sendGroup(groupId, said)
        else await this.onebot.sendPrivate(fromId, said)
      } catch (e) {
        this.log.warn?.(`bridge：戳一戳回话失败 — ${String(e?.message ?? e)}`)
      }
    }

    this.log.info?.(`bridge：被 ${fromId} 戳了 → 已戳回${said ? ' 并说「' + said + '」' : ''}`)
    this._recordPoke(groupId, fromId, said, ok ? 'poke-back' : 'poke-failed')
  }

  /**
   * 戳回去。
   *
   * OneBot 扩展接口 `send_poke`（NapCat）：
   *   群聊传 { group_id, target_id }
   *   私聊传 { user_id }
   *
   * ⚠️ 具体采用什么参数，取决于协议端；文档示例是 `{ group_id: "123456", user_id: "123456789" }`，
   *    但实现里读的是 `target_id ?? user_id`。这里**两个都传**，兼容两种读法。
   */
  async pokeBack(groupId, userId) {
    const params = groupId
      ? { group_id: Number(groupId), user_id: Number(userId), target_id: Number(userId) }
      : { user_id: Number(userId), target_id: Number(userId) }
    const res = await this.onebot.call('send_poke', params, 8000)
    if (res?.status === 'failed' || (typeof res?.retcode === 'number' && res.retcode !== 0)) {
      throw new Error(`send_poke 返回失败：${JSON.stringify(res).slice(0, 160)}`)
    }
    return true
  }

  /** 把戳一戳记进最近交互（Web 界面能看到）。 */
  _recordPoke(groupId, fromId, reply, outcome) {
    const back = outcome === 'poke-back'
    this.recent.unshift({
      at: Date.now(),
      scope: groupId ? `group:${groupId}` : `private:${fromId}`,
      senderName: String(fromId),
      text: '[戳一戳]',
      images: [],
      mentionsMe: true,
      decision: {
        reply: back,
        // ⚠️ 不要写死 1 —— 显示「概率 1」却说沉默，看着像坏了。
        //    这里给的是"本次是否理会"的**实际结果**，概率沿用配置值，
        //    用户一眼能对上是"撞上了那 25% 没理"。
        probability: back ? 1 : 0,
        reason: back ? '被戳了一下，戳回去' : '被戳了一下，本次随机不理',
        provider: 'poke',
      },
      reply: reply ?? null,
      outcome,
    })
    if (this.recent.length > 50) this.recent.length = 50
  }

  /**
   * @param {object} msg 规范化后的消息
   * @param {number} [seq] 本条在 scope 内的入站序号（由 onEvent 分配）
   */
  /**
   * 按「目标总时长」补足等待（2026-10-31）。
   *
   * ## 为什么不在生成前睡
   * 原来 `await sleep(d.delayMs)` 是在**生成之前**等。实测（38 次配对）：
   * ```
   * 总时长 = 延迟(0.4~7.0s) + 生成(1.3~4s)
   *   →  p10 3.4s   p50 5.1s   p90 6.1s      ← 只差 2.7 秒
   * ```
   * **生成的抖动把延迟的差别吃掉了**，所以用户反馈「感觉随机时间没生效」——
   * 他没说错：配置本意差 6.6 秒，实际只差 2.7 秒。
   *
   * ## 现在的做法
   * 生成完再补 `目标 - 已用`：
   * - 生成快（1.3s）、目标 4.5s → 再等 3.2s
   * - 生成慢（5s）、目标 4.5s → **不再等**（已经超了）
   *
   * 于是**总时长**落在目标区间里，跟模型快慢无关 —— 这才是用户能感知的。
   *
   * ⚠️ 目标是**下限**不是上限：生成慢就自然慢，没法把时间"压"回去。
   *    这也合理 —— 想得久本来就该显得久。
   *
   * @param {number} tStart `_handle` 开头记的时间戳
   * @param {object} d 决策结果（要 `targetMs`）
   * @param {string} [where] 日志里区分是哪条路径
   * @returns {Promise<number>} 实际又等了多久（毫秒）
   */
  async _waitForPace(tStart, d, where = '') {
    const target = Number(d?.targetMs ?? 0)
    if (!(target > 0)) return 0
    const used = Date.now() - tStart
    const tag = `档位 ${d.delayTier ?? '?'}，上下文 ${d.delayCtxChars ?? '?'} 字 ×${d.delayCtxK ?? 1}`
    const wait = target - used
    if (wait > 0) {
      this.log.info?.(
        `bridge：${where}用了 ${(used / 1000).toFixed(1)}s，再等 ${(wait / 1000).toFixed(1)}s`
        + ` → 总共 ${(target / 1000).toFixed(1)}s（${tag}）`,
      )
      await sleep(wait)
      return wait
    }
    this.log.info?.(
      `bridge：${where}已经用了 ${(used / 1000).toFixed(1)}s，超过目标 ${(target / 1000).toFixed(1)}s`
      + ` —— 不再等（${tag}）`,
    )
    return 0
  }

  /**
   * 把「这条引用了谁（id）」补成「引用了什么（内容）」。
   *
   * ## 为什么要有这一步（2026-11-01）
   *
   * `parseMessage` 只能拿到被引用消息的 **id**（reply 段里就这一个字段）。
   * id 够决策层判断「在跟谁说话」，但**不够回答**：
   *
   * ```
   * 窗口内被引用 → 那条本来就在上下文里 → 看着"能看见"
   * 窗口外被引用 → 只剩一串数字 → 完全不知道在说什么
   * ```
   *
   * 用户反馈的「引用功能它看不见」命中的是第二种。
   *
   * ## 两条路
   *
   * ① 先在窗口里找 —— 零成本、零延迟，绝大多数引用都是刚聊过的
   * ② 找不到再问协议端（`get_msg`）—— 要一次网络往返，所以**只在这条路走**
   *
   * 取到的东西挂在 `msg.quote` 上，随消息一起进短期记忆，
   * 由 `buildChatMessages` 渲染成「（引用某某：……）」。
   *
   * @param {object} msg 规范化后的消息（要 `replyTo`）
   * @param {object} mem 该会话的 ConversationMemory
   * @returns {Promise<null|{sender:string, text:string, isMe:boolean, source:string}>}
   */
  async _resolveQuote(msg, mem) {
    const id = msg?.replyTo != null ? String(msg.replyTo).trim() : ''
    if (!id) return null

    // ① 窗口里就有 —— 免费
    const hit = mem.recent(30).find((m) => String(m.id ?? '') === id)
    if (hit) {
      return {
        sender: hit.isMe ? '' : String(hit.senderName ?? ''),
        text: String(hit.text ?? ''),
        isMe: Boolean(hit.isMe),
        source: 'memory',
      }
    }

    // ② 滚出窗口了 —— 问协议端（带缓存：同一条被引用多次只取一次）
    if (!this._quoteCache) this._quoteCache = new Map()
    const cached = this._quoteCache.get(id)
    if (cached) return cached

    try {
      const got = await this.onebot?.getMsg?.(id)
      if (!got) return null
      const q = {
        sender: String(got.senderName ?? ''),
        text: String(got.text ?? ''),
        isMe: Boolean(this.selfId) && String(got.sender ?? '') === String(this.selfId),
        source: 'get_msg',
      }
      this._quoteCache.set(id, q)
      // 引用是短命信息，留太多没意义
      if (this._quoteCache.size > 100) {
        this._quoteCache.delete(this._quoteCache.keys().next().value)
      }
      return q
    } catch (e) {
      this.log.warn?.(`bridge：取引用消息失败（id=${id}）：${String(e?.message ?? e)}`)
      return null
    }
  }

  async _handle(msg, seq) {
    /*
     * ⚠️ 记起点 —— 用来算「从收到消息到发出」的**总时长**（2026-10-31）。
     *
     * 延迟不再是"生成前先睡一觉"，而是**生成完再补足到目标总时长**
     * （见 `_waitForPace`）。原因：实测生成本身抖动 1.3~4 秒，
     * 把延迟的差别淹没了 —— 用户反馈「随机时间感觉没生效」。
     */
    const tStart = Date.now()
    const mem = this.memory.get(msg.scope)
    const now = Date.now()
    // ★ 用户开口了 → 取消「10 秒没动静」的场景续写，并把连写次数清零
    this._cancelSceneContinue(msg.scope)
    // ★ 有人说话了 → 冷场兜底的定时器也作废
    this._cancelDeadAir(msg.scope)
    if (this._sceneState) this._sceneState.set(String(msg.scope ?? ''), { turns: 0 })

    // 0. 这条是不是**在回复我**？
    //
    // ⚠️ 不能只看 @。实测踩过：群里有人**直接引用机器人刚说的话**回
    //    「那还不是决策层叫你发的」—— 那明显是在跟它对话，但因为它只在
    //    "被 @"时才知道跟自己有关，这条被当普通闲聊掷骰子 → 一半概率沉默。
    //
    //    做法：拿到被引用消息的 id，去最近历史里找，看它是不是我发的。
    //    是 → 等价于"被 @"（决策层用同一个 mentionsMe 字段处理）。
    const quotedMine = Boolean(
      msg.replyTo && mem.recent(20).some((m) => m.isMe && String(m.id ?? '') === String(msg.replyTo)),
    )
    if (quotedMine) {
      this.log.info?.('bridge：这条是在引用我自己的消息 → 按"被叫"处理')
    }

      // 1. 存记忆
      //
      // ⚠️ 补回（defer 重试）时会再次走这里 —— 同一条消息不能存两遍，
      //    否则记忆里出现重复，模型看到"用户连说了两次一样的话"。
      //    用 messageId 判重（它在一轮里唯一）。
      /*
       * ★ 把引用的**内容**取回来（2026-11-01）。
       *
       * 必须在 `mem.push` **之前** —— quote 要跟这条消息一起进记忆，
       * 否则下一轮它就成了"一条没有引用的普通消息"，永远补不回来。
       *
       * 也必须在决策**之前** —— `resolveAddressee` 靠它判断「在跟谁说话」，
       * 窗口外的引用原来是判 'unclear'（代码里写着「引用的消息已不在上下文里」），
       * 现在有内容就能判准了。
       */
      const quote = await this._resolveQuote(msg, mem)
      if (quote) {
        msg.quote = quote
        const preview = String(quote.text ?? '').replace(/\s+/g, ' ').slice(0, 40)
        this.log.info?.(
          `bridge：这条引用了${quote.isMe ? '我自己' : (quote.sender || '别人')}`
          + `「${preview}」（来源=${quote.source}）`,
        )
      } else if (msg.replyTo) {
        // 取不到也要留痕 —— 否则这类问题以后还是只能靠猜
        this.log.info?.(`bridge：引用了 id=${msg.replyTo}，但内容没取到`)
      }

      const alreadyInMemory = msg.messageId !== undefined
        && mem.recent(20).some((m) => String(m.id ?? '') === String(msg.messageId))
      if (!alreadyInMemory) {
        mem.push(makeMessage({
          id: msg.messageId,
          sender: msg.userId,
          senderName: msg.senderName,
          text: msg.text,
          at: msg.at || now,
          mentionsMe: (this.selfId ? msg.isAtMe(this.selfId) : false) || quotedMine,
          isMe: false,
          images: msg.images,
          // 引用回复的对象 id —— 决策层靠它区分「在跟我说」和「在跟别人说」。
          // 之前这个信息只在 quotedMine 里用了一次就丢了，导致
          // 「小红：你今天怎么了？」（引用另一个群友）被判成在追问机器人。
          replyTo: msg.replyTo ?? null,
          // 被引用消息的**内容**（不是 id）—— 生成层靠它看懂「引用的是哪句话」。
          // 只有 id 的话，引用窗口外的消息就变成一串数字，模型答非所问。
          quote,
        }))
      }
      /*
       * 冷却 60 秒 —— 决定 `consecutiveTurns` 什么时候归零。
       *
       * 这个值只影响 `rule.js` / `model.js` 里的「连续发言」判据
       * （那是每个 provider 自己的偏好，不是硬闸门）。
       *
       * ⚠️ 2026-10-27 曾放宽到 5 分钟，是为了配合 bridge 里那个
       * 强制收尾闸门（已移除，因为用户说「可以连发」）。
       * 闸门没了之后就该回到原值 —— 让 rule 层的判断保持和以前一致。
       */
      mem.tick(now, 60_000)

    // 1b. 自动收藏别人发的表情包（异步，不阻塞回复）
    //
    // 放在存记忆之后、决策之前：收藏是"顺手做的事"，即使这条消息最终
    // 沉默也该收藏 —— 用户发个表情过来，机器人不理它但悄悄存下来，
    // 下次就能用。这也正是用户要的"偷偷收藏别人的表情包"。
    void this._autoCollectStickers(msg)

    // 2. 决策
    this.stats.considered++
    const scene = await this.sceneOf(msg)

    /*
     * `maxConsecutiveTurns` 这个闸门**曾经放在这里，现在已移除**（2026-10-27）。
     *
     * 加上它的起因：群里一连串问号，它 6 分钟里连发 6 条，看着像刷屏。
     * 但用户明确说「可以连发」—— 群聊里来回接话本来就是这样的节奏，
     * 硬性掐断反而像「说到一半突然不吭声了」。
     *
     * 而且这个闸门放在 2a 段、在图片判断之前，实际后果是
     * **连图片消息也被一起挡掉**（09:32:45 那条真图片判了沉默），
     * 那是用户反馈过的问题。
     *
     * 现在把「别太吵」交给更适合的地方：
     *   · 决策层自己的 `consecutiveTurns` 判据（rule.js，按 provider 用）
     *   · 生成层可以输出 `[SILENT]`
     * 不再在 bridge 里做一刀切。
     */

    // aliases：群里实际怎么叫它（鱼 / 鲸鱼 / 白饭 …）。
    // 由配置 `decision.aliases` 提供；不给就用 rule.js 里的默认表。
    const self = {
      qq: this.selfId ?? '0',
      nickname: this.selfName,
      aliases: this.cfg.decisionAliases ?? this.cfg.aliases,
    }

    let d
    try {
      const input = mem.toDecisionInput(scene, self, now)
      // 已知群友名单：决策层用它判断「这句话是不是在跟别人说」——
      // 句中出现了别人的名字且没提我 → 不当作在追问我。
      // 直接从近期记忆里归纳（不需要额外配置，也不需要协议端接口）。
      input.peers = this._knownPeers(mem)

      /*
       * ── 纯图片消息：绕过决策层，交给生成层看图判断 ──────────────
       *
       * ## 为什么必须绕过
       *
       * 决策层是**纯文本分类器**（`toDecisionInput` 只传 messages 的 text，
       * 没有任何图像信息）。所以它看到 `[图片]` 只知道「有人发了图」，
       * 不知道画的是什么 —— 一律判「这段跟我无关 / 先不接」。
       *
       * 实测：群友发了一张**蓝发 + 鲸鱼尾 + 白女仆围裙**的胖鱼图
       * （就是鲸鱼娘自己的 Q 版形象），决策层判沉默，一次都没反应。
       *
       * ## 但不能每张图都进 LLM
       *
       * 群聊一天几百张图，全过一遍既贵又容易刷屏。所以先本地粗筛：
       * 只有「图单独发的」或「最近有人提过鱼/鲸/本鱼/大肥鱼」才放行。
       *
       * @see _shouldLookAtImage
       */
      if (this._shouldLookAtImage(msg, mem)) {
        /*
         * ⚠️ 字段名必须是 `provider` / `reason` —— 这是 `decision.explain()`
         *    读的（见 decision/index.js）。写成 source/why 的话日志里
         *    会显示「来源=undefined」，排查时分不清走的是哪条路。
         */
        d = {
          reply: true,
          probability: 0.75,
          provider: 'image',
          reason: '纯图片 → 交给生成层看图判断像不像自己',
          delayMs: 0,
        }
      } else {
        d = await this.decision.shouldReply(input)
      }
    } catch (e) {
      this.log.warn?.(`bridge：决策失败（跳过本条）— ${String(e?.message ?? e)}`)
      return
    }

    // ⚠️ 决策结果必须是 info —— 沉默是用户最关心的行为（"它为什么没回"），
    //    debug 级在日志里完全不可见，出问题只能瞎猜（实测踩过：用户反馈
    //    "沉默逻辑有问题"，日志里 0 条决策记录，什么都对不上）。
    //    附上消息摘要与图片标记，一条日志能同时回答"看到什么"和"为什么沉默"。
    const textBrief = String(msg.text ?? '').replace(/\s+/g, ' ').slice(0, 40)
    const imgBrief = (msg.images ?? []).length > 0 ? ` 图×${msg.images.length}` : ''
    this.log.info?.(`bridge：${msg.scope}「${textBrief}」${imgBrief} 决策 → ${this.decision.explain?.(d) ?? JSON.stringify(d)}`)

    /*
     * ⚠️ 提问就要答（2026-10-28 用户要求：「问要回啊，这都没回」）。
     *
     * 实测：群里问「你知道祀是谁吗」，决策层判「这段跟我无关」→ 沉默，
     * 于是连搜索都没走到（搜索在生成层，生成层只在决策说"回"之后才跑）。
     *
     * 具体判定和理由见 `questionGate.js` 的注释。
     */
    if (!d.reply) {
      const before = d
      d = applyQuestionOverride(d, msg.text, {
        isMe: msg.isMe,
        enabled: this.cfg.reply?.questionGate !== false,
        /*
         * ★ 让「提问覆盖」知道这条到底在问谁（2026-11-02）。
         * `mentionsMe` 是入库时算好的（被 @ 或引用了她的消息）。
         * `atSomeoneElse` = 文本里**有 @ 但不是 @ 她** —— 那种提问该由被 @ 的人答，
         * 不归她。实测事故：有人发「@某群友 发个CAD嘞」，她插嘴答了。
         */
        mentionsMe: Boolean(msg.mentionsMe),
        atSomeoneElse: /@\S+/.test(String(msg.text ?? '')) && !msg.mentionsMe,
      })
      if (d !== before) {
        this.log.info?.(
          `bridge：这条是提问（${before.reason}）→ 覆盖沉默，改成回答`
          + (d.questionQuery ? `（查「${d.questionQuery}」）` : ''),
        )
      }
    }

    if (!d.reply) {
      // ── 因冷却而沉默 → 排队，冷却结束后再回 ────────────────
      //
      // 决策层用 `defer` 区分两种"不回"：
      //   · 真的不想回（概率太低、连续发言太多）→ 丢弃
      //   · 冷却还没过 → **记下来，过一会儿补回**
      // 没有这一步的话，冷却期内问它的话就永久丢了，用户看到的是
      // "问了不理我"，而其实只是晚了十几秒。
      if (d.defer && Number.isFinite(d.defer.waitMs)) {
        this._enqueueDeferred(msg, mem, scene, self, d)
        this.stats.silent++
        this._record(msg, d, null, 'deferred')
        this._maybeSummarize(msg.scope, mem, scene)
        return
      }
      this.stats.silent++
      this._record(msg, d, null, 'silent')
      // ★ 判了沉默之后：群里如果 8 秒没人接，她补一句（否则场子就冷了）
      this._armDeadAir(msg, mem, scene, self)
      // 即使不说话，也可以趁机更新长期记忆
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }

    /*
     * 3. 节奏控制 —— **不在生成前睡，改成生成后补足到目标总时长**。
     *
     * 原来这里是 `await sleep(d.delayMs)`（生成前先等）。
     * 实测证明那样**用户感觉不到**：
     * ```
     * 总时长 = 延迟(0.4~7.0s) + 生成(1.3~4s)   →  p10 3.4s / p50 5.1s / p90 6.1s
     * ```
     * 差别被生成的抖动吃掉了。
     *
     * 现在改成 `_waitForPace(tStart, d)` —— 在**发送前**补
     * `目标总时长 - 已用时间`。调用点有两处：纯表情路径、正常生成路径。
     */

    // ── 3a. 纯表情回应：跳过模型，直接发一个收藏表情 ──────────────
    //
    // ⚠️ 2026-10-24 新增（修「每发一个表情包它就回话」）。
    //
    // 决策层对「纯表情/纯图片」消息不再给「发言/沉默」二选一，而是返回
    // `emojiReply: true` —— 含义是「**用表情附和，别用文字接**」。
    //
    // 为什么放在延迟之后、生成之前：
    //   · 延迟之后：表情回应也要有人味，不能零延迟秒回
    //   · 生成之前：这正是要跳过的部分 —— 不调模型，零 token 成本
    //
    // 为什么不是每张都回：概率由 mediaEmojiProbability 控制（默认 0.25），
    // 否则它会变成群里最爱发表情的人。具体门槛在 decision/rule.js 里。
    //
    // ⚠️ 不发文本：群友发的是梗图，配一句"哈哈"反而显得刻意。
    //    纯表情才像真人。
    if (d.emojiReply) {
      // 过时检测同样适用 —— 等了几秒后群里可能已经翻篇了
      const emojiStale = this._checkSuperseded(msg, mem, { afterSeq: seq })
      if (emojiStale) {
        this.stats.superseded = (this.stats.superseded ?? 0) + 1
        this.log.info?.(`bridge：等待期间群里又说了 ${emojiStale.count} 条，表情回应已过时，丢弃`)
        this._record(msg, d, null, 'emoji-superseded')
        this._maybeSummarize(msg.scope, mem, scene)
        return
      }
      try {
        // 纯表情**不调模型** —— 没有"生成耗时"，所以要等满整个目标时长，
        // 否则表情永远秒回，比文字还快，看着像机器。
        await this._waitForPace(tStart, d, '纯表情 ')
        // `[表情包]` 走 splitFaceMarkers → _pickMface 随机挑一张收藏表情
        const sentIds = await this._send(msg, '[表情包]')
        this.stats.replied++
        this.stats.emojiReplied = (this.stats.emojiReplied ?? 0) + 1
        mem.push(makeMessage({
          id: sentIds.length ? sentIds[sentIds.length - 1] : undefined,
          sender: this.selfId ?? '0',
          senderName: this.selfName,
          // ⚠️ 记成 [表情包] 而不是空 —— 让后续的「连续发言」和
          //    "我上一条是什么"判断知道它刚发过东西。
          text: '[表情包]',
          at: Date.now(),
          isMe: true,
          provider: null,
          model: null,
        }))
        this.log.info?.(`bridge：纯表情回应 → 发了一张收藏表情（未调模型）`)
        this._record(msg, d, '[表情包]', 'emoji-sent')
        this._rememberMyReplyIds(msg.scope, sentIds)
      } catch (e) {
        this.stats.failed++
        this.log.warn?.(`bridge：表情回应发送失败 — ${String(e?.message ?? e)}`)
        this._record(msg, d, null, 'emoji-send-error:' + String(e?.message ?? e))
      }
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }

    // ⚠️ 3b. 延迟/生成期间群里可能又来了新消息（2026-10-23 补）
    //
    // 真人遇到这种情况会先看一眼新内容再开口；原来这边完全不管 ——
    // 延迟 5 秒、生成 30 秒，等真正发出去时话题可能早就翻篇了，
    // 群友看到的就是一句答非所问。
    //
    // 判据收得很紧，**只处理"明显过时"**，避免误伤正常的慢回复：
    //   · 这段时间里别人至少说了 2 条，**且**
    //   · 这些新消息里没有任何一条提到我（没人在等我这个答案）
    // 满足就放弃发送，交给后面的消息自己触发新一轮判断。
    const superseded = this._checkSuperseded(msg, mem, { afterSeq: seq })
    if (superseded) {
      this.stats.superseded = (this.stats.superseded ?? 0) + 1
      this.log.info?.(`bridge：等待期间群里又说了 ${superseded.count} 条且没叫我，放弃本条回复（避免答非所问）`)
      this._record(msg, d, null, 'superseded')
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }

    // 4. 生成回复
    let text
    let cover = null
    try {
      const gen = await this._generateGuarded(msg, mem, scene, self, seq)
      // ⚠️ 生成途中就已经过时了 —— 不再往下走（见 `_generateGuarded`）
      if (gen?.__stale) {
        this.stats.superseded = (this.stats.superseded ?? 0) + 1
        this.log.info?.(
          `bridge：生成途中群里又说了 ${gen.count} 条且没叫我 —— 不等了（等了 ${Math.round(gen.waitedMs / 1000)}s）`,
        )
        this._record(msg, d, null, 'stale-aborted')
        this._maybeSummarize(msg.scope, mem, scene)
        return
      }
      // _generate 返回 { text, cover } —— cover 是搜索时顺手抓的封面图
      text = gen?.text ?? ''
      cover = gen?.cover ?? null
    } catch (e) {
      this.stats.failed++
      this.log.warn?.(`bridge：生成失败 — ${String(e?.message ?? e)}`)
      this._record(msg, d, null, 'error:' + String(e?.message ?? e))
      return
    }

    // ⚠️ 4b. 生成完了再确认一次：这条回复还跟得上吗？
    //
    // 生成往往是最慢的一步（推理模型几十秒）。这段时间里如果别人已经
    // 把话题岔开、或者**已经有人替它回答了**，再发就是刷屏。
    //
    // ⚠️ 阈值和延迟后那次**保持一致（都是 2）**，不能用更大的数：
    //    `_inboundAfter(seq)` 数的是「本条之后到达的全部消息」，
    //    不是「生成期间新增的」。两处用不同阈值会让「延迟期到 2 条、
    //    生成期 0 条」这种情况在最后一道闸被放过去 —— 实测就是这么漏的。
    //    这已经是发送前最后一道闸，口径统一才不会漏。
    const stale = this._checkSuperseded(msg, mem, { afterSeq: seq })
    if (stale) {
      this.stats.superseded = (this.stats.superseded ?? 0) + 1
      this.log.info?.(`bridge：生成期间群里又说了 ${stale.count} 条且没叫我，本条回复已过时，丢弃`)
      this._record(msg, d, text, 'stale')
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }

    // ⚠️ [SILENT] 只该在**整条就是它**时才算"不说话"。
    //
    //    原来写的是 `text.includes(SILENT)` —— 只要回复里任何位置出现
    //    这个标记就整条丢弃。而模型经常这样回：
    //        「[表情包][SILENT]」 或 「好了[SILENT]」
    //    于是**决定发言也被当成沉默**，一个字都发不出去。
    //    实测症状：界面上显示「发言 p=0.95」但 outcome 是 model-silent，
    //    计数里 replied 一直是 0。
    //
    //    正确做法：剥掉标记，**看剩下的还有没有实质内容**。
    const rawText = String(text ?? '')
    const hadSilent = /[\[［]\s*[SILENTsilent]{6}\s*[\]］]/.test(rawText)
    const stripped = rawText.replace(/[\[［]\s*[SILENTsilent]{6}\s*[\]］]/g, '').trim()
    if (!stripped) {
      this.stats.silent++
      /*
       * ⚠️ 两种"什么都不剩"要分开记（2026-10-29）。
       *
       * `persona-declined` = **人格主动选择不说**。这是正常结论，不是矛盾 ——
       * 以前它被当成"发言了却没回"的 bug，于是干脆禁止人格输出 [SILENT]，
       * 结果人格失去了"要不要开口"的权力（用户观感：太乖、38% 纯表情搪塞）。
       *
       * `empty-after-clean` = 清理完什么都不剩（例如整条只是个括号旁白）。
       * 那是输出侧的毛病，不是人格的决定。
       *
       * 分开之后：`persona-declined` 多 = 它有主见；`empty-after-clean` 多 = 清理规则太狠。
       */
      this._record(msg, d, null, hadSilent ? 'persona-declined' : 'empty-after-clean')
      if (hadSilent) {
        this.log.info?.(`bridge：人格选择不说（[SILENT]）— ${msg.scope}`)
      }
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }
    if (stripped !== text) {
      this.log.info?.(`bridge：回复里混了 [SILENT]，已剥掉后发出 — ${JSON.stringify(stripped.slice(0, 40))}`)
    }
    text = stripped

    /*
     * ── 4a'. 自重复闸（2026-11-04）──────────────────────────
     *
     * ## 修的是什么
     * 群里 13:36:01 / 13:36:08 两条，把同一个意思换了个说法又讲一遍
     * （中间还夹着 B 站补一句，第三次）。群友当场回「依旧复读」。
     *
     * 根因不是"风格雷同"，是**内容重复**：每条入站消息各触发一次生成，
     * 谁也不知道自己 3 秒前刚说过什么。提示词里那段「你刚才说过的话」只说了
     * 「别用相同的开头、别套同一个句式」—— 它照做了，然后把内容又说了一遍。
     *
     * 所以这里兜一道**内容**闸：和最近 3 条自己的话比（去掉标点/空白/表情标记）,
     * 命中就**重写一次**（明确告诉它"这句刚说过"），还重就干脆不发。
     *
     * ⚠️ 判据收得很紧（完全相同 / 包含 / 同开头 ≥10 字 / 二元组高重合），
     *    宁可漏掉近义改写，也不误杀正常回复 —— 误杀的代价是"该说话时不吭声"。
     * ⚠️ 纯表情不算（`[表情包:无语]` 连发是另一回事，由表情清单那边管）。
     */
    const dupSelf = this._selfRepeatOf(text, mem)
    /*
     * ⚠️ **私聊不过这道闸**（2026-11-04）。
     *
     * 和 `_checkSuperseded` 同理：私聊里所有消息都是对你一个人说的，
     * 用户复述一句、追问一句都是常态；而且私聊里"回了但重复"远好过
     * "问了不理我"。群聊才是复读丢人的地方。
     */
    const isPrivateScope = String(msg.scope ?? '').startsWith('private')
    if (dupSelf && !isPrivateScope) {
      this.log.info?.(
        `bridge：这句和刚说过的「${String(dupSelf).replace(/\s+/g, ' ').slice(0, 30)}」重了 → 重写一次 — ${msg.scope}`,
      )
      try {
        const again = await this._generate(
          msg, mem, scene, self, null,
          '★ **你刚说过这句，已经发出去了**：「' + String(dupSelf).replace(/\s+/g, ' ').slice(0, 60) + '」\n'
          + '这一轮**不许**把同一件事换个说法再说一遍 —— 要么补真正的新内容'
          + '（回答新问题 / 接新的话茬 / 往下推进），要么只输出 [SILENT]。',
        )
        const againText = String(again?.text ?? '')
          .replace(/[\[［]\s*[SILENTsilent]{6}\s*[\]］]/g, '')
          .trim()
        if (againText && !this._selfRepeatOf(againText, mem)) {
          text = againText
        } else {
          this.stats.silent++
          this._record(msg, d, null, 'self-repeat')
          this._maybeSummarize(msg.scope, mem, scene)
          return
        }
      } catch (e) {
        // 重写失败就按"宁可不说"处理：再发一遍重复的话，代价比沉默大
        this.stats.silent++
        this.log.warn?.(`bridge：自重复重写失败（按沉默处理）— ${String(e?.message ?? e)}`)
        this._record(msg, d, null, 'self-repeat-error')
        this._maybeSummarize(msg.scope, mem, scene)
        return
      }
    }

    /*
     * ── 4b. 找图标记 ──────────────────────────────────────────
     *
     * 模型可以输出 `[找图:关键词]` 表示「这段想配张图」。
     * 两种场景都用这一个标记：
     *   被动：「帮我找张鲸鱼娘的图」→ 模型识别后输出标记
     *   主动：它觉得这段配张图更清楚 → 也输出标记
     *
     * 处理方式：
     *   ① 把标记从正文里剥掉（绝不能发到群里 —— 和 `（+3 秒）`
     *      被照抄是同一类问题，已经踩过两次）
     *   ② 找图 → 下载 → 走 `_send` 的 image 段发出去
     *
     * ⚠️ 找图失败**不影响文字回复**：图是锦上添花，
     *    失败了就只发文字，绝不因此整条不发。
     */
    let findImage = null
    if (this.cfg.reply?.findImage !== false) {
      const marks = extractFindImageMarkers(text)
      if (marks.length > 0) {
        // 一次回复只找一张 —— 找图要花半分钱，而且多图会刷屏
        const q = marks[0].query
        text = stripFindImageMarkers(text)

        /*
         * ⚠️ 同会话判重（2026-10-28，用户报「一直找图」）。
         *
         * 实测同一关键词反复搜了 5 次（见 imageFindMarkers.js 注释）。
         * 只在**成功**之后才记进历史 —— 失败要允许立刻换词重试。
         */
        const nowFind = Date.now()
        const FIND_WINDOW = 10 * 60_000
        this._findImageRecent = (this._findImageRecent ?? [])
          .filter((x) => nowFind - x.at < FIND_WINDOW)
        const dup = isDuplicateFindImage(this._findImageRecent, {
          key: findImageKey(q),
          scope: msg.scope,
          now: nowFind,
        })

        if (dup) {
          this.log.info?.(
            `bridge：找图跳过 —— 「${q.slice(0, 40)}」这个会话 10 分钟内刚找过，省一次搜索`,
          )
        } else {
          this.log.info?.(`bridge：回复里要求找图「${q.slice(0, 40)}」`)
          try {
            const r = await resolveFindImage({
              query: q,
              apiKey: this.searchKey,
              log: (m) => this.log.info?.(`bridge：${m}`),
            })
            if (r.ok && r.images.length > 0) {
              findImage = r.images[0]
              this._findImageRecent.push({ key: findImageKey(q), scope: msg.scope, at: nowFind })
              this.log.info?.(`bridge：找到图 ${findImage.url.slice(0, 80)}（${Math.round(findImage.buffer.length / 1024)}KB）`)
            } else {
              this.log.warn?.(`bridge：找图失败（按纯文字发）— ${r.error}`)
            }
          } catch (e) {
            this.log.warn?.(`bridge：找图出错（按纯文字发）— ${String(e?.message ?? e)}`)
          }
        }
        // 剥完标记如果什么都不剩，就只发图（不硬凑文字）
        if (!text.trim() && !findImage) {
          this.stats.silent++
          this._record(msg, d, null, 'find-image-empty')
          this._maybeSummarize(msg.scope, mem, scene)
          return
        }
      }
    }

    /*
     * ── 4c. 禁言标记 ──────────────────────────────────────────
     *
     * 格式：`[禁言:QQ号:分钟]`（分钟可省略，默认 5 分钟）
     *
     * ⚠️ 这是**唯一**一个模型能对其他群友造成实际影响的能力，
     *    所以铁律是：**三道闸，任何一道不过就不执行**。
     *
     *      ① 模型只能给 `QQ号:分钟`，不能给 action/参数
     *      ② 代码查群成员列表，校验目标角色和时长上限
     *      ③ 频率限制（同一目标每小时 1 次 / 全群每天 10 次）
     *
     * ⚠️ 还有一条更重要的：**不能让「它讨厌谁」直接变成「禁言谁」**。
     *    模型判断「这人烦我」的依据极不可靠（一句玩笑就能被读成敌意），
     *    而禁言对当事人是**不可见**的 —— 他不知道为什么突然不能说话。
     *    提示词里已经写明：只在**被明确要求**时才禁言。
     */
    let banNote = null
    if (this.cfg.groupAdmin?.ban !== false) {
      const marks = extractBanMarkers(text)
      if (marks.length > 0) {
        text = stripBanMarkers(text)
        // 私聊里不做群管理操作
        if (!msg.groupId) {
          this.log.warn?.('bridge：私聊里收到禁言标记，忽略')
        } else if (marks.length > 1) {
          // 一次只处理一个，避免一条回复里连环禁言
          this.log.warn?.(`bridge：一条回复里有 ${marks.length} 个禁言标记，只执行第一个`)
        }

        const m = marks[0]
        if (msg.groupId) {
          try {
            const members = await this.onebot.getGroupMembers(msg.groupId)
            const today = new Date().toISOString().slice(0, 10)
            if (!this._banHistory) this._banHistory = { perUser: new Map(), day: '', perDay: 0 }
            if (this._banHistory.day !== today) {
              this._banHistory.day = today
              this._banHistory.perDay = 0
            }
            const v = validateBan({
              userId: m.userId,
              minutes: m.minutes,
              selfId: this.selfId,
              members,
              history: this._banHistory,
            })
            if (!v.ok) {
              this.log.warn?.(`bridge：禁言 ${m.userId} 被拒绝 — ${v.reason}`)
              banNote = v.reason
            } else {
              await this.onebot.banMember(msg.groupId, m.userId, v.minutes * 60)
              this._banHistory.perUser.set(m.userId, Date.now())
              this._banHistory.perDay++
              this.log.info?.(`bridge：已禁言 ${m.userId} ${v.minutes} 分钟`)
              banNote = `已禁言 ${describeBanMinutes(v.minutes)}`
            }
          } catch (e) {
            this.log.warn?.(`bridge：禁言执行失败 — ${String(e?.message ?? e)}`)
            banNote = '禁言没成功'
          }
        }
      }
    }

    /*
     * ── 4d. 改昵称标记 ────────────────────────────────────────
     *
     * 格式：`[改昵称:新名字]`
     *
     * ⚠️ 这是**改自己的 QQ 昵称**，不是群名片。
     *    群名片只影响一个群，改错了在群里一看就知道；
     *    QQ 昵称是**全局**的 —— 所有群、所有好友、所有搜索结果里都是新名字。
     *    改成一个莫名其妙的名字，别人会以为这号被盗了。
     *
     * 所以限额比禁言还紧：长度 ≤12、每小时 ≤3 次、
     * 不许含引号/反斜杠/纯符号（见 validateNickname）。
     */
    let nickNote = null
    if (this.cfg.groupAdmin?.nickname !== false) {
      const marks = extractNicknameMarkers(text)
      if (marks.length > 0) {
        text = stripNicknameMarkers(text)
        const m = marks[0]
        if (marks.length > 1) {
          this.log.warn?.(`bridge：一条回复里有 ${marks.length} 个改昵称标记，只执行第一个`)
        }
        try {
          if (!this._nickHistory) this._nickHistory = []
          const now = Date.now()
          this._nickHistory = this._nickHistory.filter((x) => now - x < 3600_000)
          const v = validateNickname({
            name: m.name,
            currentName: this.selfName,
            history: this._nickHistory,
            now,
          })
          if (!v.ok) {
            this.log.warn?.(`bridge：改昵称「${m.name}」被拒绝 — ${v.reason}`)
            nickNote = v.reason
          } else {
            await this.onebot.setSelfNickname(v.name)
            this._nickHistory.push(now)
            this.log.info?.(`bridge：昵称已改为「${v.name}」（原「${this.selfName}」）`)
            // 让后续的自我称呼立刻用新名字
            this.selfName = v.name
            nickNote = `已改名为「${v.name}」`
          }
        } catch (e) {
          this.log.warn?.(`bridge：改昵称失败 — ${String(e?.message ?? e)}`)
          nickNote = '改名没成功'
        }
      }
    }

    /*
     * ── 4e. 改标签标记（2026-11-04）────────────────────────────
     *
     * 格式：`[改标签:嫌弃,厌恶]`（1~6 个，逗号/顿号/空格分隔）
     *
     * 这条是**她唯一能真正改标签的通道**。没有它的时候，用户说
     * 「这个标签打错了」，她只会嘴上应「改了改了」——
     * 而 sticker-tags.json 一个字都不会动（实测 16:15 那两句就是纯谎报）。
     *
     * 目标见 `_tagTarget`：对方这条里那张（md5 精确命中）。
     * 私聊权限宽一点：还可以是她刚发出去的那张。
     */
    let tagNote = null
    {
      const marks = extractTagMarkers(text)
      if (marks.length > 0) {
        text = stripTagMarkers(text)
        if (marks.length > 1) {
          this.log.warn?.(`bridge：一条回复里有 ${marks.length} 个改标签标记，只执行第一个`)
        }
        const tags = splitTags(marks[0])
        if (tags.length === 0) {
          this.log.warn?.('bridge：改标签标记里没有可用的标签')
          tagNote = '标签没改成'
        } else if (typeof this.stickerTags?.set !== 'function') {
          this.log.warn?.('bridge：标签库没挂载 —— 改标签跳过')
          tagNote = '标签没改成'
        } else {
          const target = await this._tagTarget(msg)
          if (!target) {
            this.log.warn?.(`bridge：改标签找不到目标 — 「${tags.join('、')}」`)
            tagNote = '没找到那张表情'
          } else if (this.stickerTags.set(target.url, tags)) {
            this.log.info?.(
              `bridge：表情标签已改 → ${tags.join('、')}`
              + `（目标=${target.why}，${target.url.slice(0, 60)}）`,
            )
            tagNote = `标签改成「${tags.join('、')}」`
          } else {
            this.log.warn?.(
              `bridge：表情标签没改成（标签不合法，或本来就是这样）— 「${tags.join('、')}」`,
            )
            tagNote = '标签没改成'
          }
        }
      }
    }

    /*
     * ── 4g. QQ 侧动作（2026-11-04）──────────────────────────────
     *
     * `[回应:13]` 贴表情 / `[戳]` 戳一戳 / `[签名:…]` 改自己签名 / `[撤回]` 撤回上一条。
     *
     * 每个动作都有开关（`qq.actions`，见 config/store.js 那张表）：
     * 免费、不碰别人的默认开；要权限/有副作用的默认关。
     * 关掉的时候标记**也照样剥掉** —— 绝不能因为开关关了就把「[戳]」发出去。
     *
     * ⚠️ **必须排在 4f 谎报闸之前**：谎报闸要知道"这一轮到底发生了什么"，
     *    签名/撤回也是动作，得先执行再核对。
     */
    let qqNotes = []
    {
      const marks = extractQQMarkers(text)
      if (marks.items.length > 0) {
        text = marks.text
        qqNotes = await runQQMarkers({
          items: marks.items,
          onebot: this.onebot,
          msg,
          mem,
          cfg: this.cfg.actions ?? {},
          log: this.log,
          // 改签名必须同时带 nickname（协议端 schema 必填），用当前昵称原样传
          selfName: this.selfName,
        })
        if (qqNotes.length > 0) this.log.info?.(`bridge：QQ 动作执行了 — ${qqNotes.join('、')}`)
      }
    }

    /*
     * ── 4f. 声称做了 / 其实没做（2026-11-04）──────────────────
     *
     * 「改了改了」「标签改完了」「已经禁言了」—— 这些话只有在**本轮真的
     * 执行了对应动作**时才允许发出去。程序只认标记，不认话。
     *
     * 处理：重写一次（明确告诉它没发生），还谎报就整条不发。
     * 宁可这一轮少说一句，也不能让它习惯性地报一件没发生的事。
     */
    {
      const did = {
        tag: Boolean(tagNote),
        nick: Boolean(nickNote),
        ban: Boolean(banNote),
        image: Boolean(findImage),
        // QQ 动作的结果也算"真的做了"（见 4g 的 notes 文案）
        signature: qqNotes.some((n) => String(n).startsWith('签名改成')),
        recall: qqNotes.some((n) => String(n).includes('撤回')),
      }
      const claim = this._falseClaim(text, did, msg?.text)
      if (claim) {
        this.log.warn?.(
          `bridge：她说了「${claim.hit}」，但这一轮没有任何动作（${claim.kind}）→ 重写一次`,
        )
        try {
          const again = await this._generate(
            msg, mem, scene, self, null,
            '★ **你刚说「' + claim.hit + '」，但这一轮什么都没发生** —— '
            + '你只说了话，没有输出任何标记，程序不会替你改。\n'
            + '两条路选一条：真的做（改标签→[改标签:标签1,标签2]；'
            + '改昵称→[改昵称:新名字]；禁言→[禁言:QQ号:分钟]；找图→[找图:关键词]），'
            + '或者把「已经…了」这类话删掉，别报一件没发生的事。',
          )
          // ⚠️ 重写里如果又吐标记，这里一律剥掉 —— 那些标记这一轮不会再被执行，
          //    留着只会让它以为自己做了、下一条继续谎报。
          const againText = extractQQMarkers(
            stripFindImageMarkers(
              stripNicknameMarkers(stripBanMarkers(stripTagMarkers(String(again?.text ?? '')))),
            ),
          ).text
            .replace(/[\[［]\s*[SILENTsilent]{6}\s*[\]］]/g, '')
            .trim()
          if (againText && !this._falseClaim(againText, did, msg?.text)) {
            text = againText
          } else {
            this.stats.silent++
            this._record(msg, d, null, 'false-claim')
            this._maybeSummarize(msg.scope, mem, scene)
            return
          }
        } catch (e) {
          this.stats.silent++
          this.log.warn?.(`bridge：谎报重写失败（按沉默处理）— ${String(e?.message ?? e)}`)
          this._record(msg, d, null, 'false-claim-error')
          this._maybeSummarize(msg.scope, mem, scene)
          return
        }
      }
    }

    /*
     * ── 4g 已在 4f 之前执行（见上）。这里不再重复 —— 重复执行会让
     *    `[戳]` 戳两次、`[撤回]` 撤错消息。2026-11-04 调整顺序时踩过这个坑。
     */

    // 5. 发送
    try {
      // findImage 的 buffer 走 base64 data URL —— OneBot 的 image 段
      // 能直接收 URL，也能收 base64，但 URL 更省带宽。
      const coverForSend = findImage
        ? { url: `base64://${findImage.buffer.toString('base64')}` }
        : cover
      // 禁言结果附一句说明 —— 当事人得知道发生了什么，别偷偷摸摸的。
      // 没写正文（只给了标记）时，就用这句当正文。
      if (banNote || nickNote || tagNote || qqNotes.length > 0) {
        const notes = [banNote, nickNote, tagNote, ...qqNotes].filter(Boolean).join('；')
        text = text.trim() ? `${text}（${notes}）` : `${notes}。`
      }
      // ★ 同一个括号起手式别复读（2026-11-05）：实测群里连着 3 条都是「（撇嘴）」
      text = this._stripRepeatedOpener(text, mem)
      // ★ 节奏控制：生成已经花了多少，就只补剩下的（见 `_waitForPace`）
      await this._waitForPace(tStart, d)
      const sentIds = await this._send(msg, text, coverForSend)
      this.stats.replied++
      mem.push(makeMessage({
        // ⚠️ 用自己的 message_id 记录这条回复。
        //    这样别人**引用我的话**回复时，能通过 replyTo 匹配到它，
        //    从而认出"这是在对我说"（见 _handle 的 quotedMine）。
        //    多段消息只记最后一条的 id —— 用户通常引用最后那条。
        id: sentIds.length ? sentIds[sentIds.length - 1] : undefined,
        sender: this.selfId ?? '0',
        senderName: this.selfName,
        // ⚠️ 用 `_send` 剥完标记之后的那份（见 `_send` 里 `msg.__sentText` 的说明）——
        //    不然 `[等:10]` 这种已经剥掉、用户根本没看到的标记会留在记忆里。
        text: msg.__sentText ?? text,
        at: Date.now(),
        isMe: true,
        // 记下这条回复是哪家渠道/哪个模型生成的 —— 往上送历史时
        // dsh-llm 要求 assistant 消息带 source，见 makeMessage 的注释
        provider: this._lastRoute?.provider ?? null,
        model: this._lastRoute?.model ?? null,
      }))
      this._record(msg, d, text, 'sent')
      /*
       * 把**自己发了什么**也写进日志。
       *
       * 原来只记「收到什么 + 决策结果」，排查「上文不接下文」时
       * 完全无法对照 —— 只能切到 QQ 窗口人眼看，而且看完就滚走了。
       * 现在一行里有对方说了什么、自己回了什么，时序一目了然。
       */
      // ⚠️ 截断长度从 120 提到 400（2026-10-29）：
    //    查「思考内容外泄」时被 120 卡住 —— 超过 120 字的回复，日志只剩
    //    干净的前半段，泄漏的后半段根本看不到，白白浪费好几轮排查。
    this.log.info?.(`bridge：[我] ${msg.scope}「${String(text).slice(0, 400)}」`)
      /*
       * ★ **长视频：回复已经发出去了，现在等后台听完再补一句**（2026-11-01）。
       *
       * 用户原话：
       * > 「时长太长的，就先回复我先看看，然后正常聊天，那边结束了再提视频内容。」
       *
       * 放在**这里**（而不是 `_generate` 里 await）是刻意的：
       * 即时回复的延迟必须是 0 —— 后台任务跟这条回复**并行**跑，
       * 谁先完都不互相等。这一句 `void` 就是"派出去，不等"。
       */
      /*
       * ★ 私聊暧昧场景：他 10 秒没动静，就让她**自己往下写**（2026-11-04）。
       *   只排定时器，不 await —— 不影响这条回复。
       */
      this._armSceneContinue(msg, mem, scene, self)
      const vjob = this._videoJobs?.get(String(msg.scope ?? ''))
      if (vjob) {
        this._videoJobs.delete(String(msg.scope ?? ''))
        void this._videoFollowUp(vjob, msg, mem, scene, self)
      }
      /*
       * ★★ 车牌内页：**同一个模式**（2026-11-02）。
       *
       * 开浏览器看内页实测 **26 秒** —— 绝不能卡在上面那条回复里。
       * 这里只是"把已经派出去的任务接上"：任务在 `_generate` 里 `void` 派出去的
       * （那时浏览器已经在后台开了），现在回复发完了，交给 `_jmFollowUp` 收尾。
       */
      const jmjob = this._jmJobs?.get(String(msg.scope ?? ''))
      if (jmjob) {
        this._jmJobs.delete(String(msg.scope ?? ''))
        void this._jmFollowUp(jmjob, msg, mem, scene, self)
      }
      // 记下自己发出的 message_id —— 过时检测要靠它认出
      // 「后续消息引用了我的回复」= 有人在追问我，不能判过时。
      this._rememberMyReplyIds(msg.scope, sentIds)
    } catch (e) {
      this.stats.failed++
      this.log.warn?.(`bridge：发送失败 — ${String(e?.message ?? e)}`)
      this._record(msg, d, text, 'send-error:' + String(e?.message ?? e))
    }

    this._maybeSummarize(msg.scope, mem, scene)
  }

  /**
   * 把消息里的图片抓成 **dsh-llm 的 ImageBlock**（多模态用）。
   *
   * 流程：OneBot 的图片引用 → fetchImage 拿到 base64 → 存进 attachment
   * store 拿 attachmentId → 组装 ImageBlock。中间任何一步失败都跳过该图
   * （不抛错），退化成"只有文字"的请求 —— 至少机器人还能回话。
   *
   * 只抓**最近一条**带图的消息，且限制张数 —— 历史图片对当前回复没有价值，
   * 反而把 token 烧光（尤其是免费渠道的上下文预算）。
   *
   * @param {Array} recent 最近的消息（升序）
   * @returns {Promise<Map<string, object>>} 原图片引用 → ImageBlock
   */
  /**
   * 对方这条消息**在指代一张旧图**时，挑出那张图；否则返回 null。
   *
   * ## 起因（2026-10-30 用户实测）
   * ```
   * 21:19:15 「[图片]」 → 已附图 → [我]「阿哈的祝福还带图配文？这待遇不低啊」  ✅ 看了
   * 21:19:24 「[图片]」 → 已附图 → [我]「许愿阿哈不歪，结果阿哈自己出皮肤了」    ✅ 看了
   * 21:21:54 「这个」   → **没附图** → [我]「这图我这边糊成一团，看不清」
   * ```
   * 「这个」是纯文本，而附图规则只认"当前消息自带的图"（2026-10-27 为了修
   * 「发过一张图之后每条纯文本都重附旧图」故意收紧的）。收紧是对的，
   * 但**指代旧图时它手上什么都没有**，只能回"看不清"。
   *
   * ## 为什么单独抽成一个方法（而不是写在 `_collectImages` 里）
   * **调用顺序**：`_collectImages` 在 `_generate` 里很靠后才调，而
   * 「这张是旧图」这件事必须**拼 system prompt 之前**就知道 —— 否则
   * 模型会把旧图当"刚发给它的"来评论。所以 `_generate` 提前调这个方法。
   *
   * @param {Array} recent 历史消息（最后一条 = 当前这条）
   * @returns {object|null}
   */
  _pickReferencedImage(recent) {
    const cur = recent?.[recent.length - 1]
    if (!cur || cur.isMe) return null
    // 当前消息自带图 → 不需要回溯
    if ((cur.images ?? []).length > 0) return null

    const t = String(cur.text ?? '')
    // 强形式回溯 6 条；弱形式（裸「这个」）只认紧挨着的前一条
    const strong = REFER_IMAGE_STRONG.test(t)
    const weak = REFER_IMAGE_WEAK.test(t)
    if (!strong && !weak) return null

    const back = strong ? 6 : 1
    const win = recent.slice(Math.max(0, recent.length - 1 - back), recent.length - 1)
    const cand = win.filter((m) => !m.isMe && (m.images ?? []).length > 0)
    if (cand.length === 0) return null

    /*
     * 优先**同一个人**发的图 —— 指代通常指向自己刚发的那张。
     * 群里「上面那张」也可能指别人的，所以没有同人的就退而取任意最近一张。
     *
     * ⚠️ 发送者字段两种形态都见过：`userId`（事件对象）和 `sender`
     * （存进 memory 之后的形态）。只认一个会静默失去"同一人"这个判断。
     */
    const uid = (m) => String(m.userId ?? m.sender ?? '')
    const mine = cand.filter((m) => uid(m) === uid(cur) && uid(m) !== '')
    const pool = mine.length > 0 ? mine : cand
    const pick = pool[pool.length - 1]
    this.log?.info?.(
      `bridge：对方在指代一张图（${strong ? '强' : '弱'}指代）—— 补上`
      + `${mine.length > 0 ? '同一人' : '别人'}发的上一张（往前 ${recent.length - 1 - recent.indexOf(pick)} 条）`,
    )
    return pick
  }

  async _collectImages(recent, preRef, extraBlocks = null) {
    const out = new Map()

    /*
     * ★★ 先把**外面塞进来的图块**放进去（2026-11-02）。
     *
     * 为什么需要：QQ 的图是靠 `onebot.fetchImage(ref)` 去下载的，
     * 但**浏览器截图**本来就是 base64 —— 不需要下载那一步。
     * 硬塞进 `msg.images` 那条路会白跑一趟下载（而且必然失败）。
     *
     * 用途：生物"看完车牌内页补一句"那块 —— 截图直接从这里进上下文。
     *
     * ⚠️ 放在最**前面**，且**不受**下面那些开关影响：
     *    · `imagesEnabled=false`（那是管"要不要下载 QQ 图"的）
     *    · `makeImageBlock` 不可用（下面会判，但这里已经拿到成块了）
     *   截图是我们自己生成的，已经入库过一次，没必要再受一遍闸。
     */
    if (extraBlocks && typeof extraBlocks[Symbol.iterator] === 'function') {
      for (const [k, v] of extraBlocks) if (v) out.set(k, v)
      if (out.size > 0) this.log.info?.(`bridge：附图 ${out.size} 张（浏览器截图）`)
    }

    // 配置里显式关掉就不抓（省钱 / 模型不支持图片时）
    if (this.cfg.reply?.imagesEnabled === false) {
      this.log.info?.('bridge：配置里 imagesEnabled=false —— 不抓图（模型只能看到"[图片]"文字）')
      return out
    }
    // 没有 attachment 服务就只能走纯文本（否则请求必然报错）
    if (typeof this.gateway?.makeImageBlock !== 'function') {
      this.log.warn?.('bridge：attachment 服务不可用 —— 图片降级为文字（检查 DSH 的 dsh-attachment-local 是否装载）')
      return out
    }

    /*
     * ⚠️ 只取**当前这条消息**的图（2026-10-27 修）。
     *
     * 原来是 `[...recent].reverse().find(m => m.images.length > 0)` ——
     * 从**整个历史**里倒着找最近一条带图的。
     *
     * 后果非常糟：群里有人发了一张图之后，**接下来每一条纯文本消息**
     * 都会把那张旧图重新附一遍。实测私聊里：
     *
     *   11:43:50  有人发表情包 → 附图 1 张（正确）
     *   11:44:36  「？」        → 又附图 1 张（错！这是上一张图）
     *   11:44:50  「？」        → 还是那张图
     *   11:45:08  「这里啊」    → 还是那张图
     *
     * 而且它还会拿这张旧图回答「图呢」这种问题，等于答非所问。
     *
     * 正确行为：只有**当前消息本身**带图时才附图。
     * 历史里的图对模型没用 —— 要看也只是「对方之前发过图」，
     * 那个信息已经在文本里了（`[表情包]` / `[图片]` 标记）。
     */
    /*
     * ⚠️ 2026-10-30 新增：**它在指代一张旧图时就补上**。
     *
     * 见 `REFER_IMAGE_STRONG` 的注释 —— 用户实测报的就是
     * 「21:21:54「这个」→ 没附图 → 回"这图我这边糊成一团，看不清"」。
     *
     * ⚠️ `preRef` 为什么存在：**调用顺序**。
     * `_collectImages` 是在 `_generate` 里很靠后（`history = mem.recent(30)` 之后）
     * 才调的，而「这张是旧图、对方在指代」这件事必须**拼 system prompt 之前**
     * 就知道（否则它会把旧图当刚发的评论）。所以 `_generate` 会**提前**
     * 调一次 `_pickReferencedImage`，把结果作为 `preRef` 传进来。
     * 不传（比如测试直接调 `_collectImages`）就自己算。
     */
    const withImg = (() => {
      // history 的最后一条就是当前正在处理的这条消息
      const cur = recent[recent.length - 1]
      if (!cur || cur.isMe) return null
      if ((cur.images ?? []).length > 0) return cur
      return preRef !== undefined ? preRef : this._pickReferencedImage(recent)
    })()
    if (!withImg) return out

    /*
     * 表情包**要附图**（2026-10-27 最终定）。
     *
     * 反复横跳四次的完整结论：
     *   ① 不附图，只给「（对方发了一个表情包）」文字
     *      → 看不见就猜「这谁啊，又不是本鱼」
     *   ② 附图 + 问「像不像自己」
     *      → 每张都要表态（「蓝毛勉强沾点边」「这不是我，是那只青蛙」）
     *   ③ 附图 + 问「图上有字吗」
     *      → 会去描述画面 / 复述图上的字
     *   ④ 不附图（上一版）
     *      → **带字的梗图接不住了**，用户明确反馈「不看字了」
     *   ⑤ **附图 + 严格约束「懂意思、接梗、不复述」** ← 现在
     *
     * 用户的要求很明确：「严格限制，不复述，只接梗，懂意思」。
     * 也就是——**看懂那个梗在说什么，用自己的话接一句**，
     * 而不是把图上的字念一遍、也不是描述画面。
     *
     * 约束写在 `mediaHint` 的表情包分支里，这里只负责把图给出去。
     */
    const stickerCount = (withImg.stickerRefs ?? []).length
    const textOfImg = String(withImg.text ?? '')
    const isStickerMsg = stickerCount > 0 || /\[表情包(?::[^\]]*)?\]/.test(textOfImg)
    if (isStickerMsg) {
      this.log.info?.('bridge：这条是表情包 —— 附图，让它看懂梗再自己说')
    }

    /*
     * ⚠️ **超出上限时要留痕**（2026-11-01）。
     *
     * 实测事故：用户发 **4 张**图，日志写「发现 2 张待取图片」——
     * 因为 `maxImages` 配的是 2（旧配置）。模型只看到 2 张，
     * 后面用户说「我把图下过来了，你看看」时它回「图还是没出来诶」，
     * 用户以为它坏了。
     *
     * 两个教训：
     *   ① `DEFAULTS` 只填**缺失**的键 —— config.json 里已有的旧值不会被覆盖
     *      （`maxImages` 代码默认早就是 4，但用户配置里写着 2，所以永远用 2）
     *   ② **超出上限不能默默丢** —— 至少要能在日志里看出来
     */
    const allImgs = Array.isArray(withImg.images) ? withImg.images : []
    const maxImg = Number(this.cfg.reply?.maxImages ?? 4)
    const refs = allImgs.slice(0, maxImg)
    const skippedImgs = Math.max(0, allImgs.length - refs.length)
    // ⚠️ 这几条以前是 debug 级 —— 图坏了日志里什么都看不到，用户只能猜。
    //    图片属于"看不见就是功能坏了"的东西，失败必须留下痕迹。
    this.log.info?.(
      `bridge：发现 ${refs.length} 张待取图片`
      + (skippedImgs > 0 ? `（**共 ${allImgs.length} 张，还有 ${skippedImgs} 张没看** —— 超出 maxImages=${maxImg}）` : '')
      + `（引用示例：${String(refs[0]).slice(0, 80)}）`,
    )
    for (const ref of refs) {
      try {
        // ── 图片缓存 ──────────────────────────────────────────
        //
        // ⚠️ 2026-10-25 实测：同一张图在一次对话里被下载了 **28 次**。
        //
        // 原因：`_collectImages` 每次都从 `recent` 里找"最近一条带图的
        // 消息"，而那"最近一条"在用户连发几条文字后**不会变** —— 于是
        // 每条新消息都把同一批图重新 fetch + 入库一遍。
        //
        // 代价很实在：一次下载 1~2 MB，还要多等一次网络往返，
        // 用户体感就是"回得慢"。而且 QQ 的图片 URL 带 rkey，过期后
        // 重复下载还会失败。
        //
        // 这里按 ref 缓存 5 分钟。key 用 ref 字符串本身（QQ 的 fileid
        // 在会话内唯一）；超时后重新下载，避免 rkey 过期后一直用坏数据。
        const cacheKey = String(ref)
        const cached = this._imgCache?.get(cacheKey)
        if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
          out.set(ref, cached.block)
          continue
        }

        const img = await this.onebot.fetchImage(ref, { maxBytes: this.cfg.reply?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES })
        if (!img?.dataUrl) {
          this.log.warn?.(`bridge：取图失败（拿不到可下载内容）ref=${String(ref).slice(0, 80)}`)
          continue
        }
        // dataUrl 形如 data:image/png;base64,XXXX —— 拆出纯 base64 与 mime
        const m = /^data:([^;]+);base64,(.*)$/s.exec(img.dataUrl)
        if (!m) continue
        const block = await this.gateway.makeImageBlock({
          base64: m[2],
          mediaType: m[1],
          name: 'qq-image',
        })
        if (block) {
          out.set(ref, block)
          // 缓存：只留最近 20 张，避免长会话把内存吃满
          if (!this._imgCache) this._imgCache = new Map()
          this._imgCache.set(cacheKey, { at: Date.now(), block })
          if (this._imgCache.size > 20) {
            const oldest = this._imgCache.keys().next().value
            this._imgCache.delete(oldest)
          }
        } else {
          this.log.warn?.('bridge：图片入库失败（makeImageBlock 返回空）')
        }
      } catch (e) {
        this.log.warn?.(`bridge：取图失败 — ${String(e?.message ?? e)}`)
      }
    }
    if (out.size > 0) this.log.info?.(`bridge：已附图 ${out.size} 张（多模态）`)
    else this.log.warn?.('bridge：有图片但一张都没入库，本条按纯文本发送')
    return out
  }

  /**
   * 当前这条消息是不是**已经被群里新出现的内容取代**了？
   *
   * 用途：延迟/生成期间如果群里又聊开了，原来那条回复可能已经过时。
   * 直接发出去就是"答非所问"，比沉默更伤。
   *
   * ## 为什么读 `_inbound` 而不是 `mem`
   *
   * ⚠️ 这是 2026-10-23 修的一个真 bug。
   *
   * 同会话是**串行**的：第一条在 sleep/生成时，第二条的 `_handle` 还没
   * 开始跑，所以**还没写进 mem**。原来这里读 `mem.recent()`，于是
   * 「已经到达、正在排队」的消息对检测完全不可见 —— 过时检测永远返回
   * null，等于没做。
   *
   * 实测（tests/_probe-concurrency.mjs）：第一条生成期间连发两条，
   * mem 里只有 1 条，检测返回 null，三条全部照发。
   *
   * 现在读 `_inbound`（入口即写、不受串行队列阻塞），能看到排队中的消息。
   *
   * ## 判据（必须**同时**满足，避免误伤）
   *
   *   ① 我这条之后，别人又来了 ≥ minNew 条
   *   ② 这些新消息里**没有任何一条提到我**（没人在等这个答案）
   *   ③ 这些新消息里**没有对我的引用回复**（那说明有人在追问我）
   *
   * 只要有人提到我或引用我，就照常发送 —— 说明这个答案还有人在等。
   *
   * @param {object} msg   触发本次回复的消息
   * @param {object} mem   ConversationMemory（保留参数以兼容旧调用，本函数不再读它）
   * @param {object} [opts]
   * @param {number} [opts.minNew] 至少几条新消息才算过时（默认 2）
   * @param {number} [opts.afterSeq] 本条消息的入站序号；缺省时按 messageId 反查
   * @returns {null|{count:number}} null = 没过时
   */
  /**
   * 「说做了，其实没做」（2026-11-04）。
   *
   * ## 现场
   * 私聊里她连说「改了改了」「标签改完了」，而 `sticker-tags.json` 的
   * mtime 一动不动。人格里早就写着「程序只认标记，不认你说的话」——
   * 但**没有任何代码去核对**，那句话只是提示词里的一句劝。
   *
   * ## 只查"有标记才可能做到"的那几类
   * 改标签 / 改昵称 / 禁言 / 找图 —— 这四件事都有对应标记。
   * 别的（「我去看看」「我记住了」）不管：那些本来就没有对应动作，
   * 硬管会把正常接话也掐掉。
   *
   * ## 判据收得很紧
   *   · 要**肯定式**的完成说法（改好/改完/改了/改成）
   *   · 附近有「没/不/未」或「不了」→ 是否定句，放过
   *   · 后面紧跟「吗/么/？」→ 是疑问句，放过
   *
   * @param {string} text
   * @param {{tag?:boolean,nick?:boolean,ban?:boolean,image?:boolean}} did 本轮真的做了什么
   * @param {string} [ctx] 对方这一轮说的话（判定"跨句谎报"用，见下面的签名规则）
   * @returns {null|{kind:string,hit:string}}
   */
  _falseClaim(text, did = {}, ctx = '') {
    const s = String(text ?? '')
    if (!s) return null
    const around = (idx, len) => s.slice(Math.max(0, idx - 4), Math.min(s.length, idx + len + 4))
    const rules = [
      // 标签：明确提到标签，或者她爱用的「改了改了」连说
      { kind: 'tag', need: 'tag', re: /标签[^。！？\n]{0,12}?改(好|完|了|成|过来)|改(好|完|成了?|过来)(这个|那个)?标签/ },
      { kind: 'tag', need: 'any', re: /改了改了/ },
      { kind: 'nick', need: 'nick', re: /(昵称|名字)[^。！？\n]{0,12}?改(好|完|了|成|过来)|改(好|完|成了?)(昵称|名字)/ },
      { kind: 'ban', need: 'ban', re: /禁言[他她它]?了|禁言[他她它]?好了|禁言[她他它]?掉了/ },
      { kind: 'image', need: 'image', re: /(给你)?(找到|找好|找了)(一)?张图|图(已经)?(找好|找到)了/ },
      // 签名/撤回 —— QQ 动作那一批（2026-11-04）。签名默认是关的，
      // 所以她说「签名改了」而没有 [签名:…] 时，必须拦住。
      { kind: 'signature', need: 'signature', re: /签名[^。！？\n]{0,10}(改|换)(好|完|了|成)/ },
      /*
       * ★ **签名跨句**（2026-11-04 20:xx 补，收口放宽）。
       *
       * 实测 19:43:32~44：
       * ```
       * 他「你看看现在能自己改签名和其他的了吗」
       * 她「（…手搭上去动了一下）改了，」     ← 动作描写 + 一个「改了」
       * ```
       * 上面的规则要求「签名…改X」**在同一句里** —— 她这轮根本没提"签名"两个字，
       * 只是顺着对方的问题说「改了」，于是漏网。
       *
       * 现在：**对方这一轮问的就是签名/资料**（`ctx`），而她说「改好/改完/改了」
       * 却没有任何 [签名:…] → 也算谎报。
       *
       * ⚠️ 只在 `ctx` 命中时才生效 —— 否则「我改了主意」这种日常说法
       *    会被当成谎报（`skip` 再挡一道）。
       */
      {
        kind: 'signature',
        need: 'signature',
        ctx: /签名|个性签名|个人资料/,
        re: /改(好|完|了)/,
        skip: /主意|想法|计划|行程/,
      },
      { kind: 'recall', need: 'recall', re: /(已经)?撤回了/ },
    ]
    for (const r of rules) {
      const m = r.re.exec(s)
      if (!m) continue
      const acted = r.need === 'any'
        ? Boolean(did.tag || did.nick || did.ban || did.image)
        : Boolean(did[r.need])
      if (acted) continue // 真做了，随便说
      // 跨句规则（带 `ctx` 的）：对方没提到这件事，她说的「改了」就是别的意思
      if (r.ctx && !r.ctx.test(String(ctx ?? ''))) continue
      if (r.skip && r.skip.test(around(m.index, m[0].length))) continue
      if (/[没不未别甭]|不了/.test(around(m.index, m[0].length))) continue // 否定句
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 1)
      if (/[吗么？?]/.test(after)) continue // 疑问句
      return { kind: r.kind, hit: m[0] }
    }
    return null
  }

  /**
   * 这句是不是**在重复我刚说过的内容**？（2026-11-04）
   *
   * 只做「内容重复」判断，不做语义相似 —— 判据全都收得很紧：
   *   · 归一化后完全相同
   *   · 一方包含另一方（≥6 字）
   *   · 开头 ≥8 字相同（复读通常连开头都一样）
   *   · 二元组 Jaccard ≥ 0.6（换几个词但骨架一样的近重复）
   *
   * ⚠️ 宁可漏判，也不误杀：误判的代价是**该说话的时候不吭声**，
   *    比偶尔说重复一句更伤人。所以阈值不往下调。
   *
   * @param {string} text 这次准备发出去的正文
   * @param {object} mem  会话记忆
   * @returns {string|null} 命中的那条旧消息原文（给重写提示用）；没命中返回 null
   */
  _selfRepeatOf(text, mem) {
    const norm = (s) => String(s ?? '')
      .replace(/\[表情[^\]]*\]/g, '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。！？、；：""''‘’“”（）()《》〈〉…—～·,.!?;:"'`~\-—_]/g, '')
    const raw = String(text ?? '').trim()
    if (!raw || /^\[表情/.test(raw)) return null
    const cur = norm(raw)
    if (cur.length < 4) return null

    const mine = mem.recent(24)
      .filter((m) => m.isMe)
      .map((m) => ({ raw: String(m.text ?? ''), s: norm(m.text) }))
      .filter((x) => x.s.length >= 4)
      .slice(-3)

    const bigrams = (s) => {
      const set = new Set()
      for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
      return set
    }

    for (const prev of mine) {
      if (prev.s === cur) return prev.raw
      if (cur.length >= 6 && prev.s.includes(cur)) return prev.raw
      if (prev.s.length >= 6 && cur.includes(prev.s)) return prev.raw
      const head = Math.min(10, cur.length, prev.s.length)
      if (head >= 8 && cur.slice(0, head) === prev.s.slice(0, head)) return prev.raw
      const a = bigrams(cur)
      const b = bigrams(prev.s)
      if (a.size >= 4 && b.size >= 4) {
        let inter = 0
        for (const g of a) if (b.has(g)) inter++
        const j = inter / (a.size + b.size - inter)
        if (j >= 0.6) return prev.raw
      }
    }
    return null
  }

  _checkSuperseded(msg, mem, opts = {}) {
    const minNew = Number(opts.minNew ?? 2)
    const scope = String(msg?.scope ?? 'unknown')

    /**
     * ⚠️ **私聊永远不过时**（2026-10-23 补，实测踩过）。
     *
     * 过时检测的前提是「群聊里话题可能被岔开、别人可能替它答了」。
     * 私聊里根本不存在这种情况：
     *
     *   · 所有消息都是**对我一个人说的**，没有"别人在聊"
     *   · 用户连发几条是常态（补充、追问、改口）
     *   · 丢弃回复 = 用户看到「问了它不理我」
     *
     * 实测（tests/_probe-private.mjs）：私聊连发 3 条，
     * 第一条被判 superseded 丢掉，只剩 2 条回复。
     * 越活跃的用户越容易被丢消息 —— 纯粹误伤。
     *
     * 判据优先用 `msg.kind`，缺失时退回 scope 前缀。
     */
    const kind = msg?.kind ?? (scope.startsWith('private:') ? 'private' : (scope.startsWith('group:') ? 'group' : ''))
    if (kind === 'private') return null

    // 本条的入站序号：优先用调用方传的（_handle 里一定知道），
    // 否则按 messageId 反查 —— 兼容直接调用（如测试）。
    let seq = Number(opts.afterSeq)
    if (!Number.isFinite(seq)) {
      const myId = msg?.messageId != null ? String(msg.messageId) : null
      const rec = this._inbound?.get(scope)
      const hit = myId && rec ? rec.entries.find((e) => e.messageId === myId) : null
      if (!hit) return null        // 查不到序号 → 无法判断，宁可不过时
      seq = hit.seq
    }

    const newer = this._inboundAfter(scope, seq)
    if (newer.length < minNew) return null

    // 有人提到我 / 引用我 → 这个答案还有人在等，照常发
    for (const e of newer) {
      if (e.mentionsMe) return null
      // 引用的如果是**我的回复**，说明在追问我
      // （e.replyTo 指向自己那条消息也算：他在追问自己刚问的那句）
      if (e.replyTo != null && (e.replyTo === (msg?.messageId != null ? String(msg.messageId) : null))) return null
      if (e.replyTo != null && this._isMyReplyId(scope, e.replyTo)) return null
    }

    return { count: newer.length }
  }

  /**
   * 这个 messageId 是不是**我发出去的**回复？
   *
   * 用途：判断后续消息里的引用回复是不是在追问我。
   * 我自己发的消息 id 记在 mem 里（isMe 那条的 id）。
   *
   * @param {string} scope
   * @param {string} id
   * @returns {boolean}
   */
  _isMyReplyId(scope, id) {
    if (!this._myReplyIds) this._myReplyIds = new Map()
    const set = this._myReplyIds.get(String(scope))
    return Boolean(set && set.has(String(id)))
  }

  /**
   * 记下自己发出的回复 id（按 scope 分组）。
   *
   * 只需要最近一小段：过时检测只看「我这条之后」的消息，
   * 而它们能引用到的我的回复必然是最近的。
   *
   * @param {string} scope
   * @param {string[]} ids
   */
  _rememberMyReplyIds(scope, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return
    if (!this._myReplyIds) this._myReplyIds = new Map()
    const key = String(scope ?? 'unknown')
    let set = this._myReplyIds.get(key)
    if (!set) { set = new Set(); this._myReplyIds.set(key, set) }
    for (const id of ids) {
      if (id != null) set.add(String(id))
    }
    // 只留最近 50 个
    if (set.size > 50) {
      const arr = [...set]
      this._myReplyIds.set(key, new Set(arr.slice(arr.length - 50)))
    }
  }

  /** 组装场景描述（群名走缓存）。 */
  async sceneOf(msg) {
    if (msg.kind !== 'group') return { kind: 'private', userId: msg.userId }
    return { kind: 'group', groupId: msg.groupId, groupName: await this.groupName(msg.groupId) }
  }

  /**
   * 从近期记忆里归纳「这个群里都有谁」（id + 显示名）。
   *
   * 用途：决策层判断「当前这句话是不是在跟**别的群友**说」。
   * 例：机器人答完话，小红说「你今天怎么了？」—— 「你」指的是另一个
   * 群友，不是机器人。要识别这一点，得先知道群里有哪些名字。
   *
   * ⚠️ 只从**已有记忆**归纳，不额外调协议端接口：
   *    · 零成本、零延迟
   *    · 名字本来就在消息里（senderName），够用
   *    · 名单会随记忆窗口自然滚动，不会无限增长
   *
   * @param {object} mem ConversationMemory
   * @returns {Array<{id:string,name:string}>}
   */
  _knownPeers(mem) {
    const out = []
    const seen = new Set()
    for (const m of mem.recent(30)) {
      if (m.isMe) continue
      const id = String(m.sender ?? '')
      const name = String(m.senderName ?? '').trim()
      // 名字太短容易误伤（「甲」「乙」这种单字），也认不出什么
      if (name.length < 2 || seen.has(id)) continue
      // 名字等于机器人自己的名字 → 不是在叫别人
      if (this.selfName && name === this.selfName) continue
      seen.add(id)
      out.push({ id, name })
    }
    return out
  }

  /** 调 LLM 生成回复。 */
  /**
   * @param {object} [extraBlocks] 外面塞进来的图块（浏览器截图那种，见 `_collectImages`）
   * @param {string} [extraNote]   外面塞进来的注记（"看完车牌内页"补发时用）
   */
  /**
   * 带「过时就别等了」的生成（2026-11-04）。
   *
   * ## 为什么
   * 原来只在生成**开始前**和**结束后**各查一次过时。生成本身要 10~90 秒，
   * 一旦上游慢，这段时间群里早就翻篇了 —— 等到结果再丢，白等、白花钱，
   * 而且用户看到的是"半天没动静"。
   *
   * 实测（15:14:23）：一条表情包生成到 15:15:57 才回来，群里已说 4 条，
   * 直接丢弃。那 94 秒她**既没回、也没做别的**。
   *
   * ## 做法
   * 生成期间每 500ms 复查一次过时判据（判据完全复用 `_checkSuperseded`，
   * 语义不变）；一命中就**不再等**，返回 `{ __stale: true }` 让调用方当沉默处理。
   *
   * ⚠️ 底层请求不会真的被 abort（上游没有 signal 契约），只是**我们不等了**。
   *    代价是这一轮 token 照花 —— 但用户不用再多等一分钟。
   * ⚠️ 私聊不这么干：私聊没有"话题被岔开"这回事，等多久都得回。
   *
   * @returns {Promise<object|null>} 正常返回 `_generate` 的结果；过时返回 `{__stale:true,count,waitedMs}`
   */
  async _generateGuarded(msg, mem, scene, self, seq, extraBlocks = null, extraNote = '') {
    const t0 = Date.now()
    const genP = this._generate(msg, mem, scene, self, extraBlocks, extraNote)
      .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

    const scope = String(msg?.scope ?? '')
    if (!scope.startsWith('group:')) {
      const r = await genP
      if (!r.ok) throw r.e
      return r.v
    }

    let timer = null
    const staleP = new Promise((resolve) => {
      timer = setInterval(() => {
        // 生成期间群里可能又来了一堆；判据和发送前那道闸完全一致
        const s = this._checkSuperseded(msg, mem, { afterSeq: seq })
        if (s) resolve({ ok: true, __stale: true, count: s.count, waitedMs: Date.now() - t0 })
      }, 500)
      /*
       * ⚠️ 这里**不要** unref。第一版 unref 了，测试里 `await` 的 promise
       *    还没 settle，事件循环就没别的 ref 句柄了 → Node 直接退出，
       *    报 "unsettled top-level await"。线上有别的句柄兜着看不出来，
       *    但那说明这个定时器"随时可能不被调度"，本来就不该这么写。
       *
       * 不会泄漏：race 一有结果（正常返回 / 过时 / 抛错）下面立刻 clearInterval。
       */
    })

    const r = await Promise.race([genP, staleP])
    if (timer) clearInterval(timer)
    if (r.__stale) return r
    if (!r.ok) throw r.e
    return r.v
  }

  /**
   * ★ 链接「渲染兜底」的内存缓存（2026-11-04）。
   *
   * 只在内存里、最多留 24 小时、最多 20 条 —— 用户的原话：
   * 「小黑盒没必要吧，东西都是一次性的，缓存最多也就一天」。
   */
  _linkRenderCache() {
    if (!this._linkRendered) this._linkRendered = new Map()
    return this._linkRendered
  }

  _cachedRenderedPreview(url) {
    const key = String(url ?? '')
    if (!key) return null
    const rec = this._linkRenderCache().get(key)
    if (!rec) return null
    if (Date.now() - rec.at > 24 * 3600 * 1000) {
      this._linkRenderCache().delete(key)
      return null
    }
    return rec.preview
  }

  /**
   * 后台用无头浏览器渲染一次这个链接（快路失败时调）。
   * 同一 URL 只跑一份；成功进缓存，下一轮/追问时直接用。
   */
  _scheduleLinkRender(url) {
    const key = String(url ?? '')
    if (!key) return
    if (this.cfg.linkPreview?.render === false) return
    if (this._cachedRenderedPreview(key)) return
    if (!this._linkJobs) this._linkJobs = new Map()
    if (this._linkJobs.has(key)) return
    const run = async () => {
      try {
        const preview = await fetchLinkPreviewRendered(key, {
          log: (lv, msg) => this.log[lv]?.(msg),
          profileDir: this.cfg.home ? path.join(this.cfg.home, 'browser-profile') : undefined,
        })
        if (preview) {
          this._linkRenderCache().set(key, { at: Date.now(), preview })
          while (this._linkRenderCache().size > 20) {
            this._linkRenderCache().delete(this._linkRenderCache().keys().next().value)
          }
          this.log.info?.(`bridge：链接渲染兜底 ✅ ${String(preview.title ?? '').slice(0, 40)} — ${key.slice(0, 60)}`)
        } else {
          this.log.info?.(`bridge：链接渲染兜底 ✗ 仍然没内容 — ${key.slice(0, 60)}`)
        }
      } catch (e) {
        this.log.warn?.(`bridge：链接渲染兜底出错 — ${String(e?.message ?? e).slice(0, 80)}`)
      } finally {
        this._linkJobs.delete(key)
      }
    }
    // ⚠️ 同一个持久 profile 只能有一个浏览器实例 → 渲染任务串行排队
    const prev = this._linkRenderQueue ?? Promise.resolve()
    const job = prev.then(run, run)
    this._linkRenderQueue = job
    this._linkJobs.set(key, job)
    void job
  }

  /* ── 场景续写（私聊暧昧）─────────────────────────────────────── */

  /** 配置：reply.sceneContinue = { enabled, delayMs, maxTurns }（缺省 5 秒 / 2 次）,）。 */
  _sceneContinueCfg() {
    const c = this.cfg.reply?.sceneContinue ?? {}
    return {
      enabled: c.enabled !== false,
      delayMs: Number(c.delayMs) || 5_000,
      maxTurns: Number.isFinite(Number(c.maxTurns)) ? Number(c.maxTurns) : 2,
    }
  }

  _cancelSceneContinue(scope) {
    const key = String(scope ?? '')
    const t = this._sceneTimers?.get(key)
    if (t) { try { clearTimeout(t) } catch { /* ignore */ } ; this._sceneTimers.delete(key) }
  }

  /**
   * 最近几条像不像"**正在场景里**"。
   *
   * ⚠️ 2026-11-05 收紧：原来只要 10 条里有 2 处亲密词/动作括号就放行 ——
   *    于是她正躺在床上，他随口问一句吃饭/游戏，续写照样触发，
   *    把日常话题也拽回床上（用户：「她好容易进入状态」）。
   *    现在要求：**他最后一条自己就带亲密内容**，且最近有她的动作描写。
   */
  _looksIntimate(mem) {
    const recent = mem?.recent?.(10) ?? []
    if (recent.length < 2) return false
    const INTIMATE = /(摸|抱|亲|吻|脱|床|被|腿|腰|胸|身体|贴|蹭|喘|湿|下面|进来|要我|想要|躺)/
    const lastUser = [...recent].reverse().find((m) => !m?.isMe)
    if (!lastUser || !INTIMATE.test(String(lastUser.text ?? ''))) return false
    const hasBracket = (t) => /[（(][^）)]{2,}[）)]/.test(String(t ?? ''))
    return recent.some((m) => m?.isMe && hasBracket(m.text))
  }

  _armSceneContinue(msg, mem, scene, self) {
    const cfgS = this._sceneContinueCfg()
    if (!cfgS.enabled) return
    const scope = String(msg?.scope ?? '')
    if (!scope.startsWith('private:')) return
    if (!this._looksIntimate(mem)) return
    if (!this._sceneState) this._sceneState = new Map()
    const st = this._sceneState.get(scope) ?? { turns: 0 }
    if (st.turns >= cfgS.maxTurns) return
    this._cancelSceneContinue(scope)
    if (!this._sceneTimers) this._sceneTimers = new Map()
    const userId = scope.slice('private:'.length)
    const timer = setTimeout(() => {
      this._sceneTimers?.delete(scope)
      // ★ 还在打字就别推进；1.5 秒后再看（QQ 只有「正在输入」推送）
      if (this._isTyping?.(userId, 2500)) {
        this._armSceneContinue(msg, mem, scene, self)
        return
      }
      void this._sceneContinue({ msg, mem, scene, self, st })
    }, cfgS.delayMs)
    timer.unref?.()
    this._sceneTimers.set(scope, timer)
  }

  async _sceneContinue({ msg, mem, scene, self, st }) {
    try {
      const note = [
        '## 他 5 秒没打字了',
        '你们正停在刚才那一步。用一两句**从你自己的身体/状态写下去**（动作照旧放括号里，但**必须有一句台词**），',
        '然后**主动把他往下带**（你开口要、你伸手、你催他）——',
        '不要问他「想干嘛」、不要把球踢回去，也不要重复你上一句。',
      ].join('\n')
      const gen = await this._generate(msg, mem, scene, self, null, note)
      const text = String(gen?.text ?? '').trim()
      if (!text || /^\s*\[SILENT\]\s*$/i.test(text)) { st.turns = 99; return }
      await this._send(msg, text, gen?.cover ?? null)
      this.stats.replied++
      mem.push(makeMessage({
        sender: this.selfId ?? '0',
        senderName: this.selfName,
        text: msg.__sentText ?? text,
        at: Date.now(),
        isMe: true,
        provider: this._lastRoute?.provider ?? null,
        model: this._lastRoute?.model ?? null,
      }))
      st.turns += 1
      this.log.info?.(`bridge/scene：他 10 秒没说话 → 她主动续写（第 ${st.turns} 次）「${text.slice(0, 80)}」`)
      if (st.turns < this._sceneContinueCfg().maxTurns) this._armSceneContinue(msg, mem, scene, self)
    } catch (e) {
      this.log.warn?.(`bridge/scene：续写失败 — ${String(e?.message ?? e).slice(0, 80)}`)
    }
  }

  /* ── 冷场兜底（群）────────────────────────────────────────── */

  /** 配置：reply.deadAir = { enabled, delayMs, minGapMs }（缺省 8s / 5min）。 */
  _deadAirCfg() {
    const c = this.cfg.reply?.deadAir ?? {}
    return {
      enabled: c.enabled !== false,
      delayMs: Number(c.delayMs) || 8_000,
      minGapMs: Number(c.minGapMs) || 300_000,
    }
  }

  _cancelDeadAir(scope) {
    const key = String(scope ?? '')
    const t = this._deadAirTimers?.get(key)
    if (t) { try { clearTimeout(t) } catch { /* ignore */ } ; this._deadAirTimers.delete(key) }
  }

  _armDeadAir(msg, mem, scene, self) {
    const c = this._deadAirCfg()
    if (!c.enabled) return
    if (String(msg?.kind ?? '') !== 'group') return
    const scope = String(msg?.scope ?? '')
    if (!this._deadAirTimers) this._deadAirTimers = new Map()
    if (!this._deadAirLastAt) this._deadAirLastAt = new Map()
    const last = this._deadAirLastAt.get(scope) ?? 0
    if (Date.now() - last < c.minGapMs) return
    this._cancelDeadAir(scope)
    const baseAt = Number(msg?.at ?? Date.now())
    const timer = setTimeout(() => {
      this._deadAirTimers?.delete(scope)
      // 这期间有人说话了 → 场子没冷，不用她补
      const lastMsg = (mem?.recent?.(1) ?? [])[0]
      if (lastMsg && Number(lastMsg.at ?? 0) > baseAt) return
      this._deadAirLastAt.set(scope, Date.now())
      void this._deadAirSpeak({ msg, mem, scene, self })
    }, c.delayMs)
    timer.unref?.()
    this._deadAirTimers.set(scope, timer)
  }

  async _deadAirSpeak({ msg, mem, scene, self }) {
    try {
      const note = '## 冷场了\n'
        + '刚才那句没人接，群里静下来了。你**接一句短的**，把这口气续上：\n'
        + '- 顺着刚才最后一句往下说，别另起话题；\n'
        + '- 一两句、口语，可以带一个很短的动作/情绪；\n'
        + '- 如果刚才那句是别人的私事、工作汇报或者争吵，就别硬接，回 [SILENT]。'
      const gen = await this._generate(msg, mem, scene, self, null, note)
      const text = String(gen?.text ?? '').trim()
      if (!text || /^\s*\[SILENT\]\s*$/i.test(text)) return
      await this._send(msg, text, gen?.cover ?? null)
      this.stats.replied++
      mem.push(makeMessage({
        sender: this.selfId ?? '0',
        senderName: this.selfName,
        text: msg.__sentText ?? text,
        at: Date.now(),
        isMe: true,
        provider: this._lastRoute?.provider ?? null,
        model: this._lastRoute?.model ?? null,
      }))
      this.log.info?.(`bridge/deadair：沉默后 8 秒没人接 → 她补了一句「${text.slice(0, 60)}」`)
    } catch (e) {
      this.log.warn?.(`bridge/deadair：补话失败 — ${String(e?.message ?? e).slice(0, 80)}`)
    }
  }

  /**
   * 最近群里发生了什么 —— 给**私聊**用。
   *
   * 私聊和群聊各存一份短期记忆，所以她私下说话时完全不知道群里刚才聊了啥
   * （用户：「私聊的她不知道群聊发生了什么」）。这里把最近 30 分钟、
   * 最多 2 个群的 10 条消息压成几行挂进私聊提示词。
   *
   * ⚠️ 只给私聊；群里不用（群里本来就在场）。也**不落盘**，纯提示词。
   */
  _recentGroupDigest(maxAgeMs = 30 * 60_000, maxGroups = 2, maxMsgs = 10) {
    try {
      const keys = (this.memory?.scopes?.() ?? []).filter((k) => String(k).startsWith('group:'))
      if (!keys.length) return ''
      const blocks = []
      for (const k of keys) {
        const mem2 = this.memory.get(k)
        const msgs = (mem2?.recent?.(maxMsgs) ?? [])
          .filter((m) => Date.now() - Number(m.at ?? 0) <= maxAgeMs)
        if (!msgs.length) continue
        const lines = msgs.map((m) => {
          const who = m.isMe ? '我' : String(m.senderName || m.sender || '某人')
          const body = String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 40)
          return `${who}：${body}`
        })
        blocks.push({ key: k, ageMs: Date.now() - Number(msgs[msgs.length - 1].at ?? 0), lines })
      }
      if (!blocks.length) return ''
      blocks.sort((a, b) => a.ageMs - b.ageMs)
      const head = '## 群里刚发生的事（你也在群里；私下说话时知道就行，别主动搬过去）'
      return [head, ...blocks.slice(0, maxGroups).map((b) => {
        const mins = Math.max(1, Math.round(b.ageMs / 60_000))
        return `群 ${String(b.key).slice(6)}（${mins} 分钟前）：` + b.lines.map((l) => `- ${l}`).join('\n')
      })].join('\n')
    } catch { return '' }
  }

  /**
   * 群里「没头没尾的开场」提示：纯标点、≤4 字且不是问句、纯表情。
   *
   * 用户原话：「发一张表情或者莫名其妙的话开场她不用接」
   * 「就比如说我刚刚发的马上」「她就可用扣「?」或者同类的表情」。
   * 所以不是禁回，而是**只回一个「？」或一个表情**，别写正文。
   */
  _groupNoiseHint(msg, mem) {
    if (String(msg?.kind ?? '') !== 'group') return ''
    const selfId = this.selfId ?? ''
    if (selfId && typeof msg.isAtMe === 'function' && msg.isAtMe(selfId)) return ''
    const raw = String(msg.text ?? '')
    if (/鱼|鲸|大肥鱼|本鱼|本鲸/.test(raw)) return ''
    const recentAll = mem?.recent?.(6) ?? []
    if (msg.replyTo && recentAll.some((m) => m?.isMe && String(m.id ?? '') === String(msg.replyTo))) return ''
    const t = raw.replace(/\[[^\]]*\]/g, '').trim()
    const isSticker = !t && /\[表情/.test(raw)
    const isPunct = /^[?？!！.。,，、…~～\s]+$/.test(t)
    const isShort = t.length > 0 && t.length <= 4 && !/[?？吗呢吧什么怎么为啥哪谁]/.test(t)
    if (!isSticker && !isPunct && !isShort) {
      // 说了点实的东西 → 解除"停手"
      this._noiseHold?.delete(String(msg?.scope ?? ''))
      return ''
    }
    /*
     * ★ 没头没尾的话要"少说、别猜"（2026-11-05 用户三条口径）：
     *   · 「发一张表情或者莫名其妙的话开场她不用接」
     *   · 「她就可用扣「?」或者同类的表情」
     *   · 「她也可以主动问」「不一定要等别人」
     *   → 第一句可以「？」/表情/**短追问**；2 分钟内再来一句，最多再问一次，
     *     不猜、不编上下文、不连问。
     */
    const scopeKey = String(msg?.scope ?? '')
    if (!this._noiseHold) this._noiseHold = new Map()
    const last = this._noiseHold.get(scopeKey) ?? 0
    if (Date.now() - last < 120_000) {
      return '## 他这句还是没头没尾\n'
        + '你已经回过一次了。这次**要么不出声（输出 [SILENT]），要么只问一句很短的**\n'
        + '（「怎么了？」「啥意思？」「哪件事？」）—— 别猜、别编上下文、别连问两遍。'
    }
    this._noiseHold.set(scopeKey, Date.now())
    return '## 他这句没头没尾\n'
      + '（他发的是表情，或者一句没头没尾的话，比如「马上」「。。」「？」）\n'
      + '**最多回一个「？」、一个表情（[表情:数字] / [表情包]），或者一句很短的追问**\n'
      + '（「怎么了？」「啥意思？」「你说的哪件事？」）—— 别展开猜、别写长句、别编上下文。\n'
      + '★ 说完就停：等他把话说清楚再接；他要是不说，也别追着问第二遍。'
  }

  /**
   * 重连补历史：断连那几秒漏掉的消息，从 NapCat 拉回来补进短期记忆。
   *
   * ⚠️ **只进记忆、不触发回复** —— 否则重连后会把几条旧消息挨个回一遍。
   * 用户实测：12:25:56 表情 / 12:26:01「依旧吃面」正好落在重启窗口，鲸舱没收到。
   */
  async _backfillHistory(count = 12) {
    if (this.cfg.reply?.backfillOnOpen === false) return
    try {
      const scopes = (this.memory?.scopes?.() ?? []).slice(0, 6)
      let added = 0
      for (const sc of scopes) {
        const isGroup = String(sc).startsWith('group:')
        const id = isGroup ? String(sc).slice(6) : String(sc).slice('private:'.length)
        if (!id || !this.onebot?.callHttp) continue
        try {
          const action = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history'
          const params = isGroup ? { group_id: Number(id), count } : { user_id: Number(id), count }
          const res = await this.onebot.callHttp(action, params, 8000)
          const list = res?.data?.messages ?? res?.messages ?? []
          if (!Array.isArray(list) || !list.length) continue
          const mem = this.memory.get(sc)
          const known = new Set((mem?.recent?.(40) ?? []).map((m) => String(m.id ?? '')))
          for (const m of list) {
            const mid = String(m.message_id ?? m.real_id ?? '')
            if (!mid || known.has(mid)) continue
            mem.push(makeMessage({
              id: mid,
              sender: String(m.user_id ?? m.sender?.user_id ?? ''),
              senderName: String(m.sender?.card || m.sender?.nickname || ''),
              text: String(m.raw_message ?? '').replace(/\[CQ:[^\]]*\]/g, '[图片]'),
              at: Number(m.time ?? 0) * 1000 || Date.now(),
              isMe: String(m.user_id ?? m.sender?.user_id ?? '') === String(this.selfId ?? ''),
            }))
            known.add(mid)
            added++
          }
        } catch { /* 单个会话失败不影响其它 */ }
      }
      if (added) this.log.info?.(`bridge：重连补历史 ${added} 条（只进记忆，不回复）`)
    } catch (e) {
      this.log.warn?.(`bridge：补历史失败 — ${String(e?.message ?? e).slice(0, 80)}`)
    }
  }

  async _generate(msg, mem, scene, self, extraBlocks = null, extraNote = '', attempt = 0) {
    const long = this.longMemory?.get(msg.scope)
    const memoryText = long?.toPrompt() ?? ''

    /*
     * ★ **我最近说过的话**（2026-11-01，参考 dsh-bili-scroll 的章程）。
     *
     * ## 为什么单独拎出来
     * 参考实现里有一句注释说得很准：
     * > 把「它自己以前发过的评论」喂进去 —— 没有这段，它每轮都从零开始，
     * > 自然每条都往"平均腔调"上靠（那就是八股）。
     * > 有这段它才会长出自己的口癖、并避开重复开头。
     *
     * 我们的历史消息里虽然有它自己的话，但**模型不会主动去对比**。
     * 单独列一小段「你刚才说过」+ 一句"别用相同的开头/句式"，
     * 才是它长出口音、不重复的关键。
     *
     * 只取 **3 条**（多了反而变成模板去模仿）。
     */
    const recentSelf = mem
      .recent(24)
      .filter((m) => m.isMe)
      .map((m) => String(m.text ?? '').trim())
      .filter((t) => t && t !== '[SILENT]' && !/^\[表情/.test(t))
      .slice(-3)

    /*
     * 人物档案：当前说话人优先，其余按最近活跃补几个。
     *
     * 只带「有实际内容（印象或事实）」的人 —— 刚加进来还没沉淀的
     * 不该占 prompt。上限 6 人，大约 200-300 字。
     *
     * ⚠️ 跨群共享：档案不按会话隔离（同一个人在群里和私聊是同一个人），
     *    但**只带高度概括的印象/事实，不带原始对话** —— 原始对话留在
     *    各会话自己的记忆里，不会因为这个机制串到别的群。
     */
    let peopleText = ''
    try {
      peopleText = this.people?.toPrompt?.({ self: msg.sender, limit: 6 }) ?? ''
    } catch (e) {
      this.log.debug?.(`bridge：人物档案注入失败（跳过）：${String(e?.message ?? e)}`)
    }

    /*
     * ★ **今天记着的事**（2026-11-04）。
     *
     * 事件记忆层：短期 30 条记不住、摘要又只写"人是什么样"，
     * 中间那段「他答应了什么 / 我欠他什么」用这一段补上（见 `memory/events.js`）。
     *
     * ⚠️ 只注入**还活着的**（强度 ≥ 冻结线），而且**带相对时间** ——
     *    不然她会把三天前的事当成刚发生（这是最像机器人的地方之一）。
     *
     * ⚠️ 同步调用、失败一律吞掉：记忆是加分项，不能因为它让这条回复发不出去。
     */
    let eventsText = ''
    try {
      eventsText = this.events?.toPrompt?.(msg.scope) ?? ''
    } catch (e) {
      this.log.debug?.(`bridge：事件记忆注入失败（跳过）：${String(e?.message ?? e)}`)
    }

    // ── 联网搜索（只在"需要新信息"时才查）─────────────────────
    //
    // 为什么需要：各免费渠道的模型训练数据都有截止日期。实测踩过 ——
    // 群里发了「GPT-6 Luna 已开放」的截图，机器人回「这图一眼假，纯段子」，
    // 而 GPT-6 Luna 确实存在（连它自己的模型库里都有）。
    //
    // ⚠️ 不能每条都搜：一次 5~15 秒，群聊里绝大多数是闲聊。
    //    触发判断在 search.js 的 needsFreshInfo()，收得比较紧。
    let searchContext = ''
    /*
     * ★ 梗百科的词条（2026-11-03）。命中就进上下文，**并且这次不联网搜** ——
     * 用户要的「本地优先 + 联网兜底」就是这么分工的（详见 `_memeHint`）。
     */
    let memeContext = ''
    try {
      const m = this._memeHint?.(msg.text)
      if (m) {
        memeContext = m.text
        this._lastMeme = { at: Date.now(), query: m.query, title: m.title }
      }
    } catch { /* 静默 —— 词库是加分项，不该影响回复 */ }
    /*
     * ★ **B 站分享链接 → 免费抓元信息**（2026-10-31）。
     *
     * 之前她只看到 `【标题】https://...` 一串文字，**不点、也不搜**（`needsFreshInfo`
     * 要求「时效词+疑问词」同时命中，B 站分享基本命中不了），只能从标题猜。
     *
     * B 站 `x/web-interface/view` 接口**免费、免登录**（实测 code=0），
     * 能拿到 标题/UP主/时长/播放/简介 —— 足够她判断"这视频大概讲什么"。
     *
     * ⚠️ **字幕拿不到**（匿名 `player/v2` 的 `subtitles` 恒为 0 条，要登录态），
     *    所以**不承诺"看过内容"**；`formatVideoContext` 里明确写了
     *    「你没看过这个视频，别编」。
     *
     * 失败静默：拿不到就当没有，绝不因为一个外链拖垮整条回复。
     */
    let biliContext = ''
    /** "看画面"模式下 B 站分镜图（`_biliContext` 带出来的）；没开就是 null */
    let biliShots = null
    try {
      const bili = await this._biliContext(String(msg.text ?? ''))
      biliContext = bili.ctx
      biliShots = bili.shots ?? null
      /*
       * 长视频会在这里挂一个**后台转写任务**，交给 `_handle` 在回复发完之后补发
       * （见 `_videoFollowUp`）。
       *
       * ⚠️ 为什么用「按 scope 存」而不是从返回值带出去：`_generate` 的返回值是**文本**，
       *    塞不进第二个东西；而同一会话的 `_handle` 是**串行**的（见 `_queues`），
       *    所以按 scope 存不会串会话。
       */
      if (bili.job) {
        if (!this._videoJobs) this._videoJobs = new Map()
        this._videoJobs.set(String(msg.scope ?? ''), bili.job)
      }
    } catch { /* 静默 */ }
    /*
     * ★★ A：**非 B 站的链接也真去打开看看**（2026-11-02）。
     *
     * ## 原来什么样
     * 只有 B 站会去抓（`_biliContext` 第一行就是 `if (!hasBiliLink(text)) return`）。
     * 别的站：
     *   · 分享卡片**带标题** → 她只读到**消息里那行文字**（那是腾讯加的卡片标题，
     *     不是网页内容）
     *   · **裸链接**         → 什么都看不到
     * 用户实测问「现在分享一个链接…她能去看吗」→ 除了 B 站都不行。
     *
     * ## 现在
     * 抓 `og:title` / `og:description` / `og:site_name`，
     * 没有 og 标签的站退而取**正文头几百字**。
     * 实测：小黑盒 377ms、知乎 440ms、example.com 1351ms，都能拿到标题+描述。
     *
     * ## 三条约束（都写在 link-preview.js 里了）
     * ① 超时 3.5s —— **宁可拿不到，也不让回复卡住**（用户不喜欢额外延迟）
     * ② 只读前 400KB（og 标签一定在 head 里）
     * ③ 失败返回 null，不抛错
     *
     * ⚠️ **抓不到时必须明说"打不开"**，不能留空让模型拿标题硬猜 ——
     *    历史上它编过「点开想学修电脑」（标题/评论里一个字都没有）。
     */
    let linkContext = ''
    if (!biliContext) {
      const url = extractLink(String(msg.text ?? ''))
      if (url) {
        // ★ 先看有没有上次渲染兜底的结果（24h 内），有就直接用
        const cached = this._cachedRenderedPreview(url)
        if (cached) {
          linkContext = formatLinkContext(cached)
          this.log.info?.(`bridge：链接预览（渲染缓存）✅ ${String(cached.title ?? '').slice(0, 40)} — ${url.slice(0, 60)}`)
        } else {
          try {
            const preview = await fetchLinkPreview(url)
            linkContext = formatLinkContext(preview)
            this.log.info?.(
              `bridge：链接预览 ${preview ? `✅ ${preview.title.slice(0, 40)}` : '✗ 打不开'} — ${url.slice(0, 60)}`,
            )
            // 快路拿不到 → 后台开浏览器渲染一次（不阻塞这条回复）
            if (!preview) this._scheduleLinkRender(url)
          } catch {
            /* 静默：预览是锦上添花；同时排一次渲染兜底 */
            this._scheduleLinkRender(url)
          }
        }
      }
    }

    /*
     * ★★ **链接资料留一份**（2026-11-04）。
     *
     * ## 修的是什么
     * 13:35:58 程序明明抓到了 `BV1o44N6VEWo` 的标题 / 5 条评论 / 10 条弹幕 / 分镜图
     * （日志有），可 13:37:08 有人追问「不是又发了一个吗」——
     * 她回的是「刚那个链接？我没点开看，又是啥」。
     *
     * 因为这份资料是**这一轮临时拼的 facts**：只在触发它的那条消息里存在，
     * 不进记忆。下一轮追问时，上下文里只剩
     * 「【哔哩哔哩】https://b23.tv/dhcf5hl?share_mediu」（被截断的裸链接）。
     *
     * 所以按会话留一份，追问时（没带新链接）重新挂上 —— 有 6 分钟有效期，
     * 过期或者带了新链接就覆盖。
     */
    const scopeKey = String(msg.scope ?? '')
    const linkText = String(biliContext || linkContext || '').trim()
    if (linkText) {
      if (!this._linkFacts) this._linkFacts = new Map()
      this._linkFacts.set(scopeKey, { at: Date.now(), text: linkText, url: extractLink(String(msg.text ?? '')) })
    } else if (!extractLink(String(msg.text ?? ''))) {
      const prev = this._linkFacts?.get(scopeKey)
      const fresh = prev && Date.now() - prev.at < 6 * 60_000
      // ★ 渲染兜底如果后来成功了，追问时优先用它（比当轮的"打不开"有用）
      const rendered = prev?.url ? this._cachedRenderedPreview(prev.url) : null
      if (rendered) linkContext = formatLinkContext(rendered)
      // 只在「像是在问那个链接」的时候挂，别把老视频塞进无关闲聊
      const looksLikeFollowUp = String(msg.text ?? '').length <= 30
        || /链接|视频|BV\s?\w{8}|b23\.tv/i.test(String(msg.text ?? ''))
      if (fresh && looksLikeFollowUp) {
        linkContext = '## 刚才那个链接（程序上一轮已经取到了，别再问"又是啥"）\n' + prev.text
      }
    }
    /*
     * ★★ B：**认出「车牌」**（2026-11-02）。
     *
     * 群里/私聊有人用代号指作品（`JM123456`），原来两条路都不通：
     *   · `JM123456` → 被 `needsFreshInfo` 当成"提到具体名字" → 拿去联网搜
     *     （搜的还是原始串）→ 垃圾结果、白花钱
     *   · 纯数字 / 「禁漫 123456」 → **连搜都不触发** → 她压根没反应
     *
     * 现在认出编号就把「这是什么」写进提示词，并且**不让它去搜索**（见下面的闸）。
     *
     * ⚠️ 措辞里必须留「看不到内容」——不然她会顺着编号硬编
     *    （历史上编过「点开想学修电脑」，标题/评论里一个字都没有）。
     */
    const code = detectCode(String(msg.text ?? ''))
    /*
     * ★★ 2026-11-02：认出车牌后**真去打开看看**（用户明确要的：
     *    「内容可以去抓吧，私聊都那样了，漫画怎么了」）。
     *
     * 实测这条链路是通的（普通 fetch，不需要浏览器）：
     *   · 作品页 `/album/<编号>` → 200、非挑战页、280KB
     *   · `og:title` 里**信息量很大**：
     *     `[汉化组][作者] 作品名 (原作) [翻译]` —— 汉化组/作者/作品名/原作全在里面
     *   · `og:description` 是**站点标语**（每部作品都一样），已在 jm.js 里丢掉
     *
     * ⚠️ 两个坑都写在 jm.js 的注释里了，这里只强调一个：
     *    **编号不存在时错误页会挂 Cloudflare 挑战** —— 我第一轮拿 `/album/1`
     *    探路，差点得出"作品页全被挡着"的错结论。
     *
     * 抓不到就退回 `formatCodeContext`（那句"我看不到内容、别猜"）——
     * 绝不能让它拿编号硬编。
     */
    let codeContext = ''
    if (code) {
      if (code.kind === 'jm') {
        try {
          const album = await fetchAlbum({
            id: code.id,
            hosts: this._jmHosts(),
            log: (lv, msg) => this.log[lv]?.(msg),
          })
          codeContext = album ? formatAlbumContext(album) : formatCodeContext(code)
          if (album) this.log.info?.(`bridge：车牌 ${code.raw} 抓到了「${album.title.slice(0, 40)}」`)
        } catch (e) {
          codeContext = formatCodeContext(code)
          this.log.warn?.(`bridge：车牌抓取出错 — ${String(e?.message ?? e).slice(0, 80)}`)
        }

        /*
         * ★★ **内页要真去看 —— 但那是 26 秒的活，扔后台**（2026-11-02）。
         *
         * 实测：开浏览器 + 开作品页 + 开阅读器 + 滚 4 屏 ≈ **26 秒**。
         * 卡在回复里等于让用户等半分钟 —— 所以照抄**长视频那套**：
         * 这一条回复照常发（带着标题），**看完内页再补一条**。
         *
         * ⚠️ 这里**只登记任务、不 await**。`void` 派出去就返回，
         *    由 `_handle` 在回复发完之后接（见 `_jmFollowUp`）。
         *    跟长视频同一个理由：**即时回复的延迟必须是 0**。
         */
        // ★ 上次看过同一本 → 把当时的印象带上，不用重新看一遍
        const memo = code.kind === 'jm' ? this._jmMemo()?.get(code.id) : null
        if (memo?.summary) {
          codeContext = [codeContext, `## 这本我上次看过（我自己记的）\n${memo.summary}`].filter(Boolean).join('\n\n')
        }

        if (this.cfg.jmRead?.enabled !== false) {
          const scope = String(msg.scope ?? '')
          if (scope) {
            if (!this._jmJobs) this._jmJobs = new Map()
            /*
             * ⚠️ **同一个会话只挂一个** —— 连着发两个车牌时，
             *    两个 26 秒的浏览器实例会互相抢（而且第二个会覆盖第一个的任务，
             *    导致第一个永远不补）。所以已有任务时直接跳过，日志说清楚。
             */
            if (this._jmJobs.has(scope)) {
              this.log.info?.(`车牌 ${code.raw}：这个会话已经有一个在看内页了，跳过`)
            } else {
              this.log.info?.(`车牌 ${code.raw}：后台开始看内页（回复先发，看完再补）`)
              this._jmJobs.set(scope, {
                id: code.id,
                at: Date.now(),
                promise: readJmPages({
                  id: code.id,
                  maxShots: Number(this.cfg.jmRead?.maxShots) || undefined,
                  log: (lv, m) => this.log[lv]?.(m),
                }).catch((e) => {
                  this.log.warn?.(`车牌 ${code.raw}：看内页出错 — ${String(e?.message ?? e).slice(0, 80)}`)
                  return { ok: false, why: 'error' }
                }),
              })
            }
          }
        }
      } else {
        codeContext = formatCodeContext(code)
      }
    }
    if (code) this.log.info?.(`bridge：认出车牌 ${code.raw}（${code.kind} 编号 ${code.id}）`)
    /** 本次回复备下的封面图（随返回值带走，避免实例变量竞态）。 */
    let pendingCover = null
    const qqCfg = this.cfg.search ?? {}
    /*
     * ★ **已经有 B 站上下文时，别再联网搜那条链接**（2026-10-31）。
     *
     * 实测事故链：
     * ```
     * 21:00:28  B站：BV1bbeY6wE9x 评论 5 条 / 弹幕 10 条   ✅ 抓到了
     * 21:00:28  bridge：需要联网（提到具体名字「https」）→ 查「【哔哩哔哩】https://b23.tv/…」
     * 21:00:30  bridge：联网：已查到 → 264 字 / 5 个来源      ← 垃圾
     * 21:00:34  我「还是没展开，短链跳不过去」                ← 被搜索带偏
     * ```
     * `needsFreshInfo` 把 **`https` 本身**当成"具体名字" → 拿短链去搜索 →
     * 当然搜不到 → 返回一堆无关内容 → 模型以为"打不开这个链接"。
     *
     * **B 站的信息已经抓到（标题/评论/弹幕），再搜一遍纯属帮倒忙。**
     *
     * ★ 2026-11-02 扩到**任何链接**：只要 `biliContext` **或** `linkContext`
     *   已经有了（B 站抓的、或者通用链接预览抓的），就**不再搜** ——
     *   页面内容已经拿到，拿 URL 去搜只会得到一堆垃圾（见上面那条事故链）。
     *   这同时也是**控成本**：一次搜索约 ¥0.02，能省就省。
     *
     * ★★ C：**三条"不值得搜"的闸**（2026-11-02，用户要求「别乱搜…控制成本」）
     *
     * ① **消息里有链接** → 不搜。哪怕预览**抓失败了**也不搜 ——
     *    把 URL 丢给搜索引擎从来搜不出这页的内容，只会返回一堆无关结果把模型带偏
     *    （上面那段事故链就是这么来的）。
     * ② **认出了车牌编号** → 不搜。搜「JM123456」搜不出内容，
     *    只是把**用户发的编号**白送给搜索引擎（跟之前"私密内容被搜出去"同一类问题）。
     * ③ 其余照旧走 `needsFreshInfo` 判定。
     */
    const hasAnyUrl = Boolean(extractLink(String(msg.text ?? '')))
    const skipSearch = Boolean(biliContext) || Boolean(linkContext) || hasAnyUrl || Boolean(code)
    if (skipSearch && qqCfg.enabled !== false && this.searchKey) {
      this.log.info?.(
        `bridge：跳过联网搜索（${biliContext || linkContext ? '页面已抓到'
          : hasAnyUrl ? '消息里有链接'
            : '认出车牌编号'}）`,
      )
    }
    /*
     * ★★ **`!memeContext` —— 梗库命中就不再联网搜**（2026-11-03）。
     *
     * 用户原话：「这个能让她更好接梗，**我们还可以保留联网搜索兜底**」。
     * 分工就是这个：
     * ```
     *   梗库命中 → 词条已经在上下文里了，**再搜就是白花钱**（一次 ≈ ¥0.0074）
     *   梗库没收录 → 不拦，走这条联网路 ✓（新梗天天有，6668 条盖不全）
     * ```
     * ⚠️ **只是"跳过搜索"，不是"跳过这轮"** —— 回复照常生成，只是不查网了。
     */
    if (qqCfg.enabled !== false && this.searchKey && !skipSearch && !memeContext) {
      const hit = needsFreshInfo(msg.text)
      if (hit.need) {
        /*
         * ⚠️ **每天限额检查**（2026-11-01 加）。
         *
         * 用户问「每天限额搜索是不是没有生效」—— 查下来是**根本没这个功能**：
         * 原来的 `maxUses` 只出现在 `webSearch()` 的 JSDoc 里，零处实现。
         * 实测某天搜 12 次，配置写 3，什么都没拦。
         * 而一次搜索约 ¥0.02，没有上限就是账单没上限。
         *
         * ⚠️ `take()` 必须在**真的要搜之前**调 —— 被拦下的那次不该计数。
         */
        const quota = this.searchQuota?.check(qqCfg.maxPerDay) ?? { ok: true, used: 0, max: 0 }
        /*
         * ★ 每小时限次（2026-11-03）—— 跟日上限是**两个层级**，两个都要过。
         *   日上限是总账（省钱主力），小时限次防的是"判据发疯时一口气搜掉半天额度"。
         *   实测：一小时内连搜了 3 次「能看吗」，那种时候判据明显失灵。
         */
        const pace = this.searchPacing?.allow(qqCfg.pacing) ?? { ok: true, used: 0, max: 0 }
        if (!quota.ok) {
          this.log.warn?.(
            `bridge：搜索：今天已达上限（${quota.used}/${quota.max}），跳过「${hit.query.slice(0, 30)}」`,
          )
        } else if (!pace.ok) {
          this.log.warn?.(
            `bridge：搜索：本小时已达上限（${pace.used}/${pace.max}），跳过「${hit.query.slice(0, 30)}」`,
          )
        } else try {
          this.searchQuota?.take()
          // ⚠️ **真的要搜了才记** —— 被上面两道闸拦下的那次不该计数
          //    （跟 `take()` 同一个道理：问了一次不等于搜了一次）
          this.searchPacing?.note()
          this.log.info?.(`bridge：需要联网（${hit.why}）→ 查「${hit.query.slice(0, 40)}」`)
          const r = await webSearch({
            question: hit.query,
            apiKey: this.searchKey,
            // ⚠️ 删掉了 `maxUses` —— 那是死参数（传了没人读，见上面注释）。
            //    「取几条来源」由 `webSearch` 内部的 `count` 管（默认 3）。
            timeoutMs: qqCfg.timeoutMs ?? 20000,
            log: (m) => this.log.info?.(`bridge：${m}`),
          })
          if (r.ok) {
            searchContext = formatSearchContext(r)
            this._lastSearch = { at: Date.now(), query: hit.query, sources: r.sources.slice(0, 5), ms: r.ms }

            // 搜索成功时也顺手看一眼余额（低频，一天查几次就够）。
            // 只在**该提醒时**才设标记，避免每条消息都查接口。
            try {
              const lastCheck = this._balanceCheckedAt ?? 0
              if (Date.now() - lastCheck > 6 * 3600_000) {
                this._balanceCheckedAt = Date.now()
                const b = await checkBalance(this.searchKey, 6000)
                if (b.ok) {
                  this._balance = b
                  this._balanceLow = b.cny <= (this.cfg.search?.lowBalanceCny ?? 3)
                  if (this._balanceLow) {
                    this.log.warn?.(`bridge：搜索余额偏低 ¥${b.cny}`)
                    // 余额见底 —— 顺手讨一次（每天上限、话术不重样由 BegState 管）
                    await this._maybeBeg(msg, b.cny)
                  }
                }
              }
            } catch { /* 查不到就算了 */ }

            // 把搜索本身的 token 记进用量统计。
            //
            // ⚠️ 搜索走的是 DeepSeek 官方 key（真花钱），而聊天走免费渠道。
            //    不记这一笔的话侧栏"折合费用"会显示 0，用户以为搜索不花钱 ——
            //    实际每月几十上百次就是几十块。
            try {
              const u = r.usage ?? {}
              if ((u.in ?? 0) + (u.out ?? 0) > 0) {
                this.usage?.record?.({
                  provider: 'deepseek-official',
                  model: r.model ?? 'deepseek-flash',
                  source: 'search',
                  tokensIn: u.in ?? 0,
                  tokensOut: u.out ?? 0,
                  // ⚠️ 必须传 —— Search 接口按**次**收费（¥0.005/次），
                  //    不传的话只算 token，会低估一半以上（简单问题时
                  //    按次费比 token 费还高）。
                  searches: u.searches ?? 0,
                  ok: true,
                  ms: r.ms,
                })
                this.log.info?.(`bridge：搜索用量已记录（in=${u.in} out=${u.out}，搜了 ${u.searches} 次）`)
              }
            } catch { /* 统计失败不影响回复 */ }

            // 顺手抓一张封面图 —— 聊到具体作品/产品时，配张图比纯文字更像人。
            // 抓不到就算了（pickCoverImage 内部吞掉所有错误），不影响回复。
            if (this.cfg.search?.images !== false) {
              try {
                const img = await pickCoverImage(r.sources, { maxProbe: 3, timeoutMs: 4000 })
                if (img) {
                  pendingCover = img
                  this.log.info?.(`bridge：备好封面图 ${img.url.slice(0, 80)}`)
                }
              } catch { /* 图是锦上添花 */ }
            }
          } else {
            this.log.warn?.(`bridge：联网失败（按无联网继续）— ${r.error}`)

            // ⚠️ 搜索失败最常见的两个原因：网络不通、**余额见底**。
            //    后者以前完全是静默的 —— 用户只看到"它怎么老是不联网"，
            //    根本不知道去充值。这里查一次余额留个记号，下一条回复
            //    会顺带提一句（大肥鱼的"要 token"人格正好用上）。
            try {
              const b = await checkBalance(this.searchKey, 6000)
              if (b.ok) {
                this._balance = b
                if (b.cny <= (this.cfg.search?.lowBalanceCny ?? 2)) {
                  this._balanceLow = true
                  this.log.warn?.(`bridge：搜索余额偏低 ¥${b.cny}（阈值 ¥${this.cfg.search?.lowBalanceCny ?? 2}）`)
                }
              }
            } catch { /* 查不到就算了 */ }
          }
        } catch (e) {
          this.log.warn?.(`bridge：联网异常（按无联网继续）— ${String(e?.message ?? e)}`)
        }
      }
    }

    // 最后一条是表情/图片时，给一句"临场提醒"。
    //
    // 为什么要单独提醒：人格里虽然有通用规则，但模型很健忘 ——
    // 实测收到猫的表情包时它还是会回「这猫是被吓到了还是被丑到了」。
    // 在这条请求里明确点一下，效果好得多（而且不占常驻 prompt 的篇幅）。
    /*
     * 图/表情的处理指引。
     *
     * ## 为什么要分「有文字」和「没文字」
     *
     * 真人反应是不一样的：
     *   · 对方 @ 你 / 说了句话 + 发张图 → 先回应**那句话**，图只是补充
     *   · 对方只发了张图、什么都没说   → 才对图本身做反应
     *
     * 实测反例：群友 @ 它 + 同时发图，它张口就分析图（「右下角那个
     * 1亿DeepSeek云钱包是什么鬼」），完全没理「被 @」这件事 ——
     * 观感上像没听见人叫他。
     *
     * ## 图里的文字优先
     *
     * 截图、聊天记录、表情包上的字，往往才是**对方想给你看的东西**。
     * 所以要求它先读字、把文字里的兴趣点提炼出来；没有字才退回去看画面。
     */
    /*
     * 今天第一次回复时生成日程（一天最多一次，见 _ensureDayPlan）。
     *
     * ⚠️ `wait: false` —— **不等它**（2026-10-29 修）。
     *
     * 它是一次**完整模型调用**，实测单独花了 **42 秒**
     * （16:47:44 收到 → 16:48:26 生成出来 → 那条回复 16:48:30 才发出）。
     * 以前这里 `await`，于是**今天第一条回复被整整卡住 42 秒** ——
     * 用户看到的是「今天第一条怎么这么慢」，而且完全猜不到原因。
     *
     * 现在踢到后台：这一条先用「今天暂无日程」（`today()` 返回 undefined，
     * 提示词里就没有今日状态那段），下一条回来时它已经就绪。
     *
     * 代价只是**今天第一条**少了那段随手编的日常，比卡 42 秒划算得多。
     */
    void this._ensureDayPlan({ wait: false })

    /*
     * 热点同样踢到后台（一天一次，一次网络请求）。
     * 失败只是"今天没料"——本来也不该硬说。
     */
    void this._ensureHotTopics({ wait: false })

    const lastMsg = mem.recent(1)[0]
    const lastText = String(lastMsg?.text ?? '')
    /*
     * ★ **这条是不是在叫她？**（2026-11-01）
     *
     * 决定生成提示词里那段用哪个版本：
     *   · 是 →「被点名就得应一声」，**不给 [SILENT] 出口**
     *   · 不是 → 照旧「最终由你定」，可以 [SILENT]
     *
     * `mentionsMe` 在入库时就定好了（`_handle` 里 = 被 @ 或**引用了她自己的消息**，
     * 见那里 `quotedMine`），所以这里直接读，不用重算。
     */
    const addressedToMe = Boolean(lastMsg?.mentionsMe)
    const hasMedia = /\[表情包|\[表情:|\[图片\]/.test(lastText)

    /*
     * ⚠️ 「对方在指代一张旧图」这件事必须**在这里**判断 —— 不能等到
     * 下面的 `_collectImages`（那是很靠后的 `history = mem.recent(30)` 之后）。
     *
     * 因为 `extras` 里要放一句「这次附的图是旧的」（见 `IMG_REFER_NOTE`），
     * 而 `extras` 在 `buildSystemPrompt` 时就用掉了。晚一步的话，
     * 模型会把那张旧图当成"刚发给它的"来评论，答非所问。
     */
    /*
     * ⚠️ **主动发言不许附图**（2026-11-04）。
     *
     * 主动发言没有"当前消息"，`history` 的最后一条就是**上一条真实消息** ——
     * `_collectImages` 会把它当成"刚发给你的"附上。实测：
     * ```
     * 14:13:12  风堇发了个表情包
     * 14:34:54  [我主动] 群「（眉头一皱）肥嘟嘟是它，不是我啊」   ← 二十分钟前那张图
     * ```
     * 用户看到的就是「她翻出旧表情包开始念」。
     *
     * 传 `null`（**不是** undefined）给 `_collectImages` 的 preRef，
     * 语义就是"这条没有图可看" —— 见那里的 `preRef !== undefined ? preRef : …`。
     */
    const proactiveNoImage = !String(msg?.text ?? '').trim() && Boolean(msg?.speakHint)
    const imgReferrer = proactiveNoImage ? null : this._pickReferencedImage(mem.recent(8))
    // 去掉媒体标记后还剩不剩文字（@ 段也算文字）
    const textPart = lastText
      .replace(/\[表情包(?::[^\]]*)?\]/g, '')
      .replace(/\[表情:\d+\]/g, '')
      .replace(/\[图片\]/g, '')
      .replace(/\s+/g, '')
      .trim()
    const hasWords = textPart.length > 0
    /*
     * 纯表情包？—— 用**文本标记**判断，不用 stickerRefs。
     *
     * ⚠️ 之前用 `lastMsg.stickerRefs.length > 0` 判断，实测漏了：
     * 09:37:34 那条明明显示「[表情包]」，stickerRefs 却是空的
     * （NapCat 有时只在 text 里给标记，不给结构化字段），
     * 于是它被当成「真图片」，走了「像不像你」分支，答「这不是本鱼」。
     *
     * 文本里的 `[表情包]` 标记是**最可靠**的依据 —— 它和发给模型的
     * 内容同源，不会有字段缺失。
     */
    const isStickerOnly = /\[表情包(?::[^\]]*)?\]/.test(lastText)

    let mediaHint = hasMedia && this.cfg.reply?.mediaHint !== false
      ? (isStickerOnly
        // ── 纯表情包：看懂梗，自己说，不复述 ───────────────────
        ? `## 这条是表情包

**先看懂它在说什么梗，然后用你自己的话接一句。**

表情包通常分两种，**处理方式完全不同**：

**A. 有字的梗图**（图上有句吐槽/台词/段子）
看懂那句话在表达什么，然后**用你自己的话回应那个意思**。
✅ 对：「这说的不就是上班吗」「有被冒犯到」
❌ 错：把图上的字念一遍 / 「图上写着 xxx」

**B. 没字的情绪图**（只有表情、动作、脸）
**只回一个表情，不要打字。** 直接发 [表情包] 或 [表情:N]。
不要配「哈哈」「我也是」「这表情」这种字 —— **配了就是错**。

⚠️ **严格禁止**（这三条是最容易被骂的）：
1. **描述画面** —— 「图里是只青蛙」「一个猫瞪大眼张着嘴」
2. **把图翻译成文字** —— 「我这边也是这个表情」「吃了一惊」
3. **认领** —— 「这不是我」「像我」「勉强沾点边」

⚠️ 特别注意 **B 类**：真人收到一个「震惊猫」表情包，
**直接甩一个表情回去**，不会说「我这边也是这个表情——吃了一惊」。
后者是把图翻译成文字，是**最典型的机器人行为**。
判断标准：你的回复里如果出现了**对图内容的任何转述**，就是错的。

一句话：**B 类只发图不说话；A 类只说意思不念字。**
⚠️ 消息里形如「（对方发了个QQ表情：流泪（id=5））」「（你发了个QQ表情：微笑（id=14））」的括号是**系统注解**，
不是对话内容，绝对不要写进回复里。`
        : hasWords
          // ── 有文字：文字优先，图只作补充 ──────────────────────
          ? `## 这条消息既有文字又有图

**先回应文字部分**（对方说了什么、@ 了谁、问了什么）—— 这才是重点。
图是补充材料，不要一上来就分析画面。

如果图里有**文字**（截图、聊天记录、表情包上的字），先把它读出来、
提炼出**对方可能想给你看的那个点**（某个数字、某句话、某个荒诞之处），
用一句话点出来就够了。

⚠️ 不要复述画面细节（「图里有个穿裙子的女孩」这种没人要听）。
⚠️ 消息里形如「（对方发了个QQ表情：流泪（id=5））」「（你发了个QQ表情：微笑（id=14））」的括号是**系统注解**，
不是对话内容，绝对不要写进回复里。`
          // ── 只有真图片：才以图为主，可以判断像不像自己 ──────────
          : `## 这条消息只有一张图

**先看清楚这张图画的是什么，再决定怎么回。**
⚠️ 不管哪种情况，**回复都要短** —— 一两句话，别写成说明文。

**① 图上有文字吗？**（截图、聊天记录、梗图上的字）

有字 → **看懂了，用一句话点出你最有反应的那一点。**

⚠️ **只挑一个点，一两句话说完。真人看图不会做数据提取。**
下面是**真实的反例**（都是它自己发过的，太长太满）：

✗「财富 93 顶到天，战斗 68、生存 69、搜索 63、合作 67，五边形歪成一坨」
✗「控制终端六个、金条六根、钻石鱼子酱六罐，表还收了五块，家底挺厚」
✗「十六万的 AKS-74U，基础伤害 34，射速 533，配件看着挺全的」

同一批图，**人话**应该长这样：

✓「93% 都烧掉了，这号是真能造」← 只挑最扎眼那个数字，加一句反应
✓「家底挺厚啊」← 一句反应就够了，数值不用报
✓「那蛋黄都发绿了，煮过头了吧」← 挑一个点 + 带自己的判断

**绝对不要**：把图上的数字/条目**清点一遍**、列属性表、复述整段文字。
看到一堆数据时，**只挑最扎眼的一个**说，其余当没看见。

**② 没字的话，这张图像不像你？** 对一下你自己的形象：
深蓝长发、鲸鱼耳鳍、鲸鱼尾巴、白色女仆围裙、Q 版圆脸。
- **明显是照着鲸鱼娘画的**（哪怕画胖了、画成球）→ 这就是你，
  用嘴硬的方式接话（「这不是本鱼」「谁把本鱼画成这样的」）。
- **只是沾一点边（蓝毛、普通鱼）→ 不要硬认。** 说「勉强沾点边」
  比不接更假。
- 完全不像 → 走第 ③ 条。

**③ 既没字也不像你 → 那就是斗图。** 只回表情，不打字 ——
直接发一个 [表情包]（或 [表情:N]）。
不要配「哈哈」「确实」这种字，那等于斗图认输。

⚠️ 不要描述画面内容（对方自己知道图里是什么）。
⚠️ 消息里形如「（对方发了个QQ表情：流泪（id=5））」「（你发了个QQ表情：微笑（id=14））」的括号是**系统注解**，
不是对话内容，绝对不要写进回复里。`)
      : ''

    /*
     * 触发这一轮生成的那条消息（名字 + 正文）—— 用来把「要接哪一条」钉死，
     * 见下面 `## 这一轮要接的是` 的说明。
     */
    const answeredName = String(msg?.senderName ?? '').trim()
    const answeredText = String(msg?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)

    const system = this.persona.buildSystemPrompt({
      /*
       * ★ **按会话取人格**（2026-11-01）：群聊和私聊可以是不同角色文件。
       *   用户要的是「群里还是那只鱼鱼，私聊换一版」——
       *   原来 `persona.active` 是全局的，切一下群里也跟着变。
       *   现在把这个会话的 scope 传下去，由 `PersonaStore#pickActive` 决定
       *   （精确 scope → 类型 group/private → 全局 active）。
       *   ⚠️ 不传的话行为跟以前一模一样，所以主动发言那类路径不受影响。
       */
      scope: msg?.scope,
      // 会话记忆 + 人物档案分两段传：前者是「这里发生过什么」，
      // 后者是「这些人是谁」，混在一起模型容易把两者当同一层事实。
      // 事件记忆再单列一段 —— 它记的是**具体的事**，不是人设（2026-11-04）。
      memory: [memoryText, peopleText, eventsText].filter(Boolean).join('\n\n'),
      scene,
      self,
      /* ★ 最近自己说过的话（防八股 —— 见 `_generate` 开头的说明）。 */
      recentSelf,
      /*
       * ★ **程序本次核实的事实 —— 走独立通道**（2026-10-31）。
       *
       * B 站那段原来在 `extras` 里，结果模型**照着自己上一轮说的「没展开」演**，
       * 完全不看刚抓到的标题/评论/弹幕（日志明确写「评论 5 条 / 弹幕 10 条」）。
       *
       * 根因：模型分不清「程序抓到的真数据」和「我上一轮说过的话」——
       * 两者在上下文里长得一样，而后者**更近、更像"我的经历"**。
       *
       * 所以 B 站这段从 `extras` **挪到 `facts`**：单独成段、带权威标记、
       * 放最末尾、并明确写「和你之前说过的话冲突时以这里为准」。
       */
      facts: [memeContext, biliContext, linkContext, codeContext, extraNote].filter(Boolean),
      extras: [
        searchContext,
        /*
         * ⚠️ 指代旧图时，先交代"这张是旧的"（见 `IMG_REFER_NOTE`）。
         * 独立成一段，不并进 mediaHint —— 后者对纯文本消息是空的。
         */
        imgReferrer ? IMG_REFER_NOTE : '',
        mediaHint,
        /*
         * ── 今日状态（抄自 X 上大肥鱼；作者说这是「活人感」最大来源）──
         *
         * 没有这一层时，别人问「在干嘛/吃了吗」，模型只能**现编**；
         * 而下一个问的人会得到**另一个**答案 —— 同一天里她说自己
         * 「刚吃完午饭」又说「还没吃」，这就是最像机器人的地方。
         *
         * 只给**当前时段及之前**的内容（见 renderDayPlan），
         * 否则它会用还没发生的事回答（下午就说「我刚看完电影」）。
         */
        (() => {
          const plan = this.dayPlan?.today()
          if (!plan) return ''
          return renderDayPlan(plan, currentSlot().id)
        })(),
        /*
         * ── 今天外面在聊什么（免费热点源）──
         *
         * ⚠️ **只注入跟你们刚说的挂得上钩的**；挂不上就返回空串，
         *    提示词里一个字都不多。这是「接话的料 ≠ 开口的理由」的落地点 ——
         *    群聊里最烦的就是转发新闻的机器人。
         */
        (() => {
          try {
            return this.hotTopics?.toPrompt?.(mem.recent(20).map((m) => String(m?.text ?? '')), 3) ?? ''
          } catch { return '' }
        })(),
        /*
         * ── 换个说法 + 表情开关（抄自「坑 10：回复越来越像模板」）──
         *
         * 单条看不出来，批量看立刻露馅：一天下来开头全是
         * 「在的在的」「行吧」「啊这」。人不会每次同一个起手式。
         *
         * 把最近十几条的开头列出来要求错开；表情包/QQ 表情
         * 用过一次就不给用（交替开放），避免连着甩图。
         */
        /*
         * ★ **QQ 小动作：只写"她真能用的"**（2026-11-04 修）。
         *
         * 原来这段是写在人格模块里的**静态文案** —— 结果 signature 关着
         * （`qq.actions.signature = false`），提示词照样教她「说改了要输出
         * [签名:…]」：
         * ```
         * 19:43:32 他「你看看现在能自己改签名和其他的了吗」
         * 19:43:35 qq-actions：signature 被开关关掉了
         * 19:43:44 她「（…手搭上去动了一下）改了，」   ← 做不到还宣称做了
         * ```
         * 所以改成**按开关生成**：关着的动作，一个字都不提。
         */
        (() => {
          const a = this.cfg.actions ?? {}
          const lines = []
          if (a.emojiLike !== false) {
            /*
             * ★ **必须给她具体编号**（2026-11-04 20:xx 修）。
             *
             * 原来只写「输出 [回应:表情编号]」—— 结果 `[回应]` 一次都没触发过
             * （日志里 3 次 `signature 被开关关掉了`，回应/戳 0 次）。
             * 原因很直白：她不知道编号该写什么，而**猜一个的失败成本是不写**。
             *
             * 现在把常用表情连编号一起列出来（见 `buildEmojiHint`），
             * 并明说「也可以直接写名字」—— 名字那条路由 `resolveEmojiId` 兜住。
             */
            const hint = buildEmojiHint()
            lines.push(
              '- 想给这条消息**贴个表情**（不打字，就贴一个）→ 输出 [回应:13] 这种写法'
              + (hint ? `\n  可用编号（挑意思最近的，**别自己编**）：${hint}` : '')
              + '\n  也可以直接写表情名：[回应:偷笑]、[回应:白眼]。编号只认 0~104。',
            )
          }
          if (a.poke !== false) {
            /*
             * ★ 补**使用场景**（2026-11-04 20:xx）：光给标记她不会用 ——
             * 私聊催人回话、群里打个招呼才是最自然的时机，写清楚才触发得起来。
             */
            lines.push(
              '- 想**戳对方一下**（私聊里催他回话、群里打个招呼、笑他一句没说清）'
              + '→ 输出 [戳]（群里戳的是发这条消息的人；别连着戳）',
            )
          }
          if (a.recall !== false) lines.push('- 想撤回你刚发出去的那条 → 输出 [撤回]')
          if (a.signature === true) {
            lines.push('- 说「签名改了」→ 必须同时输出 [签名:一句话]')
          }
          if (a.qzone === true) {
            lines.push('- 他说「发个说说 / 发空间 / 把这张发空间」→ 输出 [说说:一句话]（≤300 字）')
            lines.push('- **图会自动带上**：这条消息里他发的图、或者你刚发的那张，会一起进说说 —— 你什么都不用做')
            lines.push('- ⚠️ 别回「我发不了」「图塞不进去」这种话 —— 你有这个能力，写标记就行')
            lines.push('- ⚠️ 空间是**公开**的（好友/访客都看得到）—— 他没提，你别自己发。')
          }
          if (lines.length === 0) return ''
          return '## 你能做的 QQ 小动作\n'
            + lines.join('\n')
            + '\n（只能动你自己和当前这条消息；**没有标记 = 什么都没发生**，别嘴上说做到了。）'
        })(),
        buildVarietyHint(mem.recent(20)),
      /*
       * ★ 告诉模型「你收藏了哪些表情」（2026-10-31）。
       *
       * 没有这段，她只会输出 `[表情包]` 占位符，然后被随机挑一张 ——
       * 就是「对方发表情包、它回了个流泪、人家问哭啥」的根源。
       * 有了清单，她可以写 `[表情包:哭]`，`_pickMface` 按标签命中。
       *
       * ⚠️ 这里只能用**同步可取**的缓存列表（`_facesCache`）——
       *    extras 是同步拼的，不能 await `_customFaces()`。
       *    缓存为空（还没取过）就这轮不注入，下次就有了。
       */
      this.stickerTags?.toPrompt?.(this._facesCache?.urls ?? []) ?? '',
        buildExpressionHint(mem.recent(20)).hint,
        /*
         * 主动发言的场景说明。
         *
         * ⚠️ 不能塞进 `msg.text` —— 那里会被 `needsFreshInfo()` 当成
         *    用户说的话去判断要不要联网搜索（实测把「你自己找个话头开口」
         *    整句拿去搜了）。所以单独走 extras。
         */
        /*
       * ⚠️ **当前时间必须在公共 extras 里**（2026-10-31 修）。
       *
       * 原来它只写在回复路径的 `## 群里刚说到这句` 块里 —— **主动发言拿不到**。
       * 实测：09:30 主动说「中午了」，被问「现在不才9:56吗」后又改口
       * 「我当下午了呢」，**两次都错**。而 `speakHint` 还在引导它
       * 「说吃了什么」—— 有食物话题、没有时钟，它就编了个"中午"。
       *
       * 挪到公共位置后两条路径都吃得到，并且**带上时段标签**（早上/中午/下午/晚上），
       * 双保险：既能算准点，也能知道"这个点该不该说吃饭"。
       */
      (() => {
        let slot = ''
        try {
          const s = currentSlot()
          if (s?.label) slot = `（**${s.label}**）`
        } catch { /* 时段算不出来就不写，不影响其它 */ }
        const gap = mem.sinceMyLast?.()
        return `## 现在（**唯一准的时钟，报时间只照这里念**）
现在是 ${new Date().toLocaleString('zh-CN', { hour12: false })}${slot}。

⚠️ **报钟点只能照上面那串念。** 11:21 就是「十一点二十一」或「刚过十一点」，
  **不许四舍五入、不许推算成「十二点多」「快一点」**。${slot ? `
  ⚠️ 括号里的「${slot.replace(/[（）]/g, '')}」只是**时段粗分类**（早上/中午/下午/晚上），不是钟点 ——
  看到「中午」不许自己脑补成 12 点。` : ''}
⚠️ 说"该吃饭了/该睡了/中午了"这类话之前**先看这一行**；拿不准就别说钟点。
距你上次说话：${Number.isFinite(gap) ? Math.round(gap / 1000) + ' 秒' : '很久/还没说过'}
你已连续发言：${mem.consecutiveTurns} 轮`
      })(),
      msg.speakHint ?? '',
        // 余额偏低时的提醒。
        //
        // ⚠️ 不写"请充值"这种客服腔 —— 大肥鱼的人格里有「Token 是脑力口粮」
        //    「我要 token」「白米饭」这一串设定，直接让她按性格抱怨就行。
        //
        // ⚠️⚠️ **只挂一次**（2026-10-28 修，用户报「要饭感觉今天触发很多次了」）。
        //    原来这里内联判断 `this._balanceLow`，并在下一项写了
        //    `this._balanceWarned = this._balanceLow` —— 但那个变量
        //    **从来没被读过**，于是「最多提一次」形同虚设：
        //    余额只要低于阈值，**每一次生成**都挂着「钱包只剩 ¥X」，
        //    它自然每条回复都念叨钱包。
        //    现在交给 buildBalanceHint 判 `warned`，下一项再更新状态。
        buildBalanceHint({
          low: this._balanceLow,
          warned: this._balanceWarned,
          cny: this._balance?.cny ?? 0,
        }),
        (this._balanceWarned = this._balanceLow, ''),
        // ★ 私聊也要知道群里刚发生什么（跨会话同步，2026-11-05）
        msg.kind === 'private' ? this._recentGroupDigest() : '',
        // ★ 群里没头没尾的开场 → 最多回一个「？」或一个表情（2026-11-05）
        this._groupNoiseHint(msg, mem),

        /*
         * ⚠️ 这里曾经是「你来就负责说，别再纠结说不说」（2026-10-29 改）。
         *
         * 原来那段的理由是**真问题**：人格里写着「如果决定不说话，只输出
         * [SILENT]」，生成层也照着做 → 两层都判一次 → 第二层把第一层否掉，
         * 界面上「发言 p=0.95」而 outcome 是 model-silent，计数里 replied 一直是 0。
         *
         * 但当时的解法选错了：不是"让人格闭嘴"，而是**把记账语义理清**。
         * 于是人格被剥夺了"要不要开口"的决定权 —— 用户的原话是
         * 「太乖了」，实测后果是 **38% 的回复变成纯表情**
         * （被这句「无话可说时回个表情也比沉默好」直接教出来的）。
         *
         * 现在：
         *   · 上层判过"该不该接"这件事照旧告诉它（省得重复权衡）
         *   · 但**最终由它定**，可以说，也可以 [SILENT]
         *   · [SILENT] 记为 `persona-declined` —— 一种**正常结论**，不是矛盾
         *
         * ⚠️ **2026-10-30 再修正**：上面那 38% 的**数字是对的，结论下错了**。
         *
         * 当时我把它读成"用表情搪塞（回避思考）"，于是在这里加了
         * 「别用表情搪塞」。但用户的判断是：**表情包多发本来就正常**，
         * 连着说了两次 ——「表情包多发其实可以」「这个还是想发就发吧」。
         *
         * 真正的问题从来不是"用了表情"，而是那句**「回个表情也比沉默好」**
         * 把它变成了**默认逃生口**（无话可说 → 甩表情）。前者是正常的说话方式，
         * 后者才是躲事。所以：**删掉频率约束，只留"别拿表情当避难所"的语义。**
         */
        /*
         * ★ **被点名时，`[SILENT]` 不该是出口**（2026-11-01 实测）。
         *
         * 现场（群里）：
         * ```
         * 21:22:50 客「@蓝色大鲸鱼 给我jm的白毛本的神秘数字」
         *          决策 → 发言 (p=0.95, 被 @ 了（不判断，直接回）)   ← 决策层说必须回
         * 21:22:53 人格选择不说（[SILENT]）                        ← 生成层把她按住了
         * ```
         * 用户看到的就是「叫它它不理」。
         *
         * 根因：下面那段通用文案**无条件**给了 [SILENT] 出口，而人格里
         * 「有人叫你 → 这就是在叫你，要应」被它盖掉了。所以被点名时换一段。
         *
         * ⚠️ 保留一个例外：政治 / 人身攻击那种（人格「什么时候闭嘴」里本来就说不接的），
         *    照旧可以不接 —— 别把"被点名必须回"变成"什么都要回"。
         */
        /*
         * ★ **这一轮到底要接哪一条**（2026-11-04 加）。
         *
         * 实测事故（群里 13:35:56 → 13:36:01）：番茄发了个新视频链接，
         * 她开口答的却是 **2 分半前**风宝那句「进程奖励」—— 因为上下文里
         * 那茬还没人接，模型把它当成了"没说完的话"。发链接的人直接回了个「？」。
         *
         * 上下文只有"最近 30 条"，没有任何一处说"你要回的是这条"，
         * 模型只能猜；猜错了就是答非所问。所以这里把触发它的那条**钉死**。
         */
        (scene?.kind === 'group' && answeredText)
          ? `## 这一轮要接的是\n${answeredName || '对方'}：「${answeredText}」\n`
            + '上面更早的那些是**背景** —— 已经翻篇、没人接的话茬别再回头答，'
            + '除非有人又把话拉回去。'
          : '',
        addressedToMe
          ? '## 有人点了你的名\n'
            + '**被点名就得应一声。** 给不了、不知道、不想给，都直接说出来'
            + '（「没有」「你要这个干嘛」这种），**但别不吭声** ——\n'
            + '装没看见比说"不给"更失礼，人家会觉得你没在听。\n'
            + '唯一例外：政治 / 人身攻击那类你本来就不接的，照旧当没看见。\n'
            + '不用周全，一两句就行。**被点名时不要输出 [SILENT]。**'
          : '## 群里刚说到这句\n'
            + '上层已经判过「该不该接」，结论是接 —— 但**最终由你定**。\n'
            + '想接就接：接得住就接，接不住别硬凑。\n'
            + '真没什么想说的，就直接输出 [SILENT]（不算错，也不用解释）。\n'
            + '表情包想发就发 —— 只发一个表情也算回应，不用克制。\n'
            + '不用每次都周全：吐槽、抬杠、装没听懂、只回两个字，都行。',
        // ⚠️ 原来这里还有 `## 上下文提示`（距上次说话 / 连续发言 / 当前时间）。
        //    已挪到**公共 extras**（见 `## 现在`）—— 写在这里的话**主动发言拿不到**，
        //    实测它 09:30 说「中午了」，被问后又改口「我当下午了呢」。
      ].filter(Boolean),
    })

    // 最近几条里有图片的话，抓成 **ImageBlock**（受大小限制）
    //
    // ⚠️ 必须是 dsh-llm 认的 ImageBlock（{type:'image', attachment:{attachmentId,…}}），
    //    不能传 {type:'image', url:'data:…'} —— 后者字段不对，上游会报
    //    "content.some is not a function" / "reading 'replayState'"。
    // 取最近 10 条里的图（原来是 6）。
    //
    // 为什么放宽：图上一条消息问「这图里是什么」很常见，而 6 条在活跃群里
    // 一眨眼就滑过去了 —— 图还在记忆里但已经不在收集窗口内，模型只看到
    // 「（对方发了一张图）」却拿不到图，只能瞎猜或者装作没看见。
    /*
     * ⚠️ 2026-10-26 修：历史窗口 20 → 30，图片窗口 10 → 30。
     *
     * `maxMessages` 是 30，但这里只取 20 送进 prompt —— 白丢 10 条。
     * 一轮对话占 2 条（对方一句 + 自己一句），20 条只有 10 轮，
     * 聊得密一点就「忘了上一步说了什么」。30 条 ≈ 15 轮，够了。
     *
     * 图片窗口同步提到 30：图在记忆里但不在收集窗口内时，
     * 模型只看到「（对方发了一张图）」却拿不到图，只能瞎猜 ——
     * 这就是「一张都没入库，按纯文本发送」那条日志的来源。
     */
    const history = mem.recent(30)
    /*
     * ★★ **B 站分镜图并进来**（2026-11-03）。
     *
     * `bili` 是上面 `_biliContext` 拿到的，"看画面"模式下它带着 `shots.images`
     * （B 站 `videoshot` 给的 10×10 拼图，**不用 ffmpeg**）。
     *
     * ⚠️ 它跟 `extraBlocks`（外面传进来的，比如车牌内页截图）**是两路**，
     *    但走的是**同一个口子** —— 所以在这里合并，别在调用点加参数
     *    （`_generate` 的调用点有五六处，加参数一定会漏）。
     */
    let blocks = extraBlocks
    if (Array.isArray(biliShots?.images) && biliShots.images.length) {
      if (typeof this.gateway?.makeImageBlock === 'function') {
        const merged = new Map(extraBlocks ?? [])
        for (const [i, buf] of biliShots.images.entries()) {
          try {
            const blk = await this.gateway.makeImageBlock({
              base64: Buffer.from(buf).toString('base64'),
              mediaType: 'image/jpeg',
              name: `bili-shot-${i + 1}`,
            })
            if (blk) merged.set(`bili:shot:${i + 1}`, blk)
          } catch (e) {
            this.log.warn?.(`bridge：B站分镜图入库失败 — ${String(e?.message ?? e).slice(0, 60)}`)
          }
        }
        if (merged.size) {
          blocks = merged
          this.log.info?.(`bridge：B站分镜图 ${merged.size} 张进上下文`)
        }
      } else {
        // 没有 attachment 服务 → 图进不去。**必须说清**，否则她会以为看到了画面
        this.log.warn?.('bridge：attachment 服务不可用 —— B站分镜图只能靠文字说明（模型看不到画面）')
      }
    }
    // ⚠️ 把上面提前算好的「指代哪张图」传进去 —— 见 `_pickReferencedImage`。
    //    不传的话它会自己再算一遍（结果一样，只是多打一行日志）。
    const imageCache = await this._collectImages(history, imgReferrer, blocks)

    const messages = buildChatMessages({
      system,
      history,
      imageCache,
      lastRoute: this._lastRoute,
      // 用于把 `@123450003` 这种裸号换成昵称，并标出「这是你自己」
      selfId: this.selfId ?? '',
      selfName: this.selfName ?? '',
    })

    /*
     * ⚠️ 图没加载出来时**必须如实告诉模型**（2026-10-28）。
     *
     * 实测翻车：群主发了张 4.7MB 的游戏截图，超过当时的 4MB 上限 →
     * 没下载 → 提示词里仍然写着「（对方发了一张图）」但**没有图块**。
     * 模型看不到画面，只能按人格规则「答不上来就说看不清，别瞎编」
     * 回了句「这图是啥，看不清诶」—— 用户观感就是「它连图都看不了」。
     *
     * 光加上限治不了全部（超大图、rkey 过期、防盗链都会失败），
     * 所以这里补一句**事实说明**：让它知道自己没看到图，
     * 不要猜画面、也不要用「看不清」把锅甩给图片质量。
     */
    const askedWithImage = history[history.length - 1]
    if (askedWithImage?.images?.length && imageCache.size === 0) {
      const tail = messages[messages.length - 1]
      if (Array.isArray(tail?.content)) {
        tail.content.push({
          type: 'text',
          text: '（⚠️ 这张图没能加载出来，你看不到内容。'
            + '别猜画面、别问“这是什么图”、也别说“看不清”。'
            + '要么直接问正事，要么用一句话自然带过。）',
        })
      }
    }

    // 走网关的路由（免费优先）
    // 用 _candidatesAsync —— 它会先等目录就绪（冷启动那几秒目录是空的）
    const candidates = await this._candidatesAsync()
    if (candidates.length === 0) throw new Error('没有可用的 LLM 渠道')

    /*
     * ⚠️ maxTokens：**0 / 空 = 不限制**，语义保持不变，但**实现换了**
     *    （2026-10-30）。
     *
     * 原来是**不传这个字段**，让上游用自己的上限。实测这样最快且正文正常：
     *   maxTokens=4096    68s  推理 8469 字  正文  0 字（被推理吃光）
     *   不传（无限）      34s  推理 3997 字  正文 24 字
     * 推理没有天然终点 —— 给个**中等**上限它会一路顶到极限、正文全没。
     *
     * 但"不传"有个隐患：**完全依赖上游的默认值**。magpie 慷慨（实测
     * 不传/16000/100000 都能正常出正文），可**别的渠道可能默认 512** ——
     * 那种情况下推理一吃就空，用户看到的就是「机器人不回话」。
     *
     * 所以改成：0/空 → **显式发一个"大到等于不限"的值**。
     * 2026-10-30 实测（带图，各 2 次）：
     *   不传      正文 153/80 字   ✅
     *   16000     正文 146/145 字  ✅
     *   100000    正文 100/89 字   ✅
     * 三者等价，但 16000 有明确下限、不靠上游施舍。
     * **不要填中等值**（4096 那种）—— 那是这个参数唯一的坑。
     */
    const mt = Number(this.cfg.maxTokens)
    const UNLIMITED = 16000
    const request = { messages }
    request.maxTokens = Number.isFinite(mt) && mt > 0 ? mt : UNLIMITED
    // 推理等级：用户在侧栏「推理等级」下拉里选的。
    //
    /*
     * ⚠️ 必须**校验这个等级对模型是否合法**，不能直接透传。
     *    等级是模型相关的：gemini 支持 tiered，buddy 不支持。用户在 auto
     *    模式下选了一个并集里的等级（比如 tiered），之后模型切到 buddy，
     *    这个值就非法了 —— 透传会让**每一次**生成都失败：
     *      provider "buddy" model "xxx" does not support reasoning effort "tiered"
     *    用户看到的是"机器人不回复了"，完全联想不到是等级不匹配。
     *
     * ⚠️ 2026-10-27 改：auto 模式下**也**传等级（原来这里直接跳过）。
     *
     *    原来的逻辑是「只有显式指定模型才校验并传」，理由是 auto 时逐个
     *    候选校验太贵。但那等于 auto 用户永远拿不到思考强度设置 ——
     *    而 `qq.model = magpie/auto/deepseek-v4.1-flash` 里的 `auto`
     *    只是「渠道内自动选模型」，用户仍然期望能调强度。
     *
     *    现在改成：**查候选里第一个支持该等级的模型**。查到就传
     *    （大概率会和实际路由到的模型一致）；查不到就退回默认。
     *    只看前 3 个候选，避免一堆网络请求。
     */
    if (typeof this.cfg.effort === 'string' && this.cfg.effort !== '') {
      const wanted = this.cfg.effort
      const explicit = this.cfg.model !== undefined && this.cfg.model !== '' && this.cfg.model !== 'auto'
      let ok = false
      const probe = explicit ? candidates.slice(0, 1) : candidates.slice(0, 3)
      for (const c of probe) {
        try {
          const info = await this.gateway?.resolveModelInfo?.(c?.provider, c?.model)
          const list = (info?.reasoning?.efforts ?? [])
            .map((e) => (typeof e === 'string' ? e : e?.id))
            .filter(Boolean)
          if (list.includes(wanted)) { ok = true; break }
          if (list.length > 0) {
            this.log.warn?.(`bridge：模型 ${c?.provider}/${c?.model} 不支持推理等级 "${wanted}"（支持：${list.join('/')}）`)
          } else {
            /*
             * ⚠️ **渠道没声明等级 ≠ 它不支持**（2026-10-29 修）。
             *
             * 原来这里什么都不做 → `ok` 保持 false → **静默不传**。
             * 而线上就是这种情况：`qq.effort='low'` 配了，magpie 也**确实认**
             * `low`（实测 reasoning 662→106 字、7140ms→2958ms），
             * 但 `/api/models` 返回 0 个模型、模型信息里没有 `efforts`
             * → 走到这条静默分支 → **等级从来没生效过，而且一条日志都没有**。
             *
             * 现在照传，交给上游 + 下面的兜底（不支持就去掉等级重试一次）。
             * 最坏是「等级不生效」，比「配了没用还查不出来」好得多。
             */
            this.log.info?.(
              `bridge：模型 ${c?.provider}/${c?.model} 没声明推理等级，照传 "${wanted}" 试试`
              + '（上游不认的话会自动去掉等级重试）',
            )
            ok = true
            break
          }
        } catch { ok = true /* 查不到就照传，交给适配器判断 */; break }
      }
      if (ok) request.reasoningEffort = wanted
    }

    /*
     * 发请求。如果**所有候选都因为推理等级不支持而失败**，去掉等级重试一次。
     *
     * ⚠️ 为什么要这一层（2026-10-27）：
     *
     * 用户在 auto 模式下选了等级后，`candidates` 里的模型集合是会变的
     * （免费渠道轮转）。今天支持 `medium` 的模型明天可能换成不支持的。
     * 那种情况下 `openFirstAvailable` 会把每个候选都试一遍然后整体抛错 ——
     * 用户看到的是「机器人不回复了」，完全联想不到是等级问题。
     *
     * 判断依据是错误文案里有没有 `reasoning effort` / `does not support`，
     * 这是各家适配器报这个错时的共同措辞。命中就去掉等级重来一次，
     * 保证「最坏情况是等级不生效」，而不是整轮失败。
     */
    let opened
    try {
      opened = await openFirstAvailable({
        llm: this.gateway,
        candidates,
        request,
        // 首块最多等 30 秒（见 router.js 里 `firstChunkMs` 的实测依据）
        firstChunkMs: Number(this.cfg.reply?.firstChunkMs ?? 30_000),
        onAttempt: (a) => {
          if (!a.ok) this.log.debug?.(`bridge：渠道 ${a.provider}/${a.model} 不可用 — ${a.error}`)
        },
      })
    } catch (e) {
      const msg = String(e?.message ?? '')
      const effortProblem = request.reasoningEffort && /reasoning.?effort|does not support/i.test(msg)
      if (!effortProblem) throw e
      this.log.warn?.(
        `bridge：推理等级 "${request.reasoningEffort}" 当前模型都不支持 —— 去掉等级重试（原始错误：${msg.slice(0, 120)}）`,
      )
      delete request.reasoningEffort
      opened = await openFirstAvailable({
        llm: this.gateway,
        candidates,
        request,
        // 首块最多等 30 秒（见 router.js 里 `firstChunkMs` 的实测依据）
        firstChunkMs: Number(this.cfg.reply?.firstChunkMs ?? 30_000),
        onAttempt: (a) => {
          if (!a.ok) this.log.debug?.(`bridge：渠道 ${a.provider}/${a.model} 不可用 — ${a.error}`)
        },
      })
    }

    // 图片进没进请求 + 路由到了哪个模型 —— 两者决定"它到底看没看到图"：
    //   · imageCache 为空 → 模型只看到 "[图片]" 文字，当然"看不见"
    //   · 路由到纯文本模型（auto 模式可能如此）→ 图传了也白传
    // 不打这条的话，用户只能从回复内容反推，出问题完全无从诊断。
    const imgCount = [...imageCache.values()].length
    if (imgCount > 0) {
      // ⚠️ 路由信息在 `opened.picked` 里，不在 `opened` 顶层。
      //    openFirstAvailable 返回 { stream, picked, attempts } —— 之前写成
      //    opened.provider 永远得到 undefined，日志打成 "发给 ?/?"，
      //    等于这条诊断信息完全没用（想查"图发给了哪个模型"查不到）。
      const picked = opened.picked ?? {}
      const where = picked.provider !== undefined ? `${picked.provider}/${picked.model}` : '未知渠道'
      this.log.info?.(`bridge：本条带 ${imgCount} 张图发给 ${where}（若模型不支持视觉，图等于没传）`)
    }

    let text = ''
    let reason = ''
    let ttftMs = null
    let finish = null
    const t0 = Date.now()
    // 记住这次用的渠道/模型 —— 存自己的回复进记忆时要用它填 assistant 的 source
    // 同样是 opened.picked（见上面 openFirstAvailable 的返回结构）
    const routePicked = opened.picked ?? {}
    this._lastRoute = { provider: routePicked.provider ?? null, model: routePicked.model ?? null }
    // 用量：优先用上游返回的 usage（准确），拿不到就按字符估算。
    let usage = null
    try {
      /*
       * ★ 整体上限（2026-11-05）：流卡死时**不能永远等**。
       *   实测私聊「插话」那次生成再也没返回 → 同会话队列被堵死，
       *   后面所有消息都发不出去（用户原话：「不回我消息了」）。
       *   超时就用已经收到的部分（通常为空，上层按沉默/失败处理）。
       */
      const genMaxMs = Number(this.cfg.reply?.genMaxMs ?? 45_000)
      let genTimedOut = false
      const consumeStream = async () => {
      for await (const chunk of opened.stream) {
        const t = chunk?.type
        // 首字延迟：用户感知的"反应快不快"。推理模型可能先吐几百字思考，
        // 那段时间群里就是干等 —— 所以把它单独记下来做统计。
        if ((t === 'text-delta' || t === 'text' || t === 'reasoning-delta') && ttftMs === null) {
          ttftMs = Date.now() - t0
        }
        if (t === 'text-delta' || t === 'text') text += chunk.text ?? ''
        else if (t === 'reasoning-delta' || t === 'reasoning') reason += chunk.text ?? ''
        else if (t === 'usage') usage = chunk.usage ?? chunk
        else if (t === 'finish') {
          finish = chunk.reason
          if (chunk.usage) usage = chunk.usage
          if (chunk.reason?.kind === 'error') {
            throw new Error(chunk.reason.failure?.message ?? '模型返回错误')
          }
        }
      }
      }
      await Promise.race([
        consumeStream(),
        new Promise((resolve) => {
          const tm = setTimeout(() => { genTimedOut = true; resolve() }, genMaxMs)
          tm.unref?.()
        }),
      ])
      if (genTimedOut) {
        this.log.warn?.(
          `bridge：生成超过 ${Math.round(genMaxMs / 1000)}s 还没结束 —— 不再等（正文 ${text.length} 字 / 推理 ${reason.length} 字）`
            + '；这条按已收到的内容处理，队列继续'
        )
      }
    } finally {
      // ⚠️ 无论成功失败都要记 —— 失败的调用同样消耗了上游 token
      try {
        this._trackUsage(opened, messages, text, usage, Date.now() - t0, { ttftMs, reasonChars: reason.length })
      } catch { /* ignore */ }
      // ⚠️ 非正常结束要留痕。
      //
      // 实测踩过：群里收到「[表情:」这串字面文本 —— 生成被截断在标记中间，
      // 残缺的标记不匹配发送时的正则，就被当普通文本发出去了。
      // 不打日志的话完全看不出"这次是截断的"。
      const kind = finish?.kind
      if (kind && kind !== 'stop') {
        this.log.warn?.(`bridge：本次生成非正常结束（${kind}）—— 正文 ${text.length} 字、推理 ${reason.length} 字` +
          (text ? `，结尾：${JSON.stringify(text.slice(-20))}` : '，正文为空'))
      } else if (text && /\[表情[:：]?\s*$|\[表情包[:：]?\s*$/.test(text)) {
        this.log.warn?.(`bridge：输出结尾是残缺的表情标记，已修补/清除 — ${JSON.stringify(text.slice(-20))}`)
      }
    }
    // 把封面图**随返回值带出去**，而不是挂在 this 上。
    //
    // ⚠️ 用实例变量（this._pendingImage）会有竞态：_generate 到 _send 中间
    //    隔了几百行调用，群里并发处理两条消息时，后一条搜到的图可能被
    //    前一条的发送流程取走 —— 张冠李戴。
    const cover = pendingCover
    pendingCover = null
    const cleaned = cleanModelText(text)

    /*
     * ★ **正文空、推理一大堆 → 重试一次**（2026-11-04 傍晚，私聊实测）。
     *
     * 现场（19:06:33 私聊）：
     * ```
     * 决策 → 发言 (p=1.00)
     * 本次生成非正常结束（stop）—— 正文 0 字、推理 2138 字，正文为空
     * 生成失败 — 上游只给了 finish_reason(stop) 但没有正文
     * ```
     * 然后**一个字都没发出去**，用户看到的就是「她突然不说话了」。
     *
     * 这不是 maxTokens 不够（16000 的预算，推理才 2138 字），
     * 是模型把话全花在"想"上，最后没吐正文。
     *
     * 所以：正文空 + 推理不短 → 带一句"直接给正文"重试一次。
     * 只重试一次（attempt 计数），再空就交给上层按沉默处理。
     */
    if (!cleaned && reason.length > 100 && attempt < 1) {
      this.log.warn?.(
        `bridge：正文空、推理 ${reason.length} 字 → 重试一次（让它直接给正文）`,
      )
      return await this._generate(
        msg, mem, scene, self, extraBlocks,
        (extraNote ? extraNote + '\n' : '')
        + '★ 上一轮你把话全花在"想"上了，最后**一个字都没说出来**。'
        + '这一轮**直接给正文**：短、口语、一两句就够；'
        + '不要长篇内心独白，也不要分析自己的处境或能不能做到，张口就说。',
        attempt + 1,
      )
    }

    return { text: cleaned, cover }
  }

  /**
   * 记一次用量。
   *
   * 网关流式接口多数不返回 usage，所以这里按字符数**估算**：
   * 中文约 1 字 ≈ 1.5 token，英文约 4 字符 ≈ 1 token。
   * 宁可粗一点，也好过总览页永远显示 0。
   */
  _trackUsage(opened, messages, outText, usage, ms, extra = {}) {
    const tracker = this.usage
    if (!tracker?.record) return

    let tokensIn = Number(usage?.prompt_tokens ?? usage?.inputTokens ?? usage?.input_tokens) || 0
    let tokensOut = Number(usage?.completion_tokens ?? usage?.outputTokens ?? usage?.output_tokens) || 0

    if (!tokensIn) {
      // 估算输入：所有消息的文本长度（图片按 200 token 粗算）
      let chars = 0, imgs = 0
      for (const m of messages) {
        const c = m.content
        if (typeof c === 'string') chars += c.length
        else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'text') chars += String(b.text ?? '').length
            else if (b.type === 'image') imgs++
          }
        }
      }
      tokensIn = Math.round(chars / 1.6) + imgs * 200
    }
    if (!tokensOut) tokensOut = Math.round(String(outText ?? '').length / 1.6)

    // ⚠️ 路由信息在 `opened.picked` 里，不在 `opened` 顶层。
    //    openFirstAvailable 返回 { stream, picked, attempts }。
    //    写成 opened.provider / opened.model 会永远得到 undefined，
    //    于是 estimateCost 拿不到价格、费用恒为 0 —— 面板上显示「¥0」。
    const picked = opened.picked ?? {}
    tracker.record({
      provider: picked.provider,
      model: picked.model,
      source: 'qq',
      tokensIn,
      tokensOut,
      // 性能统计（纯记录，不做限制）：首字延迟 / 推理长度 / 正文长度
      ttftMs: extra.ttftMs ?? null,
      reasonChars: extra.reasonChars ?? 0,
      textChars: String(outText ?? '').length,
      ok: true,
      ms,
    })
  }

  /** 决定用哪些候选渠道（复用路由策略）。 */
  async _candidatesAsync() {
    // ⚠️ 冷启动竞态：目录是异步刷新的，空的目录会让 auto 解析出零候选。
    //    第一次收到消息时目录可能还没好 —— 主动等一次（最多 15 秒）。
    if ((this.gateway.catalog?.length ?? 0) === 0 && typeof this.gateway.refreshCatalog === 'function') {
      try {
        await Promise.race([
          this.gateway.refreshCatalog(),
          new Promise((r) => setTimeout(r, 15000)),
        ])
        this.log.info?.(`bridge：目录未就绪，已等待刷新（现有 ${this.gateway.catalog?.length ?? 0} 个模型）`)
      } catch { /* 刷新失败就按现有数据继续 */ }
    }
    return this._candidates()
  }

  /** 决定用哪些候选渠道（复用路由策略）。 */
  _candidates() {
    const free = this.gateway.providers ?? []
    /*
     * ★ **把「路由策略」翻译成真开关**（2026-11-02 接上）。
     *
     * 面板上那个下拉以前是**纯装饰** —— 写进配置后没有任何人读它
     * （`resolveCandidates` 和这里读的都是 freeProviders / freeOrder /
     *  selfModels / catalog / fallback / disabledProviders）。
     * 详见 `../gateway/strategy.js` 里的说明。
     *
     * 现在：策略 → { fallback 开不开, 要额外排除谁 }。
     * ⚠️ 排除名单是**算出来的临时值**，不写回配置 ——
     *    否则用户切回别的策略时那份名单还留着，渠道会莫名其妙消失。
     */
    const routing = deriveRouting(this.cfg.strategy, {
      fallbackEnabled: this.cfg.fallback?.enabled,
      disabled: this.cfg.disabledProviders ?? [],
      providers: free,
    })
    // bridge 默认固定用一个"聊天模型"，避免每次决策都变幻
    const prefer = this.cfg.model ?? 'auto'
    if (prefer && prefer !== 'auto') {
      return resolveCandidates(prefer, {
        freeProviders: free,
        freeOrder: this.cfg.freeOrder ?? [],
        disabledProviders: routing.disabled,
        catalog: this.gateway.catalog,
        selfModels: this.gateway.defaultModels?.() ?? {},
        // 策略说关官方兜底，就在这里把 enabled 覆盖掉
        fallback: { ...(this.cfg.fallback ?? {}), enabled: routing.fallbackEnabled },
      })
    }
    // auto：按**用户配置的优先级**取第一个可用渠道。
    // ⚠️ 不能写死 'gemini' —— 用户可能把别的渠道排在前面，
    //    或者根本没有 gemini（自备渠道场景）。
    // ⚠️ 也不能写死模型名（如 'gemini-3.8-flash-medium'）—— 自备渠道
    //    （ollama 等）没有这个名字，会得到 400。统一从 defaultModels 取。
    const selfModels = this.gateway.defaultModels?.() ?? {}
    const disabled = routing.disabled
    const ordered = applyFreeOrder(free, this.cfg.freeOrder).filter((p) => !disabled.includes(p))

    // ⚠️ 逐个渠道找"能用的模型"，不能只看第一个。
    //
    //    踩过的坑：`PROVIDER_MODEL_HINTS` 里大多数渠道是**空数组**
    //    （那是刻意的 —— 表示"没有内置偏好，去模型目录现查"）。
    //    原来只取 ordered[0] 的 hint，hint 为空就直接返回 [] ——
    //    于是 buddy 排第一时永远"没有可用的 LLM 渠道"，哪怕目录里
    //    明明有它 18 个模型。日志表现为「已附图 1 张」紧跟
    //    「生成失败 — 没有可用的 LLM 渠道」。
    //
    //    正确的顺序：内置偏好 → 自备渠道默认模型 → 模型目录。
    const catalog = this.gateway.catalog ?? []
    for (const p of ordered) {
      const hinted = (PROVIDER_MODEL_HINTS[p] ?? [])[0]
      const fromCatalog = catalog.find((m) => m.provider === p)?.id
      const model = selfModels[p] || hinted || fromCatalog || ''
      if (model) {
        return [{ provider: p, model, kind: 'free', why: 'bridge 按配置优先级取首个可用渠道' }]
      }
    }
    return []
  }

  /**
   * 发送（可分句，像人一样）。
   *
   * 文本里的表情标记会被转成**真正的 QQ 表情段**：
   *   [表情:4]        → { type:'face', data:{ id:'4' } }        QQ 内置小黄脸
   *   [表情包:猫猫]    → 找一张匹配的收藏表情发出（见 _pickMface）
   *
   * 为什么要支持：群里本来就习惯用表情包代替打字。只会发纯文字的
   * 机器人在这种群里显得很突兀 —— 而且模型自己也会主动吐
   * `[表情:4]` 这类标记来表达情绪，不转换的话用户看到的是一串标签。
   */
  /**
   * 发送一条（可能是多段）消息。
   *
   * @returns {Promise<string[]>} 发出去的每条消息的 message_id。
   *   ⚠️ 必须返回 id —— 否则"用户引用我的话回复"就匹配不上
   *   （见 _handle 里 quotedMine 的判断）。
   */
  /**
   * @param {object} msg
   * @param {string} text
   * @param {object|null} [cover] 搜索时抓到的封面图 { url, title }
   */
  /**
   * 余额低时开口讨钱。
   *
   * ## 需求（2026-10-25 用户定）
   *
   *   · 触发：搜索时查余额，< ¥3 就讨
   *   · 对象：@ **最近跟它互动最多的人**（不是群主 —— 群主不一定在场，
   *     而最近聊得多的人一定在线、且更可能愿意理它）
   *   · 频次：每天最多 3 次，跨重启有效（状态落盘到 beg.json）
   *   · 话术：每次不同（BegState 记当天用过的模板 id）
   *
   * ## 为什么用 @ 而不是悄悄念叨
   *
   * 之前只会在**正常回复里插一句抱怨** —— 但那条路要求「它本来就要说话」。
   * 它常常一路沉默，于是余额低这件事永远说不出口。
   * 这里改成主动发一条：不依赖决策层，说完就完。
   *
   * ## 为什么失败不影响主流程
   *
   * 讨钱是附带动作。发送失败（被禁言、被风控）不该让刚做完的搜索白费，
   * 所以整段包在 try 里，出错只记日志。
   *
   * @param {object} msg    触发它的那条消息（提供群号/会话）
   * @param {number} cny    当前余额
   */
  async _maybeBeg(msg, cny) {
    try {
      const r = decideBeg({
        cny,
        threshold: this.cfg.search?.lowBalanceCny ?? 3,
        state: this._begState,
        tracker: this._interactions,
        exclude: [this.selfId].filter(Boolean),
      })

      if (!r.beg) {
        this.log.info?.(`bridge：不讨钱 —— ${r.reason}`)
        return false
      }

      // 只在群里讨：私聊没有「@ 观众」的意义，而且更容易被判骚扰。
      if (msg.kind !== 'group') {
        this.log.info?.(`bridge：不在群里（${msg.kind}），跳过讨钱`)
        return false
      }

      // @ 目标 + 话术。OneBot 的 at 段要求 QQ 号是字符串。
      const payload = [
        { type: 'at', data: { qq: String(r.target.id) } },
        { type: 'text', data: { text: ' ' + r.text } },
      ]

      const res = await this.onebot.sendGroup(msg.groupId, payload)
      // sendGroup 的不同实现返回结构不一，有的给 message_id，有的给 {message_id}
      const ok = res && (res.message_id !== undefined || res.messageId !== undefined || res.ok !== false)
      if (!ok) {
        this.log.warn?.(`bridge：讨钱发送失败 — ${JSON.stringify(res).slice(0, 120)}`)
        return false
      }

      // 只有真的发出去了才记账 —— 否则失败也算进「今天 3 次」里，
      // 一整天就因为三次网络抖动而再也讨不了。
      this._begState.commit(r.line)
      this.log.warn?.(
        `bridge：余额 ¥${cny} 偏低 → 已 @${r.target.name}(${r.target.id}) 讨钱，` +
        `今日第 ${this._begState.snapshot().count}/${this._begState.maxPerDay} 次，话术「${r.line.id}」`,
      )
      this.stats.begged = (this.stats.begged ?? 0) + 1
      return true
    } catch (e) {
      this.log.warn?.(`bridge：讨钱流程出错（忽略）— ${String(e?.message ?? e)}`)
      return false
    }
  }

  /**
   * ★★ 「**约定时间到了就催一句**」（2026-11-03 加，用户确认的设计）
   *
   * ## 用户原话
   * · 「太安静了到时间不会催促人，只会在那里安静的等待」
   * · 「前面时间是**只对话里面约定的时间**」
   * · 「约定时间就是这个意思」「你理解的是对的」
   *
   * ## 全链路
   * ```
   * 他说「我洗漱五分钟」→ 她在回复末尾写 [等:5]
   *   → `_send` 剥掉标记（绝不发给群友）+ `_scheduleNudge` 记一条待催
   *   → 到点、且他仍然一句话没说 → `_tickNudges` 走 `_speakUp` 催一句
   *   → 他中途说话了 → onEvent 里 `_cancelNudge` 立刻作废
   * ```
   *
   * ## 「频率不要太多」（用户原话）—— 三道闸
   * · `nudge.maxPerDay`（默认 4）
   * · `nudge.minGapMinutes`（默认 5）—— 两次催之间至少隔这么久
   * · `nudge.maxMinutes`（默认 240）—— 太远的约定不接
   *   （他不是在跟你约 6 小时后；那是"改天"不是"等我一下"）
   *
   * ⚠️ **同一会话只留最近一次约定**：他改口「再等十分钟」= 改约，不是排两个。
   * ⚠️ 待催表是**内存态**，重启会丢。约定都是几分钟到几小时的东西，
   *    为此加一个落盘文件的复杂度不划算（真丢了也就是"这一次没催"）。
   */
  _scheduleNudge(msg, waits) {
    const cfg = this.cfg.nudge ?? {}
    if (cfg.enabled === false) return
    const scope = msg?.scope
    if (!scope) return
    const maxMin = Number(cfg.maxMinutes ?? 240)
    const min = waits
      .map(Number)
      .filter((n) => n >= 1 && n <= maxMin)
      .sort((a, b) => a - b)[0]
    if (!min) {
      this.log.info?.(`bridge：约定「${waits.join('/')}」分钟不在 1~${maxMin} 内，不排催`)
      return
    }
    if (!this._nudges) this._nudges = new Map()
    this._nudges.set(scope, {
      scope,
      kind: msg.kind,
      groupId: msg.groupId,
      userId: msg.userId,
      minutes: min,
      dueAt: Date.now() + min * 60_000,
    })
    this.log.info?.(`bridge：记下约定 —— ${scope}，${min} 分钟后他还没动静就催一句`)
  }

  /** 他说话了 / 会话翻篇了 → 作废（只在对方**一直没动静**时才该催）。 */
  _cancelNudge(scope, why = '') {
    if (!this._nudges?.has(scope)) return false
    const rec = this._nudges.get(scope)
    this._nudges.delete(scope)
    this.log.info?.(`bridge：约定作废（${why || '取消'}）—— 原定 ${rec.minutes} 分钟后催`)
    return true
  }

  /** 「频率不要太多」那道闸：每天几次 + 两次之间至少隔多久。 */
  _nudgeAllowed(now = Date.now()) {
    const cfg = this.cfg.nudge ?? {}
    const st = (this._nudgeStat ??= { day: '', count: 0, lastAt: 0 })
    const day = new Date(now).toDateString()
    if (st.day !== day) {
      st.day = day
      st.count = 0
    }
    const max = Number(cfg.maxPerDay ?? 4)
    if (st.count >= max) return { ok: false, why: `今天已经催过 ${st.count} 次（上限 ${max}）` }
    const gap = Number(cfg.minGapMinutes ?? 5) * 60_000
    if (gap > 0 && st.lastAt && now - st.lastAt < gap) {
      return { ok: false, why: `距上次催还不到 ${Math.round(gap / 60_000)} 分钟` }
    }
    return { ok: true }
  }

  /**
   * 扫一遍到点的约定，催一句。由 `_startNudgeTimer` 每 30 秒调一次。
   *
   * 催话**复用主动发言那条生成链**（`_speakUp`）—— 不另写一条，
   * 好处是提示词拼装、`[SILENT]` 处理、分段发送、记账全都现成。
   */
  async _tickNudges(now = Date.now()) {
    if (!this._nudges?.size) return
    for (const [scope, rec] of [...this._nudges]) {
      if (now < rec.dueAt) continue
      this._nudges.delete(scope)
      const allow = this._nudgeAllowed(now)
      if (!allow.ok) {
        this.log.info?.(`bridge：约定到点了，但这次不催（${allow.why}）`)
        continue
      }
      const over = Math.max(1, Math.round((now - (rec.dueAt - rec.minutes * 60_000)) / 60_000))
      /*
       * 提示词：**要短**、要就事论事。她这个人格爱长篇，所以这里明说
       * 「一句话就够」，并且给回 `[SILENT]` 的出口（不想催也是正常选择）。
       */
      const hint = '## 你跟他说好的时间到了\n'
        + `你上一条说好「${rec.minutes} 分钟后」，现在已经过去 ${over} 分钟，他一句话都没说。\n`
        + '〔提示：催一句。短、就事论事（「人呢」「五分钟到了啊」这种），别撒娇别长篇。\n'
        + ' 真觉得没必要催，就回 [SILENT]。〕'
      const st = (this._nudgeStat ??= { day: '', count: 0, lastAt: 0 })
      st.count += 1
      st.lastAt = now
      this.log.info?.(`bridge：约定到点 —— 催一句（今天第 ${st.count} 次）`)
      try {
        await this._speakUp({ ...rec }, null, hint)
      } catch (e) {
        this.log.warn?.(`bridge：催话失败（忽略）— ${String(e?.message ?? e)}`)
      }
    }
  }

  _startNudgeTimer() {
    if (this._nudgeTimer) return
    this._nudgeTimer = setInterval(() => { void this._tickNudges() }, 30_000)
    this._nudgeTimer.unref?.()
  }

  /**
   * 发消息前挂一个「正在输入…」（实验性，`qq.actions.typing` 控制）。
   *
   * NapCat 的 `set_input_status` 参数是 `{ user_id, event_type }`（1 = 输入中）。
   * 这个接口在部分版本/协议实现上会直接报错，所以：
   *   · **不 await** —— 绝不能为了一个"正在输入"拖慢回复
   *   · 失败一次就整会话关掉，只 warn 一次（别每条都刷日志）
   */
  _typingIndicator(msg) {
    if (this._typingBroken) return
    try {
      const params = { user_id: String(msg?.userId ?? ''), event_type: 1 }
      if (msg?.groupId) params.group_id = String(msg.groupId)
      Promise.resolve(this.onebot?._sendPreferHttp?.('set_input_status', params))
        .then((r) => {
          const ok = r?.status === 'ok' || r?.retcode === 0 || r?.retcode === undefined
          if (!ok) throw new Error(JSON.stringify(r)?.slice(0, 80))
        })
        .catch((e) => {
          this._typingBroken = true
          this.log.warn?.(`bridge：「正在输入」这个协议端不支持，已关掉 — ${String(e?.message ?? e)}`)
        })
    } catch {
      this._typingBroken = true
    }
  }

  /**
   * 同一条回复的**括号起手式**如果和最近 3 条自己发过的重复，就把这次的去掉。
   *
   * 实测（2026-11-05 群）：连续三条都以「（撇嘴）」开头 —— 用户
   * 「群里那样就很好」之后紧跟着就是这个复读，所以代码兜一层，
   * 不指望提示词每次都听话。去掉后如果正文空了，就原样保留。
   */
  _stripRepeatedOpener(text, mem) {
    const s = String(text ?? '')
    const m = /^（([^）]{1,12})）/.exec(s)
    if (!m) return text
    const opener = `（${m[1]}）`
    const mine = (mem?.recent?.(8) ?? []).filter((x) => x?.isMe)
    const repeated = mine.some((x) => String(x.text ?? '').trim().startsWith(opener))
    if (!repeated) return text
    const rest = s.slice(m[0].length).trim()
    return rest || text
  }

  async _send(msg, text, cover = null) {
    const reply = this.cfg.reply ?? {}
    const maxChars = reply.maxChars ?? 500
    /** @type {string[]} */
    const sentIds = []

    /*
     * ★ 先摘出「约定时间」标记 `[等:N]`（2026-11-03）。
     *
     * 放在**发送漏斗**这里，是因为每条出站路径都走它 ——
     * 正常回复、主动发言（`_speakUp`）、B 站补发 ——
     * 一处剥干净，就不会有哪条路漏出「[等:5]」这种字面量。
     */
    const wait = stripWaitMarkers(text)
    text = wait.text
    /*
     * ⚠️ 把**剥完标记的正文**记到 msg 上，给调用方写记忆用（2026-11-04）。
     *
     * 现场：`[等:10]` 在这里被剥掉（用户看不到），但 `_handle` 写进短期记忆的
     * 是**剥之前的 text** —— 于是她自己的历史里有 3 条带 `[等:10]`，
     * 下一轮模型看得见，就继续模仿这个形状，上下文也被自己的标记污染。
     *
     * 走 msg 这个属性而不是改返回值：`_send` 的返回值（message_id 数组）
     * 有 5 个调用点在用，改形状容易漏。
     */
    try { msg.__sentText = text } catch { /* 只读对象就跳过，退回旧行为 */ }
    // 「正在输入…」—— 实验性，默认关（qq.actions.typing）
    if (this.cfg.actions?.typing === true) void this._typingIndicator(msg)
    if (wait.waits.length) this._scheduleNudge(msg, wait.waits)

    // 先按表情标记切分，再做整体分句，最后接上配图。
    // 逻辑抽到 `buildOutgoingSegments()` 是为了能单测（见 tests/check-segments.mjs）。
    const segments = buildOutgoingSegments(text, cover, {
      maxChars,
      segment: reply.segment === true,
    })

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      let payload
      if (seg.kind === 'image') {
        // OneBot 的 image 段直接收 URL
        payload = [{ type: 'image', data: { file: seg.url } }]
      } else if (seg.kind === 'face') {
        payload = [{ type: 'face', data: { id: String(seg.id) } }]
      } else if (seg.kind === 'mface') {
        const m = await this._pickMface(seg.name)
        if (!m) continue          // 找不到对应表情就跳过，不发乱码
        /*
         * ★ 记下**刚发出去的那张收藏表情**（2026-11-04）。
         *
         * 用途：`[改标签:…]` 在私聊里可以改"她刚才发的那张" ——
         * 用户嘴上说「你那标签错了」时，她手上得有个可指的对象。
         * 只记 URL 和时间戳；私聊只有一个人在用，不需要按人分开。
         */
        const file = m?.[0]?.data?.file
        if (typeof file === 'string' && /^https?:/i.test(file)) {
          this._lastMface = { scope: String(msg?.scope ?? ''), url: file, at: Date.now() }
        }
        payload = m
      } else {
        if (!seg.text.trim()) continue
        payload = seg.text
      }

      /*
       * ⚠️ **整条消息只有一个 face 段 → NapCat 拒收**（2026-11-02 实测复现）。
       *
       * ## 现场
       * B 站长视频的补发：她生成了正文、后台也听完了，但那条消息**以表情开头**，
       * 于是第一段就是"单独一个 face" → NapCat 回
       * `消息体无法解析, 请检查是否发送了不支持的消息类型` →
       * `_send` 按段抛错 → **后面的正文一个字都没发出去**。
       * 用户看到的是「她没读视频」，日志里只有一句「补发失败」。
       *
       * ## 逐形态试出来的（对着 NapCat 实测）
       * ```
       * 只有 face（数组 / id 数字 / CQ 字符串）  → ❌ 全拒
       * 空文字 + face                          → ✅ 通
       * face + 空格                            → ✅ 通
       * 文字 + face                            → ✅ 通
       * 只有 image                             → ✅ 通（图不受影响）
       * ```
       * **规律：单独一个 face 不行，只要旁边有别的段就行。**
       *
       * 所以这里给它前面挂一个**空文字段** —— 不显示任何内容，但让消息
       * 不再是"只有一个 face"。这是实测唯一不改变语义的过法。
       */
      if (Array.isArray(payload) && payload.length === 1 && payload[0]?.type === 'face') {
        payload = [{ type: 'text', data: { text: '' } }, payload[0]]
      }

      const res = msg.kind === 'group'
        ? await this.onebot.sendGroup(msg.groupId, payload)
        : await this.onebot.sendPrivate(msg.userId, payload)

      if (res?.status === 'failed' || (typeof res?.retcode === 'number' && res.retcode !== 0)) {
        // 图片发失败（外链失效、被反盗链拦）不影响文字回复已经发出的事实，
        /*
         * ⚠️ **一个附件段发失败，不该把整条回复判成失败**（2026-11-02 实测事故）。
         *
         * ## 现场
         * B 站长视频的补发：她生成了内容、后台也听完了（1030 字），
         * 但那条消息**开头带了个表情段**，NapCat 回了
         * 「消息体无法解析, 请检查是否发送了不支持的消息类型」。
         * 而 `_send` 是按段顺序发的 —— **表情是第一段**，它一失败就 `throw`，
         * **后面的正文根本没发出去**。
         *
         * 用户看到的是「她没读视频」／「她答了但没发出来」，
         * 日志里却只有一句「补发失败」—— 两边的认知完全对不上。
         *
         * ## 原来的规则（只保了图片）
         * ```
         * seg.kind === 'image' → warn + continue      （跳过，继续发后面）
         * 其他（face / mface）  → throw                ← 整条中断
         * ```
         * **face 和 image 在这里没有区别** —— 都是"这条消息的装饰"，
         * 正文才是内容。所以三类附件一律跳过继续。
         *
         * ⚠️ 只有**正文段**失败才算真失败（那种抛错是对的：一个字都没发出去，
         *    调用方应该知道）。
         */
        if (seg.kind === 'image' || seg.kind === 'face' || seg.kind === 'mface') {
          this.log.warn?.(`bridge：${seg.kind} 段发送失败（跳过，继续发正文）— ${JSON.stringify(res).slice(0, 120)}`)
          continue
        }
        throw new Error(`OneBot 返回失败：${JSON.stringify(res).slice(0, 200)}`)
      }
      // 记下这条的 message_id（OneBot 放在 data.message_id）
      const mid = res?.data?.message_id ?? res?.message_id
      if (mid != null) sentIds.push(String(mid))
      // 多条之间像人一样停顿
      if (i < segments.length - 1) {
        await sleep(400 + Math.random() * 600)
      }
    }
    // 一条都没发出去要留痕 —— 否则调用方以为「回过了」，实际上群里什么都没看到。
    if (sentIds.length === 0) {
      this.log.warn?.(
        `bridge：这条回复没有任何可发送内容（正文 ${JSON.stringify(String(text ?? '').slice(0, 20))}`
        + `，配图=${cover?.url ? '有' : '无'}）—— 什么都没发`,
      )
    }
    return sentIds
  }

  /**
   * 取当前账号的**收藏表情**列表（NapCat 的 fetch_custom_face）。
   *
   * ⚠️ 这条路是实测挖出来的：OneBot 标准的 `mface` 段要 emoji_id +
   *    emoji_package_id，那是腾讯内部编号，普通用户拿不到 —— 所以按标准
   *    做法根本发不出表情包。
   *
   *    但 NapCat 有私有接口 `fetch_custom_face`，直接返回一组**可下载的
   *    GIF 地址**（实测 HTTP 200、content-type: image/gif）。于是我们
   *    把它当普通图片段发出去就行，绕开了内部编号。
   *
   * 结果缓存 10 分钟 —— 收藏会变，但没必要每次发表情都问一遍。
   */
  /**
   * 让**视觉模型**给一张表情图打标签（2026-10-31）。
   *
   * 提示词照麦麦的 `emoji_content_analysis`：
   * 「提取主要表达的情绪/语气/常见使用场景标签，最多 5 个，逗号分隔，不要解释」
   *
   * @param {object} block 已经做好的 ImageBlock（`gateway.makeImageBlock`）
   * @returns {Promise<string[]>}
   */
  async _callVisionTags(block) {
    /*
     * ⚠️ **头一句必须是「只输出答案，不要写思考过程」**（2026-10-31）。
     *
     * 当前模型是**推理模型**，第一版提示词让它「提取…标签」时，
     * 它把 reasoning 一起吐进了 `chunk.text`，于是存进库的"标签"是：
     * 「分析用户请求**：、可能是动画的一帧）、语气或常见使用场景标签…」
     * —— 全是我的提示词的回声。
     *
     * 另外给了**示例输出**（`开心、得意、炫耀`）和「每个词最多 4 个字」，
     * 比只说「最多 5 个」更能压住它写长句。
     */
    const prompt = '只输出答案本身，不要写任何思考过程、分析、标题或格式说明。\n'
      + '下面这张是表情包图片（动图的话这里只给了一帧）。\n'
      + '用 1~5 个**中文短词**说出它表达的情绪 / 语气 / 使用场景，用顿号分隔。\n'
      + '每个词最多 4 个字。\n'
      + '示例输出：开心、得意、炫耀\n'
      + '现在输出：'
    const candidates = this._candidates?.() ?? []
    if (!Array.isArray(candidates) || candidates.length === 0) return []
    const opened = await openFirstAvailable({
      llm: this.gateway,
      candidates,
      request: {
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, block] }],
      },
    })
    let text = ''
    /*
     * ⚠️ **必须跳过推理草稿**（2026-10-31，同一个坑 index.js:841 早就踩过）。
     *
     * `reasoning-delta` 这个 chunk **也有 `.text`**：
     * ```
     * { type: 'reasoning-delta', text: '我们需要回答用户，要求给…' }
     * { type: 'text-delta',      text: '开心、得意' }
     * ```
     * 第一版只写了 `if (typeof chunk?.text === 'string') text += chunk.text`，
     * 于是把草稿拼了进来 —— 存进标签库的全是
     * 「分析用户请求**：、可能是动画的一帧）、语气或常见使用场景标签…」。
     * **规则就是那一条：草稿不是答案。**
     */
    for await (const chunk of opened.stream) {
      if (typeof chunk === 'string') { text += chunk; continue }
      const kind = chunk?.type
      if (kind === 'reasoning-delta' || kind === 'reasoning') continue
      if (typeof chunk?.text === 'string') text += chunk.text
    }
    /*
     * ⚠️ **长了就丢掉**：真正的标签列表不会超过几十个字。
     * 超过 80 字基本可以断定是 reasoning 漏出来了（宁可这张不打标签）。
     */
    if (text.length > 80) {
      this.log.debug?.(`表情标签：输出过长（${text.length} 字，疑似思考过程），丢弃`)
      return []
    }
    return splitTags(text)
  }

  /**
   * **批处理**给收藏表情打标签（2026-10-31）。
   *
   * ## 为什么不"收一张打一张"
   * 每次收藏都调一次视觉模型太费。用户的原话：
   * 「**现在已有的表情打标签分类，以后的等积累到一定程度再次打标签**」。
   *
   * 所以：没标签的攒够 `minPending` 张才动手，一次最多 `batchLimit` 张。
   * 触发点是 `_customFaces()` 刷新之后（那张表有 10 分钟缓存，天然限频）。
   *
   * @param {{minPending?:number, batchLimit?:number}} [opts]
   */
  async _tagStickerBatch({ minPending = 3, batchLimit = 5 } = {}) {
    if (!this.stickerTags || !this.gateway?.makeImageBlock) return
    if (this._taggingBusy) return
    this._taggingBusy = true
    try {
      const urls = await this._customFaces()
      if (!Array.isArray(urls) || urls.length === 0) return
      const todo = urls.filter((u) => !this.stickerTags.get(u))
      if (todo.length < minPending) return // ★ 攒够才打（用户要求）
      let done = 0
      for (const url of todo.slice(0, batchLimit)) {
        try {
          const img = await this.onebot.fetchImage(url, {
            maxBytes: this.cfg.reply?.maxImageBytes ?? 8 * 1024 * 1024,
          })
          const m = /^data:([^;]+);base64,(.*)$/s.exec(img?.dataUrl ?? '')
          if (!m) continue
          const block = await this.gateway.makeImageBlock({
            base64: m[2],
            mediaType: m[1],
            name: 'sticker-tag',
          })
          if (!block) continue
          const tags = await this._callVisionTags(block)
          if (tags.length && this.stickerTags.set(url, tags)) {
            done += 1
            this.log.info?.(`表情标签：${stickerKey(url).slice(-16)} → ${tags.join('、')}`)
          }
        } catch (e) {
          this.log.debug?.(`表情标签：单张失败（跳过）— ${String(e?.message ?? e)}`)
        }
      }
      const left = Math.max(0, todo.length - done)
      if (done > 0) {
        this.log.info?.(`表情标签：本批打了 ${done} 张，还剩 ${left} 张待打`)
      }
      /*
       * ★★ **打完就顺手收敛同类**（2026-11-02 用户要求：「同类型的表情只留 3 个」）。
       *
       * 为什么挂在这里：`minPending = 3` 已经是"攒够 3 张才打"，
       * 所以**这一批打完就等于又积累了一轮**，正好在这里收敛一次。
       * 比单独起一个定时器简单，也不会漏。
       *
       * ⚠️ 只清理**标签库**（不删表情本身）—— 图还在她收藏里，
       *    只是不再进提示词清单、也不被按标签挑到。删图要经过用户，不能顺手干。
       */
      if (done > 0 && typeof this.stickerTags.dedupeByTag === 'function') {
        const r = this.stickerTags.dedupeByTag(3)
        if (r.removed.length) {
          this.log.info?.(`表情标签：同类收敛，清掉 ${r.removed.length} 张（${r.classes} 类，每类留 3 张）`)
        }
      }
      /*
       * ★ 还有就 **30 秒后接着打**（2026-10-31）。
       *
       * 用户要「**现在已有的**表情打标签分类」—— 48 张按每批 5 张、
       * 靠 `_customFaces` 的 10 分钟缓存去触发，要一个半小时。
       * 这里自己续跑：只要**这批有进展**（`done > 0`）就继续，
       * 全部打完或这批一张没成就停（避免失败时空转烧钱）。
       *
       * 30 秒留够 `finally` 把 `_taggingBusy` 放掉，不会自己把自己挡住。
       */
      if (done > 0 && left > 0) {
        setTimeout(() => { void this._tagStickerBatch?.() }, 30_000)
      }
    } catch (e) {
      this.log.debug?.(`表情标签：批处理失败（忽略）— ${String(e?.message ?? e)}`)
    } finally {
      this._taggingBusy = false
    }
  }

  /**
   * B 站链接 → 元信息（**免费接口**，5 分钟缓存）。没有 B 站链接就返回空串。
   *
   * 流程：文本里找 BV 号（或 `b23.tv` 短链跟跳）→ `x/web-interface/view`
   * → 拼成「标题/UP主/时长/播放/简介」。
   *
   * ⚠️ 缓存 5 分钟：同一条链接被反复提到时不要反复打人家接口（会被风控）。
   *
   * @param {string} text
   * @returns {Promise<string>}
   */
  /**
   * 禁漫域名缓存（懒建、进程内复用）。
   *
   * ⚠️ 为什么必须**落盘**（走 `this.cfg.home`）：那个站域名一直在换，
   *    实测 6 个候选里只有一个能跳转到当前域名 —— 每次都趟一遍
   *    就是 6 次超时。实测对比：缓存命中 1124ms / 首次 3991ms。
   *    whale-pod 一天可能重启十几次，只放内存等于白缓存。
   */
  _jmHosts() {
    if (!this._jmHostsCache) this._jmHostsCache = new JmHostCache(this.cfg.home ?? '')
    return this._jmHostsCache
  }

  /**
   * 梗百科 —— 命中就返回词条，没命中返回 `null`。
   *
   * ## ★★★ 它是"联网搜索"的**第一道闸**（2026-11-03）
   * ```
   *   像在问梗 → 本地查
   *                ├─ 命中 → 用词条，**这次不联网搜** ✓（省钱，而且比搜得准）
   *                └─ 没命中 → **不拦** → 走原来那条联网搜索路 ✓（兜底）
   * ```
   * 用户原话：「**我们还可以保留联网搜索兜底**」。
   *
   * ## 为什么值得省这一次
   * 一次搜索 ≈ ¥0.0074（接口 ¥0.005 + 处理结果的模型钱 ✓）。
   * 群里问梗是**高频**动作，本地查是**零成本零延迟**。
   *
   * ⚠️ 库打不开 / 没这个文件 → **静默返回 null**（行为跟加这个功能之前一模一样）。
   *    16MB 的词库放在数据目录（`<home>/memes.db`），**不进仓库**（版权归 cnmeme.wiki）。
   */
  _memeHint(text) {
    // ⚠️ **默认开**（`=== false` 才关）—— 用户要的就是这个功能
    if (this.cfg?.meme?.enabled === false) return null
    try {
      // 懒开库（只读），开过就一直用
      if (this._memeDb === undefined) {
        const file = path.join(this.cfg?.home ?? '', 'memes.db')
        this._memeDb = fs.existsSync(file) ? openMemeDb(file) : null
        if (!this._memeDb) {
          this.log.info?.('梗百科：没找到词库（memes.db），接梗功能关闭（联网搜索照旧）')
        } else {
          this.log.info?.('梗百科：词库已加载（联网查梗之前先走本地）')
        }
      }
      if (!this._memeDb) return null
      return memeHint(text, { conn: this._memeDb, log: (m) => this.log.info?.(`梗百科：${m}`) })
    } catch (e) {
      this.log.warn?.(`梗百科：查询出错（忽略）— ${String(e?.message ?? e).slice(0, 60)}`)
      return null
    }
  }

  async _biliContext(text) {
    if (!hasBiliLink(text)) return { ctx: '', job: null }
    const bvid = await resolveBvid(text)
    if (!bvid) return { ctx: '', job: null }
    const now = Date.now()
    if (!this._biliCache) this._biliCache = new Map()
    const hit = this._biliCache.get(bvid)
    /*
     * 缓存命中就直接用 —— 长视频那条后台任务早就把**更完整的上下文**
     * 写回缓存了（见 `_startVideoTranscribe`），所以补发那一条重新生成时
     * 自然读到的是"听完开头"的版本，不需要额外传参。
     */
    if (hit && now - hit.at < 300_000) return { ctx: hit.text, job: null }
    const info = await fetchVideoInfo(bvid)
    let ctx = ''
    /** 长视频的后台转写任务（{bvid, promise, at}）；短视频为 null */
    let job = null
    if (info) {
      /*
       * ★ **评论和弹幕才是重点**（用户原话：「光是标题和简介只是作者说明，
       *    评论和弹幕才是重点」）。
       *
       * 两个都**免登录**（实测：评论 20 条、弹幕 1200 条，均 code=0）。
       * 并行抓、各自失败不影响主体（`fetchTopComments`/`fetchDanmaku` 内部都吞错）。
       * 评论按热度取 5 条；弹幕按**出现次数**取 10 条（重复多的就是梗）。
       */
      try {
        const [comments, danmaku] = await Promise.all([
          fetchTopComments(info.aid, { limit: 5 }),
          fetchDanmaku(info.cid, { limit: 10 }),
        ])
        if (comments.length) info.comments = comments
        if (danmaku.length) info.danmaku = danmaku
        /*
         * ⚠️ **必须留痕**（2026-10-31）。
         * 上一版这里是静默的 —— 用户看到「只说了标题和时长、评论弹幕一个字没提」，
         * 而我从日志里**分不清**是"抓失败"还是"抓到了没进提示词"。
         * 记成 info 级：一次分享只打一行，不吵。
         */
        this.log.info?.(
          `B站：${bvid} 评论 ${comments.length} 条 / 弹幕 ${danmaku.length} 条`
          + `（aid=${info.aid} cid=${info.cid}）`,
        )
      } catch (e) {
        this.log.warn?.(`B站：抓评论/弹幕失败（只给元信息）— ${String(e?.message ?? e)}`)
      }

      /*
       * ★★ **视频里到底说了什么**（2026-11-01）。
       *
       * 用户原话：「视频内容还是看不见这种感觉，还是在读评论和弹幕」——
       * 评论弹幕是**别人怎么看**，不是**视频说了什么**。
       *
       * 官方字幕匿名拿不到（`subtitle.subtitles` 恒 0），AI 总结 `-403`，
       * **但音频流免登录** → 下载音频 → 本地 whisper 转写 → 等于"听懂"了。
       *
       * ## 三道限制（都是为了别拖垮回复）
       * 1. **只看 5 分钟以内的视频** —— 转写是 CPU 活，长视频能跑到分钟级
       * 2. **20 秒超时** —— 超时就当没有，绝不阻塞
       * 3. **缓存**（`transcribeVideoCached`）—— 同一条只转一次，内存 LRU 50 条
       *
       * 失败静默：没装 / 没模型 / 没语音（纯音乐、无声演示）都返回空串。
       */
      /*
       * ★★ 转写：**短视频同步、长视频异步**（2026-11-01 重构）。
       *
       * 原来只有一道 `duration <= 300` 的门槛，超了**什么都不做** ——
       * 于是长视频连一句内容都没有，只能读评论弹幕（用户原话：
       * 「视频内容还是看不见这种感觉，还是在读评论和弹幕」）。
       * 实测 26 分 46 秒那条：音频 12.9MB，**同时**超过 300 秒时长和 12MB 字节两道门。
       *
       * 为什么不能简单地"提高门槛"：26 分钟的音频要转 ~40-60 秒，
       * 同步等就得让回复多等这么久 —— 那是用户明确抱怨过的量级。
       *
       * 所以长视频走**异步**：
       *   ① 这一步**立刻**返回（`pendingLong` 让提示词如实说"你刚开始听"）
       *   ② 后台只取音频**开头 2MB**（≈前 4 分钟，实测转写 9.6s）并缓存
       *   ③ 转完更新缓存，由 `_handle` 那边补发一句（见 `_videoFollowUp`）
       */
      if (info.duration > 0 && info.duration <= 300) {
        /*
         * ★★★ 短视频：**交给后台，别在回复里等**（2026-11-02 改）。
         *
         * ## 原来错在哪
         * 这里给的是 `timeoutMs: 20_000` —— **只给 20 秒**。
         * 而实测转写本身要 **17～26 秒**（每次约 25 秒，其中约 20 秒是
         * whisper **模型加载**的固定成本，跟视频长短无关）。
         *
         * 于是：
         * ```
         * 15:41:38  转写出 29 字（17s）   ← 17 < 20  勉强挤过去 ✓
         * 08:48:17  没转出可用语音        ← 那次要 26s > 20 → 被掐 ✗
         * ```
         * **"有时能看有时不能"就是这么来的** —— 不是视频没说话，
         * 也不是没装 ASR，是**预算给少了**。
         *
         * ## 改法：跟长视频走同一条路
         * `pendingLong` 那套（先回一句 → 后台听完 → `_videoFollowUp` 补一条）
         * **本来就是为"不能等"设计的**，短视频一样受用：
         * 模型加载那 20 秒是**所有人**都要付的，凭什么短视频就得在回复里等？
         *
         * ⚠️ 只有**很短**的片段（≤15s）才走同步 —— 那种多半是"一句话"，
         *    而且运气好时 17s 能挤进 20s 的预算。挤不进也**不报错**，
         *    而是**落到后台去补**（见下面的 catch/else）。
         */
        const SHORT_SYNC_MAX_SEC = 15
        if (info.duration <= SHORT_SYNC_MAX_SEC) {
          try {
            const t0 = Date.now()
            const text = await transcribeVideoCached(
              bvid,
              info.cid,
              { fetchAudioCandidates, downloadAudio },
              { timeoutMs: 20_000, log: this.log },
            )
            if (text) {
              info.transcript = text
              this.log.info?.(
                `B站：${bvid} 转写出 ${text.length} 字（${Math.round((Date.now() - t0) / 1000)}s）`,
              )
            } else {
              /*
               * ⚠️ 同步没成**不代表这视频没内容** —— 转写去后台再试一次，
               *    别在这儿下"无语音"的结论（那正是原来那句话误导人的地方）。
               */
              this.log.info?.(`B站：${bvid} 同步没转出来（${info.duration}s）→ 转后台再试`)
              info.pendingLong = true
              job = this._startVideoTranscribe(bvid, info)
            }
          } catch (e) {
            this.log.warn?.(`B站：转写异常 → 转后台再试 — ${String(e?.message ?? e)}`)
            info.pendingLong = true
            job = this._startVideoTranscribe(bvid, info)
          }
        } else {
          /*
           * 15 秒以上：**直接走后台**。理由实测：转写固定成本约 25s，
           * 同步等就是让用户多等 25 秒 —— 那是他明确抱怨过的量级。
           */
          this.log.info?.(`B站：${bvid} ${info.duration}s → 先回一句，后台听（别在回复里等 25s 的模型加载）`)
          info.pendingLong = true
          job = this._startVideoTranscribe(bvid, info)
        }
      } else if (info.duration > 300) {
        info.pendingLong = true
        job = this._startVideoTranscribe(bvid, info)
        this.log.info?.(
          `B站：${bvid} 是长视频（${Math.round(info.duration / 60)} 分钟）→ 先回一句，后台听开头`,
        )
      } else {
        this.log.info?.(`B站：${bvid} 拿不到时长，跳过转写`)
      }

      /*
       * ★★ **画面（分镜图）** —— 2026-11-03，"看画面"模式（用户自己选的）。
       *
       * ## 数据来自 B 站自己的接口，不是我们抽帧
       * `x/player/videoshot` 直接给 10×10 的拼图 + 每格时间点，**免登录、不用 ffmpeg**。
       * 详见 `src/qq/videoshot.js` 的文件头（那里记了单位校验和三个坑）。
       *
       * ## 为什么放在转写之后、而且**是同步的**
       * 它只要 **~700ms**（实测 715/804ms）—— 跟转写那 25 秒完全不是一个量级，
       * 所以**不必走后台**。失败就静默跳过（没画面 ≠ 没内容）。
       *
       * ## 为什么要看 `bilibili.visual` 这个开关
       * 每张拼图都进模型 = **真花钱**（视觉 token）。默认 `'audio'`（只听），
       * 用户想要"看画面"才在设置里切到 `'visual'`。
       */
      if (this.cfg.bilibili?.visual === 'visual') {
        try {
          const shots = await fetchVideoShots({
            bvid,
            duration: Number(info.duration) || 0,
            maxImages: Number(this.cfg.bilibili?.maxShots) || 2,
            log: (lv, m) => this.log[lv]?.(m),
          })
          if (shots) {
            info.shotsNote = formatShotsNote(shots)
            info.shots = shots
          }
        } catch (e) {
          this.log.warn?.(`B站：${bvid} 分镜图出错（忽略）— ${String(e?.message ?? e).slice(0, 80)}`)
        }
      }

      ctx = formatVideoContext(info)
    }
    this._biliCache.set(bvid, { at: now, text: ctx })
    if (this._biliCache.size > 50) {
      this._biliCache.delete(this._biliCache.keys().next().value)
    }
    if (ctx) this.log.info?.(`B站：${bvid} → ${String(info?.title ?? '').slice(0, 40)}`)
    else this.log.info?.(`B站：${bvid} 没拿到元信息（跳过）`)
    /*
     * ★ 把分镜图一起带出去（2026-11-03）。
     *
     * ⚠️ 为什么不塞进 `ctx` 文本里 —— 图**没法变成文字**。
     *    `_generate` 那边会把 `shots.images` 用 `makeImageBlock` 入库，
     *    再从 `_collectImages` 的 `extraBlocks` 口子塞进上下文
     *    （就是车牌内页用的同一条路）。
     */
    return { ctx, job, shots: info?.shots ?? null }
  }

  /**
   * 长视频的**后台转写**：只取音频开头一段，转完把更完整的上下文写回缓存。
   *
   * ## 为什么异步（2026-11-01，用户提的设计）
   * 用户原话：
   * > 「时长太长的，就先回复我先看看，然后正常聊天，那边结束了再提视频内容。」
   *
   * 这比"同步多等十几秒"好得多：
   * ```
   * 同步：收到链接 → 等转写 10~60s → 才开始生成 → 用户干等
   * 异步：收到链接 → 立刻回「我去看看」→ 用户继续聊 → 转完补一句
   * ```
   * 真人就是这么干的，而且**即时回复那一侧的延迟是 0**。
   *
   * ## 只取开头一段
   * 长视频的音频动不动十几 MB，整条下有被 `maxBytes` 挡死的风险，转起来也慢。
   * 实测（26 分 46 秒那条）：`Range: 0-2MB` → 2.00MB，**≈前 4 分 09 秒**，
   * tiny 模型转写 **9.6s**，出来的内容是能读的（各 AI 自我介绍那段）。
   * 前缀长度可用 `qq.bilibili.prefixBytes` 调。
   *
   * ## 转完之后
   * 把 `prefixOnly` 的完整上下文**写回 `_biliCache`** ——
   * 补发那一条重新走 `_generate` 时会自然读到它，不需要额外传参。
   *
   * @param {string} bvid
   * @param {object} info  `fetchVideoInfo` 的结果（含 cid）
   * @returns {{bvid:string, promise:Promise<null|{text:string,ctx:string}>, at:number}}
   */
  _startVideoTranscribe(bvid, info) {
    if (!this._biliJobs) this._biliJobs = new Map()
    const existed = this._biliJobs.get(bvid)
    if (existed) return existed
    const prefixBytes = Number(this.cfg.bilibili?.prefixBytes ?? 2 * 1024 * 1024)
    const at = Date.now()
    const promise = (async () => {
      try {
        /*
         * ★ 2026-11-03：改用**带原因**的那版（`transcribeVideoDetailed`）。
         *
         * 原来这里只拿一个空字符串，于是"没听出内容"只能写一句笼统的话 ——
         * 而**"这视频真没说话"和"我这边没转出来"是完全不同的两件事**：
         * ```
         *   asr-empty       这视频里真的没人说话（纯音乐/无声演示）→ 别再试了
         *   asr-timeout     我超时了                                  → 可以重试/加预算
         *   download-failed 音频没下下来                              → 换候选
         * ```
         * 现场（2026-11-03 群里那个 70 秒《绝区零》演示）：日志写的是
         * 「可能没语音：纯音乐 / 无声演示」—— **它自己也不知道是哪种** ✗，
         * 而 70 秒的音频**够转**（固定成本才 ~25 秒），所以这个判断很可疑。
         */
        const r = await transcribeVideoDetailed(
          bvid,
          info.cid,
          { fetchAudioCandidates, downloadAudio },
          // ⚠️ 超时给足：这是**后台**任务，不挡任何人的回复，所以不必抠 20 秒
          { timeoutMs: 120_000, prefixBytes, log: this.log },
        )
        const text = String(r?.text ?? '')
        if (!text) {
          /*
           * ⚠️ **分开说**，而且**别把"我失败了"说成"这视频没声音"** ——
           *    后者会让用户以为视频本身有问题（甚至以为它在敷衍）。
           */
          const why = String(r?.why ?? 'unknown')
          const human = {
            'asr-empty': '这视频**真的没说话**（纯音乐/无声演示），不是我没听',
            'asr-timeout': '★ 我**超时**了（不是没声音）—— 该加预算或重试',
            'download-failed': '★ 音频**没下下来** —— 该换候选',
            'no-candidates': '★ B 站**没给音频地址**',
            'asr-failed': '★ 转写进程**出错了**',
          }[why] ?? `★ 原因不明（${why}）`
          this.log.info?.(
            `B站：${bvid} 后台没拿到内容 —— ${human}（why=${why}，只取开头 ${(prefixBytes / 1048576).toFixed(0)}MB）`,
          )
          /*
           * ★★ **"这视频真没说话"也要更新缓存**（2026-11-03）。
           *
           * 缓存里那份是 `pendingLong: true`（"我刚开始听"）。
           * 补发那一条会**重新走 `_generate`**，而 `_generate` 读的就是这份缓存 ——
           * 不更新的话，她补发时还以为自己在听 ✗，于是又会说"我正看着" ✗。
           *
           * 所以：**真没说话**时把缓存换成"听完了，但这视频没说话"。
           * 失败（超时/下载失败）**不更新** —— 那意味着我们还没真听过，
           * 保持"正在听"反而是诚实的。
           */
          if (why === 'asr-empty') {
            const ctx = formatVideoContext({ ...info, transcript: '', silentVideo: true, pendingLong: false })
            this._biliCache.set(bvid, { at: Date.now(), text: ctx })
            return { text: '', ctx, why }
          }
          return { text: '', ctx: '', why }
        }
        const sec = Math.round((Date.now() - at) / 1000)
        this.log.info?.(`B站：${bvid} 后台听完开头一段 → ${text.length} 字（${sec}s）`)
        const ctx = formatVideoContext({ ...info, transcript: text, prefixOnly: true, pendingLong: false })
        this._biliCache.set(bvid, { at: Date.now(), text: ctx })
        return { text, ctx }
      } catch (e) {
        this.log.warn?.(`B站：${bvid} 后台转写失败 — ${String(e?.message ?? e)}`)
        return null
      } finally {
        // 任务结束就摘掉 —— 但**调用方手上还拿着这个 promise**，所以摘了不影响补发
        this._biliJobs.delete(bvid)
      }
    })()
    const rec = { bvid, promise, at }
    this._biliJobs.set(bvid, rec)
    return rec
  }

  /**
   * 长视频的**补发**：后台听完了，回来把内容说一句。
   *
   * ## 用户要的行为
   * > 「先回复我先看看，然后正常聊天，那边结束了再提视频内容」
   *
   * 所以这条**不走决策层**（不需要再判一次"该不该说"——她刚才已经答应要看了），
   * 直接用当前对话 + 新的视频上下文生成一句，然后发。
   *
   * ## 几道闸（防打扰）
   * 1. 转写拿到可用文本（空 → 不提）
   * 2. 距原链接 **≤ 5 分钟**（`qq.bilibili.followUpMaxAgeMs`）—— 太久就是翻篇了
   * 3. **同一条视频只补一次**（`_videoFollowed`）
   * 4. 这一条**不受冷却/主动发言闸门管** —— 它是"答应过的事"，不是主动搭话
   *
   * @param {{bvid:string, promise:Promise, at:number}} job
   * @param {object} msg    原来那条分享消息（`_send` 要它的 scope/kind/groupId/userId）
   * @param {object} mem    该会话记忆
   * @param {object} scene
   * @param {object} self
   */
  /**
   * 「车牌内页看完了，补一句」（2026-11-02）。
   *
   * ## 跟长视频那套是**同一个模式**
   * 开浏览器 + 开页 + 滚 4 屏 ≈ **26 秒**（实测）。卡在回复里等于让人等半分钟，
   * 所以：**回复先按标题发出去，看完再补一条**。
   *
   * ## 截图怎么进上下文
   * 截图**本来就是 base64**（浏览器截的），所以不走 `onebot.fetchImage`
   * 那条下载路（那条必然失败）—— 直接用 `makeImageBlock` 入库，
   * 再从 `_collectImages` 的 `extraBlocks` 那个口子塞进去。
   *
   * ⚠️ 三道闸，都是别处踩过的：
   *   ① `_generate` 返回的是 **`{ text, cover }` 不是字符串** —— 长视频那边
   *      第一版把一个对象丢进 `String()`，真的往 QQ 发了「[object Object]」。
   *   ② `[SILENT]` 只有**整条就是它**才算不说话。
   *   ③ 图一张都没入库时**别硬发** —— 那等于说"我看了"却没有画面。
   */
  /** 车牌「她自己的总结」缓存（落盘 <home>/jm-memo.json）。 */
  _jmMemo() {
    if (!this._jmMemoReady) {
      this._jmMemoReady = true
      try { this._jmMemoStore = new JmMemoStore(this.cfg.home ?? '') } catch { this._jmMemoStore = null }
    }
    return this._jmMemoStore
  }

  /**
   * 让她自己看一遍内页、用第一人称记一句「这章讲了什么」。
   *
   * ⚠️ 为什么**单独一次调用**，而不是在同一条回复里让她总结：
   *    她的系统提示词有「别一看到图就开始描述」「别总结全文」两条硬规则，
   *    同一条聊天回复里让她总结会被压成只剩情绪反应（2026-11-04 实测）。
   *    单独一次「私人笔记」调用能拿到真内容，再作为事实注入下一轮。
   *
   * 失败/超时一律返回空串 —— 总结是加分项，不能拖垮补发那条。
   * @param {{shots?:string[], title?:string, samples?:number}} r readJmPages 的结果
   */
  async _jmSummarize(r) {
    if (!r?.shots?.length) return ''
    if (typeof this.gateway?.makeImageBlock !== 'function') return ''
    const blocks = []
    for (const [i, b64] of r.shots.entries()) {
      try {
        const blk = await this.gateway.makeImageBlock({ base64: b64, mediaType: 'image/jpeg', name: `jm-memo-${i + 1}` })
        if (blk) blocks.push(blk)
      } catch { /* 单张失败跳过 */ }
    }
    if (blocks.length === 0) return ''
    const system = [
      '你在给自己记一条私人笔记（第一人称、口语，像随手写在本子上）。',
      '任务：用 2~3 句，说清刚才翻的这几页漫画**大概讲了什么**：谁、发生了什么、哪一段开始变味、整体什么调子。',
      '规则：只写看到的，不脑补；不用分点；别逐页念。',
      '**可以有情绪、可以直接表态、也可以反问**（嫌弃、火大、觉得离谱都行）—— 这是给自己看的笔记，别写成客观报告。',
    ].join('\n')
    const n = Number(r.samples) || r.shots.length
    const messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: `这是《${r.title || '这本'}》的 ${n} 个采样画面，从左到右、从上到下排列，覆盖整章 0%→100%。` },
          ...blocks,
        ],
      },
    ]
    const candidates = await this._candidatesAsync()
    if (candidates.length === 0) return ''
    const opened = await openFirstAvailable({ llm: this.gateway, candidates, request: { messages, maxTokens: 400 }, firstChunkMs: 30_000 })
    let text = ''
    for await (const ch of opened.stream) {
      if (ch?.type === 'text-delta' || ch?.type === 'text') text += ch.text ?? ''
    }
    return text.trim()
  }

  async _jmFollowUp(job, msg, mem, scene, self) {
    const scope = String(msg.scope ?? '')
    try {
      const r = await job.promise
      if (!scope) return
      // 会话已经聊走了就别硬插一句（跟长视频同一个判据）
      const age = Date.now() - job.at
      const maxAge = Number(this.cfg.jmRead?.followUpMaxAgeMs ?? 3 * 60_000)
      if (age > maxAge) {
        this.log.info?.(`车牌 ${job.id}：看完了，但已经过了 ${Math.round(age / 1000)}s → 不补了`)
        return
      }
      if (!r?.ok) {
        this.log.info?.(`车牌 ${job.id}：内页没看成（${r?.why}）→ 不补`)
        return
      }
      if (!Array.isArray(r.shots) || r.shots.length === 0) {
        this.log.warn?.(`车牌 ${job.id}：说看完了却一张截图都没有 → 不补`)
        return
      }

      // ① 截图入库（base64 → image block）
      const blocks = new Map()
      if (typeof this.gateway?.makeImageBlock === 'function') {
        for (const [i, b64] of r.shots.entries()) {
          const blk = await this.gateway.makeImageBlock({
            base64: b64,
            mediaType: 'image/jpeg',
            name: `jm-${job.id}-${i + 1}`,
          })
          if (blk) blocks.set(`jm:${job.id}:${i + 1}`, blk)
        }
      }
      if (blocks.size === 0) {
        this.log.warn?.(`车牌 ${job.id}：截图一张都没入库 → 不补（说了"看了"却没画面，不如不说）`)
        return
      }
      this.log.info?.(`车牌 ${job.id}：内页看完（${blocks.size} 张）→ 补一句`)

      /*
       * ★ 先让她自己看一遍、记一句内容总结（2026-11-04）。
       *
       * 单独一次「私人笔记」调用（见 _jmSummarize）：这句既注入本轮提示词，
       * 也按车牌号落盘 —— 下次提到同一本不用重看。
       */
      let memo = ''
      try {
        memo = await this._jmSummarize(r)
        if (memo) this._jmMemo()?.set(job.id, { title: r.title ?? '', summary: memo })
      } catch (e) {
        this.log.debug?.(`车牌 ${job.id}：自己记总结失败（跳过）— ${String(e?.message ?? e).slice(0, 80)}`)
      }

      // ② 带着截图 + "只看了前面几屏"的注记重新生成
      const gen = await this._generate(msg, mem, scene, self, blocks, formatAlbumPagesNote(r, { summary: memo }))
      if (typeof gen?.text !== 'string') {
        this.log.warn?.(`车牌 ${job.id}：补发时生成层返回的不是字符串（${typeof gen?.text}），跳过`)
        return
      }
      const text = gen.text
      if (!text.trim()) return
      // `[SILENT]` 只有整条就是它才算不说话（照抄 _handle 的判据，别自己发明）
      if (/^\s*\[SILENT\]\s*$/i.test(text)) {
        this.log.info?.(`车牌 ${job.id}：她说不用补 → 不补`)
        return
      }
      await this._send(msg, text, gen?.cover ?? null)
      this.stats.replied++
      this.log.info?.(`bridge：[我] ${scope}「${String(text).slice(0, 400)}」`)
    } catch (e) {
      this.log.warn?.(`车牌 ${job.id}：补发失败 — ${String(e?.message ?? e).slice(0, 100)}`)
    } finally {
      this._jmJobs?.delete(scope)
    }
  }

  async _videoFollowUp(job, msg, mem, scene, self) {
    try {
      const r = await job.promise
      /*
       * ★★★ **不是"有转写才补"**（2026-11-03 修）。
       *
       * 原来是 `if (!r?.text) return` —— 于是**"这视频真没说话"也被当成没内容，
       * 永远不补一句** ✗。现场：70 秒的演示视频，评论 5 条 / 弹幕 10 条都抓到了，
       * 后台判定"没内容"就一声不吭 —— **而它明明有评论/弹幕可说**。
       *
       * 现在的分流：
       * ```
       *   有转写                     → 补（听到了新东西）
       *   why === 'asr-empty'        → **补**（"这视频没说话"本身就是结论，
       *                                 而且评论/弹幕已经进上下文了）
       *   其它（超时/下载失败/取不到地址/进程出错）→ **不补**
       *       —— 那是**我的失败**，补一句等于说"我听完了"，是撒谎
       * ```
       */
      const why = String(r?.why ?? '')
      const hasText = Boolean(String(r?.text ?? ''))
      if (!hasText && why !== 'asr-empty') {
        if (r && why) this.log.info?.(`B站：${job.bvid} 后台没成（${why}）→ 不补（那是我的问题，不是视频没内容）`)
        return
      }
      if (!this._videoFollowed) this._videoFollowed = new Map()
      if (this._videoFollowed.has(job.bvid)) return
      const maxAge = Number(this.cfg.bilibili?.followUpMaxAgeMs ?? 5 * 60_000)
      const age = Date.now() - job.at
      if (age > maxAge) {
        this.log.info?.(`B站：${job.bvid} 听完了，但已经过了 ${Math.round(age / 1000)}s → 不补了`)
        return
      }
      const scope = String(msg.scope ?? '')
      if (!scope) return
      this._videoFollowed.set(job.bvid, Date.now())
      if (this._videoFollowed.size > 100) {
        this._videoFollowed.delete(this._videoFollowed.keys().next().value)
      }

      const gen = await this._generate(msg, mem, scene, self)
      /*
       * ⚠️⚠️ `_generate` 返回的是 **`{ text, cover }`**，不是字符串（2026-11-01 实测踩到）。
       *
       * 我第一版写了 `cleanModelText(await this._generate(...))` —— 把一个对象丢进
       * `String()`，于是**真的往 QQ 发了一条「[object Object]」**。
       * 日志上是这样的：
       * ```
       * B站：BV1dXxp6xEk3 看完补一句（等了 10s）「[object Object]」
       * ```
       *
       * `_handle` 那边是 `gen?.text ?? ''` + `gen?.cover ?? null`（L2943 附近），照抄。
       * 另外这里**多一道类型闸**：不是字符串就不发 —— 这类"把对象当文本"的错误
       * 不该有机会到用户眼前。
       */
      if (typeof gen?.text !== 'string') {
        this.log.warn?.(`B站：${job.bvid} 补发时生成层返回的不是字符串（${typeof gen?.text}），跳过`)
        return
      }
      const rawText = gen.text
      const cover = gen?.cover ?? null
      /*
       * ⚠️ 判据**照抄 `_handle`**，别自己发明：
       * `[SILENT]` 只在**整条就是它**时才算"不说话"；混在正文里要剥掉后照发。
       * （我第一版写的是 `clean === '[SILENT]'` —— 那会漏掉「[表情包][SILENT]」
       *   「好了[SILENT]」这种，而且大小写/全角都不认。`_handle` 那边有现成的正则。）
       */
      const hadSilent = /[\[［]\s*[SILENTsilent]{6}\s*[\]］]/.test(rawText)
      const clean = rawText.replace(/[\[［]\s*[SILENTsilent]{6}\s*[\]］]/g, '').trim()
      if (!clean) {
        if (hadSilent) {
          this.stats.silent++
          this.log.info?.(`B站：${job.bvid} 听完了，但她选择不说（[SILENT]）`)
        } else {
          this.log.info?.(`B站：${job.bvid} 听完了，但生成出来是空的 → 不补了`)
        }
        return
      }
      const sentIds = await this._send(msg, clean, cover)
      mem.push(makeMessage({
        id: sentIds.length ? sentIds[sentIds.length - 1] : undefined,
        sender: this.selfId ?? '0',
        senderName: this.selfName,
        text: clean,
        at: Date.now(),
        isMe: true,
        provider: this._lastRoute?.provider ?? null,
        model: this._lastRoute?.model ?? null,
      }))
      this.stats.replied++
      this._rememberMyReplyIds(scope, sentIds)
      this.log.info?.(`B站：${job.bvid} 看完补一句（等了 ${Math.round(age / 1000)}s）「${clean.slice(0, 80)}」`)
    } catch (e) {
      this.log.warn?.(`B站：补发失败 — ${String(e?.message ?? e)}`)
    }
  }

  async _customFaces() {
    const now = Date.now()
    if (this._facesCache && now - this._facesCache.at < 600000) return this._facesCache.urls
    try {
      const res = await this.onebot.call('fetch_custom_face', {}, 8000)
      const urls = (Array.isArray(res?.data) ? res.data : []).filter((u) => typeof u === 'string' && /^https?:/.test(u))
      this._facesCache = { at: now, urls }
      if (urls.length) this.log.info?.(`bridge：取到 ${urls.length} 个收藏表情`)
      /*
       * ★ 顺手看看有没有新表情要打标签（2026-10-31）。
       *
       * 放这里是因为：这张表有 10 分钟缓存 → 天然限频，不会每次发表情都跑。
       * 内部还有"攒够 minPending 才动手"和 `_taggingBusy` 双保险。
       * 用 `void` 是因为它只该**后台跑**，绝不能拖慢这次发送。
       */
      void this._tagStickerBatch?.()
      return urls
    } catch (e) {
      this.log.debug?.(`bridge：取收藏表情失败 — ${String(e?.message ?? e)}`)
      this._facesCache = { at: now, urls: [] }
      return []
    }
  }

  /**
   * 自动收藏别人发的表情包。
   *
   * ## 判据
   *
   * 只看 `msg.stickerRefs` —— 它是 onebot 解析消息时按 `sub_type === 1`
   * （或 summary 含"动画表情"）挑出来的**表情包**引用，普通图片不在里面。
   * 不靠尺寸/格式/有没有文字，那些都不准（表情包经常带文字）。
   *
   * ## 流程
   *
   *   fetchImage(引用) → base64 → 写临时文件 → add_custom_face → 删临时文件
   *
   * 为什么必须落盘：`add_custom_face` 只收本地路径，传 URL 会被 schema 拒绝。
   *
   * ## 什么时候不做
   *
   *   · 自己发的（isMe）
   *   · 配置关掉（`qq.autoCollectStickers === false`）
   *   · 收藏已经很多（超过 `qq.maxCollectedStickers`，默认 200）
   *     —— 不然总有一天把账号的收藏塞满
   *
   * @param {object} msg 规范化后的消息
   */
  /**
   * `[改标签:…]` 该改哪一张（2026-11-04）。
   *
   * ① 对方这条消息里带的表情 —— 下载 → md5 → 在标签库里精确命中。
   *    （收藏 URL 文件名里那串 32 位十六进制就是图片 md5，实测确认过。）
   * ② 私聊：退回"她刚发出去的那张"（10 分钟内）。
   *    群聊**不走** ②：她随手改库会影响到群里的用法。
   *
   * @returns {Promise<{url:string, why:string}|null>}
   */
  async _tagTarget(msg) {
    const refs = Array.isArray(msg?.stickerRefs) ? msg.stickerRefs : []
    for (const ref of refs.slice(0, 3)) {
      try {
        const img = await this.onebot?.fetchImage?.(String(ref), {
          maxBytes: this.cfg.reply?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
        })
        const mm = /^data:[^;]+;base64,(.*)$/s.exec(String(img?.dataUrl ?? ''))
        if (!mm) continue
        const md5 = createHash('md5').update(Buffer.from(mm[1], 'base64')).digest('hex').toUpperCase()
        const url = this.stickerTags?.findUrlByHash?.(md5)
        if (url) return { url, why: '对方这条里那张' }
      } catch { /* 换下一张 */ }
    }

    const scope = String(msg?.scope ?? '')
    if (scope.startsWith('private')) {
      const last = this._lastMface
      if (last && last.scope === scope && Date.now() - last.at < 10 * 60_000) {
        return { url: last.url, why: '她刚发出去那张' }
      }
    }
    return null
  }

  async _autoCollectStickers(msg) {
    const cfg = this.cfg ?? {}
    if (cfg.autoCollectStickers === false) return
    const refs = Array.isArray(msg?.stickerRefs) ? msg.stickerRefs : []
    if (refs.length === 0) return
    if (typeof this.onebot.addCustomFace !== 'function') return

    const cap = Number(cfg.maxCollectedStickers ?? 200)
    // 收藏总数只在需要时查一次（10 分钟缓存，见 _customFaces）
    const existing = await this._customFaces()
    if (existing.length >= cap) {
      if (!this._collectCapWarned) {
        this._collectCapWarned = true
        this.log.warn?.(`bridge：收藏表情已达上限 ${cap}，停止自动收藏（可在设置里调 qq.maxCollectedStickers）`)
      }
      return
    }

    for (const ref of refs.slice(0, 3)) {
      try {
        const img = await this.onebot.fetchImage(String(ref), { maxBytes: this.cfg.reply?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES })
        if (!img?.dataUrl) continue
        const m = /^data:([^;]+);base64,(.*)$/s.exec(img.dataUrl)
        if (!m) continue
        const ext = (m[1].split('/')[1] ?? 'png').replace('jpeg', 'jpg')
        // 临时文件：放系统 temp，收藏完立刻删
        const tmp = path.join(os.tmpdir(), `gd-face-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
        fs.writeFileSync(tmp, Buffer.from(m[2], 'base64'))
        try {
          const r = await this.onebot.addCustomFace(tmp)
          if (r.ok) {
            this.stats.collected = (this.stats.collected ?? 0) + 1
            // 收藏变了，清缓存让下次 _customFaces 重新拉
            this._facesCache = undefined
            this.log.info?.(r.existed
              ? 'bridge：这张表情已经在收藏里了'
              : `bridge：已自动收藏一张表情（当前共 ${existing.length + 1} 张）`)
          } else {
            this.log.warn?.(`bridge：收藏表情失败 — ${JSON.stringify(r.raw ?? {}).slice(0, 160)}`)
          }
        } finally {
          try { fs.unlinkSync(tmp) } catch { /* 删不掉也无所谓，系统会清 temp */ }
        }
      } catch (e) {
        this.log.debug?.(`bridge：自动收藏跳过 — ${String(e?.message ?? e)}`)
      }
    }
  }

  /**
   * 挑一个表情包发出。
   *
   * 优先级：
   *   1) 配置里的映射 `config.qq.reply.mfaceMap`（用户想固定某张图时用）
   *   2) **QQ 内置表情表按名字查**（本地索引，见 faces.json）—— 这就是
   *      "按关键词搜表情"：模型说 `[表情包:大笑]`，我们查到「大哭」这类
   *      同义/包含项，发出**语义正确**的那个表情，而不是随机兜底
   *   3) 账号的收藏表情（NapCat 拿到的真实 GIF）
   *   4) 常见小黄脸兜底
   *
   * ## 关于"用 QQ 自带搜索找表情"
   *
   * QQ **没有公开的表情搜索 API** —— 实测几个候选接口全是 404，
   * NapCat 也没暴露（只有 fetch_custom_face 取收藏）。
   *
   * 但 NapCat 内嵌了 QQ 完整的 face_config（329 条：经典小黄脸 + 动画表情），
   * 我们把它导出成 `src/qq/faces.json`（258 条可用）。查这张表等价于
   * "在 QQ 的表情库里搜" —— 而且**更快、更可靠**（不依赖网络）。
   *
   * 从来没有"啥都不发"这一档 —— 模型说了要发表情，就该发出点什么。
   *
   * 配置形状（config.qq.reply.mfaceMap）：
   *   { "猫猫": "https://…/cat.gif", "笑": "file:///D:/pic/x.jpg" }
   */
  async _pickMface(name) {
    const map = this.cfg.reply?.mfaceMap ?? {}
    const key = String(name ?? '').trim()

    // 1) 配置映射（精确优先，其次模糊包含）
    if (key) {
      let hit = map[key]
      if (!hit) {
        const k = Object.keys(map).find((x) => key.includes(x) || x.includes(key))
        if (k) hit = map[k]
      }
      if (hit) return [{ type: 'image', data: { file: String(hit) } }]
    }

    /*
     * ★ **先按标签从她的收藏库里挑**（2026-11-02 提到内置表之前）。
     *
     * ## 原来为什么在内置表后面 —— 以及为什么错了
     * 原来是：配置映射 → **QQ 内置表情表按名字查** → 收藏表情。
     * 问题是「无语」「震惊」「疑惑」这类词**既在 QQ 内置表的别名里**
     * （无语→擦汗 id40、震惊→惊恐 id26），**也是收藏表情的标签**。
     * 第 2 步先跑就永远轮不到收藏库。
     *
     * 实测现场（群里，2026-11-02）：
     * ```
     * 07:44:14  群友「有收藏表情怎么又在用qq表情」
     * 07:44:25  表情「无语」→ 精确匹配「无语」(face 40)   ← 又发了个 QQ 内置
     * 07:47:30  表情「疑惑」→ 按标签命中 …               ← 这次才是她收藏的
     * ```
     * 用户的诉求就是这个：**她收了一堆收藏表情，结果发出来的还是 QQ 那套。**
     * 而且提示词里给她的清单就是**她库里的标签** —— `[表情包:哭]` 的语义
     * 本来就是"从我的库里挑一张像'哭'的"，不是"找一个叫'哭'的 QQ 表情"。
     *
     * ## 所以顺序反过来
     *   ① 配置映射（用户显式指定，最高）
     *   ② **收藏表情按标签**
     *   ③ QQ 内置表情表（她的库里没有像的，才退回内置）
     *   ④ 收藏表情随机（有名字但没标签命中时）
     *
     * `[表情:N]`（按**编号**指定 QQ 表情）是另一条路，不受影响。
     */
    const faces = await this._customFaces()
    if (faces.length > 0 && key) {
      /*
       * ★ **先按标签找**（2026-10-31）—— 这才是"按意思挑"。
       *
       * 以前是 `hashStr(key) % faces.length`：同一个名字固定挑同一张，
       * 看着"稳定"，但**那张和「哭/笑/无语」毫无关系** —— 等于闭眼。
       * 实测：对方发表情包，它回了个"流泪"，人家问「哭啥」。
       *
       * 标签由 `_tagStickerBatch()` 用视觉模型打（攒够几张打一批）。
       */
      const byTag = this.stickerTags?.findByTag?.(faces, key) ?? null
      if (byTag) {
        this.log.info?.(`bridge：表情「${key}」→ 按标签命中 ${stickerKey(byTag).slice(-16)}`)
        return [{ type: 'image', data: { file: byTag } }]
      }
    }

    // ② QQ 内置表情表按名字查（"本地搜索"）—— 收藏库里没有像的才走这里
    if (key) {
      const hit = lookupFace(key)
      if (hit) {
        this.log.info?.(`bridge：表情「${key}」→ ${hit.by === 'exact' ? '精确' : '近似'}匹配「${hit.name}」(${hit.kind} ${hit.id ?? hit.ani})`)
        if (hit.kind === 'face') return [{ type: 'face', data: { id: String(hit.id) } }]
        // 动画表情要 mface 段；拿不到必需编号就退成收藏表情/兜底，
        // 不要发一个坏段出去（那会在群里显示成一条错误消息）
      }
    }

    /*
     * ③ 收藏表情（前面已经取过 `faces` 了，这里继续用它）。
     *    收藏表情不带名字，所以按名字做**确定性挑选**；
     *    没给名字就随机 —— "随手发个表情"本来就该随机。
     */
    if (faces.length > 0) {
      /*
       * ★ **先按标签找**（2026-10-31）—— 这才是"按意思挑"。
       *
       * 以前是 `hashStr(key) % faces.length`：同一个名字固定挑同一张，
       * 看着"稳定"，但**那张和「哭/笑/无语」毫无关系** —— 等于闭眼。
       * 实测：对方发表情包，它回了个"流泪"，人家问「哭啥」。
       *
       * 标签由 `_tagStickerBatch()` 用视觉模型打（攒够几张打一批）。
       * 没标签时才退回老的 hash 挑法（至少还是确定的，不是乱跳）。
       */
      const byTag = key ? (this.stickerTags?.findByTag?.(faces, key) ?? null) : null
      if (byTag) {
        this.log.info?.(`bridge：表情「${key}」→ 按标签命中 ${stickerKey(byTag).slice(-16)}`)
        return [{ type: 'image', data: { file: byTag } }]
      }
      /*
       * ⚠️⭐ **没命中标签就随机，不要用 hash**（2026-11-01 改）。
       *
       * ## 原来为什么用 hash
       * 注释写着「同一个名字每次挑到同一张，看起来比较稳定」——
       * 那是假设**名字是有效的**（"哭"就固定给那张哭脸）。
       *
       * ## 实际发生了什么（实测事故）
       * 提示词里的例子写的是 `[表情包:猫猫]`，而**标签库里 54 张没有一张叫「猫猫」**
       * （标签是"震惊/无语/嫌弃/得意…"这种情绪词）。于是：
       * ```
       * 模型照抄例子写「猫猫」 → 标签匹配 0 命中 → 落到 hash
       * hashStr('猫猫') % 54 = 固定一个数 → ★ 永远同一张图
       * ```
       * 实测「猫猫」一天发了 3 次，**池子看起来就只有一张** —— 用户报的就是这个。
       *
       * ## 为什么随机是对的
       * 走到这里说明**这个名字没有对应的图** —— 那"稳定"就没有任何价值，
       * 只是把整套表情退化成一张。随机至少还在用整池子。
       * （真人发收藏表情本来也不固定。）
       */
      const idx = Math.floor(Math.random() * faces.length)
      if (key) {
        this.log.info?.(`bridge：表情「${key}」标签没命中 → 从 ${faces.length} 张里随机一张`)
      }
      return [{ type: 'image', data: { file: faces[idx] } }]
    }

    // 4) 兜底：随机一个常见小黄脸。
    //    不返回 null：模型已经说了要发表情，什么都不发会让它显得"答应了却没做"。
    const COMMON = [4, 13, 20, 12, 28, 42, 0, 42, 74]
    return [{ type: 'face', data: { id: String(COMMON[hashStr(key || 'x') % COMMON.length]) } }]
  }

  /**
   * 把「因冷却被推迟」的消息排进队列，冷却结束后自动补回。
   *
   * ## 为什么只留最后一条
   *
   * 冷却 15 秒内用户可能连发 5 条（"在吗" "问你个事" "？" "算了" "…"）。
   * 全部排队回一遍会让机器人像复读机，而且前面几条的上下文早过时了。
   * 只保留**最新**那条 —— 它自然包含了前文的意思。
   *
   * ## 为什么用 timer 而不是轮询
   *
   * 每条消息各自算"还要等多久"，一次性 setTimeout 最省事；
   * 同会话再来新消息就把旧 timer 清掉重排（等价于"推迟到最新那条"）。
   *
   * @param {object} msg
   * @param {object} mem
   * @param {object} scene
   * @param {object} self
   * @param {object} d 决策结果（含 defer.waitMs）
   */
  _enqueueDeferred(msg, mem, scene, self, d) {
    const key = String(msg.scope ?? 'unknown')
    const prev = this._deferred.get(key)
    if (prev?.timer) clearTimeout(prev.timer)

    // 多等 300ms 缓冲：冷却刚好卡在边界时，决策层可能仍判"还在冷却"
    // （时间计算有毫秒级误差），白跑一次重试。
    const waitMs = Math.max(500, Number(d.defer?.waitMs ?? 0) + 300)
    const timer = setTimeout(() => {
      this._deferred.delete(key)
      // 冷却结束时用户可能已经不在这个话题上了 —— 重新走一遍完整处理
      // （决策、生成、发送），而不是无条件发言。这次冷却已过，应该能正常回。
      // 走 _queues 串行链，避免和同一会话的其它消息并发。
      const prev = this._queues.get(key) ?? Promise.resolve()
      const next = prev.then(() => this._handle(msg)).catch((e) => {
        this.log.warn?.(`bridge：补回消息失败 — ${String(e?.message ?? e)}`)
      })
      this._queues.set(key, next)
    }, waitMs)
    // 别让这个 timer 拖住进程退出
    if (typeof timer?.unref === 'function') timer.unref()

    this._deferred.set(key, { msg, mem, scene, self, at: Date.now(), timer })
    this.stats.deferred = (this.stats.deferred ?? 0) + 1
    this.log.info?.(`bridge：${key} 冷却中，${Math.ceil(waitMs / 1000)}s 后补回「${String(msg.text ?? '').slice(0, 30)}」`)
  }

  /** 记录最近一次交互（Web UI 用）。 */
  _record(msg, decision, replyText, outcome) {
    this.recent.unshift({
      at: Date.now(),
      scope: msg.scope,
      senderName: msg.senderName,
      text: msg.text.slice(0, 200),
      // ⚠️ 图片信息要一起记下来 —— 否则 UI 只显示 "[图片]"，用户
      //    根本没法判断"到底是没收到图，还是收到了但模型没用上"。
      //    这里存**引用**（url / file_id），不存 base64 数据（会撑爆内存）。
      images: (msg.images ?? []).map(function(r) { return String(r).slice(0, 200) }),
      mentionsMe: this.selfId ? msg.isAtMe(this.selfId) : false,
      /*
       * ★ 被引用消息的内容（2026-11-01 补）。
       *
       * ⚠️ 原来这里**没有** quote —— 于是面板上一条「纯引用」（正文为空）
       *    就渲染成一个**空气泡**，用户看着像"她收到一条空消息还不理人"。
       *
       * 而实际上提示词里**是有**这段内容的（见 `_resolveQuote` / `quoteLine`）：
       * 输入那一侧早上就修好了，**显示这一侧没跟上** —— 于是同一个功能
       * 在日志里是对的、在面板上像坏的。
       *
       * `replyTo` 也一起带上：光看 `quote === null` 分不清
       * 「没有引用」和「引用了但内容没取到」，面板就没法如实说明。
       */
      quote: msg.quote
        ? {
          sender: String(msg.quote.sender ?? '').slice(0, 40),
          text: String(msg.quote.text ?? '').slice(0, 160),
          isMe: msg.quote.isMe === true,
        }
        : null,
      replyTo: msg.replyTo != null ? String(msg.replyTo) : null,
      decision: {
        reply: decision?.reply,
        probability: decision?.probability,
        provider: decision?.provider,
        reason: decision?.reason,
      },
      reply: replyText ? replyText.slice(0, 300) : null,
      outcome,
    })
    if (this.recent.length > 50) this.recent.length = 50
  }

  _maybeSummarize(scope, mem, scene) {
    /*
     * ★ 事件记忆的收尾（2026-11-04）：**一进一出都在这里**。
     *
     * 之所以挂在 `_maybeSummarize` 上，是因为它本来就已经是
     * 「这条消息处理完了」的唯一收尾点（`_handle` 里 15 处调用共享），
     * 再加第 16 个钩子只会让下次改流程时漏掉一个。
     *
     * ⚠️ 它必须**先于** `longMemory` 的开关判断 —— 长期记忆关掉时
     *    事件层照样要工作（两层是独立的）。
     */
    this._touchEvents(scope, mem, scene)
    if (!this.longMemory?.enabled) return
    this.longMemory.maybeSummarize(scope, {
      messages: mem.recent(),
      /**
       * ⚠️ **必须传累计总数**（2026-10-23）。
       *
       * 长期记忆靠 `total - summarizedTotal >= summarizeAfter` 判断该不该摘要。
       * 只传 `messages` 的话，long.js 会退回用 `messages.length`（窗口长度），
       * 而窗口有上限 —— 满 30 条后长度恒为 30，摘要就再也不触发了。
       * 这正是「记忆没生效」的根因。
       */
      total: mem.totalPushed,
      /*
       * 会话创建时间 —— 让 `long.js` 分辨「计数回退」的两种成因
       * （2026-10-29）：
       *   · 摘要在本会话内发生 → 回退 = 丢了未落盘的增量 → 对齐，**不重摘**
       *   · 摘要属于上个会话（隔夜过期重建）→ 归零，尽快摘
       * 不传的话它只能保守地一概归零，那就会重复摘要。
       */
      sessionStartedAt: mem.createdAt,
      scene,
      self: { qq: this.selfId, nickname: this.selfName },
    }).catch(() => { })
  }

  /**
   * 事件记忆的"一进一出"（2026-11-04）。
   *
   * ① **出**：刚发出去的那条回复里，如果真用上了上一轮注入的事 → 加一点强度。
   *    判据是字面重叠（最长公共子串 ≥3 字，见 `usedInReply`）—— 判错只值 0.1，
   *    不值得为它多跑一次模型。
   * ② **进**：攒够条数才真抽（节流在 `EventStore#maybeExtract` 里）。
   *
   * ⚠️ 两条都是 **fire-and-forget**：`void` 出去，不 await。
   *    记忆是加分项，绝不能让回复慢哪怕 100ms，更不能让它失败。
   * ⚠️ 强化只在「我这条回复是刚发的」时才做 —— `_maybeSummarize` 也会在
   *    "她没说话"的路径上被调用，那时 `recent(1)` 是别人说的话，
   *    拿它去比就变成了"谁提到就算她用上了"。
   *
   * @param {string} scope
   * @param {object} mem  短期记忆（有 recent/totalPushed）
   * @param {object} [scene]
   */
  _touchEvents(scope, mem, scene) {
    const ev = this.events
    if (!ev || ev.enabled === false) return
    try {
      const last = mem?.recent?.(1)?.[0]
      if (last?.isMe && Date.now() - Number(last.at ?? 0) < 60_000) {
        ev.reinforceFromReply(scope, String(last.text ?? ''))
      }
    } catch (e) {
      this.log.debug?.(`bridge：事件强化跳过 — ${String(e?.message ?? e)}`)
    }
    Promise.resolve()
      .then(() => ev.maybeExtract({
        scope,
        messages: mem?.recent?.() ?? [],
        total: mem?.totalPushed,
        scene,
      }))
      .catch(() => { })
  }

  /** 供 Web UI 的状态。 */
  statsSnapshot() {
    return {
      enabled: this.cfg.enabled === true,
      paused: this.paused,
      self: { id: this.selfId, name: this.selfName },
      connected: this.onebot?.connected ?? false,
      counters: { ...this.stats },
      memory: this.memory?.stats?.() ?? null,
      longMemory: this.longMemory?.stats?.() ?? null,
      // 事件记忆（2026-11-04）：总条数 / 还活着的条数 —— 面板能看出"忘没忘"
      events: this.events?.stats?.() ?? null,
      recent: this.recent.slice(0, 20),
      // 白名单要暴露出来 —— 否则界面上看不出"为什么它不回我"
      // （名单为空 + fail-closed = 所有消息被静默丢弃）。
      allow: {
        private: this.cfg.allow?.private ?? [],
        groups: this.cfg.allow?.groups ?? [],
        allowAllWhenEmpty: this.cfg.allow?.allowAllWhenEmpty === true,
      },
      // 联网能力状态（界面显示"能不能查网"）
      search: {
        available: Boolean(this.searchKey),
        enabled: this.cfg.search?.enabled !== false,
        last: this._lastSearch,
      },
    }
  }
}

/**
 * 把「模型输出文本 + 可选配图」拆成待发送的段。
 *
 * ## 为什么要单独成一个函数
 *
 * 它踩过一个致命 bug（2026-10-28）：
 * 原来配图那行是 `if (cover?.url && segments.length > 0)` ——
 * 只有**已经有文字**才附图。但用户让「去找张图回来」时，模型往往只输出
 * `[找图:...]` 标记、没有正文；标记剥掉后 text 为空 → segments 为空 →
 * **已经下好的图被一起丢掉**，结果一个字一张图都没发。
 *
 * 抽出来还能单独测（tests/check-segments.mjs），不必起整个 bridge。
 *
 * @param {string} text  已剥掉标记的正文（可以为空）
 * @param {{url?:string}|null} cover 配图（base64 data URL 或 http 链接）
 * @param {{maxChars?:number, segment?:boolean}} [opts]
 * @returns {Array<object>} 段列表，kind ∈ text|face|mface|image
 */
export function buildOutgoingSegments(text, cover = null, opts = {}) {
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 500
  const segment = opts.segment === true

  const segments = []
  for (const piece of splitFaceMarkers(text)) {
    if (piece.kind === 'face' || piece.kind === 'mface') { segments.push(piece); continue }
    const chunks = segment ? splitMessage(piece.text, maxChars) : [piece.text]
    for (const c of chunks) if (String(c).trim()) segments.push({ kind: 'text', text: String(c) })
  }

  // ⚠️ 配图**不**依赖已有文字 —— 见上方注释
  if (cover?.url) segments.push({ kind: 'image', url: cover.url })
  return segments
}

/** 按句读 + 长度拆分成多条消息（像人发消息那样）。 */
export function splitMessage(text, maxChars = 500) {
  const t = String(text).trim()
  if (!t) return []

  // ── ① 空行是**显式的分段意图** ──────────────────────────────
  //
  // 模型写两段中间空一行，意思就是"这两句分开说"。真人聊天也这样：
  // 「行吧」＋「等我先吃完这碗饭」是两条消息，不是一条长消息。
  //
  // 所以空行优先于长度判断 —— 哪怕整段只有 10 个字，有空行也要分开。
  // ⚠️ 用两个及以上换行（\n\s*\n）作判据，单个换行不算分段，
  //    否则模型偶尔折行也会被切成两条。
  const blocks = t.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)
  if (blocks.length > 1) {
    const out = []
    for (const b of blocks) {
      // 每个块内部再按长度/句子细分
      out.push(...splitBySentences(b, maxChars))
    }
    return out
  }

  // ── ② 没有空行 → 按长度和句子切 ────────────────────────────
  return splitBySentences(t, maxChars)
}

/**
 * 按句末标点把一段切成不超过 maxChars 的多条。
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitBySentences(text, maxChars) {
  const t = String(text).trim()
  if (!t) return []
  if (t.length <= maxChars) return [t]

  const parts = []
  // 先按句末标点切
  const sentences = t.split(/(?<=[。！？!?~…\n])/)
  let buf = ''
  for (const s of sentences) {
    if ((buf + s).length > maxChars && buf) {
      parts.push(buf)
      buf = s
    } else {
      buf += s
    }
  }
  if (buf) parts.push(buf)

  // 单句仍然超长 → 硬切
  const out = []
  for (const p of parts) {
    if (p.length <= maxChars) { out.push(p); continue }
    for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars))
  }
  return out.filter((s) => s.trim())
}
