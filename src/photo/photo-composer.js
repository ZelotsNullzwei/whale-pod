/**
 * 构图决策（photo-composer）
 *
 * 用户明确要废掉的旧规则（P0 第 4、5 条）：
 *   ❌ 全身照默认 45° 侧身
 *   ❌ 每张都强调鞋袜、全身占比 85~90%
 *
 * 新规则：**构图跟着"照片目的"走**，不是跟着"要展示人物"走。
 */

/**
 * 构图档位 → 取景说明。
 * 每种构图写清：拍到哪、占多大、有没有脚、要不要留地面。
 */
export const FRAMINGS = {
  面部特写: {
    label: '面部特写',
    desc: '只拍脸到下巴，占画面大部分；背景虚化',
    feet: false,
    groundGap: 0,
    showFace: true,
  },
  头肩: {
    label: '头肩照',
    desc: '头 + 肩，到胸口上方',
    feet: false,
    groundGap: 0,
    showFace: true,
  },
  半身: {
    label: '半身照',
    desc: '到腰或胯，能看到手',
    feet: false,
    groundGap: 0,
    showFace: true,
  },
  '三分之二身': {
    label: '三分之二身',
    desc: '到膝盖上方（坐姿常见：沙发、桌边）',
    feet: false,
    groundGap: 0,
    showFace: true,
  },
  全身: {
    label: '全身照',
    desc: '从头到脚完整入画',
    feet: true,
    /* 关键：脚下要留地面，否则裁水印会把脚切掉 */
    groundGap: 0.12,
    showFace: true,
  },
  环境照: {
    label: '环境照',
    desc: '以环境/物品为主，人可能只在边上或不在画面里',
    feet: false,
    groundGap: 0,
    showFace: false,
  },
  局部: {
    label: '局部特写',
    desc: '手、桌面、食物、裙摆这类局部；人不必完整出现',
    feet: false,
    groundGap: 0,
    showFace: false,
  },
}

/**
 * 根据拍摄方案决定构图。
 *
 * @param {object} plan  已经过 validator 修正的方案
 * @param {object} [o]
 * @param {string} [o.request] 用户原话（他要"看看你""自拍""站起来"之类，会影响构图）
 * @returns {{framing:string, desc:string, feet:boolean, groundGap:number, showFace:boolean, cameraAngle:string, notes:string[]}}
 */
export function composeFraming(plan, o = {}) {
  const req = String(o.request ?? '')
  const notes = []
  let framing = '半身'

  switch (plan.mode) {
    case 'front_selfie':
      /* 自拍：他要"看看你/自拍"就头肩或面部；否则半身 */
      framing = /(脸|正脸|长什么样|自拍)/.test(req) ? '头肩' : '半身'
      if (/(特写|近一点|凑近)/.test(req)) framing = '面部特写'
      break
    case 'mirror_selfie':
      /* 对镜：看穿搭就全身，否则三分之二身 */
      framing = /(穿搭|全身|这一身|衣服)/.test(req) ? '全身' : '三分之二身'
      break
    case 'first_person':
      framing = '局部'
      break
    case 'rear_selfie':
      framing = '环境照'
      break
    case 'video_call':
      /* 通话截图：半身或头肩（手机架着，拍不到脚，不做全身） */
      framing = /(脸|近点|特写)/.test(req) ? '面部特写' : '半身'
      break
    default:
      framing = '半身'
  }

  const f = FRAMINGS[framing] ?? FRAMINGS.半身

  /* 手机位置 → 相机角度（这决定"透视对不对"） */
  let cameraAngle = '平视（镜头与眼睛等高）'
  if (plan.mode === 'first_person') cameraAngle = '俯视（镜头朝下，看着手上的东西）'
  if (plan.mode === 'mirror_selfie') cameraAngle = '平视偏上（镜子在胸口~眼睛高度）'
  if (plan.mode === 'front_selfie') cameraAngle = '略高（自拍时手举得比脸高一点）'

  /* 全身照必须有地面留白 —— 这条保留，因为它是"裁水印"的物理约束 */
  if (f.feet) {
    notes.push('脚下留 10~15% 的空白地面，脚和拖鞋不要顶到画面底边（底边会被裁掉去水印）')
  }

  /* 坐姿/沙发这类，不要强行让她站起来 */
  if (/(沙发|床|坐|窝|靠)/.test(String(plan.subject ?? '')) && framing === '全身') {
    notes.push('她是坐着/窝着的，不要为了拍全身让她站起来')
  }

  return {
    framing,
    desc: f.desc,
    feet: f.feet,
    groundGap: f.groundGap,
    showFace: f.showFace && plan.faceVisible !== false,
    cameraAngle,
    notes,
  }
}
