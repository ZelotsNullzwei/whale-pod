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
  age: '24岁以上的成年女性',
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
  /* 身形：只参照人物图，不给模型下固定尺寸 */
  body: {
    shape: '成年女性的自然身形，以人物参考图为准，不夸张塑形',
    notes: [
      '保持自然肩线与四肢比例，不刻意拉长或缩窄身体',
      '双腿结构自然，膝盖朝向一致，不画成 O 型腿',
    ],
  },
  hands: {
    desc: '手指自然修长、指节清楚，指甲短而平整（不涂甲油），保留真实皮肤纹理',
    forbid: ['塑料感的完美手', '多指', '并指'],
  },
  feet: {
    desc: '脚部结构自然，脚趾自然分开，平时穿白棉袜',
    forbid: ['脚尖绷紧的姿势'],
  },
}

/** 拿不到参考图时的兜底文字（尽量短，避免堆砌形体描述） */
export function fallbackText() {
  const p = PROFILE
  return `${p.age}：${p.face.shape}，${p.face.skin}；${p.face.eyes}；${p.face.nose}。\n`
    + `${p.hair.base}，${p.hair.bangs}，${p.hair.ahoge}。\n`
    + `${p.accessories.head}；${p.accessories.ears}（${p.accessories.earNote}）。\n`
    + `${p.body.shape}；${p.hands.desc}。`
}

/** 旧接口兼容：仅返回定性参考，不输出身材数字。 */
export function bodyNumbers() {
  return PROFILE.body.shape
}
