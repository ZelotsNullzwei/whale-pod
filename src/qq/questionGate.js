import { needsFreshInfo } from '../gateway/search.js'

/**
 * 「提问就要答」兜底（2026-10-28，用户原话：「问要回啊，这都没回」）。
 *
 * ## 为什么需要
 *
 * 实测：群里问「你知道祀是谁吗」，决策层判「这段跟我无关」→ 沉默。
 * 但 `needsFreshInfo` 明明识别出这是**需要查资料的问题** ——
 * 结果连搜索都没走到（搜索在生成层，生成层只在决策说"回"之后才跑）。
 *
 * 用户看到的观感是「问了不理」，而这其实不是搜索坏了，是前面那道门没开。
 *
 * ## 为什么敢直接覆盖决策
 *
 * `needsFreshInfo` 已经内置排除了两类**不该搜**的：
 *   · 寒暄：吃了/睡了/在吗/忙吗…
 *   · 反问：你不是/你才/你刚/不是才…（这类是在怼人，不是查资料）
 *
 * 它说 `need === true`，就是「在问某个具体的东西」，沉默就是错的。
 *
 * 另外 `search.images` 已关（`false`），不会再出现「一句质问换一张
 * 公众号封面图」那种翻车。
 *
 * ## 边界
 *
 * - 只覆盖**别人的**消息（`isMe` 时不覆盖）
 * - 已经是 `reply: true` 的不动（没必要二次加工）
 * - 可以通过 `enabled: false` 整条关掉
 * - ⚠️ **明确 @ 了别人（且不是 @ 我）的提问，不覆盖**（2026-11-02 实测事故）
 *
 *   ## 那个事故
 *   群里有人发：「**@某群友(2129024700) 发个CAD嘞**」—— @ 的是**另一个人**，
 *   决策层已经判「沉默（先不接，还在听）」，**判得对**。
 *   但这一层看到"发个CAD嘞"是个问句、`needsFreshInfo` 为真，就**直接覆盖成回答**，
 *   还去联网查了一遍：
 *   ```
 *   03:35:48 决策 → 沉默（模型判断：先不接）
 *   03:35:48 这条是提问 → 覆盖沉默，改成回答（查「@某群友 发个CAD嘞」）
 *   03:35:52 [我]「CAD 啊，本鱼刚瞅了眼，有人说这玩意儿得一千块才给」
 *   ```
 *   用户看到的就是**别人被 @ 时她插嘴** —— 群聊体验上的真问题。
 *
 *   ## 为什么这条判据可靠
 *   `mentionsMe` 在入库时就定好了（= 被 @ 或**引用了她自己的消息**，见 `_handle`），
 *   不是这里现算的，所以读它不会引入新的误判。
 *
 *   ⚠️ **只有"明确 @ 了别人"时才拦**（`atSomeoneElse`）。没有 @ 的普通提问照旧覆盖
 *      —— 那是这条规则本来的用途，别一刀切掉。
 *
 * @param {object} d    决策结果
 * @param {string} text 原始消息文本
 * @param {object} [opts]
 * @param {boolean} [opts.isMe]          是不是自己发的
 * @param {boolean} [opts.enabled]       默认 true
 * @param {boolean} [opts.mentionsMe]    这条是不是 @ 了我（入库时算好的）
 * @param {boolean} [opts.atSomeoneElse] 这条**明确 @ 了别人**（且不是 @ 我）
 * @returns {object} 处理后的决策（可能与入参同一个对象）
 */
export function applyQuestionOverride(d, text, opts = {}) {
  if (!d || typeof d !== 'object') return d
  if (d.reply) return d
  if (opts.isMe === true) return d
  if (opts.enabled === false) return d
  /* ★ 明确 @ 了别人的提问不归我答 —— 见上面那段事故 */
  if (opts.atSomeoneElse === true && opts.mentionsMe !== true) return d

  let nf
  try {
    nf = needsFreshInfo(text)
  } catch (e) {
    if (process.env.QG_DEBUG) console.error('QG_DEBUG 捕获:', e)
    return d
  }
  if (!nf?.need) return d

  return {
    ...d,
    reply: true,
    probability: 1,
    // 冷却排队（defer）是另一套语义，这里要让位给「直接回答」
    defer: null,
    delayMs: Number.isFinite(d.delayMs) ? d.delayMs : 800,
    provider: d.provider ?? 'question',
    reason: `提问需查资料（${nf.why}）`,
    // 留给日志展示用
    questionQuery: nf.query,
  }
}
