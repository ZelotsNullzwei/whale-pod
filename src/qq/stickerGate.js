/**
 * 这条内容是不是「只回了表情、没有文字」。
 *
 * 用于判断表情包的**斗图节奏**：连着两条纯表情就是在刷屏，该停了。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isPureStickerText(text) {
  const s = String(text ?? '')
  if (!/\[表情/.test(s)) return false
  const rest = s
    .replace(/\[表情包(?::[^\]]*)?\]/g, '')
    .replace(/\[表情:\d+\]/g, '')
    .replace(/\s+/g, '')
  return rest.length === 0
}

/**
 * 表情包要不要接（2026-10-28，用户选 B）。
 *
 * ## 背景：那张青蛙表情包出现 4 次，它 4 次都回了
 *
 * ```
 * 15:23:34 → 15:23:37 回「[表情包]」
 * 15:24:48 → 15:24:51 回「这青蛙看着还挺心宽体胖的」
 * 16:26:42 → 16:26:58 回「[表情包]」
 * 17:45:29 → 17:45:38 回「[表情包]」
 * ```
 * 用户原话：「还是反应青蛙，为啥啊」。
 *
 * 根因：这条路径**完全没有「是不是在跟我说话」的判断** —— 决策层给
 * `p=0.75「纯图片 → 交给生成层看图判断像不像自己」`，唯一的抑制是
 * 「最近 3 条回复里已有 2 条纯表情」，而青蛙前后夹着大量别人的聊天，
 * 计数器根本攒不到 2。
 *
 * ## 五次调整历史（别再走回头路）
 *   ① 无条件放行 → 见表情就回
 *   ② 整个排除   → 连**跟它斗图**都不接了
 *   ③ 按「群里有没有人热聊」判断 → 错，那些话恰恰是在聊它
 *   ④ 放行 + 只防连发 → **还是每张都回**
 *   ⑤ **只在明确互动时回** ← 现在
 *
 * @param {object} o
 * @param {object} o.msg   当前消息（要能调 `isAtMe`，或直接给 `atMe`）
 * @param {string} o.selfId 机器人 QQ
 * @param {Array}  [o.recent] 最近的消息（含自己发的），用于判断节奏
 * @returns {boolean}
 */
export function shouldAnswerSticker(o = {}) {
  const { msg, selfId, recent = [] } = o

  // ① @ 它 / ② 引用它自己的消息 —— 明确点名，永远放行
  const atMe = o.atMe === true
    || (typeof msg?.isAtMe === 'function' ? msg.isAtMe(selfId) : false)
  const quotedMine = Boolean(
    msg?.replyTo && recent.some((m) => m?.isMe && String(m?.id ?? '') === String(msg.replyTo)),
  )
  if (atMe || quotedMine) return true

  const mineAll = recent.filter((m) => m?.isMe)

  // 防连发：最近 3 条自己的发言里已有 2 条「只回表情」→ 停
  // （这是对下面 ③/④ 的上限；@ 和引用不受它限制）
  const pureStickerReplies = mineAll.slice(-3).filter((m) => isPureStickerText(m.text)).length
  if (pureStickerReplies >= 2) return false

  const lastMine = mineAll[mineAll.length - 1]
  if (lastMine) {
    const gap = Number(msg?.at ?? 0) - Number(lastMine.at ?? 0)
    if (gap >= 0 && gap <= 60_000 && isPureStickerText(lastMine.text)) {
      return true                                    // ③ 斗图：接它刚发的表情
    }
    if (gap >= 0 && gap <= 20_000 && !isPureStickerText(lastMine.text)) {
      return true                                    // ④ 它刚说完话，同一个人接着发表情
    }
  }

  // 没满足任何「明确互动」→ 不接。表情包只是情绪信号，别人互相斗图不关它的事。
  return false
}