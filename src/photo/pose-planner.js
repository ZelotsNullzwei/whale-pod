/**
 * pose-planner · V3.0 第四阶段
 *
 * 唯一职责：人物身体怎么完成动作 —— 姿势、左右手职责、肢体数量、接触关系、
 *           以及"动作需要" 与 "画面可见" 的区分。
 *
 * 禁止：修改 subject / camera / framing，不决定构图、不决定机位。
 * 未知：一律 null / []，并用 unresolved 记录，不编造左右手、不默认姿势。
 */

const POSTURE = [
  { re: /(躺在|躺着|趴着)/, posture: 'lying' },
  { re: /(坐着|坐在|坐姿)/, posture: 'sitting' },
  { re: /(蹲|蹲着)/, posture: 'squatting' },
  { re: /(跪|跪着)/, posture: 'kneeling' },
  { re: /(站在|站着|站)/, posture: 'standing' },
]

/** 显式左右手（只有她说清楚才认） */
function explicitSides(text) {
  const out = { left: null, right: null }
  const mLeft = /左手[^，。；]{0,8}?(拿|端|握|扶|按|托|举|放|整理|写|翻)/.exec(text)
  const mRight = /右手[^，。；]{0,8}?(拿|端|握|扶|按|托|举|放|整理|写|翻)/.exec(text)
  if (mLeft) out.left = mLeft[1]
  if (mRight) out.right = mRight[1]
  return out
}

/** 动作 → 手部需求与接触关系 */
function analyzeAction(intent) {
  const text = String(intent._raw ?? '')
  const acts = (intent.activities || []).map((a) => a.type)
  const contacts = []
  let actionHands = 0
  let actionVerb = null
  let target = null

  if (/(双手|两只手|捧|拧|撕开|掰)/.test(text)) {
    actionHands = 2
    actionVerb = /(捧)/.test(text) ? 'holding' : 'manipulating'
    target = (text.match(/(碗|盆|箱|袋子|衣服|被子)/) || [])[1] || null
  } else if (/(端着|拿着|握着|举着|捧着|喝)/.test(text)) {
    actionHands = 1
    actionVerb = 'holding'
    target = (text.match(/(杯|碗|瓶|手机|书|杯水|水杯)/) || [])[1] || null
  } else if (/(写字|翻书|翻页|按着|按住|压着)/.test(text)) {
    actionHands = /(写字|翻书)/.test(text) && /(按住|按着|压着)/.test(text) ? 2 : 1
    actionVerb = 'manipulating'
    target = /(纸|书|本子)/.test(text) ? 'book' : null
  } else if (/(整理|收拾|擦拭|擦桌|挑|翻找|摆弄)/.test(text)) {
    actionHands = 1
    actionVerb = 'manipulating'
    target = /(桌|台面)/.test(text) ? 'table' : null
  } else if (/(扶着|撑着|按在|搭在)/.test(text)) {
    actionHands = 1
    actionVerb = 'supporting'
    target = /(桌|墙|床|栏杆|扶手)/.test(text) ? 'support' : null
  } else if (/(放在|搁在|摆在)/.test(text)) {
    actionHands = 1
    actionVerb = 'resting_on'
    target = /(桌|台面)/.test(text) ? 'table' : /(腿|膝)/.test(text) ? 'lap' : null
  }

  if (actionHands > 0 && actionVerb) {
    contacts.push({ source: 'hand', target, relation: actionVerb })
  }
  return { actionHands, actionVerb, target, contacts, acts }
}

/** 可见性：动作需要 ≠ 画面可见；由 framing.band 决定上限 */
function visibleFrom(band, requiredTotal) {
  if (!band) return { visibleHands: [], visibleArms: [], visibleBodyParts: [], limited: false }
  const capByBand = { hand_object: 2, object: 1 }
  if (band in capByBand) {
    const n = Math.min(requiredTotal, capByBand[band])
    const hands = n === 2 ? ['left', 'right'] : n === 1 ? ['hand'] : []
    return { visibleHands: hands, visibleArms: n > 0 ? [n === 2 ? 'both' : 'one'] : [], visibleBodyParts: [], limited: requiredTotal > n }
  }
  /* 其余取景：不显示手（自拍/头肩/全身/背影/环境） */
  return { visibleHands: [], visibleArms: [], visibleBodyParts: [], limited: requiredTotal > 0 }
}

export function planPose(intent = {}, camera = {}, framing = {}) {
  const text = String(intent._raw ?? '')
  const unresolved = []

  const posture = (POSTURE.find((r) => r.re.test(text)) || {}).posture ?? null
  if (!posture) unresolved.push('posture')

  const { actionHands, actionVerb, target, contacts } = analyzeAction(intent)
  const sides = explicitSides(text)

  /* 持机手（来自 camera.capture，不重复计数） */
  const cameraHands = camera && camera.capture && camera.capture.holdingDevice ? 1 : 0

  /* 去重：动作手 + 持机手，同一只手不重复计数 */
  /*
   * 第一人称的相机在眼睛位置 —— 不占"画面里的手"，不能和动作手叠加计数。
   * 自拍/镜拍才是真的用一只手举机（那只是 1 只手，且前摄不入画）。
   */
  const cameraHandCounts = camera && camera.mode === 'first_person' ? 0 : cameraHands
  const rawRequired = Math.min(2, actionHands + cameraHandCounts)
  const requiredCount = rawRequired

  /* 左右职责：只有明确说了才填，否则 null（不随机分配） */
  const left = { role: sides.left ? 'action' : null, action: sides.left ?? null }
  const right = { role: sides.right ? 'action' : null, action: sides.right ?? null }
  if (requiredCount > 0 && !sides.left && !sides.right) unresolved.push('hand_sides_unknown')
  if (requiredCount === 2 && (!sides.left || !sides.right)) unresolved.push('two_hand_assignment_incomplete')

  const __portraitMode = camera && ['front_selfie', 'face_closeup', 'video_call', 'mirror_selfie', 'back_view', 'scene_only'].includes(camera.mode)
  const vis = __portraitMode
    ? { visibleHands: [], visibleArms: [], visibleBodyParts: [], limited: requiredCount > 0 }
    : visibleFrom(framing ? framing.band : null, requiredCount)
  if (vis.limited) unresolved.push('action_exceeds_visible_range')
  if (!framing || !framing.band) unresolved.push('framing_band_unknown')

  /* 视角朝向：只读 camera，不改它 */
  let orientation = null
  if (camera && camera.mode === 'back_view') orientation = 'back_to_camera'
  else if (camera && camera.mode) orientation = 'facing_camera'

  return {
    pose: { type: null, orientation, posture },
    limbs: {
      leftArm: sides.left ? 'active' : null,
      rightArm: sides.right ? 'active' : null,
      leftLeg: null,
      rightLeg: null,
    },
    hands: {
      requiredCount,
      actionHands,
      poseHands: 0,
      cameraHands,
      left,
      right,
    },
    contacts,
    visibility: vis,
    source: actionHands > 0 ? 'action_inferred' : 'no_action',
    unresolved,
  }
}

export const POSE_RELATIONS = ['holding', 'touching', 'supporting', 'resting_on', 'manipulating', 'releasing']
