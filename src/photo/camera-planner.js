/**
 * camera-planner · V3.0 第二阶段（评审后 v2）
 *
 * 职责：只把 intent 翻译成"相机在哪、朝哪、多远、能看到什么"。
 * 不重新推断 subject / purpose，不覆盖 explicit 机位；camera=null → unresolved。
 *
 * 输出契约（评审要求：capture 与 visibility 分开；手部拆三维）：
 * {
 *   mode, source, povSubtype,
 *   capture:   { device, deviceVisible, holdingDevice },   // 她怎么完成拍摄
 *   geometry:  { position, height, orientation, distance, direction },
 *   visibility:{ face, hands: [], arms: [], phone, bodyParts: [] }, // 画面里实际能看到什么
 *   hands:     { actionHands, poseHands, cameraHands },     // 手的三类来源
 *   unresolved: []
 * }
 */

const MODE_SPEC = {
  face_closeup: {
    capture: { device: 'front_cam', deviceVisible: false, holdingDevice: true },
    geometry: { position: 'in_front_of_face', height: 'eye_level', orientation: 'toward_face', distance: '20-35cm', direction: 'forward' },
    visibility: { face: true, hands: [], arms: [], phone: false, bodyParts: ['face', 'neck'] },
    hands: { actionHands: 0, poseHands: 0, cameraHands: 1 },
  },
  front_selfie: {
    capture: { device: 'front_cam', deviceVisible: false, holdingDevice: true },
    geometry: { position: 'arm_length_front', height: 'slightly_high', orientation: 'toward_face', distance: '40-60cm', direction: 'forward' },
    /* 她拿着手机，但**手机本身不进入画面**，所以可见手部为 0（不是 ['phone']） */
    visibility: { face: true, hands: [], arms: [], phone: false, bodyParts: ['head', 'shoulder', 'upper_body'] },
    hands: { actionHands: 0, poseHands: 0, cameraHands: 1 },
  },
  mirror_selfie: {
    capture: { device: 'rear_cam_via_mirror', deviceVisible: true, holdingDevice: true },
    geometry: { position: 'in_front_of_mirror', height: 'chest_level', orientation: 'toward_mirror', distance: '60-120cm', direction: 'forward' },
    /* 镜拍：手机和她本人都出现在镜中 */
    visibility: { face: true, hands: ['camera_hand'], arms: ['one'], phone: true, bodyParts: ['full_or_half_body'] },
    hands: { actionHands: 0, poseHands: 0, cameraHands: 1 },
  },
  back_view: {
    capture: { device: 'rear_cam', deviceVisible: false, holdingDevice: true },
    geometry: { position: 'behind_subject', height: 'shoulder_level', orientation: 'toward_back', distance: '60-150cm', direction: 'forward' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: ['back', 'back_of_head'] },
    hands: { actionHands: 0, poseHands: 0, cameraHands: 1 },
  },
  rear_object: {
    capture: { device: 'rear_cam', deviceVisible: false, holdingDevice: true },
    geometry: { position: 'in_front_of_object', height: 'eye_level', orientation: 'toward_object', distance: '30-70cm', direction: 'forward_down' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: ['object'] },
    hands: { actionHands: 0, poseHands: 0, cameraHands: 1 },
  },
  scene_only: {
    capture: { device: 'rear_cam', deviceVisible: false, holdingDevice: true },
    geometry: { position: 'scene_viewpoint', height: null, orientation: 'toward_scene', distance: null, direction: 'forward' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: [] },
    hands: { actionHands: 0, poseHands: 0, cameraHands: 1 },
  },
  video_call: {
    capture: { device: 'front_cam', deviceVisible: false, holdingDevice: false },
    geometry: { position: 'desk_stand', height: 'chest_level', orientation: 'toward_face', distance: '50-80cm', direction: 'forward' },
    visibility: { face: true, hands: [], arms: [], phone: false, bodyParts: ['head', 'shoulder', 'upper_body'] },
    hands: { actionHands: 0, poseHands: 0, cameraHands: 0 },
  },
}

const POV_SPEC = {
  eye_pov: {
    geometry: { position: 'at_eyes', height: 'eye_level', orientation: 'forward', distance: 'n/a', direction: 'forward' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: [] },
    poseHands: 0,
    note: '看窗外/看环境：画面是眼前景象，不需要为了 POV 强行画手',
  },
  hand_action_pov: {
    geometry: { position: 'beside_head_tilted_down', height: 'eye_level_minus', orientation: 'toward_hands', distance: '40-60cm', direction: 'forward_down' },
    visibility: { face: false, hands: ['action_hand'], arms: ['one'], phone: false, bodyParts: ['hand', 'forearm'] },
    poseHands: 0,
    note: '拿杯子/切菜/整理：只出现做动作的那只手',
  },
  tabletop_pov: {
    geometry: { position: 'above_table', height: 'above_chest', orientation: 'down_to_table', distance: '40-70cm', direction: 'down_60_90' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: ['table', 'object'] },
    poseHands: 0,
    note: '桌面承载：没有拿取/书写动作时手不入镜',
  },
  lap_pov: {
    geometry: { position: 'at_eyes_seated', height: 'seated_eye_level', orientation: 'down_to_lap', distance: '40-60cm', direction: 'down_45_60' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: ['lap', 'object'] },
    poseHands: 0,
    note: '腿上放东西：坐姿视线',
  },
  close_object_pov: {
    geometry: { position: 'near_object', height: 'object_level', orientation: 'toward_object', distance: '15-30cm', direction: 'forward_down' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: ['object_detail'] },
    poseHands: 0,
    note: '拍小物件/局部细节；不改变主体类型',
  },
}

/** 由 activities 判定 POV 子型（几何细分，不判 subject） */
export function pickPovSubtype(intent = {}) {
  const acts = (intent.activities || []).map((a) => a.type)
  const text = String(intent._raw ?? '')
  if (/(双手|两只手|捧|拧|撕|掰|搓|揉)/.test(text)) return 'hand_action_pov'
  if (/(桌面|书桌|桌上|键盘|写字|砧板|台面)/.test(text)) return 'tabletop_pov'
  if (/(腿上|膝盖上|盘腿)/.test(text)) return 'lap_pov'
  if (/(小物件|细节|特写|近一点|摆件)/.test(text)) return 'close_object_pov'
  if (/(窗外|远处|风景|房间|环境)/.test(text) && acts.length === 0) return 'eye_pov'
  return 'hand_action_pov'
}

/**
 * 三类手（评审要求）：动作所需 / 姿势支撑 / 持机。
 * 注意：**cameraHands 只在镜拍里变成"可见"**，前摄自拍时手机不可见。
 */
export function handSources(intent, subtype) {
  const acts = (intent.activities || []).map((a) => a.type)
  const text = String(intent._raw ?? '')
  let actionHands = 0
  if (/(双手|两只手|捧|拧|撕|掰)/.test(text)) actionHands = 2
  else if (acts.includes('holding_item') || /(端着|拿着|举着|喝)/.test(text)) actionHands = 1
  else if (acts.includes('tidying') || acts.includes('cooking') || /(写字|翻书|键盘)/.test(text)) actionHands = 1
  const poseHands = 0
  return { actionHands, poseHands, cameraHands: 1 }
}

/** 可见手/臂：由 actionHands 与子型共同决定；没有动作就没有手 */
function visibleLimbs(subtype, hands) {
  if (hands.actionHands === 2) return { hands: ['left', 'right'], arms: ['both'], reason: 'two_hand_action' }
  if (hands.actionHands === 1) return { hands: ['action_hand'], arms: ['one'], reason: 'one_hand_action' }
  if (subtype === 'tabletop_pov') return { hands: [], arms: [], reason: 'nothing_happening_on_table' }
  return { hands: [], arms: [], reason: 'no_hand_action' }
}

export function planCamera(intent = {}) {
  const cam = intent.camera || null
  const mode = cam && cam.mode ? cam.mode : null
  const source = cam && cam.source ? cam.source : 'unresolved'

  /* ① 机位未定：不猜 */
  if (!mode) {
    return {
      mode: null,
      source: 'unresolved',
      povSubtype: null,
      capture: { device: null, deviceVisible: null, holdingDevice: null },
      geometry: { position: null, height: null, orientation: null, distance: null, direction: null },
      visibility: { face: null, hands: [], arms: [], phone: null, bodyParts: [] },
      hands: { actionHands: 0, poseHands: 0, cameraHands: 0 },
      unresolved: ['camera_mode', 'camera_position'],
      reason: 'no_explicit_camera_requirement',
    }
  }

  /* ② 第一人称：五套几何 + 三类手 */
  if (mode === 'first_person') {
    const subtype = pickPovSubtype(intent)
    const spec = POV_SPEC[subtype] || POV_SPEC.hand_action_pov
    const hands = handSources(intent, subtype)
    const limbs = visibleLimbs(subtype, hands)
    return {
      mode,
      source,
      povSubtype: subtype,
      capture: { device: 'phone', deviceVisible: false, holdingDevice: true },
      geometry: { ...spec.geometry },
      visibility: {
        face: false,
        hands: limbs.hands,
        arms: limbs.arms,
        phone: false,
        bodyParts: spec.visibility.bodyParts,
      },
      hands,
      unresolved: [],
      note: spec.note,
    }
  }

  /* ③ 其他模式查表 */
  const spec = MODE_SPEC[mode]
  if (!spec) {
    return {
      mode,
      source,
      povSubtype: null,
      capture: { device: null, deviceVisible: null, holdingDevice: null },
      geometry: { position: null, height: null, orientation: null, distance: null, direction: null },
      visibility: { face: null, hands: [], arms: [], phone: null, bodyParts: [] },
      hands: { actionHands: 0, poseHands: 0, cameraHands: 0 },
      unresolved: ['unknown_mode:' + mode],
      reason: 'mode_not_in_geometry_table',
    }
  }

  return {
    mode,
    source,
    povSubtype: null,
    capture: { ...spec.capture },
    geometry: { ...spec.geometry },
    visibility: { ...spec.visibility },
    hands: { ...spec.hands },
    unresolved: [],
  }
}

export function listCameraModes() {
  return { modes: Object.keys(MODE_SPEC).concat(['first_person']), povSubtypes: Object.keys(POV_SPEC) }
}
