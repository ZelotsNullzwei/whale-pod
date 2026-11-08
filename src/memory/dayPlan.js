/**
 * 「今日状态」——每天一份日程，让她在**同一整天里**的答案对得上。
 *
 * ## 为什么需要（抄自 X 上大肥鱼的做法）
 *
 * 没有这一层时，别人问「在干嘛 / 吃了吗 / 今天忙不忙」，
 * 模型只能**现编**。而且下一个人再问，它会编出**另一个**答案 ——
 * 同一天里她说自己「刚吃完午饭」又说「还没吃」，这就是最像机器人的地方。
 *
 * 有了日程之后：不同的人在不同时间问，答案都能对上。
 *
 * 作者的原话：这是「提升活人感最有效的一项」。
 *
 * ## 设计要点
 *
 * ① **只精确到时段**（早上/中午/下午/晚上），不带分钟 ——
 *    带分钟会让前缀缓存每分钟失效（他实测过，缓存命中率掉 10 个点）。
 * ② **参考前几天避免重样** —— 否则每天都「在吃大白饭」。
 * ③ **平平常常、具体一点** —— 不要「今天拯救了世界」这种戏剧化的。
 * ④ 人设里的往事（比如「炒糊过一次饭」）**不能当成今天又发生一遍**
 *    （他踩过的坑：日程里又写了一遍「炒糊饭」，变成今天又炒糊了）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { outfitForDay, sleepwearForDay, hairForDay } from './wardrobe.js'
/*
 * ★ **今天临时换上的那套**（2026-11-06，用户：「有要换衣服就同步一下，
 *   临时替换？第二天或者到了晚上换睡衣的时候再换」）。
 *
 * 日程表里的 `outfit` 是**按日期算死的**；但聊天里她真的换了衣服之后，
 * 提示词里「今天穿的」必须跟着变 —— 否则她嘴上说女仆装、提示词还说家居服，
 * 生图也按家居服画，三边对不上。
 *
 * ⚠️ 只在**渲染时**覆盖，**不回写** `plans[dayKey].outfit` ——
 *    第二天/到了睡衣时段 `wearingFor` 自然返回 null，日程表原样恢复。
 */
import { wearingFor } from './wearing.js'
import { outingForDay } from './outing.js'

/** 一天分成四个时段。带分钟会让缓存失效，所以只到时段。 */
export const SLOTS = [
  { id: 'morning', label: '早上', range: [5, 11] },
  { id: 'noon', label: '中午', range: [11, 14] },
  { id: 'afternoon', label: '下午', range: [14, 18] },
  { id: 'evening', label: '晚上', range: [18, 29] }, // 18~凌晨5点（跨日）
]

/**
 * 当前时刻属于哪个时段。
 *
 * @param {Date} [now]
 * @returns {{id:string, label:string}}
 */
export function currentSlot(now = new Date()) {
  const h = now.getHours()
  // 凌晨 0~5 归到「晚上」—— 那会儿还在熬夜，不是新的一天
  if (h >= 18 || h < 5) return SLOTS[3]
  if (h < 11) return SLOTS[0]
  if (h < 14) return SLOTS[1]
  return SLOTS[2]
}

/** 本地日期键（YYYY-MM-DD），换日就用新日程。 */
export function dayKey(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 生成日程用的提示词。
 *
 * @param {object} o
 * @param {string} o.selfName
 * @param {string[]} [o.recent]  前几天的日程大意（避免重样）
 * @param {string} [o.date]
 * @returns {string}
 */
export function buildDayPlanPrompt(o = {}) {
  const recent = (o.recent ?? []).filter(Boolean).slice(-3)
  return `给「${o.selfName ?? '蓝色大肥鱼'}」编一份**今天**的日程。

要求：
- **平平常常**，就是一个普通女孩子的一天。不要戏剧化，不要有大事发生。
- **具体一点**：几点起、三餐吃什么、在玩什么、心情如何。
- 一两件**小事**就够（比如「买了个新杯子」「把袜子洗了」）。
${recent.length > 0 ? `- 别跟前几天重样。前几天大概是：\n${recent.map((x) => `  · ${x}`).join('\n')}` : ''}

⚠️ 重要：下面这些是**以前发生过的事**，不要写成今天又发生一遍：
- 「炒糊过一次蛋炒饭」→ 今天是**以前**的事，不是今天又炒糊了
- 任何「上次」「之前」发生过的事，今天都不该重演

按这个 JSON 输出，不要加别的字：
{
  "wake": "几点起，一句",
  "morning": "早上在干嘛",
  "noon": "中午吃什么/在干嘛",
  "afternoon": "下午在干嘛",
  "evening": "晚上在干嘛",
  "mood": "今天的心情，一两个词",
  "smallThing": "今天发生的一件小事",
  "weather": "今天的天气，一句（晴/阴/雨 + 冷热感，比如「阴天，十几度，有点凉」）",
  "hair": "（不用填，代码会填）",
  "outfit": "（不用填，代码会填）",
}`
}

/**
 * 解析模型给出的日程 JSON。容错：模型常包一层 ```json。
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseDayPlan(text) {
  const s = String(text ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  try {
    const j = JSON.parse(s)
    if (!j || typeof j !== 'object') return null
    // 只保留认识的字段，避免模型塞一堆东西进来
    const out = {}
    for (const k of ['wake', 'morning', 'noon', 'afternoon', 'evening', 'mood', 'smallThing', 'weather', 'hair', 'outfit', 'sleepwear']) {
      const v = j[k]
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 60)
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * 把日程渲染成提示词片段（**只给当前时段和已过去的时段**）。
 *
 * ## 为什么只给过去的时段
 *
 * 如果把「晚上在干嘛」也给它，它会**提前用未来发生的事**回答
 * （「我刚看完电影」—— 而现在才下午）。只给 `slot` 及之前的，
 * 它就只能说「已经发生过的」。
 *
 * @param {object} plan
 * @param {string} slotId
 * @returns {string}
 */
export function renderDayPlan(plan, slotId) {
  if (!plan) return ''
  const order = ['morning', 'noon', 'afternoon', 'evening']
  const idx = order.indexOf(slotId)
  const parts = []
  if (plan.wake) parts.push(`起床：${plan.wake}`)
  for (let i = 0; i <= idx && i < order.length; i++) {
    const v = plan[order[i]]
    if (v) parts.push(`${SLOTS[i].label}：${v}`)
  }
  if (plan.weather) parts.push(`今天天气：${plan.weather}`)
  if (plan.hair) parts.push(`今天的头发：${plan.hair}`)
  /*
   * ★ 今天穿的：**临时换上的优先**（2026-11-06）。
   *   `wearingFor` 只在"当天 + 还没到该穿睡衣的钟点（22:00）"返回内容，
   *   第二天或深夜自动 null → 这里回落到日程表那套。
   *   ⚠️ 别按 slot 判 —— evening 覆盖 18:00–05:00，会把晚上最活跃那段
   *      一起判掉（2026-11-06 群里「衣服没换过来」就是这么来的）。
   */
  const worn = (() => {
    /*
     * ⚠️ 用**今天**的 dayKey（不是 plan 里存的）—— 这样"第二天"天然不生效，
     *    不需要额外的清理逻辑。
     */
    try { return wearingFor(dayKey(), slotId) } catch { return null }
  })()
  if (worn?.text) parts.push(`今天穿的（刚换上的）：${worn.text}`)
  else if (plan.outfit) parts.push(`今天穿的：${plan.outfit}`)
  if (plan.sleepwear) parts.push(`睡觉穿的：${plan.sleepwear}`)
  if (plan.outing) {
    /* ★ 标出时段（2026-11-08）：不然正文说"下午去便利店"、这行说"去公园"，读起来像同一下午两件事 */
    const slotLabel = SLOTS.find((x) => x.id === String(plan.outingSlot ?? ''))?.label ?? ''
    parts.push(`今天出门${slotLabel ? `（${slotLabel}）` : ''}：${plan.outing}`)
  }
  if (plan.mood) parts.push(`心情：${plan.mood}`)
  if (plan.smallThing) parts.push(`今天的小事：${plan.smallThing}`)
  if (parts.length === 0) return ''
  return `## 今天我（${SLOTS[idx]?.label ?? '现在'}）的状态\n`
    + '（下面这些是**今天真的发生过**的事，别人问「在干嘛」「吃了吗」就按这个答）\n'
    + '- **只用这里写过的**：没写的事不要补细节（实测编过「下午去公园遛狗」，计划里根本没有）\n'
    + '- **别把还没到的时段当已完成**：当前时段还没过完，不能说成「刚做完一整段」\n'
    + '- **别按时间顺序念流水账**：挑跟当前话题有关的一件说，别把早上中午下午全报一遍\n'
    + parts.join('\n')
}

/**
 * 今日状态的存取。
 *
 * 每天一份，换日自动作废 —— 不需要清理逻辑，读的时候对不上日期就当没有。
 */
export class DayPlanStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {object} [opts.log]
   * @param {number} [opts.keepDays] 保留几天的历史（给「别重样」用）
   */
  constructor(opts = {}) {
    this.dir = opts.dir ?? '.'
    this.log = opts.log ?? {}
    this.keepDays = opts.keepDays ?? 5
    this.file = path.join(this.dir, 'day-plan.json')
    /** @type {{version:number, plans:Record<string, object>}} */
    this.data = { version: 1, plans: {} }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return this
      const raw = fs.readFileSync(this.file, 'utf8')
      const j = JSON.parse(raw)
      if (j && typeof j === 'object' && j.plans && typeof j.plans === 'object') {
        this.data = { version: 1, plans: j.plans }
      }
    } catch (e) {
      this.log.warn?.(`dayPlan：读取失败（当作没有）— ${String(e?.message ?? e)}`)
    }
    return this
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      // 只留最近 keepDays 天
      const keys = Object.keys(this.data.plans).sort()
      while (keys.length > this.keepDays) {
        const drop = keys.shift()
        delete this.data.plans[drop]
      }
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch (e) {
      // 落盘失败不阻断主流程 —— 最坏情况是每天重新生成一次
      this.log.warn?.(`dayPlan：写入失败 — ${String(e?.message ?? e)}`)
    }
  }

  /**
   * 取今天的日程；没有就返回 null（调用方据此触发生成）。
   *
   * @param {Date} [now]
   */
  today(now = new Date()) {
    return this.data.plans[dayKey(now)] ?? null
  }

  /**
   * 存今天的日程。
   *
   * @param {object} plan
   * @param {Date} [now]
   */
  setToday(plan, now = new Date()) {
    /*
     * ★ 衣服/睡衣/发型**不由模型编**（2026-11-06）：
     *   从衣柜白名单按日期取 —— 同一天永远同一套，隔天换一套，且不会编出怪东西。
     */
    const k = dayKey(now)
    const p = { ...plan }
    p.outfit = outfitForDay(k)
    p.sleepwear = sleepwearForDay(k)
    p.hair = hairForDay(k)
    /*
     * ★ 今天出不出去（2026-11-06 用户：「总不能一直待在家里吧」）：
     *   按日期算，A 附近为主 / B 市区经常 / C 远门偶尔 / 少数天不出门。
     */
    const outing = outingForDay(k)
    p.outing = outing.text
    p.outingKind = outing.kind
    /*
     * ★ **出门的时段要和日程正文错开**（2026-11-08 用户：
     *   「时间错开好像也没问题，看这么园得回来」）。
     *
     * 实测 2026-11-08：正文写「两点多去楼下便利店买生抽」，
     * outing 又写「去公园坐了一下午」—— **同一个下午两个外出**，
     * 她会两个都说（之前「下午去公园遛狗」那次混乱就是这个源头）。
     *
     * 用户的判断是对的：只要**不在同一格**就成立 —— 去公园回来顺路进便利店很自然。
     * 所以这里**换格，不删任何一个**。
     */
    let outingSlot = outing.slot
    if (outing.kind && outing.kind !== 'none') {
      const OUT = /(去|逛|出门|下楼|便利店|超市|商场|公园|市场|快递|药店|理发|看电影|书店|咖啡)/
      if (OUT.test(String(p[outingSlot] ?? ''))) {
        const other = outingSlot === 'morning' ? 'afternoon' : 'morning'
        if (!OUT.test(String(p[other] ?? ''))) outingSlot = other
      }
    }
    p.outingSlot = outingSlot
    this.data.plans[k] = p
    this.save()
    return plan
  }

  /**
   * 前几天的日程大意（生成时用来避免重样）。
   *
   * @param {Date} [now]
   * @returns {string[]}
   */
  recentHints(now = new Date()) {
    const today = dayKey(now)
    return Object.entries(this.data.plans)
      .filter(([k]) => k !== today)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 3)
      .map(([, p]) => [p.morning, p.noon, p.afternoon, p.evening].filter(Boolean).join('；'))
      .filter(Boolean)
  }
}
