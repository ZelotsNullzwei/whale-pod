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
 * 生成「换个说法」提示。
 *
 * 没有历史（或全都不同）时返回空串 —— 不占提示词空间。
 *
 * @param {Array<{text:string, isMe?:boolean}>} messages
 * @returns {string}
 */
export function buildVarietyHint(messages) {
  const heads = recentHeads(messages)
  // 少于 3 个说明聊得还少，谈不上模板化
  if (heads.length < 3) return ''
  return `## 换个说法

你最近这些回复是这么开头的：
${heads.map((h) => `· ${h}…`).join('\n')}

**这一条别用上面任何一个开头，也别用同样的句式。**
换个起手：可以直接给结论、可以先反问、可以只说半句、可以从对方的话里挑个词接着说。
不要为了「不一样」而硬凑怪句子 —— 换句式，不是换花样。`
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
