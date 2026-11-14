/**
 * Prompt Validator（2026-11-11 v2）
 *
 * 输出前检查"模块是否越界 / 是否自相矛盾 / 是否有残句"。
 * 只做静态字符串检查，不改 prompt；返回 issues 供日志/测试。
 */
export const PI = {
  PI_001: 'subjectMode 缺失或非法',
  PI_002: '无人场景出现人物身份模块',
  PI_003: '无人场景出现服装/发型模块',
  PI_004: '无人环境出现手部契约/可见手',
  PI_006: '无人场景出现表情要求',
  PI_007: '前置自拍要求手机入画',
  PI_011: '景别同时出现全身和半身',
  PI_020: '无人场景出现与人物有关的负向词',
  PI_021: '删除模块后残留孤立句',
  PI_022: '同一约束重复出现',
  PI_023: '无人场景出现固定倍率/擦镜头尾巴',
}

const VALID_SUBJECT = new Set(['person', 'first_person', 'object', 'environment'])

export function validatePrompt(prompt, ctx = {}) {  const p = String(prompt ?? '')
  const subjectMode = String(ctx.subjectMode ?? '')
  const issues = []
  const add = (code, detail = '') => issues.push({ code, detail, msg: PI[code] ?? code })

  if (!VALID_SUBJECT.has(subjectMode)) add('PI_001', subjectMode || '(空)')
  const noPerson = subjectMode === 'object' || subjectMode === 'environment'
  if (noPerson) {
    if (/【人物身份】/.test(p)) add('PI_002')
    if (/今天穿着|今天的头发|【当日状态】/.test(p)) add('PI_003')
    if (/【手部契约】|【动作手部】|最多 \d+ 只手/.test(p)) add('PI_004')
    if (/【表情与肢体】|表情：|视线：/.test(p)) add('PI_006')
    if (/胸型|完整双脚|衣服款式|裙子|袜口/.test(p)) add('PI_020')
    if (/1\.5-3 倍|擦净镜头/.test(p)) add('PI_023')
  }
  if (String(ctx.mode ?? '') === 'front_selfie') {
    /* 正面写了"手机可以入画"就是矛盾；"手机不入画/画外"是对的 */
    if (/手机[^\n]{0,6}(可以入画|入画)/.test(p) && !/不入画|在画外|画面外/.test(p)) add('PI_007')
  }
  if (/全身(入镜|构图|景别)/.test(p) && /半身(入镜|构图|景别)/.test(p)) add('PI_011')
  /* 残句：单独一行只有"以参考图和【人物】为准"类 */
  if (/(^|\n)\s*[^\n]{0,10}以参考图和【人物】为准。?\s*(\n|$)/.test(p)) add('PI_021')
  const personBlocks = (p.match(/【人物[^】]*】/g) ?? []).length
  if (personBlocks > 1 && subjectMode !== 'person') add('PI_022', `【人物】×${personBlocks}`)
  return { ok: issues.length === 0, issues }
}
