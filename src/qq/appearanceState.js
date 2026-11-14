/**
 * 聊天里她自己说过的"外观状态"（2026-11-11）
 *
 * 场景：她在私聊说「你要看马尾的话，本鲸扎起来」，紧接着发来「来张自拍」。
 * 出图必须画**马尾**，不能再用日程里的"披着，头发有点乱"。
 *
 * 只认「她自己（isMe）最近说过」的发型/换装，且有时间窗（默认 2 小时）；
 * 文案必须能落到明确形态，模糊表述不当依据。
 */

/** 从消息列表里取她最近说过的发型；取不到返回 '' */
export function detectSaidHair(messages = [], now = Date.now(), maxAgeMs = 2 * 3600_000) {
  for (const m of [...messages].reverse()) {
    if (!m || m.isMe !== true) continue
    const at = Number(m.at ?? 0)
    if (at && now - at > maxAgeMs) continue
    const t = String(m.text ?? '')
    if (!t) continue
    if (/(丸子头|盘起来|盘发)/.test(t)) return '扎成丸子头，头发收干净'
    if (/马尾/.test(t)) return '扎成马尾（刚扎的，发尾自然）'
    if (/(扎起来|扎一下|扎了|扎好)/.test(t)) return '扎成马尾（刚扎的）'
    if (/(披着|披下来|披肩|没梳|没顾上梳)/.test(t)) return '披着，自然状态（可能有点乱）'
  }
  return ''
}

/** 从消息列表里取她自己最近说的"穿了什么"原文（交给 wardrobe 映射） */
export function detectSaidOutfitText(messages = [], now = Date.now(), maxAgeMs = 2 * 3600_000, extractSaidOutfit) {
  if (typeof extractSaidOutfit !== 'function') return ''
  for (const m of [...messages].reverse()) {
    if (!m || m.isMe !== true) continue
    const at = Number(m.at ?? 0)
    if (at && now - at > maxAgeMs) continue
    const raw = extractSaidOutfit(String(m.text ?? ''))
    if (raw) return raw
  }
  return ''
}
