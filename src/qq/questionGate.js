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
 *
 * @param {object} d    决策结果
 * @param {string} text 原始消息文本
 * @param {object} [opts]
 * @param {boolean} [opts.isMe]    是不是自己发的
 * @param {boolean} [opts.enabled] 默认 true
 * @returns {object} 处理后的决策（可能与入参同一个对象）
 */
export function applyQuestionOverride(d, text, opts = {}) {
  if (!d || typeof d !== 'object') return d
  if (d.reply) return d
  if (opts.isMe === true) return d
  if (opts.enabled === false) return d

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
