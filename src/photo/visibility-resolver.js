/**
 * visibility-resolver · V3.0 可见性唯一出口（评审第 1~3 条）
 *
 * 问题：
 *   1. camera.visibility 与 pose.visibility 各说一套，没有统一出口。
 *   2. 「手需要几只手」与「画面看得见几只」容易混（后置拍物不该出现持机手）。
 *   3. 镜拍语义交叉：camera 认为镜中能看到持机手，pose 的人像模式把手清空。
 *
 * 本模块只做**合并与裁决**，不新增任何摄影规则：
 *   camera  = 机位允许看到什么（上限）
 *   pose    = 这个动作实际产生什么（内容）
 *   结果    = 两者的交集，并把冲突写进 conflicts
 */

export function resolveVisibility({ intent = {}, camera = {}, framing = {}, pose = {} } = {}) {
  const conflicts = []
  const unresolved = []

  const camVis = camera.visibility || {}
  const poseVis = pose.visibility || {}
  const mode = camera.mode ?? null
  const band = framing.band ?? null

  /* ① 机位未定 → 全部未定，不猜 */
  if (!mode) {
    return {
      face: null,
      hands: [],
      arms: [],
      phone: null,
      bodyParts: [],
      unresolved: ['camera_undetermined'],
      conflicts: [],
      source: 'unresolved',
    }
  }

  /* ② 脸：只由机位决定（姿势不改变看不看得见脸） */
  const face = camVis.face ?? null

  /*
   * ③ 手机：只有镜拍会在画面里出现（前摄=镜头本身，后摄=不拍手机）。
   *    ⚠️ no_phone 是"画面里不许出现手机"，与"不能用手机拍摄"无关（评审备注）。
   */
  let phone = mode === 'mirror_selfie' ? true : false
  const noPhoneConstraint = (intent.constraints || []).some((c) => (c.type === 'no_phone') && (c.scope === 'frame'))
  if (noPhoneConstraint && phone) {
    conflicts.push({ field: 'phone', ruleId: 'constraint.no_phone_vs_mirror', resolvedBy: 'constraint_no_phone', value: false })
    phone = false
  }

  /* ④ 手：以"机位允许"为上限，"动作实际需要"为内容，取交集 */
  const camHands = Array.isArray(camVis.hands) ? camVis.hands : []
  const poseHands = Array.isArray(poseVis.visibleHands) ? poseVis.visibleHands : []

  let hands = []
  if (mode === 'mirror_selfie') {
    /* 镜拍：镜中必然看到举机那只手；动作手若也可见则并入（去重） */
    const set = new Set(['camera_hand'])
    for (const h of poseHands) if (h !== 'camera_hand') set.add(h)
    hands = [...set].slice(0, 2)
    if (poseHands.length === 0) {
      /* pose 把人像模式的手清了 → 与 camera 的"镜中可见持机手"冲突，按 camera 为准 */
      conflicts.push({ field: 'hands', ruleId: 'mirror.camera_hand_forced', camera: camHands, pose: poseHands, resolvedBy: 'camera_mirror_rule' })
    }
  } else if (mode === 'rear_object' || mode === 'scene_only') {
    /* 后置拍物/纯场景：持机手不算画面内容；只有动作手（且取景允许）才可能出现 */
    const canShow = band === 'object' || band === 'hand_object'
    const actionOnly = poseHands.filter((h) => h !== 'camera_hand')
    hands = canShow ? actionOnly.slice(0, band === 'hand_object' ? 2 : 1) : []
    if (camHands.includes('camera_hand') && hands.length === 0) {
      conflicts.push({ field: 'hands', ruleId: 'rear.camera_hand_not_visible', camera: camHands, pose: poseHands, resolvedBy: 'rear_camera_hand_not_visible' })
    }
  } else if (mode === 'front_selfie' || mode === 'face_closeup' || mode === 'video_call' || mode === 'back_view') {
    /* 前摄/特写/通话/背影：手不入画（镜头就在手上/相机不拍手） */
    hands = []
    if (poseHands.length > 0) {
      conflicts.push({ field: 'hands', ruleId: 'portrait.hides_hands', camera: camHands, pose: poseHands, resolvedBy: 'portrait_mode_hides_hands' })
    }
  } else if (mode === 'first_person') {
    /* 第一人称：动作手 = 画面内容；持机手永不入画 */
    hands = poseHands.filter((h) => h !== 'camera_hand').slice(0, 2)
  }

  /* ⑤ 手臂：与手同源，最多两条 */
  const arms = hands.length === 2 ? ['both'] : hands.length === 1 ? ['one'] : []

  /* ⑥ 可见身体部位：机位给的范围 ∩ 取景范围（评审第 2 条：要被 framing 收窄） */
  const BAND_LIMIT = {
    face: ['face', 'neck'],
    head_shoulder: ['head', 'shoulder', 'face', 'neck'],
    half: ['head', 'shoulder', 'upper_body'],
    full: ['full_or_half_body', 'head', 'shoulder', 'upper_body'],
    back: ['back', 'back_of_head'],
    hand_object: ['hand', 'forearm'],
    object: ['object', 'object_detail', 'table'],
    scene: [],
  }
  const allowed = BAND_LIMIT[band]
  let bodyParts = Array.isArray(camVis.bodyParts) ? camVis.bodyParts.slice() : []
  if (Array.isArray(allowed) && allowed.length === 0 && band === 'scene') bodyParts = []
  else if (Array.isArray(allowed) && allowed.length) {
    const kept = bodyParts.filter((p) => allowed.some((a) => String(p).includes(a) || String(a).includes(String(p))))
    /* 取景比机位窄时，被裁掉的部位要记录 */
    if (kept.length !== bodyParts.length) {
      conflicts.push({ field: 'bodyParts', ruleId: 'framing.narrows_body_parts', dropped: bodyParts.filter((p) => !kept.includes(p)) })
    }
    bodyParts = kept
  }

  /* ⑦ 收集上游 unresolved（只搬运，不新增判断） */
  for (const u of camera.unresolved ?? []) unresolved.push(u)
  for (const u of framing.unresolved ?? []) unresolved.push(u)
  for (const u of pose.unresolved ?? []) unresolved.push(u)

  return {
    face,
    hands,
    arms,
    phone,
    bodyParts,
    unresolved: [...new Set(unresolved)],
    conflicts,
    source: conflicts.length ? 'merged_with_conflict' : 'merged',
  }
}
