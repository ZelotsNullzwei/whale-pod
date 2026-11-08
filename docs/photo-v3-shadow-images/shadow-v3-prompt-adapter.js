/**
 * shadow-v3-prompt-adapter.js（隔离于 _scratch，**不接入正式链路**）
 *
 * 唯一职责：把 V3 结构化结果翻译成提示词。
 * 铁律：只翻译已有字段，**不新增**任何机位/动作/可见性判断。
 * 为了公平，同时提供旧链路 → **同一套骨架** 的翻译，两边只有"规划字段"不同。
 */
import { PROFILE, bodyNumbers } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/photo/character-profile.js'

const COMMON = [
  '【画风】真实生活摄影：手机随手拍的自然质感，自然光/室内灯，轻微噪点，不做商业精修。',
  `【人物】${PROFILE.name}：${PROFILE.age}，${PROFILE.hair}，${PROFILE.face}，${PROFILE.accessories}。${bodyNumbers ? bodyNumbers() : ''}`,
  '【尾巴】鲸鱼尾巴只是挂件/装饰，**不得画成身体结构**，不得生出身体尾巴。',
]

/** 旧链路 → 骨架字段（只取它本来就有的字段） */
export function fromLegacy(plan, scene) {
  const framingText = Array.isArray(plan.framing) ? plan.framing.join('/') : String(plan.framing ?? '')
  return {
    scene,
    camera: String(plan.camera ?? ''),
    framing: framingText,
    hands: '',                       // 旧链路没有手部模型 → 留空，不臆造
    visibility: `脸部${plan.faceVisible ? '可见' : '不可见'}`,
    forbid: '',
    rules: Array.isArray(plan.rules) ? plan.rules.slice(0, 3).join('；') : '',
  }
}

/** V3 → 骨架字段（严格来自结构化字段） */
export function fromV3(shot, scene) {
  const cam = shot.camera || {}
  const g = cam.geometry || {}
  const vis = shot.visibility || {}
  const pose = shot.pose || {}
  const fr = shot.framing || {}
  const hands = pose.hands || {}
  return {
    scene,
    camera: [cam.mode ?? '未定', g.position, g.height, g.orientation, g.distance].filter(Boolean).join(' / '),
    framing: [fr.band, fr.layout].filter(Boolean).join(' / '),
    hands: [
      `需要手 ${hands.requiredCount ?? 0} 只`,
      `可见手 ${(vis.hands || []).length} 只${(vis.hands || []).length ? '（' + (vis.hands || []).join(',') + '）' : ''}`,
      pose.contacts && pose.contacts.length ? '接触：' + pose.contacts.map((c) => `${c.source}→${c.target ?? '?'} ${c.relation}`).join('；') : '',
    ].filter(Boolean).join('；'),
    visibility: `脸部${vis.face === true ? '可见' : vis.face === false ? '不可见' : '未定'}；手机${vis.phone === true ? '出现在画面' : vis.phone === false ? '不入画' : '未定'}`,
    forbid: (shot.intent?.constraints || []).map((c) => c.type).join('；'),
    rules: '',
  }
}

/** 同一套骨架：两边只有字段值不同 */
export function renderPrompt(f) {
  const L = [...COMMON]
  L.push(`【场景（原始输入）】${f.scene}`)
  L.push(`【机位】${f.camera || '（规划给出为空）'}`)
  L.push(`【取景】${f.framing || '（规划给出为空）'}`)
  if (f.hands) L.push(`【手脚】${f.hands}`)
  L.push(`【可见性】${f.visibility}`)
  if (f.forbid) L.push(`【硬性约束】${f.forbid}`)
  L.push('【输出】竖版 9:16，单张。')
  return L.join('\n')
}
