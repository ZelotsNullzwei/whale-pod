/**
 * framing-planner · V3.0 第三阶段
 *
 * 职责（严格限定）：决定**拍多近、主体如何进入画面**。
 *   · 不改 subject，不改 camera，不改 intent.purpose
 *   · camera.mode 为 null → 返回 unresolved，不猜
 *   · **composition（主体位置/布局）不在这里**，留给 composition-planner（本阶段输出 null）
 *
 * 输出：
 * {
 *   band,              // face | head_shoulder | half | full | hand_object | object | scene | back
 *   aspect,            // '9:16'
 *   entry,             // 主体怎么进入画面
 *   layout,            // 仅第一人称有：如 '上 2/3 物品，下 1/3 手臂'
 *   visibleRange,      // { top, bottom } 语义范围
 *   composition,       // null（本阶段不做）
 *   source, unresolved
 * }
 */

const BAND_BY_MODE = {
  face_closeup: 'face',
  front_selfie: 'head_shoulder',
  mirror_selfie: 'full',
  back_view: 'back',
  rear_object: 'object',
  scene_only: 'scene',
  video_call: 'head_shoulder',
}

const POV_BAND = {
  eye_pov: 'scene',
  hand_action_pov: 'hand_object',
  tabletop_pov: 'object',
  lap_pov: 'hand_object',
  close_object_pov: 'object',
}

const ENTRY = {
  face: 'face_fills_frame',
  head_shoulder: 'head_and_shoulders',
  half: 'waist_up',
  full: 'whole_body',
  hand_object: 'hand_and_object',
  object: 'object_only',
  scene: 'environment',
  back: 'back_of_body',
}

const RANGE = {
  face: { top: 'top_of_head', bottom: 'collarbone' },
  head_shoulder: { top: 'top_of_head', bottom: 'chest' },
  half: { top: 'top_of_head', bottom: 'waist' },
  full: { top: 'top_of_head', bottom: 'feet' },
  hand_object: { top: 'object', bottom: 'forearm' },
  object: { top: 'object_top', bottom: 'object_bottom' },
  scene: { top: 'sky_or_ceiling', bottom: 'floor' },
  back: { top: 'back_of_head', bottom: 'waist_or_feet' },
}

export function planFraming(intent = {}, camera = {}) {
  /* ① 机位未定 → 取景也不定，不猜 */
  if (!camera || !camera.mode) {
    return {
      band: null,
      aspect: '9:16',
      entry: null,
      layout: null,
      visibleRange: { top: null, bottom: null },
      composition: null,
      source: 'unresolved',
      unresolved: ['framing_band', 'framing_range'],
      reason: 'camera_undetermined',
    }
  }

  /* ② 第一人称：五子型各自取景，且 handheld 明确"上物下手" */
  if (camera.mode === 'first_person') {
    const sub = camera.povSubtype || 'hand_action_pov'
    const band = POV_BAND[sub] || 'object'
    const layout = sub === 'hand_action_pov'
      ? '上 2/3 物品/桌面，下 1/3 手臂与手'
      : sub === 'tabletop_pov'
        ? '上半部桌面与物品，下半部桌面延伸'
        : null
    return {
      band,
      aspect: '9:16',
      entry: ENTRY[band],
      layout,
      visibleRange: { ...RANGE[band] },
      composition: null,
      source: 'camera_pov',
      unresolved: [],
    }
  }

  /* ③ 其余模式：默认取景 + 用 intent.framing 校正（构建层不得改机位） */
  const base = BAND_BY_MODE[camera.mode]
  if (!base) {
    return {
      band: null,
      aspect: '9:16',
      entry: null,
      layout: null,
      visibleRange: { top: null, bottom: null },
      composition: null,
      source: 'unresolved',
      unresolved: ['unknown_camera_mode:' + camera.mode],
    }
  }

  let band = base
  const want = intent && intent.framing ? intent.framing.type : null
  if (want && ['face', 'head_shoulder', 'half', 'full', 'part'].includes(want)) {
    /* part 在非第一人称里退成 object，避免"局部"变成奇怪的人体裁切 */
    band = want === 'part' ? 'object' : want
  }

  return {
    band,
    aspect: '9:16',
    entry: ENTRY[band],
    layout: null,
    visibleRange: { ...RANGE[band] },
    composition: null,
    source: want ? 'intent_framing' : 'mode_default',
    unresolved: [],
  }
}

export const FRAMING_BANDS = Object.keys(RANGE)
