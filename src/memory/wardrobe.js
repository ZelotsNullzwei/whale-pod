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

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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
/**
 * 标志性套装（她的基础形象）。
 *
 * ⚠️ **不进日期轮换** —— 日常不会穿女仆装。只在下面两种情况用：
 *   ① 用户明确说「穿你那套标志性的 / 女仆装 / 带尾巴那套」
 *   ② 她自己想"认真拍一张"（纪念、给粉丝看）
 *
 * 尾巴是可拆卸的挂件，挂在腰后、**从侧面也能看到一点**，不要求背影。
 */
export const SIGNATURE_OUTFITS = [
  /* ① 长款女仆装 */
  '白色蕾丝头带（拱形、一侧蓝丝带蝴蝶结），**女仆装长款**（藏青到深蓝渐变的连身裙，裙长到膝盖以下，三层白蕾丝裙摆 + 花瓣状缺口，泡泡袖 + 白蕾丝袖口），白色蕾丝围裙（肩带交叉、胸前小鲸鱼刺绣），颈饰是黑色大蝴蝶结 + 中央蓝宝石，手臂戴白色蕾丝袖套，小腿戴藏青蕾丝袜套，**藏青玛丽珍鞋（带搭扣）**，腰后挂着**一条**深蓝色鲸鱼尾巴（从腰后正中伸出、末端分成左右两片叶状尾鳍；不是左右各一条）',
  /* ② 短款女仆装 */
  '白色蕾丝头带（拱形、一侧蓝丝带蝴蝶结），**女仆装短款**（藏青到深蓝渐变的连身裙，裙长在膝盖以上，两层白蕾丝裙摆 + 花瓣状缺口，泡泡袖 + 白蕾丝袖口），白色蕾丝围裙（肩带交叉、胸前小鲸鱼刺绣），颈饰是黑色大蝴蝶结 + 中央蓝宝石，手臂戴白色蕾丝袖套，小腿戴藏青蕾丝袜套，**藏青玛丽珍鞋（带搭扣）**，腰后挂着**一条**深蓝色鲸鱼尾巴（从腰后正中伸出、末端分成左右两片叶状尾鳍；不是左右各一条）',
  /* ③ 女仆风上衣 + 长裤 */
  '白色蕾丝头带（拱形、一侧蓝丝带蝴蝶结），**女仆风上衣**（藏青泡泡袖短上衣 + 白蕾丝袖口 + 白色多褶围领），下身是**藏青棉质长裤**（松紧腰），白色蕾丝围裙收在腰上，颈饰是黑色大蝴蝶结 + 中央蓝宝石，手臂戴白色蕾丝袖套，小腿戴藏青蕾丝袜套，**藏青玛丽珍鞋（带搭扣）**，腰后挂着**一条**深蓝色鲸鱼尾巴（从腰后正中伸出、末端分成左右两片叶状尾鳍；不是左右各一条）',
  /* ④ 藏青连衣裙 + 围裙 */
  '白色蕾丝头带（拱形、一侧蓝丝带蝴蝶结），**藏青棉质连衣裙**（过膝、圆领、腰上有细带），外面系**白色蕾丝围裙**，白棉袜，**藏青玛丽珍鞋（带搭扣）**，腰后挂着**一条**深蓝色鲸鱼尾巴（末端两片叶状尾鳍）',
  /* ⑤ 水手服 + 鲸尾 */
  '白色蕾丝头带（拱形、一侧蓝丝带蝴蝶结），**藏青水手服**（白衬衫 + 藏青水手领 + 白蕾丝袖口），**藏青百褶短裙**（膝上），白棉袜，**藏青玛丽珍鞋（带搭扣）**，腰后挂着**一条**深蓝色鲸鱼尾巴（末端两片叶状尾鳍）',
  /* ⑥ 白色系女仆装 */
  '白色蕾丝头带（一侧蓝丝带蝴蝶结），**白色系女仆装**（白衬衫 + 藏青背带连衣裙 + 白色蕾丝围裙，肩带交叉、胸前小鲸鱼刺绣），颈饰是黑色大蝴蝶结 + 中央蓝宝石，手臂戴白色蕾丝袖套，小腿戴藏青蕾丝袜套，**藏青玛丽珍鞋（带搭扣）**，腰后挂着**一条**深蓝色鲸鱼尾巴（从腰后正中伸出、末端分成左右两片叶状尾鳍；不是左右各一条）',
]

/**
 * 取标志性套装（按日期在 3 套里挑，避免每次一模一样）。
 * @param {string} dayKey
 * @returns {string}
 */
export function signatureOutfitForDay(dayKey) {
  const pool = effectivePools().signature
  return pool[pickIndex(dayKey, pool.length, 11)] ?? pool[0] ?? ''
}

export const HOME_OUTFITS = [
  /* ── 简约基础 ── */
  '白色蕾丝发带，浅灰短袖家居T恤，深蓝棉布长裤，白棉袜，不穿鞋只穿木色拖鞋',
  '蓝色小发夹，米白宽松针织衫，浅灰棉麻家居长裤（松紧腰），白棉袜，木色拖鞋',
  '白色蕾丝发带，淡蓝条纹长袖家居服上衣，藏青棉布长裤，白棉袜，木色拖鞋',
  /* ── 休闲运动 ── */
  '蓝色发圈（低马尾），奶白圆领卫衣，浅灰束脚棉裤，白棉袜，木色拖鞋',
  '白色蕾丝发带，雾霾蓝短袖T恤，米色棉质家居短裤，白棉袜，木色拖鞋',
  '蓝色小发夹，浅灰长袖家居上衣，深灰棉布长裤，白棉袜，木色拖鞋',
  /* ── 学院风（在家也穿得舒服） ── */
  '白色蕾丝发带，**藏青V领针织背心 + 白衬衫（衬衫领露出来）**，深灰百褶短裙，白棉袜，木色拖鞋',
  '蓝色小发夹，**米白麻花针织开衫 + 浅蓝衬衫**，深蓝直筒棉裤，白棉袜，木色拖鞋',
  /* ── 甜妹 ── */
  '白色蕾丝发带，**浅粉碎花小方领上衣（泡泡袖、上衣塞进裙腰）**，米白棉质半长裙（到小腿），白棉袜，木色拖鞋',
  '蓝色发圈（低马尾），**奶白荷叶边短袖**，浅蓝棉质A字半裙（过膝），光脚，木色拖鞋',
  /* ── 复古 ── */
  '白色蕾丝发带，**深棕格纹长袖衬衫（下摆塞进裤子）**，米色直筒棉裤，白棉袜，木色拖鞋',
  '蓝色小发夹，**米白细针织高领上衣**，深棕灯芯绒直筒裤，白棉袜，木色拖鞋',
  /* ── 一个人在家随便穿 ── */
  '头发随便挽起来用蓝色发圈，一件**宽松大T恤当睡裙穿**（过臀、光腿），白棉袜，木色拖鞋',
  '蓝色小发夹，**浅灰吊带背心 + 米色棉质家居短裤**（光腿），白棉袜，木色拖鞋',
  '头发披着没梳，**白色大码衬衫（只扣两粒扣）当外套**，浅灰棉质家居短裤（光腿），光脚，木色拖鞋',
  '蓝色发圈（低马尾），**雾霾蓝细吊带 + 深灰棉质家居短裤**，光脚，木色拖鞋',
]

/**
 * 外出服（出门穿）。
 *
 * ⚠️ 和家居服的区别：**外面能穿的**（牛仔裤、外套、帆布鞋、包）。
 *   家里那套不行 —— 出门不会穿拖鞋。
 */
export const OUTING_OUTFITS = [
  /* ── JK 制服 ── */
  '白色蕾丝发带，**白衬衫 + 藏青水手领（领巾打结）**，深蓝百褶短裙，白棉袜，**黑色小皮鞋**',
  '蓝色小发夹，**浅灰西装外套 + 白衬衫 + 藏青领带**，藏青百褶中长裙，白棉袜，**黑色乐福鞋**',
  '蓝色发圈（低马尾），**奶白针织开衫 + 白衬衫**，格纹百褶短裙，白棉袜，**棕色小皮鞋**',
  /* ── 学院风 ── */
  '白色蕾丝发带，**藏青V领毛衣 + 白衬衫（领子翻出来）**，米白直筒长裤，白棉袜，**白色帆布鞋**',
  /* ── 简约基础 ── */
  '白色蕾丝发带，浅灰短袖针织衫，**深蓝直筒牛仔裤**，白棉袜，**白色帆布鞋**',
  '蓝色小发夹，米白开衫（内搭白T），**浅蓝牛仔裤**，白棉袜，**白色帆布鞋**',
  /* ── 甜妹 ── */
  '白色蕾丝发带，**米白伞摆半长裙（到小腿）+ 白色修身针织上衣**（塞进裙腰，上紧下松），白棉袜，**裸色浅口单鞋**',
  '蓝色小发夹，**浅粉碎花连衣裙（过膝、有腰带）**，白棉袜，**白色小皮鞋**',
  /* ── 休闲运动 ── */
  '蓝色发圈（高马尾），**浅灰连帽卫衣**，深灰束脚运动裤，白棉袜，**白色运动鞋**',
  /* ── 中性工装 ── */
  '蓝色小发夹，**卡其工装夹克 + 白T**，深灰直筒工装裤（卷脚），白棉袜，**黑色帆布鞋**',
  /* ── 复古/知性 ── */
  '白色蕾丝发带，**深蓝直筒半裙（开叉、过膝）+ 米白宽松衬衫**（上宽下窄），白棉袜，**黑色乐福鞋**',
  '蓝色发圈（低马尾），**藏青背带连衣裙（及膝）+ 白色短袖内搭**，白棉袜，**白色小皮鞋**',
  '白色蕾丝发带，**卡其色薄风衣** + 浅灰内搭，深蓝牛仔裤，白棉袜，**棕色短靴**',
  '蓝色小发夹，**深棕格纹西装外套 + 白T**，米白阔腿长裤（高腰），白棉袜，**棕色乐福鞋**',
  /* ── 温柔针织 ── */
  '白色蕾丝发带，**米白长款针织连衣裙（过膝、系细腰带）**，白棉袜，**裸色短靴**',
  '蓝色发圈（低马尾），雾霾蓝长袖针织衫，**深灰阔腿裤**，白棉袜，**黑色小皮鞋**',
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
  /* ⚠️ 连衣裙必须写「连身」才会触发三分之二身构图；上半身必须无袖/短袖，写了长袖会变T恤裙 */
  '浅灰棉质长袖睡衣套装（小翻领、前襟纽扣 + 同款长裤），白棉袜，不穿拖鞋，**不戴头饰**',
  '浅灰棉质**吊带连身睡裙**（细肩带、**无袖**、一整件到膝、下摆宽松），光脚，不穿拖鞋，**不戴头饰**',
  '淡蓝格纹长袖睡衣套装（对襟纽扣上衣 + 同款格纹睡裤），白棉袜，不穿拖鞋，**不戴头饰**',
  '白色棉质**背心式连身睡裙**（**无袖**、圆领、一整件到膝），白棉袜，不穿拖鞋，**不戴头饰**',
  '雾霾蓝棉质睡衣套装（短袖翻领上衣 + 及膝短裤），光脚，不穿拖鞋，**不戴头饰**',
  '奶白棉质**吊带连身睡裙**（细肩带、**无袖**、一整件到膝、下摆宽松），白棉袜，不穿拖鞋，**不戴头饰**',
  '米白棉质长袖睡衣上衣 + 同色睡裤（宽松、有抽绳），白棉袜，不穿拖鞋，**不戴头饰**',
  '淡粉碎花棉质睡衣套装（短袖小翻领 + 同款短裤），白棉袜，不穿拖鞋，**不戴头饰**',
  '浅蓝棉质**连身睡裙**（短袖、圆领、一整件到膝），光脚，不穿拖鞋，**不戴头饰**',
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
  const pool = effectivePools().home
  return pool[pickIndex(dayKey, pool.length, 0)] ?? pool[0] ?? ''
}

/**
 * 取某天的外出服。
 * @param {string} dayKey
 * @returns {string}
 */
export function outingOutfitForDay(dayKey) {
  const pool = effectivePools().outing
  return pool[pickIndex(dayKey, pool.length, 3)] ?? pool[0] ?? ''
}
/**
 * 取某天的睡衣。
 * @param {string} dayKey
 * @returns {string}
 */
export function sleepwearForDay(dayKey) {
  const pool = effectivePools().sleepwear
  return pool[pickIndex(dayKey, pool.length, 2)] ?? pool[0] ?? ''
}

/**
 * 取某天的发型。
 * @param {string} dayKey
 * @returns {string}
 */
export function hairForDay(dayKey) {
  const pool = effectivePools().hairstyle
  return pool[pickIndex(dayKey, pool.length, 1)] ?? pool[0] ?? ''
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
/**
 * 衣柜摘要（进对话提示词用）。
 *
 * 现场问题：用户说「给你加了几件新衣服」，她反问「真的？什么样的，快说说」——
 * 因为衣柜只存在于出图链路，**没进她的对话提示词**。
 *
 * ⚠️ 只给分类/风格/套数/标志性名单 —— 47 套逐条列会把提示词撑爆，
 *    但足够她回答「你有什么衣服」「都什么风格」。
 * @returns {string}
 */
export function wardrobeBrief() {
  const total = HOME_OUTFITS.length + OUTING_OUTFITS.length + SLEEPWEAR.length + SIGNATURE_OUTFITS.length
  return [
    `【你的衣柜】一共 ${total} 套，都是你自己的衣服：`,
    `- 家居服 ${HOME_OUTFITS.length} 套：简约基础、休闲运动、学院风（V领背心+衬衫）、甜妹碎花、复古格纹，还有几套"一个人在家随便穿"的`,
    `- 外出服 ${OUTING_OUTFITS.length} 套：**JK 制服 3 套**（水手服 / 西装+领带 / 开衫+格纹裙）、学院风、甜妹碎花裙、休闲运动、中性工装、复古知性、温柔针织`,
    `- 睡衣 ${SLEEPWEAR.length} 套：睡衣套装 + 吊带连身睡裙`,
    `- 标志性造型 ${SIGNATURE_OUTFITS.length} 套（按官方设定图）：女仆装长款、女仆装短款、女仆风上衣+长裤、藏青连衣裙+围裙、水手服+鲸尾、白色系女仆装`,
    '⚠️ 上面这些就是全部。别人问「什么衣服/哪件/什么风格」就按这个答，**不要现编这里没有的衣服**；要说今天具体穿了哪套，看上面「今天穿的」。',
  ].join('\n')
}

/* ══════════════════════════════════════════════════════════════
 *  可编辑层（2026-11-06）
 *
 *  用户：「衣柜要能改吧，毕竟现在这个只是我们的预设，不代表别人喜欢」。
 *
 *  数据目录下放 `wardrobe.json`：
 *  {
 *    "home":      ["…", "…"],
 *    "outing":    ["…"],
 *    "sleepwear": ["…"],
 *    "signature": ["…"],
 *    "hairstyle": ["…"]
 *  }
 *
 *  · **某类存在且非空 → 整类用文件里的**（不是追加 —— 追加的话
 *    用户删掉的那套下次启动又回来了，删不掉等于不能改）
 *  · 缺省 / 空数组 → 回落到内置预设（老用户无痛）
 *  · **按 mtime 热加载**：改完下一轮就生效，不用重启
 * ══════════════════════════════════════════════════════════════ */

let WARDROBE_HOME = path.join(
  process.env.WHALE_POD_HOME
  ?? path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'whale-pod'),
)

/** 分类名（= wardrobe.json 的键） */
export const WARDROBE_KINDS = ['home', 'outing', 'sleepwear', 'signature', 'hairstyle']

/** 文件名 */
export const WARDROBE_FILE = 'wardrobe.json'

/** 告诉衣柜数据目录在哪（启动时调一次；不调就用默认路径）。 */
export function configureWardrobe({ home } = {}) {
  if (typeof home === 'string' && home.trim()) WARDROBE_HOME = home.trim()
  _wardrobeCache.mtime = -1
}

/** 衣柜文件路径 */
export function wardrobePath() {
  return path.join(WARDROBE_HOME, WARDROBE_FILE)
}

const _wardrobeCache = { mtime: -1, data: null, error: '' }

/**
 * 读覆盖文件（按 mtime 缓存）。
 * @returns {{data:object, error:string}}
 */
function readWardrobeOverrides() {
  const file = wardrobePath()
  let st
  try {
    st = fs.statSync(file)
  } catch {
    _wardrobeCache.mtime = -1
    _wardrobeCache.data = null
    _wardrobeCache.error = ''
    return { data: {}, error: '' }
  }
  if (_wardrobeCache.data && st.mtimeMs === _wardrobeCache.mtime) {
    return { data: _wardrobeCache.data, error: _wardrobeCache.error }
  }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const out = {}
    for (const k of WARDROBE_KINDS) {
      const v = j?.[k]
      if (!Array.isArray(v)) continue
      const list = v.map((x) => String(x ?? '').trim()).filter(Boolean)
      if (list.length) out[k] = list
    }
    _wardrobeCache.mtime = st.mtimeMs
    _wardrobeCache.data = out
    _wardrobeCache.error = ''
    return { data: out, error: '' }
  } catch (e) {
    // 文件写坏了：**继续用预设**，但把错误留着（上层可以提示）
    _wardrobeCache.mtime = st.mtimeMs
    _wardrobeCache.data = null
    _wardrobeCache.error = String(e?.message ?? e)
    return { data: {}, error: _wardrobeCache.error }
  }
}

/** 最近一次读取错误（文件写坏时非空） */
export function wardrobeError() {
  readWardrobeOverrides()
  return _wardrobeCache.error
}

/**
 * 生效中的池子（文件覆盖 + 内置预设的合并结果）。
 * @returns {{home:string[],outing:string[],sleepwear:string[],signature:string[],hairstyle:string[]}}
 */
export function effectivePools() {
  const { data } = readWardrobeOverrides()
  return {
    home: data.home ?? HOME_OUTFITS,
    outing: data.outing ?? OUTING_OUTFITS,
    sleepwear: data.sleepwear ?? SLEEPWEAR,
    signature: data.signature ?? SIGNATURE_OUTFITS,
    hairstyle: data.hairstyle ?? HAIRSTYLES,
  }
}

/** 哪些类被文件覆盖了（给 UI/日志看） */
export function wardrobeOverrides() {
  const { data } = readWardrobeOverrides()
  return Object.keys(data)
}

/**
 * 写衣柜文件（整类替换）。
 *
 * ⚠️ 写入的是**完整文件**：没点名的类**原样保留文件里已有的值**，
 *    而不是回落到预设 —— 否则"只改家居服"会把别的类的覆盖抹掉。
 *
 * @param {object} patch {home?:string[], outing?:string[], …}
 * @returns {{ok:boolean, file:string, error?:string}}
 */
export function saveWardrobe(patch = {}) {
  const file = wardrobePath()
  const cur = readWardrobeOverrides().data ?? {}
  const next = { ...cur }
  for (const k of WARDROBE_KINDS) {
    if (!(k in patch)) continue
    const list = (Array.isArray(patch[k]) ? patch[k] : [])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
    if (list.length) next[k] = list
    else delete next[k] // 空数组 = 恢复内置预设
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
    _wardrobeCache.mtime = -1
    return { ok: true, file }
  } catch (e) {
    return { ok: false, file, error: String(e?.message ?? e) }
  }
}

/**
 * 往某类里加一套（去重；已经有就原样返回）。
 * @param {'home'|'outing'|'sleepwear'|'signature'|'hairstyle'} kind
 * @param {string} text
 */
export function addOutfit(kind, text) {
  const t = String(text ?? '').trim()
  if (!t || !WARDROBE_KINDS.includes(kind)) return { ok: false, error: '分类或内容不合法' }
  const cur = effectivePools()
  const list = Array.isArray(cur[kind]) ? [...cur[kind]] : []
  if (list.includes(t)) return { ok: true, added: false, count: list.length }
  list.push(t)
  const r = saveWardrobe({ [kind]: list })
  return { ...r, added: r.ok, count: list.length }
}

/**
 * 从某类里删掉一条（按**包含关系**匹配，方便用户只说半句）。
 * @param {'home'|'outing'|'sleepwear'|'signature'|'hairstyle'} kind
 * @param {string} text
 */
export function removeOutfit(kind, text) {
  const t = String(text ?? '').trim()
  if (!t || !WARDROBE_KINDS.includes(kind)) return { ok: false, error: '分类或内容不合法' }
  const cur = effectivePools()
  const list = Array.isArray(cur[kind]) ? [...cur[kind]] : []
  const idx = list.findIndex((x) => x.includes(t) || t.includes(x))
  if (idx < 0) return { ok: false, error: '没找到那一套' }
  const removed = list.splice(idx, 1)[0]
  const r = saveWardrobe({ [kind]: list })
  return { ...r, removed }
}
