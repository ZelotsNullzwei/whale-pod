/**
 * 动作池（2026-11-13 定稿：刷牙验证有效的句式）
 *
 * 句式：「对镜自拍，另一只手拿X做Y」——这一版刷牙/护肤/口红都成立、不多手。
 * 不加左右手细分、不写手数、不加接触约束。
 */

export const ACTIONS = [
  {
    id: 'stretch', label: '伸懒腰',
    scene: '刚睡醒坐在床边，自然地伸了个懒腰',
    mode: 'front_selfie', replacesScene: true,
    re: /伸(个)?懒腰/,
  },
  {
    id: 'cream', label: '涂面霜',
    scene: '对镜自拍，另一只手把面霜抹在脸颊',
    mode: 'mirror_selfie',
    re: /面霜/,
  },
  {
    id: 'cotton', label: '化妆棉护肤',
    scene: '坐在梳妆台前，对镜自拍，另一只手拿化妆棉擦脸颊',
    mode: 'mirror_selfie',
    re: /护肤|化妆棉/,
  },
  {
    id: 'lipstick', label: '涂口红',
    scene: '对镜自拍，另一只手拿着一支口红',
    mode: 'mirror_selfie',
    re: /口红/,
  },
  {
    id: 'brow', label: '画眉',
    scene: '对镜自拍，另一只手拿眉笔画眉毛',
    mode: 'mirror_selfie',
    re: /画眉|眉笔|眉毛/,
  },
  {
    id: 'brush', label: '刷牙',
    scene: '对镜自拍，另一只手拿牙刷刷牙',
    mode: 'mirror_selfie',
    re: /刷牙|牙刷/,
  },
  {
    id: 'blow', label: '吹头发',
    scene: '对镜自拍，另一只手拿吹风机吹头发',
    mode: 'mirror_selfie',
    re: /吹头发|吹风机/,
  },
  {
    id: 'comb', label: '梳头',
    scene: '对镜自拍，另一只手拿梳子梳头发',
    mode: 'mirror_selfie',
    re: /梳头|梳子/,
  },
  /* 以下动作已由 planner/composer 正确处理，只作为规范目录，不自动拼 scene */
  {
    id: 'water', label: '喝水',
    scene: '坐在沙发上喝一杯水',
    mode: 'front_selfie', auto: false,
    re: /喝水|水杯|玻璃杯/,
  },
  {
    id: 'comic', label: '看漫画',
    scene: '第一人称视角，手里拿着漫画书在阅读',
    mode: 'first_person', auto: false,
    re: /看漫画|漫画/,
  },
  {
    id: 'diary', label: '写日记',
    scene: '第一人称视角，握笔在日记本上写',
    mode: 'first_person', auto: false,
    re: /写日记|日记|笔记本/,
  },
]

/** 场景 → 命中的动作（无则 null） */
export function matchAction(scene = '') {
  const s = String(scene)
  return ACTIONS.find((a) => a.re.test(s)) || null
}

export function needsActionDetail(scene = '') {
  const a = matchAction(scene)
  return Boolean(a && a.auto !== false)
}

/** 给 planShot 用：返回动作描写与模式/手数约束 */
export function actionForScene(scene = '') {
  const a = matchAction(scene)
  if (!a) return null
  return { id: a.id, label: a.label, scene: a.scene, mode: a.mode, hands: a.hands, replacesScene: Boolean(a.replacesScene) }
}
