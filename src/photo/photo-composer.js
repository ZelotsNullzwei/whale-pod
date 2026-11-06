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
/**
 * 他是不是**要看身形**（2026-11-06 用户：「三围我看不出来，无法判断」）。
 * 这类要求必须给能看全身的构图，半身/头肩看不出来。
 */
/**
 * 「看身材」的姿势（2026-11-06，来自知乎《网红身材打假》，实测定稿）。
 *
 * 只用**身体姿态 + 机位**，不写道具。三种都留着（用户：「有更多选择」）：
 *   · 骨盆前倾 → 腰塌下去、臀自然翘起来（实测最好）
 *   · 侧腰入镜 → 收腹 + 脊柱旋转，侧面看腰更细
 *   · 上身微前倾 → 肩腰对比，腰显细（偏正面，臀不明显）
 */
const FIGURE_POSES = [
  '侧身站、胯往一侧顶（骨盆前倾），收腹、上身微微后仰，屁股自然往后送；'
    + '身体沿画面对角线摆放，机位略低于腰、往上仰一点',
  '侧身站、收腹、脊柱微微旋转让侧腰入镜，一手扶着镜框；机位略低，身体沿对角线',
  '正面偏侧一点站，收腹、上身略微前倾，胯往一侧顶；肩和腰形成对比，机位略低',
]

/**
 * 按日期稳定取一个看身材的姿势（同一天同一句，不会每次换）。
 * @param {string} dayKey  YYYY-MM-DD
 * @returns {string}
 */
export function figurePoseForDay(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey ?? ''))
  if (!m) return FIGURE_POSES[0]
  const n = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000)
  return FIGURE_POSES[((n % FIGURE_POSES.length) + FIGURE_POSES.length) % FIGURE_POSES.length]
}

function wantsFigure(req) {
  return /(身材|三围|体型|身高|腿长|比例|胖了|瘦了|腰细|腰粗|好不好看|看看这一身|全身)/.test(String(req ?? ''))
}

export function composeFraming(plan, o = {}) {
  const req = String(o.request ?? '')
  const notes = []
  let framing = '半身'
  /**
   * 覆盖 FRAMINGS 里的通用构图描述（2026-11-06）。
   * 通用描述是按"最典型的情况"写的，某些模式（对镜自拍）会跟它打架。
   */
  let framingNote = ''

  switch (plan.mode) {
    case 'face_closeup':
      framing = '面部特写'
      break
    case 'front_selfie':
      /* 自拍：他要"看看你/自拍"就头肩或面部；否则半身 */
      framing = /(脸|正脸|长什么样|自拍)/.test(req) ? '头肩' : '半身'
      /*
       * ★ 特写要看 request **和场景**（2026-11-06）：
       *   用户说「看看你的脸」+ 她写「怼脸特写」时，只看 request 会漏掉场景。
       */
      const closeupText = req + ' ' + String(o.scene ?? '')
      if (/(特写|近一点|凑近|怼脸|脸贴镜头|镜头贴脸)/.test(closeupText)) framing = '面部特写'
      // 要看身形 → 至少给到三分之二身（半身看不出来）
      if (wantsFigure(req)) framing = '三分之二身'
      break
    case 'mirror_selfie':
      /* 对镜：看穿搭/看身形就全身，否则三分之二身 */
      framing = (/(穿搭|全身|这一身|衣服)/.test(req) || wantsFigure(req)) ? '全身' : '三分之二身'
      /*
       * ★ **对镜自拍的构图要说"镜子里的取景"，不是"沙发/桌边"**（2026-11-06 修）。
       *
       * `三分之二身` 的通用 desc 是「到膝盖上方（坐姿常见：沙发、桌边）」——
       * 那句是给"坐着自拍"写的。对镜自拍是**站着对镜子**，照抄这句会让模型
       * 把人画成坐着，构图和场景打架，镜子/手机这些要素就更容易丢。
       */
      framingNote = '镜子里取到膝盖上方（站姿，全身镜 / 穿衣镜前）'
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
    desc: framingNote || f.desc,
    feet: f.feet,
    groundGap: f.groundGap,
    showFace: f.showFace && plan.faceVisible !== false,
    cameraAngle,
    notes,
  }
}
