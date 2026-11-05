/**
 * 动态表情系统（photo-expression）
 *
 * 规范第九条 / 第四~五条的核心：
 *   **外貌固定，表情不固定。**
 *
 * 以前每张都是同一张冷脸 —— 因为提示词里压根没有表情这一层，
 * 参考图（三视图）是中性的，模型就照抄了那张脸。
 *
 * 这里做三件事：
 *   ① 从**语境**推断情绪（聊天内容 / 当天心情 / 时段 / 正在做的事）
 *   ② 情绪 → **表情 + 视线 + 头部 + 肢体**（联动，不能只有嘴在笑）
 *   ③ **防重复**：同一会话连续两张不用同一个表情
 */

/**
 * 八种情绪。每种的 `face` 是面部，`body` 是肢体联动，
 * `gaze` 是视线，`head` 是头部姿态。
 */
export const EMOTIONS = {
  happy: {
    id: 'happy',
    label: '开心',
    face: '自然微笑，眼睛有一点笑意（笑眼），嘴角上扬',
    gaze: '可以看镜头，也可以看着手上的东西',
    head: '头部自然，可以略微仰起',
    body: '肩膀放松，身体可能自然前倾',
  },
  playful: {
    id: 'playful',
    label: '调皮',
    face: '嘴角一侧上扬（坏笑），可以眨一只眼或做个小鬼脸，略带得意',
    gaze: '斜眼看镜头，或故意看向一边',
    head: '头略微偏转，不正对镜头',
    body: '动作不对称（比如一只手撑着下巴、一只手举手机）',
  },
  shy: {
    id: 'shy',
    label: '害羞',
    face: '轻微脸红，抿嘴或不好意思地笑，视线躲闪',
    gaze: '避开镜头，看向旁边或下方',
    head: '微微低头，脸转开一点',
    body: '肩膀略收紧，手指可能碰脸颊或整理头发',
  },
  sleepy: {
    id: 'sleepy',
    label: '困倦',
    face: '半睁眼、眼神放空，面部肌肉放松（不笑），可以打哈欠',
    gaze: '视线散、看不太聚焦',
    head: '头微微倾斜或靠在枕头/靠背上',
    body: '身体放松塌下来，可能抱着枕头、揉眼睛',
  },
  surprised: {
    id: 'surprised',
    label: '惊讶',
    face: '眼睛睁大，微微张嘴，眉毛上扬',
    gaze: '直看镜头或看向让她惊讶的东西',
    head: '头略后仰或定住',
    body: '动作停在半途（比如手停在半空）',
  },
  unhappy: {
    id: 'unhappy',
    label: '不满',
    face: '轻微皱眉、鼓嘴或撇嘴，嘴角下压',
    gaze: '不耐烦地看向一旁',
    head: '头偏向一侧',
    body: '双臂抱起，或双手叉腰',
  },
  thinking: {
    id: 'thinking',
    label: '思考',
    face: '视线偏移，轻微蹙眉，咬唇或抿嘴，注意力集中',
    gaze: '看向别处（不在镜头上）',
    head: '头略低或偏',
    body: '手可能停在半空、撑着脸',
  },
  calm: {
    id: 'calm',
    label: '平静',
    face: '自然放松，**不刻意微笑、也不刻意冷脸**（重点：不要面无表情的证件照脸）',
    gaze: '看向自己正在做的事',
    head: '头部自然放松',
    body: '身体姿态随当前动作，不摆拍',
  },
}

/**
 * 语境 → 情绪。**顺序重要**：先匹配更具体的话。
 */
const CUE = [
  // 夸奖 / 撩 → 害羞 或 开心
  { re: /(好看|漂亮|可爱|美|真好看|身材好|喜欢你|想你了|亲亲|抱抱)/, emotion: 'shy' },
  // 逗 / 调侃 → 调皮
  { re: /(逗你|逗你玩|骗你|欺负|哈哈|笑死|坏|调皮|鬼脸)/, emotion: 'playful' },
  // 被怼 / 不高兴 → 不满
  { re: /(讨厌|烦|生气|不理你|哼|凭什么|过分|滚)/, emotion: 'unhappy' },
  // 惊讶
  { re: /(?!.*不)(真的假的|不可能|居然|竟然|怎么会|吓|惊)/, emotion: 'surprised' },
  // 困
  { re: /(困|睡|躺|赖床|起不来|眯|打哈欠|没睡醒)/, emotion: 'sleepy' },
  // 思考 / 认真
  { re: /(想想|琢磨|研究|做作业|写东西|看资料|认真|专注)/, emotion: 'thinking' },
]

/** 时段兜底倾向 */
const SLOT_MOOD = {
  wake: 'sleepy',
  morning: 'calm',
  noon: 'calm',
  afternoon: 'calm',
  evening: 'calm',
  night: 'sleepy',
}

/**
 * 推断这一张的情绪。
 *
 * @param {object} o
 * @param {string} [o.request]  他刚说的话（最能决定情绪）
 * @param {string} [o.scene]    她写的场景
 * @param {string} [o.mood]     当天心情（day-plan 的 mood）
 * @param {string} [o.slot]     时段
 * @param {string} [o.lastEmotion] 上一张用过的情绪（防重复）
 * @returns {{id:string,label:string,face:string,gaze:string,head:string,body:string,reason:string}}
 */
export function pickEmotion({ request = '', scene = '', mood = '', slot = 'afternoon', lastEmotion = '' } = {}) {
  let emotion = ''
  let reason = ''

  /* ① 他刚说的话最优先 */
  for (const c of CUE) {
    if (c.re.test(String(request))) { emotion = c.emotion; reason = '他的话'; break }
  }

  /* ② 场景里如果明确写了情绪词，也算 */
  if (!emotion) {
    for (const c of CUE) {
      if (c.re.test(String(scene))) { emotion = c.emotion; reason = '场景'; break }
    }
  }

  /* ③ 当天心情（day-plan 的 mood 是"平静，松弛"这种） */
  if (!emotion) {
    const m = String(mood)
    if (/(开心|高兴|愉快|雀跃|兴奋)/.test(m)) { emotion = 'happy'; reason = '当天心情' }
    else if (/(懒|松|惬意|舒服)/.test(m)) { emotion = 'calm'; reason = '当天心情' }
    else if (/(烦|闷|低落|没劲|丧)/.test(m)) { emotion = 'unhappy'; reason = '当天心情' }
  }

  /* ④ 时段兜底 */
  if (!emotion) { emotion = SLOT_MOOD[slot] ?? 'calm'; reason = '时段' }

  /* ⑤ 防重复：和上一张一样就换一个邻近的 */
  if (lastEmotion && emotion === lastEmotion) {
    const alt = {
      calm: 'happy',
      happy: 'playful',
      playful: 'shy',
      shy: 'playful',
      sleepy: 'calm',
      surprised: 'happy',
      unhappy: 'playful',
      thinking: 'calm',
    }[emotion] ?? 'calm'
    emotion = alt
    reason += '（上一张刚用过同款，换个表情）'
  }

  const e = EMOTIONS[emotion] ?? EMOTIONS.calm
  return { ...e, reason }
}

/** 给提示词用的那段文字（面部 + 视线 + 头部 + 肢体，必须联动） */
export function renderExpression(e) {
  return `【表情与肢体：这一张必须和别的照片不一样】
表情：${e.face}
视线：${e.gaze}
头部：${e.head}
肢体：${e.body}
⚠️ 表情要**带着身体一起变**（不能只有嘴角在笑、身体还是标准人设图的站姿）。
⚠️ **不要用参考图里那张中性脸** —— 参考图只锁长相，不锁表情。`
}

/**
 * 防重复记录（进程内）。
 * key = scope，value = 上一次的情绪 id。
 */
export class ExpressionHistory {
  constructor() { this.map = new Map() }
  last(scope) { return this.map.get(scope) ?? '' }
  set(scope, id) { if (scope) this.map.set(scope, id) }
}
