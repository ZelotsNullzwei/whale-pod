/**
 * 衣柜（2026-11-06 用户口径：「女生，家居服可以有很多选择吧
 * 主要是看你怎么描述才能控制固定」）。
 *
 * ## 为什么不交给模型编
 * 让 LLM 每天自由写「今天穿什么」有两个必然的坏结果：
 *   · 天天都是「浅灰T恤 + 深蓝棉裤」（它懒，往最常见的那套靠）
 *   · 或者编出「紫色天鹅绒睡袍配渔网袜」这种怪东西（它乱）
 * 两种都不像真人。
 *
 * ## 做法
 * **白名单 + 按日期确定性选择**：
 *   · 每套衣服都在代码里写死（颜色、款式、配件都对得上人设）
 *   · 用日期算一个下标 —— 同一天永远同一套（不会早上说 A、晚上说 B）
 *   · 隔天换一套（看起来像换过衣服）
 *   · 睡衣和家居服是**两套独立的池**
 *
 * 这样既"有变化"，又"控制得住"。
 */

/** 家居服（白天在家穿）。每套都写全：头饰 → 上衣 → 下装 → 袜子 → 鞋。 */
/**
 * 家居服（白天在家穿）。
 *
 * ⚠️ **她一个人住，穿得很随便**（2026-11-06 用户：
 *   「一个人甚至可以穿着内衣在家里到处跑」）——
 *   所以这里既有成套的家居服，也有"随手套一件"的短打。
 *   写成具体可穿的款式（大T恤当睡裙、吊带背心 + 短裤、光腿），
 *   不写"内衣"这种字面词（模型会画成不适合发出去的图）。
 */
/**
 * ⚠️ **材质只写家居词**（2026-11-06 用户指正）：棉布 / 棉麻 / 针织 / 束脚 / 睡裤。
 *   不要写「牛仔、工装、休闲裤」——实测「浅蓝牛仔家居裤」被直接画成了牛仔裤。
 */
export const HOME_OUTFITS = [
  '白色蕾丝发带，浅灰短袖家居T恤，深蓝棉布长裤，白棉袜，不穿鞋只穿木色拖鞋',
  '蓝色小发夹，米白宽松针织衫，浅灰棉麻家居长裤（松紧腰），白棉袜，木色拖鞋',
  '白色蕾丝发带，淡蓝条纹长袖家居服上衣，藏青棉布长裤，白棉袜，木色拖鞋',
  '蓝色发圈（低马尾），奶白圆领卫衣，浅灰束脚棉裤，白棉袜，木色拖鞋',
  '白色蕾丝发带，雾霾蓝短袖T恤，米色棉质家居短裤，白棉袜，木色拖鞋',
  '蓝色小发夹，浅灰长袖家居上衣，深灰棉布长裤，白棉袜，木色拖鞋',
  '白色蕾丝发带，米白棉质衬衫（不扎进裤子），浅蓝棉质家居长裤，白棉袜，木色拖鞋',
  /* ── 下面这几套是"一个人在家随便穿" ── */
  '头发随便挽起来用蓝色发圈，一件**宽松大T恤当睡裙穿**（过臀、光腿），白棉袜，木色拖鞋',
  '蓝色小发夹，**浅灰吊带背心 + 米色棉质家居短裤**（光腿），白棉袜，木色拖鞋',
  '头发披着没梳，**白色大码衬衫（只扣两粒扣）当外套**，浅灰棉质家居短裤（光腿），光脚，木色拖鞋',
  '蓝色发圈（低马尾），**雾霾蓝细吊带 + 深灰棉质家居短裤**，光脚，木色拖鞋',
]

/**
 * 睡衣（睡觉 / 刚起床穿）。
 *
 * ⚠️ **她一个人在家，怎么舒服怎么穿**（2026-11-06 用户口径：
 *   「没必要保守吧，她一个人在家哎」）—— 吊带、短裤睡裙都正常，
 *   不要按"外人面前得体"的标准写。
 *
 * ⚠️ 唯一保留的约束：**睡觉不戴女仆头饰**（那是白天日常的配饰）。
 */
export const SLEEPWEAR = [
  '白色棉质吊带睡裙（过膝），光脚，不穿拖鞋，**不戴头饰**',
  '淡蓝格纹短袖睡衣套装（上衣 + 及膝短裤），白棉袜，不穿拖鞋，**不戴头饰**',
  '米白宽松长袖睡裙（过膝），光脚，不穿拖鞋，**不戴头饰**',
  '雾霾蓝吊带睡裙（及膝），外披一件薄开衫，光脚，不穿拖鞋，**不戴头饰**',
  '奶白棉质长袖睡衣上衣 + 同色睡裤，白棉袜，不穿拖鞋，**不戴头饰**',
  '浅灰棉质短袖睡裙（及膝），白棉袜，不穿拖鞋，**不戴头饰**',
]

/** 头发（和衣服配套，别出现"穿着睡裙但梳着出门发型"） */
export const HAIRSTYLES = [
  '披着，只有额前用一枚白色小发夹别住',
  '披着，用蓝色发圈松松扎在脑后',
  '披着，额前夹一枚白色小发夹，发尾自然垂在肩前',
  '扎成低马尾，用蓝色发圈，刘海自然',
  '披着，头发有点乱（刚起床没来得及梳）',
]

/**
 * 日期 → 稳定下标。
 * 用「日期序号」而不是随机数：同一天调多少次都一样，隔天才会变。
 *
 * @param {string} dayKey  YYYY-MM-DD
 * @param {number} mod     池子长度
 * @param {number} [salt]  同一个池子在不同用途时错开
 * @returns {number}
 */
function pickIndex(dayKey, mod, salt = 0) {
  const s = String(dayKey ?? '')
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m || mod <= 0) return 0
  // 自 1970-01-01 起的天数
  const n = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000)
  return (((n + salt) % mod) + mod) % mod
}

/**
 * 取某天的家居服。
 * @param {string} dayKey
 * @returns {string}
 */
export function outfitForDay(dayKey) {
  return HOME_OUTFITS[pickIndex(dayKey, HOME_OUTFITS.length, 0)] ?? HOME_OUTFITS[0]
}

/**
 * 取某天的睡衣。
 * @param {string} dayKey
 * @returns {string}
 */
export function sleepwearForDay(dayKey) {
  return SLEEPWEAR[pickIndex(dayKey, SLEEPWEAR.length, 2)] ?? SLEEPWEAR[0]
}

/**
 * 取某天的发型。
 * @param {string} dayKey
 * @returns {string}
 */
export function hairForDay(dayKey) {
  return HAIRSTYLES[pickIndex(dayKey, HAIRSTYLES.length, 1)] ?? HAIRSTYLES[0]
}

/**
 * 这个时段该穿哪套。
 *
 * @param {string} slotId  morning/noon/afternoon/evening
 * @param {string} dayKey
 * @param {boolean} [justWoke] 刚起床（还没换衣服）
 * @returns {{kind:'home'|'sleep', text:string}}
 */
export function outfitForSlot(slotId, dayKey, justWoke = false) {
  if (justWoke) return { kind: 'sleep', text: sleepwearForDay(dayKey) }
  // 凌晨（归在 evening 里）默认穿睡衣 —— 那会儿在家多半已经洗漱完
  const h = new Date().getHours()
  if (slotId === 'evening' && (h >= 23 || h < 5)) {
    return { kind: 'sleep', text: sleepwearForDay(dayKey) }
  }
  return { kind: 'home', text: outfitForDay(dayKey) }
}