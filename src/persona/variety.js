/**
 * 防模板化：让它别老用同一个开头。
 *
 * ## 为什么需要（抄自 X 上大肥鱼的坑 10）
 *
 * 一天几百条回复看下来，开头高度重复：
 *   「在的在的」「行吧」「啊这」「不是，」「你说得对」
 *
 * **单条看不出来，批量看立刻露馅。** 这是「像机器人」最明显的信号之一，
 * 比 emoji 和颜文字都明显 —— 因为人不会每次都同一个起手式。
 *
 * ## 做法
 *
 * 把她**最近十几条回复的开头**列出来，随提示词一起给模型，
 * 要求「这一条别用这些开头」。不是禁止所有话，只是错开。
 *
 * 成本很低（十几个短句，几百 token），效果直接。
 */

/** 取多少个字当「开头」—— 太短分不出，太长变成要求不复述整句。 */
const HEAD_LEN = 6

/** 列出多少个历史开头。 */
const KEEP = 12

/**
 * 从一条回复里提取「开头」用于查重。
 *
 * 去掉表情标记和**首尾**标点 —— 否则「行吧」和「行吧，」会被当成
 * 两个不同开头，白白占掉「换个说法」列表的位置（实测踩过）。
 *
 * @param {string} text
 * @returns {string}
 */
export function replyHead(text) {
  const s = String(text ?? '')
    // 标记不算开头
    .replace(/\[表情包(?::[^\]]*)?\]/g, '')
    .replace(/\[表情:\d+\]/g, '')
    .replace(/\[找图[:：][^\]]*\]/g, '')
    .replace(/\[改昵称[:：][^\]]*\]/g, '')
    .replace(/\[禁言[:：][^\]]*\]/g, '')
    // 首尾标点都去掉：`^` 只处理开头，结尾必须单独处理
    .replace(/^[\s，。！？、,.!?~～…]+/, '')
    .replace(/[\s，。！？、,.!?~～…]+$/, '')
    .trim()
  return s.slice(0, HEAD_LEN)
}

/**
 * 从最近若干条自己的回复里，提取不重复的开头。
 *
 * @param {Array<{text:string, isMe?:boolean}>} messages
 * @param {number} [keep]
 * @returns {string[]}
 */
export function recentHeads(messages, keep = KEEP) {
  const out = []
  const seen = new Set()
  for (let i = (messages ?? []).length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m?.isMe) continue
    const h = replyHead(m.text)
    if (h.length < 2) continue
    if (seen.has(h)) continue
    seen.add(h)
    out.push(h)
    if (out.length >= keep) break
  }
  return out
}

/**
 * 生成「起手方式」提示。
 *
 * 没有历史（或全都不同）时返回空串 —— 不占提示词空间。
 *
 * ## ⚠️ 2026-10-31 从「黑名单 + 禁止」改成「候选 + 挑选」
 *
 * 原来的写法是：
 * ```
 * 你最近这些回复是这么开头的：· 那可不，吃是…
 * **这一条别用上面任何一个开头**
 * ```
 * **副作用（用户实测到的）**：他问「不你说的吗」（指机器人自己说的
 * 「吃是正事」），机器人回「我说啥了，你倒是说清楚」——
 * **它不敢重复自己刚说过的话**，因为那条开头正在"禁用清单"里。
 *
 * A/B（同一段真实上下文，各 3 次）：
 * ```
 * 不带这条提示：2/3 复述了「吃是正事」
 * 带这条提示：  0/3
 * ```
 * 注意它**没有否认**（仍有 2 次说「是我说的，认了」），
 * 但**明显不愿复述原句**。
 *
 * ## 参考麦麦（MaiBot）的做法
 * 它的 `maisaka_expression_selector.prompt` 是**正向**的：
 * ```
 * Select 0 to {max_selected} expressions from the candidates below
 * that best fit the current context.
 * If none are clearly suitable, return an empty array.
 * ```
 * —— 从**候选**里挑、**允许不挑**、标准是「适合当前上下文」。
 *
 * 所以这里也改成：列出最近的起手当**参考**（不是黑名单），
 * 给几个**起手方式**让模型挑，并明确「**复述自己说过的话**」是一个**合法选项**。
 *
 * @param {Array<{text:string, isMe?:boolean}>} messages
 * @returns {string}
 */
export function buildVarietyHint(messages) {
  const heads = recentHeads(messages)
  // 少于 3 个说明聊得还少，谈不上模板化
  if (heads.length < 3) return ''
  return `## 起手方式

你最近几条是这么开头的（**仅供参考，不是禁用清单**）：
${heads.map((h) => `· ${h}…`).join('\n')}

这一条从下面挑一个起手 —— **也可以不挑，按你本来想说的来**：
· 直接给结论：「就是…」「对，…」
· 先反问：「你说呢」「咋了」
· 只说半句，剩下的让对方接
· 从对方的话里挑个词接着说
· **直接承认或复述自己说过的**：「我说过…」「是我说的」← 对方问起时用这个

⚠️ 别为了「不一样」硬凑怪句子 —— 换句式，不是换花样。
⚠️ **对方在问你说过什么、让你重复、或指代你的话（「不你说的吗」「你刚说的」「那不是你说的」）时，
   就照实复述，不受这里任何约束。复述不等于套路。**`
}

/**
 * 表情包/颜文字的开关建议。
 *
 * 作者的规则是「用过一次后下一条就不给用，交替开放」。
 * 这样既不会一段对话里连着甩表情，也不会永远不发。
 *
 * @param {Array<{text:string, isMe?:boolean}>} messages
 * @returns {{allowSticker:boolean, allowEmoji:boolean, hint:string}}
 */
export function buildExpressionHint(messages) {
  const mine = (messages ?? []).filter((m) => m?.isMe)
  // 最近一条自己的回复有没有用表情包 / QQ 表情
  const last = mine.length > 0 ? String(mine[mine.length - 1]?.text ?? '') : ''
  const lastHadSticker = /\[表情包(?::[^\]]*)?\]/.test(last)
  const lastHadFace = /\[表情:\d+\]/.test(last)

  // 连带用过的次数也看 —— 连发三张表情包的观感很差
  let streakSticker = 0
  for (let i = mine.length - 1; i >= 0; i--) {
    if (/\[表情包(?::[^\]]*)?\]/.test(String(mine[i]?.text ?? ''))) streakSticker++
    else break
  }

  const allowSticker = !lastHadSticker && streakSticker < 2
  const allowEmoji = !lastHadFace

  const lines = []
  if (!allowSticker) lines.push('· **这一条不要再发表情包** —— 上一条（或最近连着几条）已经发过了')
  if (!allowEmoji) lines.push('· **这一条不要再用 [表情:N]** —— 上一条已经用过了')
  return { allowSticker, allowEmoji, hint: lines.join('\n') }
}
