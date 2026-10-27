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
  "smallThing": "今天发生的一件小事"
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
    for (const k of ['wake', 'morning', 'noon', 'afternoon', 'evening', 'mood', 'smallThing']) {
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
  if (plan.mood) parts.push(`心情：${plan.mood}`)
  if (plan.smallThing) parts.push(`今天的小事：${plan.smallThing}`)
  if (parts.length === 0) return ''
  return `## 今天我（${SLOTS[idx]?.label ?? '现在'}）的状态\n`
    + '（下面这些是**今天真的发生过**的事，别人问「在干嘛」「吃了吗」就按这个答，'
    + '不要说成还没发生的）\n'
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
    this.data.plans[dayKey(now)] = plan
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
