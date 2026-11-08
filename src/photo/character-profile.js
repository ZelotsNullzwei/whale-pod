/**
 * 人物固定设定（character-profile）
 *
 * 集中放"定死了的东西"，避免它们散落在 bridge.js 的巨型提示词里
 * 反复被重述（重述越多，模型越容易拿文字覆盖参考图）。
 *
 * ⚠️ 有参考图时，这里的内容**不直接进提示词**（只用来说明"照参考图"）。
 *    只有拿不到参考图时，才用 `fallbackText()` 兜底。
 */

export const PROFILE = {
  name: '鲸鱼娘',
  age: '十八九岁',
  /* 面部 */
  face: {
    shape: '脸型柔和、下颌线清楚（不要婴儿肥、不要锥子脸）',
    skin: '皮肤偏白但有真实质感（不磨皮、不反光、不做成瓷娃娃）',
    forbid: ['法令纹', '眼袋', '眼下凹陷', '浓妆', '欧美脸', '网红整容脸'],
    eyes: '蓝色瞳孔（清澈的蓝，不是灰蓝/绿蓝），眼型略圆，双眼皮不明显',
    nose: '鼻子小巧、鼻梁不高',
    lips: '嘴唇薄、唇色自然偏粉',
  },
  /* 头发 */
  hair: {
    base: '蓝色长卷发，发根深蓝渐变到浅蓝（冷蓝调），长度过腰',
    bangs: '齐刘海，两侧有修饰脸颊的碎发',
    ahoge: '头顶正中一缕呆毛（发根处翘起、向上再自然侧弯）',
    texture: '真实的、染过的头发：有飞发、毛流、边缘不齐、光下透光；不要整片均匀色块、不要cosplay假发套',
    colorForbid: ['泛绿', '泛灰', '泛紫', '发白'],
  },
  /* 饰品 */
  accessories: {
    head: '白色蕾丝女仆头饰（一侧蓝丝带蝴蝶结）',
    ears: '耳侧各一组：深蓝缎面蝴蝶结（中心小蓝宝石）+ 下面垂一片鳍形布片（外侧深蓝、内里白色）',
    earNote: '是**戴上去的饰品**，不是从头上长出来的鳍，也不是精灵耳；耳朵是普通人的耳朵，被头发半遮着',
    earForbid: ['耳钉', '多个耳洞', '精灵耳'],
  },
  /* 身材（数值定死） */
  body: {
    height: 165,
    headRatio: 7.8,
    shoulder: 33,
    bust: 82,
    waist: 58,
    hip: 85,
    upperArm: 21,
    wrist: 13,
    footSize: 35,
    /*
     * ★ 三围要**定死**（2026-11-06 用户：「三围每次都变，能不能定死」）：
     *   光写厘米数模型不会照着画 —— 必须给可执行的形体词。
     */
    shape: '**纤细偏瘦**的少女体型（不是丰满型、不是前凸后翘、不是欧美身材）',
    bustNote: '胸**小、平**（A~B 罩杯的观感）：胸口平顺，**不要大胸、不要事业线、不要撑出曲线**',
    waistNote: '腰**细**，腰线明显、侧面看是收进去的',
    hipNote: '臀**窄**，胯不宽，**不是翘臀**',
    limbNote: '四肢细：上臂细、小臂到手腕收细、腿细直',
    forbid: ['丰满', '大胸', '前凸后翘', 'S 曲线', '欧美身材', '肌肉感'],
    notes: [
      '成年少女体型：不是幼童比例，也不是模特的夸张长腿',
      '肩膀是自然斜肩（肩线从颈部微微下倾、肩头圆润）；不要平直的直角肩/外扩的方肩',
      '手臂很细：上臂细、肘部窄、小臂到手腕逐渐收细；垂手时手腕在大腿根附近、指尖到大腿中段',
      '双腿并拢能自然贴合（不是O型腿），膝盖朝正前方',
    ],
  },
  hands: {
    desc: '手掌长约16.5cm，手指修长、指节清楚，指甲短而平整（不涂甲油），手背有自然细小血管',
    forbid: ['塑料感的完美手', '多指', '并指'],
  },
  feet: {
    desc: '脚长约22.5cm（35码），脚背干净、脚趾自然分开，平时穿白棉袜',
    forbid: ['脚尖绷紧的姿势'],
  },
}

/** 拿不到参考图时的兜底文字（尽量短，别写成长篇小说） */
export function fallbackText() {
  const p = PROFILE
  return `十八九岁的中国女孩子：${p.face.shape}，${p.face.skin}；${p.face.eyes}；${p.face.nose}。
${p.hair.base}，${p.hair.bangs}，${p.hair.ahoge}。
${p.accessories.head}；${p.accessories.ears}（${p.accessories.earNote}）。
身高 ${p.body.height}cm，头身比 ${p.body.headRatio}，肩宽 ${p.body.shoulder}cm（窄肩薄背、自然斜肩），
胸 ${p.body.bust}（A~B）／腰 ${p.body.waist}／臀 ${p.body.hip}，上臂围 ${p.body.upperArm}cm、手腕 ${p.body.wrist}cm，腿直不O型。
${p.hands.desc}。`
}

/** 数值摘要（给"身形比例"那句用） */
export function bodyNumbers() {
  const b = PROFILE.body
  return `身高 ${b.height}cm、头身比 ${b.headRatio}、肩宽 ${b.shoulder}cm（窄肩薄背、自然斜肩）、`
    + `胸 ${b.bust}（**A~B，小而平**）／腰 ${b.waist}（**细，腰线明显**）／臀 ${b.hip}（**窄，不是翘臀**）、`
    + `上臂围 ${b.upperArm}cm、手腕 ${b.wrist}cm、腿细直不O型`
}
