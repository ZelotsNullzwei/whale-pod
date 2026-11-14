/**
 * 手部契约（hand contract）—— **唯一真源**：某个拍摄模式下，画面允许出现几只手、持机手是否可见。
 *
 * 目的：把"手应该有几只"从散落的静态文案里收回来，供
 *   ① 生成 Prompt（photo-prompt）
 *   ② 审核器（captureCheck.reviewHands）
 * 共用同一份数字，避免两边各说各话。
 *
 * 约束来源：用户 2026-11-09《第一人称摄影系统专项整改方案》：
 *   · first_person：默认无手；单手动作最多 1 只；双手默认不允许
 *   · rear_object：持机手不入画，只出现动作需要的手（≤1）
 *   · rear_selfie：可以只露手/手臂（≤1；动作确需双手须显式声明）
 *   · front_selfie：持机手/手机通常在画外，其他手部动作单独规划（可见 ≤1）
 *   · mirror_selfie：镜中可见持机手+手机，不得无故增加另一只手（默认 1）
 *   · back_view：不涉及手（0）
 */

/** 每个模式的基准契约（不含"动作确需双手"的例外） */
export const HAND_CONTRACTS = {
  first_person: { maxVisibleHands: 1, baselineHands: 0, holderHand: 'none', allowTwoHandsWhenAction: false, occupiesHand: true, holderVisible: false, note: '默认不出手；单手动作最多 1 只' },
  rear_object: { maxVisibleHands: 1, baselineHands: 0, holderHand: 'hidden', allowTwoHandsWhenAction: false, occupiesHand: true, holderVisible: false, note: '持机手不入画，最多 1 只操作手' },
  rear_selfie: { maxVisibleHands: 1, baselineHands: 0, holderHand: 'hidden', allowTwoHandsWhenAction: false, occupiesHand: true, holderVisible: false, note: '可只露手/手臂，最多 1 只；确需双手须显式声明' },
  front_selfie: { maxVisibleHands: 1, baselineHands: 0, holderHand: 'hidden', allowTwoHandsWhenAction: false, occupiesHand: true, holderVisible: false, note: '持机手/手机在画外，可见手最多 1 只' },
  face_closeup: { maxVisibleHands: 1, baselineHands: 0, holderHand: 'hidden', allowTwoHandsWhenAction: false, occupiesHand: true, holderVisible: false, note: '怼脸特写：默认不出手；托腮/挡脸等最多 1 只' },
  mirror_selfie: { maxVisibleHands: 2, baselineHands: 1, holderHand: 'visible', allowTwoHandsWhenAction: false, occupiesHand: true, holderVisible: true, note: '镜中可见持机手+手机；另一只手做当前动作或自然垂放，不得出现第三只手' },
  back_view: { maxVisibleHands: 0, baselineHands: 0, holderHand: 'hidden', allowTwoHandsWhenAction: false, occupiesHand: false, holderVisible: false, status: 'placeholder_pending_product', note: '背影：占位规则（怎么拍待产品决定），手不入画' },
  /* 架机定时（2026-11-10）：没有持机手，双手都可以入画 */
  tripod: { maxVisibleHands: 2, baselineHands: 0, holderHand: 'none', allowTwoHandsWhenAction: true, occupiesHand: false, holderVisible: false, note: '架机定时拍摄（无持机手，允许双手）' },
  /* 视频通话：设备固定，不占手；手数上限待产品决定（null） */
  video_call: { maxVisibleHands: null, baselineHands: 0, holderHand: 'none', allowTwoHandsWhenAction: true, occupiesHand: false, holderVisible: false, note: '视频通话（设备固定，手数上限待定）' },
  /* 纯场景：画面没有人，也就没有手 */
  scene_only: { maxVisibleHands: 0, baselineHands: 0, holderHand: 'hidden', allowTwoHandsWhenAction: false, occupiesHand: false, holderVisible: false, note: '纯场景图，无人无手' },
}

/**
 * 取某模式的手部契约。
 * @param {string} mode
 * @param {{ actionRequiresBothHands?: boolean }} [opts] 显式声明"动作确需双手"时才放宽
 */
export function handContractFor(mode, { actionRequiresBothHands = false } = {}) {
  const m = String(mode ?? '')
  const base = HAND_CONTRACTS[m]
  if (!base) return null   // 未登记模式：不套用手部契约（也不据此阻断）
  const max = actionRequiresBothHands && base.allowTwoHandsWhenAction ? 2 : base.maxVisibleHands
  return { mode: m, maxVisibleHands: max, baselineHands: base.baselineHands, holderHand: base.holderHand, note: base.note, actionRequiresBothHands: Boolean(actionRequiresBothHands) }
}

/** 该模式是否需要"手部门禁"（未登记模式不阻断，保持旧行为） */
export function requiresHandGate(mode) {
  return Boolean(HAND_CONTRACTS[String(mode ?? '')])
}

/** 生成 Prompt 用的权威一行（放最后，压过其它散落表述） */
export function handRuleLine(contract) {
  if (!contract) return ''
  const { maxVisibleHands: max, holderHand, note } = contract
  const holder = holderHand === 'visible'
    ? '镜中可以看到持机手与手机；另一只手可自然出现，不得出现第三只手'
    : (holderHand === 'hidden' ? '持机手与手机不入画' : '画面中不出现持机手')
  if (max === 0) return `【手部契约】${note}：**画面里不得出现手或手臂**（${holder}）。`
  if (max == null) return `【手部契约】${note}：手数上限**待定**（${holder}）；不要出现多余的手。`
  return `【手部契约】${note}：**最多 ${max} 只手**（${holder}）；不得出现多余的手、重复的同侧手或第三只手。`
}

/**
 * 由 Pose Planner 的手部职责生成 Prompt 说明（动作需要几只手、左右职责、持机手）。
 * 契约上限仍由模式决定；若动作需求超过上限，明确提示"拆分动作/用桌面支撑"，不擅自放宽。
 */
export function handDutyLine(contract, pose) {
  if (!contract || !pose || !pose.hands) return ''
  const h = pose.hands
  const camRaw = Number(h.cameraHands ?? 0)
  const camVisible = contract.holderHand === 'visible' ? camRaw : 0
  const camHidden = contract.holderHand === 'hidden' ? camRaw : 0
  const cap = contract.maxVisibleHands

  /* unknown：不写"动作手 N 只"，只写按上限执行（2026-11-10） */
  const need = h.needVisibleHands !== undefined ? h.needVisibleHands : (h.requiredCount ?? null)
  if (need == null) {
    const parts0 = []
    if (camVisible > 0) parts0.push('持机手 ' + camVisible + ' 只（镜中可见）')
    else if (camHidden > 0) parts0.push('持机手 ' + camHidden + ' 只（不入画）')
    parts0.push('手数未知：按本模式最多 ' + (cap == null ? '待定' : cap) + ' 只手执行，不要增加手')
    return '【动作手部】' + parts0.join('｜') + '。'
  }

  const action = Number(h.actionHands ?? 0)
  const poseHands = Number(h.poseHands ?? 0)
  const fmt = (side) => {
    if (!side) return ''
    if (typeof side === 'string') return side
    const t = [side.role, side.action].filter(Boolean).join('/')
    return t
  }
  const left = fmt(h.left)
  const right = fmt(h.right)
  const parts = []
  if (action > 0) parts.push('动作手 ' + action + ' 只')
  if (poseHands > 0) parts.push('摆姿势手 ' + poseHands + ' 只')
  if (camVisible > 0) parts.push('持机手 ' + camVisible + ' 只（镜中可见）')
  else if (camHidden > 0) parts.push('持机手 ' + camHidden + ' 只（不入画）')
  const duties = [left && '左手:' + left, right && '右手:' + right].filter(Boolean)
  if (duties.length) parts.push(duties.join('；'))
  if (!parts.length) return ''
  if (cap != null && need > cap) parts.push('⚠️ 规划动作需要 ' + need + ' 只手，超过本模式上限 ' + cap + '：优先拆分动作或让物品放桌面/支撑，不要增加第三只手')
  return '【动作手部】' + parts.join('｜') + '。'
}
