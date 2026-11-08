/**
 * camera-planner · V3.0 第二阶段（2026-11-08）
 *
 * 职责边界（复核意见）：
 *   · **只**把 `intent` 翻译成"相机在哪、朝哪、多远、能看到什么"
 *   · **不**重新推断 subject / purpose，**不**覆盖 explicit 机位
 *   · intent.camera.mode 为 null 时 → 返回 unresolved，**绝不默认 front_selfie**
 *   · 不知道的一律 null，不为了凑满字段而编造
 *
 * 输出契约（供 framing-planner / pose-planner 直接消费）：
 * {
 *   mode, source, device,
 *   geometry: { position, height, orientation, distance, direction },
 *   visibility: { face, hands: [], arms: [], phone, bodyParts: [] },
 *   unresolved: []
 * }
 */

/** 非第一人称的机位几何表 */
const MODE_GEOMETRY = {
  face_closeup: {
    device: 'front_cam',
    geometry: { position: 'in_front_of_face', height: 'eye_level', orientation: 'toward_face', distance: '20-35cm', direction: 'forward' },
    visibility: { face: true, hands: [], arms: [], phone: false, bodyParts: ['face', 'neck'] },
  },
  front_selfie: {
    device: 'front_cam',
    geometry: { position: 'arm_length_front', height: 'slightly_high', orientation: 'toward_face', distance: '40-60cm', direction: 'forward' },
    visibility: { face: true, hands: ['phone'], arms: ['one'], phone: false, bodyParts: ['head', 'shoulder', 'upper_body'] },
  },
  mirror_selfie: {
    device: 'rear_cam_via_mirror',
    geometry: { position: 'in_front_of_mirror', height: 'chest_level', orientation: 'toward_mirror', distance: '60-120cm', direction: 'forward' },
    /* 镜中必须同时看到手机与她本人 */
    visibility: { face: true, hands: ['phone'], arms: ['one'], phone: true, bodyParts: ['full_or_half_body'] },
  },
  back_view: {
    device: 'rear_cam',
    geometry: { position: 'behind_subject', height: 'shoulder_level', orientation: 'toward_back', distance: '60-150cm', direction: 'forward' },
    /* 背影：看到背面，不露正脸；不强制相机在正后方（可镜面） */
    visibility: { face: false, hands: [], arms: ['zero_or_one'], phone: false, bodyParts: ['back', 'back_of_head'] },
  },
  rear_object: {
    device: 'rear_cam',
    geometry: { position: 'in_front_of_object', height: 'eye_level', orientation: 'toward_object', distance: '30-70cm', direction: 'forward_down' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: ['object'] },
  },
  scene_only: {
    device: 'rear_cam',
    geometry: { position: 'scene_viewpoint', height: null, orientation: 'toward_scene', distance: null, direction: 'forward' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: [] },
  },
  video_call: {
    device: 'front_cam',
    geometry: { position: 'desk_stand', height: 'chest_level', orientation: 'toward_face', distance: '50-80cm', direction: 'forward' },
    visibility: { face: true, hands: [], arms: ['zero_or_one'], phone: false, bodyParts: ['head', 'shoulder', 'upper_body'] },
  },
}

/**
 * 第一人称的五套几何（复核意见：禁止所有 POV 共用 camera=eye）
 */
const POV_GEOMETRY = {
  eye_pov: {
    geometry: { position: 'at_eyes', height: 'eye_level', orientation: 'forward', distance: 'n/a', direction: 'forward' },
    visibility: { face: false, hands: [], arms: [], phone: false, bodyParts: [] },
    note: '看窗外/观察环境：画面是眼前景象，通常没有手',
  },
  hand_action_pov: {
    geometry: { position: 'beside_head_tilted_down', height: 'eye_level_minus', orientation: 'toward_hands', distance: '40-60cm', direction: 'forward_down' },
    visibility: { face: false, hands: ['action_hand'], arms: ['one'], phone: false, bodyParts: ['hand', 'forearm'] },
    note: '拿杯子/切菜/整理：只出现做动作的那只手',
  },
  tabletop_pov: {
    geometry: { position: 'above_table', height: 'above_chest', orientation: 'down_to_table', distance: '40-70cm', direction: 'down_60_90' },
    visibility: { face: false, hands: ['zero_or_two'], arms: ['zero_or_two'], phone: false, bodyParts: ['table', 'object'] },
    note: '桌面承载：没有拿取动作时手不应强行入镜',
  },
  lap_pov: {
    geometry: { position: 'at_eyes_seated', height: 'seated_eye_level', orientation: 'down_to_lap', distance: '40-60cm', direction: 'down_45_60' },
    visibility: { face: false, hands: ['zero_or_one'], arms: ['zero_or_one'], phone: false, bodyParts: ['lap', 'object'] },
    note: '腿上放东西：坐姿视线',
  },
  close_object_pov: {
    geometry: { position: 'near_object', height: 'object_level', orientation: 'toward_object', distance: '15-30cm', direction: 'forward_down' },
    visibility: { face: false, hands: ['zero_or_one'], arms: ['zero_or_one'], phone: false, bodyParts: ['object_detail'] },
    note: '拍小物件/局部细节',
  },
}

/** 由 activities / 文本线索判第一人称子型（只判几何，不判 subject） */
export function pickPovSubtype(intent = {}) {
  const acts = (intent.activities || []).map((a) => a.type)
  const text = String(intent._raw ?? '')
  if (acts.includes('two_hands')) return 'hand_action_pov'
  if (/(双手|两只手|捧|拧|撕|掰|搓|揉)/.test(text)) return 'hand_action_pov'
  if (/(桌面|书桌|桌上|键盘|写字|砧板|台面)/.test(text)) return 'tabletop_pov'
  if (/(腿上|膝盖上|盘腿|窝在.*看)/.test(text)) return 'lap_pov'
  if (/(小物件|细节|特写|近一点)/.test(text)) return 'close_object_pov'
  if (/(窗外|远处|风景|房间|环境)/.test(text) && acts.length === 0) return 'eye_pov'
  return 'hand_action_pov'
}

/** 由 activities 决定可见手/臂（唯一真源） */
function limbsFromActivities(intent) {
  const acts = (intent.activities || []).map((a) => a.type)
  const text = String(intent._raw ?? '')
  if (/(双手|两只手|捧|拧|撕|掰)/.test(text)) return { hands: ['left', 'right'], arms: ['both'], reason: 'two_hand_action' }
  if (acts.includes('holding_item') || /(端着|拿着|举着|喝)/.test(text)) return { hands: ['action_hand'], arms: ['one'], reason: 'holding_item' }
  if (acts.includes('tidying') || acts.includes('cooking')) return { hands: ['action_hand'], arms: ['one'], reason: 'desk_work' }
  return { hands: [], arms: [], reason: 'no_hand_action' }
}

/**
 * 主入口
 * @param {object} intent  photo-planner.planIntent() 的输出（可带 `_raw` 原话用于几何细分）
 */
export function planCamera(intent = {}) {
  const unresolved = []
  const cam = intent.camera || null
  const mode = cam && cam.mode ? cam.mode : null
  const source = cam && cam.source ? cam.source : 'unresolved'

  /* ① 机位未定：直接 unresolved，不猜、不兜底 */
  if (!mode) {
    return {
      mode: null,
      source: 'unresolved',
      device: null,
      geometry: { position: null, height: null, orientation: null, distance: null, direction: null },
      visibility: { face: null, hands: [], arms: [], phone: null, bodyParts: [] },
      povSubtype: null,
      unresolved: ['camera_mode', 'camera_position'],
      reason: 'no_explicit_camera_requirement',
    }
  }

  /* ② 第一人称：五套几何 */
  if (mode === 'first_person') {
    const subtype = pickPovSubtype(intent)
    const g = POV_GEOMETRY[subtype] || POV_GEOMETRY.hand_action_pov
    const limbs = limbsFromActivities(intent)
    return {
      mode,
      source,
      device: 'phone',
      povSubtype: subtype,
      geometry: { ...g.geometry },
      visibility: {
        face: false,
        hands: limbs.hands,
        arms: limbs.arms,
        phone: false, // 第一人称：手机本体绝不入画
        bodyParts: g.visibility.bodyParts,
      },
      unresolved: [],
      note: g.note,
    }
  }

  /* ③ 其余模式：查表 */
  const spec = MODE_GEOMETRY[mode]
  if (!spec) {
    /* 未知模式：不假装认识 */
    return {
      mode,
      source,
      device: null,
      geometry: { position: null, height: null, orientation: null, distance: null, direction: null },
      visibility: { face: null, hands: [], arms: [], phone: null, bodyParts: [] },
      povSubtype: null,
      unresolved: ['unknown_mode:' + mode],
      reason: 'mode_not_in_geometry_table',
    }
  }

  return {
    mode,
    source,
    device: spec.device,
    povSubtype: null,
    geometry: { ...spec.geometry },
    visibility: { ...spec.visibility },
    unresolved,
  }
}

/** 供测试/调试：列出所有模式与 POV 子型 */
export function listCameraModes() {
  return { modes: Object.keys(MODE_GEOMETRY).concat(['first_person']), povSubtypes: Object.keys(POV_GEOMETRY) }
}
