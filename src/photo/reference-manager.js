/**
 * reference-manager · P1-1（独立模块，**未接入** formal 生图入口）
 *
 * 问题（已核实证据）：`head-video-ahoge.png` 这张"脸参考图"其实是**女仆装半身照**
 *（白色蕾丝女仆裙、露肩、蓝蝴蝶结，且瞳色为棕色）。当它被当作 face ref 传入时，
 * 会同时把**服装、身材、瞳色**一起带进画面 —— 于是日程选的家居服被覆盖成女仆装。
 *
 * 本模块只回答一件事：**这一次该用哪张参考图**。规则：
 *   1. 画面里本就不该有人（first_person / rear_object / scene_only）→ 不用任何人物参考图
 *   2. 日程服装与 canon 定妆照**一致** → 可以用 canon
 *   3. 不一致 → **不允许**用带服装的 canon；只能用"只锁脸"的参考图（faceRefKind==='head'）
 *   4. 没有合适的只锁脸参考图 → 不用参考图，走 PROFILE 兜底文字
 *
 * 注意：这里不判断服装该穿什么（那是衣柜/日程的事），只判断"参考图会不会污染服装"。
 */

/** 服装主体词（用于判断"是不是同一套衣服"） */
const GARMENT_WORDS = [
  '吊带', '背心', '短裤', '长裤', '裙', '衬衫', '衬衣', 'T恤', 't恤', '卫衣', '毛衣',
  '针织', '开衫', '外套', '风衣', '睡衣', '睡裙', '制服', '水手', '女仆', '围裙', '泳',
]

function tokens(text) {
  const t = String(text ?? '')
  const out = new Set()
  for (const w of GARMENT_WORDS) if (t.includes(w)) out.add(w)
  return out
}

/** 两段服装描述是否算"同一套"：共享主体词 ≥2，或 Jaccard ≥0.34 */
export function sameOutfit(a, b) {
  const A = tokens(a)
  const B = tokens(b)
  if (!A.size || !B.size) return false
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  const jac = shared / (A.size + B.size - shared)
  return shared >= 2 || jac >= 0.34
}

/** 画面里是否可能出现人物（由 camera mode 决定；不重新推断） */
const NO_PERSON_MODES = new Set(['first_person', 'rear_object', 'scene_only'])

/**
 * @param {object} o
 * @param {string} o.outfitText    当天（或本轮）实际要穿的
 * @param {{match?:string,label?:string,file:string}|null} o.canon  命中的定妆照
 * @param {string} o.faceRef       只锁脸的参考图路径
 * @param {'head'|'costume'|'unknown'} o.faceRefKind  参考图性质（关键）
 * @param {string} o.mode          camera mode
 * @returns {{strategy:'canon'|'face'|'fallback'|'none', refImage:string|null, reason:string, conflict:boolean}}
 */
export function resolveReference({ outfitText = '', canon = null, faceRef = '', faceRefKind = 'unknown', mode = '' } = {}) {
  /* ① 本来就不该有人 */
  if (NO_PERSON_MODES.has(String(mode))) {
    return { strategy: 'none', refImage: null, reason: 'mode_has_no_person', conflict: false }
  }

  const canonOutfit = canon ? String(canon.label ?? canon.match ?? '') : ''

  /* ② 有 canon 且与当天服装一致 → 用 canon */
  if (canon && canon.file && canonOutfit && sameOutfit(outfitText, canonOutfit)) {
    return { strategy: 'canon', refImage: canon.file, reason: 'outfit_matches_canon', conflict: false }
  }

  /* ③ canon 存在但不一致 → 冲突：绝不能用它（会覆盖当天服装） */
  const conflict = Boolean(canon && canon.file && canonOutfit && !sameOutfit(outfitText, canonOutfit))

  /* ④ 只能用"只锁脸"的参考图；带服装的参考图（costume）同样会污染服装 */
  if (faceRef && faceRefKind === 'head') {
    return {
      strategy: 'face',
      refImage: faceRef,
      reason: conflict ? 'canon_conflicts_with_day_outfit_use_head_ref' : 'no_canon_use_head_ref',
      conflict,
    }
  }

  /* ⑤ 兜底：不用参考图，走 PROFILE 文字 */
  return {
    strategy: 'fallback',
    refImage: null,
    reason: conflict
      ? 'canon_conflicts_and_face_ref_not_head_only'
      : (faceRef && faceRefKind === 'costume' ? 'face_ref_carries_costume' : 'no_usable_reference'),
    conflict,
  }
}

export const REFERENCE_STRATEGIES = ['canon', 'face', 'fallback', 'none']
