/**
 * 事件记忆层（2026-11-04）。
 *
 * ## 为什么还要一层
 *
 * 现在的记忆是两截：
 * ```
 * 短期：最近 30 条          → 撑 36 分钟（实测）
 * 长期：每 20 条重写一遍摘要 → 私聊 685 条压成 343 字（0.5 字/条）
 * ```
 * 中间**是空的**。于是「他昨天说这周要交毕设」「我答应留一碗饭」这种
 * **一件一件的事**，既活不过 30 条，也挤不进一段越来越淡的摘要 ——
 * 摘要写的是"这个人是什么样"，不是"我欠他什么"。
 *
 * 参考 MaiBot 的 A_Memorix（原文核实过）：
 * ```
 * half_life_hours = 24.0      prune_threshold = 0.1
 * freeze_duration_hours = 24  revive_threshold = 0.15   # 必须 > prune，做迟滞区
 * access_reinforcement_alpha = 0.05
 * ```
 * **关键设计：只衰减"关系/印象"，段落和 Episode 不衰减。**
 * 这里是另一层，所以跟着衰减；摘要那层不动。
 *
 * ## 一条事件长什么样
 * ```
 * { id, kind: promise|fact|state|name, text ≤40 字, at, lastAt, strength, hits }
 * ```
 * - `at`      第一次记下的时间
 * - `lastAt`  上次算衰减的时间（惰性衰减：读的时候才推，不跑定时器）
 * - `strength` 0~1，`lastAt` 时刻的值
 *
 * ## 生命周期
 * ```
 * 记下            1.0
 * 每过 24 小时     ×0.5      （私聊 48 小时 —— 私聊比群里亲，忘得慢）
 * < 0.1           冻结：**不注入，但数据留着**（这是"忘"和"丢"的区别）
 * 又被提起        复活到 0.15（> 0.1，迟滞区，不会一碰就又掉回去）+0.5
 * 被注入且她用上  +0.1，同一件事 60 分钟内只加一次
 * ```
 *
 * ⚠️ **不做 embedding**。这一层的判断全是"字面重叠 + 时间"，
 *    宁可少记几条，也不要引入一个查不准就悄悄错的检索面。
 *
 * ## 三条纪律
 * ① **绝不影响回复**：抽取是异步 `void` 出去的，任何失败只 warn。
 * ② **只注入还活着的**，且**带上相对时间** —— 不然她会把三天前的事
 *    当成"刚发生"来接话（这是最像机器人的地方之一）。
 * ③ **写进去的文本会被原文塞回提示词**，所以一行一句话、不带引号抄原句。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 允许的事件类型（抽取端和存储端共用这张白名单）。 */
export const EVENT_KINDS = ['promise', 'fact', 'state', 'name']

/**
 * 默认参数。
 *
 * 这些值是**照着 MaiBot 的比例**定的，不是拍脑袋：
 * 半衰期 24h（私聊 48h）、冻结线 0.1、复活线 0.15（必须 > 冻结线）、
 * 强化 0.1（比 MaiBot 的 0.05 大一点 —— 我们的事件条数少，加得太慢等于没加）。
 */
export const EVENT_DEFAULTS = {
  /** 总开关。关掉之后 bridge 既不全注入也不抽。 */
  enabled: true,
  /** 群里一件事的半衰期（小时）。 */
  halfLifeHours: 24,
  /** 私聊的半衰期 —— 私聊比群里亲，忘得慢一倍。 */
  privateHalfLifeHours: 48,
  /** 低于这个强度就冻结：不注入，数据留着。 */
  pruneThreshold: 0.1,
  /** 被重新提起时先拉回这条线（必须 > pruneThreshold，做迟滞）。 */
  reviveTo: 0.15,
  /** 被重新提起额外加多少强度。 */
  reviveBoost: 0.5,
  /** 被注入且她真用上了，加多少。 */
  reinforceAlpha: 0.1,
  /** 同一件事两次强化之间的冷却（分钟）。 */
  reinforceCooldownMinutes: 60,
  /** 每个会话最多留多少条（超了先丢冻结的、再丢最弱的）。 */
  maxEvents: 60,
  /** 每轮最多注入几条。 */
  injectMax: 8,
  /** 每轮注入的字符预算。 */
  injectChars: 600,
  /** 攒够几条新消息才抽一次（省 token：抽一次是一次 LLM 调用）。 */
  extractAfter: 6,
  /** 单条事件的字数上限。 */
  maxTextChars: 40,
}

/** 各类型在提示词里的中文标签。 */
const KIND_LABEL = {
  promise: '答应过',
  fact: '他说过',
  state: '在做',
  name: '叫法',
}

/**
 * 衰减：`强度 × 2^(-经过小时数 / 半衰期)`。
 *
 * @param {number} strength 当前强度
 * @param {number} dtMs     经过的毫秒
 * @param {number} halfLifeHours 半衰期（小时）
 * @returns {number} 衰减后的强度
 */
export function decayStrength(strength, dtMs, halfLifeHours) {
  const s = Number(strength)
  if (!Number.isFinite(s) || s <= 0) return 0
  const hl = Number(halfLifeHours)
  if (!Number.isFinite(hl) || hl <= 0) return Math.min(1, s)
  const dt = Number(dtMs)
  if (!Number.isFinite(dt) || dt <= 0) return Math.min(1, s)
  return Math.min(1, s * Math.pow(2, -dt / (hl * 3600_000)))
}

/** 归一化文本：去空白/标点，用于"是不是同一件事"的判断。 */
function normText(s) {
  return String(s ?? '')
    .replace(/[\s，。、！？…,.!?"'“”‘’（）()《》~～\-—]/g, '')
    .toLowerCase()
}

/**
 * 粗判「这句话里用上了这件事没有」。
 *
 * 为什么不用模型判：每次回复再多一次调用太贵，而且这件事**判错也不致命**
 * —— 判错只是强度多加或少加了 0.1。
 *
 * ## 判据：**最长公共子串 ≥ 3 字**
 *
 * 一开始写的是「2-gram 命中率 ≥ 1/3」，实测不行：
 * ```
 * 事件：答应给他留一碗饭
 * 回复：行，我给你留一碗米饭
 * 2-gram 只撞上「留一」「一碗」= 2/7 = 29%  → 判成"没用上"
 * ```
 * 但她显然用上了（「留一碗」三个字连在一起）。
 * 短句比的是**连续片段**，不是零散片段的比例。
 *
 * 3 字的门槛足够挡掉「我给」「今天」这种巧合 —— 中文里连着三个字
 * 撞上的概率很低，而「留一碗」「图书馆」「赶毕设」这种真正的复用
 * 一定 ≥3 字。
 *
 * @param {string} eventText
 * @param {string} reply
 * @returns {boolean}
 */
export function usedInReply(eventText, reply) {
  const a = normText(eventText)
  const b = normText(reply)
  if (!a || !b) return false
  const need = Math.min(3, a.length)
  if (need === 0) return false
  // 事件很短（「交毕设」）就直接看包含
  if (a.length <= 4) return b.includes(a)
  return longestCommonSubstring(a, b) >= need
}

/**
 * 最长公共子串长度（朴素 DP，O(n·m)）。
 *
 * 两边都是几十到几百字的短串，跑一次几万次比较完全无所谓 ——
 * 换成后缀自动机只会让这段代码以后没人敢改。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function longestCommonSubstring(a, b) {
  const s1 = String(a ?? '')
  const s2 = String(b ?? '')
  if (!s1 || !s2) return 0
  let best = 0
  let prev = new Array(s2.length + 1).fill(0)
  for (let i = 1; i <= s1.length; i++) {
    const cur = new Array(s2.length + 1).fill(0)
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

/**
 * 解析抽取结果。
 *
 * 模型被要求输出 `类型 | 一句话`，但免费渠道经常自由发挥
 * （全角竖线、`：`、前后带 `-`）。这里认宽松一点，认不出的行**直接丢** ——
 * 宁可少记，也不要记进一行「NONE」或者半句解释。
 *
 * @param {string} raw
 * @returns {Array<{kind:string, text:string}>}
 */
export function parseExtracted(raw) {
  const out = []
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const s = line.trim().replace(/^[-*·\d.、)\s]+/, '').trim()
    if (!s) continue
    if (/^NONE$/i.test(s) || /^(没有|无)$/.test(s)) continue
    const m = s.match(/^([a-zA-Z]+)\s*[|｜:：]\s*(.+)$/)
    if (!m) continue
    const kind = m[1].toLowerCase()
    if (!EVENT_KINDS.includes(kind)) continue
    const text = m[2].trim()
    if (!text) continue
    out.push({ kind, text })
  }
  return out
}

/** 相对时间（给提示词用）。 */
export function relativeTime(ms) {
  const m = Math.max(0, Math.round(Number(ms) / 60_000))
  if (m < 2) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.round(h / 24)
  if (d === 1) return '昨天'
  if (d < 7) return `${d} 天前`
  return `${Math.round(d / 7)} 周前`
}

/**
 * 抽取提示词。
 *
 * ⚠️ 跟 `SUMMARY_PROMPT` 一样：**这一段是模板字符串的一部分，
 *    不能用反引号标代码块** —— 会截断字符串（踩过）。
 */
export const EXTRACT_PROMPT = `你在帮一个聊天机器人**记几件具体的事**。只记"这几天还用得上"的，别推理，别总结人设。

四种类型，只输出这四种：
promise  答应过对方、还没做完的事（"给他留一碗饭"）
fact     对方亲口说过的、长期成立的事（在哪上学/上班、作息、在玩什么）
state    对方正在做的事 / 正在等的东西（"这周在赶毕设"）
name     她对某人或某物的固定叫法（绰号、内部叫法）

规则：
- 一行一条，格式：类型 | 一句话（不超过 40 字）
- ⚠️ 只写**对方**的事；你自己答应的（promise）可以写，你自己的日常琐事不写
- ⚠️⚠️ **你自己在干什么不记**：「正在修资料页面功能」「在画图」「在找东西」
  —— 那是你的动作，不是他的。实测就这么混进来过。
- ⚠️⚠️ 对方给你的**规矩 / 要求不记**：「以后都这样」「不要那样」「按这个规则来」
  —— 那是配置，不是一件事。只有他明确说「答应我以后…」才进 promise。
- ⚠️ 一次性的花钱 / 收到的东西不记（买了什么、送了张卡、买了个气泡）
- ⚠️⚠️ **主语写清楚**：用昵称或 QQ 号开头，说不清是谁的就别记
  （「这周回城」这种半边句子，宁可不记）
- ⚠️ 客气话、玩笑、反话、猜测、角色扮演一律不记
- ⚠️ 当天就过去的（吃了什么、天气、路上看到啥、一次性的吐槽）不记
- ⚠️ 已经在【已知的事】里的，不要重复输出；有明显变化的才重写一行
- 没有值得记的就只输出 NONE

对 / 错示例（照这个形状写）：
  ✅ promise | 答应 Null_zwei 下课后一起摸鱼
  ✅ state | 番茄下周有两天要去公司学习
  ✅ fact | 阿乙周末常去图书馆
  ✅ name | 管他叫老陈
  ❌ state | 正在修资料页面功能        ← 这是你自己在做的事
  ❌ promise | 以后核图按带字规则归档    ← 这是规矩，不是答应过的事
  ❌ fact | 给我买了聊天气泡            ← 一次性消费
  ❌ state | 这周回城                  ← 谁回城？说不清

【已知的事】
{known}

【新的聊天记录】
{messages}

只输出上面那种「类型 | 一句话」的行，或者 NONE。`

/**
 * 事件记忆存储。
 *
 * @param {object} opts
 * @param {object} [opts.cfg]      `memory.events` 配置
 * @param {string} [opts.home]     数据目录
 * @param {string} [opts.dir]      `memory.dir`（记忆单独放别处时用）
 * @param {Function} [opts.extract] async ({ messages, scene, known }) => string
 *                                  由上层注入（用 LLM 抽事件）；不注入就永不抽取
 * @param {object} [opts.log]
 */
export class EventStore {
  constructor(opts = {}) {
    this.cfg = { ...EVENT_DEFAULTS, ...(opts.cfg ?? {}) }
    this.enabled = this.cfg.enabled !== false
    this.extract = opts.extract
    this.log = opts.log ?? {}
    const dir = typeof opts.dir === 'string' && opts.dir.trim() ? opts.dir.trim() : opts.home
    this.file = dir ? path.join(dir, 'memory-events.json') : null
    /** @type {Map<string, {events: Array, updatedAt: number}>} */
    this.scopes = new Map()
    /** 每个会话抽到哪了（累计条数），防止重复抽同一批 */
    this._cursor = new Map()
    /** 上一轮注入了哪些（供"她用上了没有"判断） */
    this._injected = new Map()
    /** 防止同一会话并发抽取 */
    this._busy = new Set()
    this._dirty = false
    this._timer = null
  }

  /** 半小时（毫秒）—— 每轮都要算，抽出来省得每次都乘。 */
  _halfLifeMs(scope) {
    const s = String(scope ?? '')
    const h = s.startsWith('private:')
      ? this.cfg.privateHalfLifeHours
      : this.cfg.halfLifeHours
    const v = Number(h)
    return (Number.isFinite(v) && v > 0 ? v : 24) * 3600_000
  }

  /** 取某个会话的桶（没有就建）。 */
  _bucket(scope, create = false) {
    const key = String(scope ?? '')
    let b = this.scopes.get(key)
    if (!b) {
      if (!create) return null
      b = { events: [], updatedAt: 0 }
      this.scopes.set(key, b)
    }
    return b
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [scope, v] of Object.entries(j.sessions ?? {})) {
        const events = (Array.isArray(v?.events) ? v.events : [])
          .filter((e) => e && EVENT_KINDS.includes(e.kind) && String(e.text ?? '').trim())
          .map((e) => ({
            id: String(e.id ?? ''),
            kind: e.kind,
            text: String(e.text).slice(0, this.cfg.maxTextChars),
            at: Number(e.at ?? 0),
            lastAt: Number(e.lastAt ?? e.at ?? 0),
            strength: Math.max(0, Math.min(1, Number(e.strength ?? 1))),
            hits: Number(e.hits ?? 0),
            lastBoostAt: Number(e.lastBoostAt ?? 0),
          }))
        this.scopes.set(scope, { events, updatedAt: Number(v?.updatedAt ?? 0) })
        // 老文件没有游标 → 从当前条数起步，别把整段历史重抽一遍
        this._cursor.set(scope, Number(v?.cursor ?? v?.events?.length ?? events.length))
      }
      const n = [...this.scopes.values()].reduce((a, b) => a + b.events.length, 0)
      this.log.info?.(`事件记忆：载入 ${this.scopes.size} 个会话 / ${n} 条事件`)
    } catch (e) {
      this.log.warn?.(`事件记忆载入失败（忽略）：${String(e?.message ?? e)}`)
    }
  }

  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const sessions = {}
      for (const [scope, b] of this.scopes) {
        const cursor = this._cursor.get(scope) ?? 0
        /*
         * ⚠️ **游标也要落盘，哪怕这个会话还没有事件**（2026-11-04）。
         * 只存有事件的会话的话：抽过一次但什么都没抽到（很常见 ——
         * 大部分聊天确实没什么可记的），重启后游标归零 →
         * 下一轮把整个窗口**重抽一遍**，白花一次 LLM 调用。
         */
        if (!b.events.length && !cursor) continue
        sessions[scope] = {
          events: b.events,
          updatedAt: b.updatedAt,
          cursor,
        }
      }
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      this._dirty = false
    } catch (e) {
      this.log.warn?.(`事件记忆落盘失败（忽略）：${String(e?.message ?? e)}`)
    }
  }

  /** 2 秒防抖落盘（跟短期记忆同一个节奏）。 */
  _touch() {
    this._dirty = true
    if (!this.file || this._timer) return
    this._timer = setTimeout(() => {
      this._timer = null
      if (this._dirty) this.save()
    }, 2000)
    this._timer.unref?.()
  }

  /** 立刻落盘（退出/测试时用）。 */
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (this._dirty) this.save()
  }

  /**
   * 惰性衰减：读的时候按"上次算到现在"推一次。
   *
   * ⚠️ 不跑定时器 —— 事件只有几十条，读时算一下的代价可以忽略；
   *    而定时器会在没人聊天的时候把磁盘写满。
   */
  _decayAll(bucket, scope, now) {
    const hl = this._halfLifeMs(scope)
    let changed = false
    for (const e of bucket.events) {
      const dt = now - Number(e.lastAt ?? 0)
      if (!Number.isFinite(dt) || dt <= 0) continue
      const next = decayStrength(e.strength, dt, hl / 3600_000)
      if (next !== e.strength) { e.strength = next; changed = true }
      e.lastAt = now
    }
    if (changed) this._touch()
    return changed
  }

  /**
   * 记几条事件（新记 / 重提都在这里）。
   *
   * @param {string} scope
   * @param {Array<{kind:string, text:string}>} items
   * @param {object} [o]
   * @param {number} [o.now]
   * @returns {{added:number, revived:number}}
   */
  remember(scope, items, o = {}) {
    if (!this.enabled) return { added: 0, revived: 0 }
    const now = Number(o.now ?? Date.now())
    const list = (Array.isArray(items) ? items : [])
      .filter((it) => it && EVENT_KINDS.includes(it.kind) && String(it.text ?? '').trim())
      .map((it) => ({ kind: it.kind, text: String(it.text).trim().slice(0, this.cfg.maxTextChars) }))
    if (list.length === 0) return { added: 0, revived: 0 }

    const b = this._bucket(scope, true)
    this._decayAll(b, scope, now)

    let added = 0
    let revived = 0
    for (const it of list) {
      const n = normText(it.text)
      const hit = b.events.find((e) => {
        if (e.kind !== it.kind) return false
        const en = normText(e.text)
        return en === n || (en.length >= 4 && (en.includes(n) || n.includes(en)))
      })
      if (hit) {
        /*
         * 重提：先"复活"再加强。
         *
         * ⚠️ 先复活到 `reviveTo` 再加 —— 直接 `+reviveBoost` 的话，
         *    一条冻到 0.02 的事件只会回到 0.52 的一半…… 不对，
         *    是 0.02+0.5=0.52，看着够；但那意味着**衰减越久的新消息反而更弱**。
         *    先拉到 0.15 再 +0.5 = 0.65，跟"刚记下"的 1.0 有差距，
         *    又足够重新进注入区，这才是迟滞该有的样子。
         */
        if (hit.strength < this.cfg.pruneThreshold) {
          hit.strength = Math.max(hit.strength, this.cfg.reviveTo)
          revived++
        }
        hit.strength = Math.min(1, hit.strength + Number(this.cfg.reviveBoost))
        hit.hits = Number(hit.hits ?? 0) + 1
        // 文本以新的为准（模型可能把同一件事说得更准）
        if (it.text.length > hit.text.length) hit.text = it.text
        continue
      }
      b.events.push({
        id: `e${now.toString(36)}${(b.events.length + 1).toString(36)}`,
        kind: it.kind,
        text: it.text,
        at: now,
        lastAt: now,
        strength: 1,
        hits: 1,
        lastBoostAt: 0,
      })
      added++
    }

    this._trim(b, now)
    b.updatedAt = now
    this._touch()
    if (added || revived) {
      this.log.info?.(
        `事件记忆：${scope} +${added} 条${revived ? `，复活 ${revived} 条` : ''}`
        + `（现有 ${b.events.length} 条）`,
      )
    }
    return { added, revived }
  }

  /** 超上限时：先丢冻结的（最弱的），再丢最旧的。 */
  _trim(b, now) {
    const max = Math.max(1, Number(this.cfg.maxEvents) || 60)
    if (b.events.length <= max) return
    const frozen = (e) => e.strength < this.cfg.pruneThreshold
    b.events.sort((x, y) => {
      const fx = frozen(x) ? 0 : 1
      const fy = frozen(y) ? 0 : 1
      if (fx !== fy) return fx - fy           // 冻结的排前面（先丢）
      if (x.strength !== y.strength) return x.strength - y.strength
      return Number(x.at ?? 0) - Number(y.at ?? 0)
    })
    b.events.splice(0, b.events.length - max)
    // 恢复成"新的在后"的自然顺序，注入时再排序
    b.events.sort((x, y) => Number(x.at ?? 0) - Number(y.at ?? 0))
    this._touch()
  }

  /** 还活着的事件（强度 ≥ 冻结线），按强度降序。 */
  active(scope, o = {}) {
    const now = Number(o.now ?? Date.now())
    const b = this._bucket(scope)
    if (!b || b.events.length === 0) return []
    this._decayAll(b, scope, now)
    return b.events
      .filter((e) => e.strength >= this.cfg.pruneThreshold)
      .sort((x, y) => y.strength - x.strength || Number(y.at ?? 0) - Number(x.at ?? 0))
  }

  /**
   * 生成「记着的事」这一段。
   *
   * 同时记下**这一轮注入了哪几条** —— 回复之后 `reinforceFromReply`
   * 要按这份名单算"她用上了没有"，不能拿全部事件去比（会误加强）。
   *
   * @param {string} scope
   * @param {object} [o]
   * @param {number} [o.now]
   * @returns {string}
   */
  toPrompt(scope, o = {}) {
    if (!this.enabled) return ''
    const now = Number(o.now ?? Date.now())
    const act = this.active(scope, { now })
    if (act.length === 0) return ''

    const budget = Math.max(80, Number(this.cfg.injectChars) || 600)
    const maxN = Math.max(1, Number(this.cfg.injectMax) || 8)
    const lines = []
    const ids = []
    let used = 0
    for (const e of act.slice(0, maxN)) {
      const line = `- [${KIND_LABEL[e.kind] ?? e.kind}] ${e.text}（${relativeTime(now - Number(e.at ?? now))}）`
      if (used + line.length > budget) break
      used += line.length + 1
      lines.push(line)
      ids.push(e.id)
    }
    if (lines.length === 0) return ''

    this._injected.set(String(scope ?? ''), { ids, at: now })
    return '## 今天记着的事\n'
      + '（这是你自己记下来的，**不是新消息**。别逐条念，也别主动翻旧账；'
      + '话题真说到的时候自然带上就行。）\n'
      + lines.join('\n')
  }

  /**
   * 回复发出去之后：看看这一轮注入的事，她真用上了没有。
   *
   * 用上 → +`reinforceAlpha`（同一件事有冷却，免得一句话刷满）。
   *
   * @param {string} scope
   * @param {string} reply 她刚发出去的正文
   * @param {object} [o]
   * @param {number} [o.now]
   * @returns {number} 强化了几条
   */
  reinforceFromReply(scope, reply, o = {}) {
    if (!this.enabled) return 0
    const key = String(scope ?? '')
    const inj = this._injected.get(key)
    if (!inj) return 0
    this._injected.delete(key)
    const b = this._bucket(key)
    if (!b || !inj.ids.length) return 0

    const now = Number(o.now ?? Date.now())
    const cooldown = Math.max(0, Number(this.cfg.reinforceCooldownMinutes) || 60) * 60_000
    let n = 0
    for (const id of inj.ids) {
      const e = b.events.find((x) => x.id === id)
      if (!e) continue
      if (!usedInReply(e.text, reply)) continue
      if (now - Number(e.lastBoostAt ?? 0) < cooldown) continue
      e.strength = Math.min(1, e.strength + Number(this.cfg.reinforceAlpha))
      e.lastBoostAt = now
      n++
    }
    if (n) this._touch()
    return n
  }

  /**
   * 也许该抽一次事件了。
   *
   * ## 为什么要节流
   * 抽一次 = 一次 LLM 调用。每条消息都抽，余额会被这一层吃光。
   * 所以按「攒够 `extractAfter` 条」抽一次 —— 6 条消息里总有一两句值得记的，
   * 而 6 条一起看比一条一条看**更省也更准**（单句没上下文，客套话会被误记）。
   *
   * @param {object} o
   * @param {string} o.scope
   * @param {Array}  o.messages 窗口里的消息（含 isMe/sender/senderName/text）
   * @param {number} [o.total]  累计条数（`mem.totalPushed`）
   * @param {object} [o.scene]
   * @returns {Promise<boolean>} 是否真抽了
   */
  async maybeExtract(o = {}) {
    if (!this.enabled || typeof this.extract !== 'function') return false
    const scope = String(o.scope ?? '')
    if (!scope) return false
    if (this._busy.has(scope)) return false

    const msgs = Array.isArray(o.messages) ? o.messages : []
    if (msgs.length === 0) return false
    const total = Number.isFinite(o.total) ? Number(o.total) : msgs.length
    const prev = Number(this._cursor.get(scope) ?? 0)
    let delta = total - prev
    /*
     * ⚠️ 计数回退（重启后短期记忆归零）→ 游标跟着归零。
     * 跟长期记忆那边同一个坑：不回退的话 `delta` 永远是负数，
     * 抽取**永久停摆**（且没有任何报错，只是"她再也不记事"）。
     */
    if (delta < 0) { delta = 0; this._cursor.set(scope, 0) }
    if (delta < Math.max(1, Number(this.cfg.extractAfter) || 6)) return false

    const take = Math.max(1, Math.min(delta, msgs.length))
    const fresh = msgs.slice(-take)
    // 先建桶：不然"抽了但没抽到东西"的会话不会出现在 `save()` 里，游标就白记了
    this._bucket(scope, true)

    this._busy.add(scope)
    try {
      const known = this.active(scope).map((e) => `${e.kind} | ${e.text}`).slice(0, 20).join('\n')
      const raw = await this.extract({
        messages: fresh,
        scene: o.scene,
        known: known || '（无）',
      })
      const items = parseExtracted(raw)
      // 抽完把游标推到 total —— 无论抽没抽到东西，这批已经"看过"了
      this._cursor.set(scope, total)
      if (items.length === 0) {
        this._touch()
        return false
      }
      const r = this.remember(scope, items, { now: Date.now() })
      return r.added + r.revived > 0
    } catch (e) {
      // 失败也推进游标，否则每条消息都会重试一次，把余额打穿
      this._cursor.set(scope, total)
      this.log.warn?.(`事件抽取失败（${scope}）：${String(e?.message ?? e)}`)
      return false
    } finally {
      this._busy.delete(scope)
    }
  }

  stats() {
    let events = 0
    let alive = 0
    for (const b of this.scopes.values()) {
      events += b.events.length
      alive += b.events.filter((e) => e.strength >= this.cfg.pruneThreshold).length
    }
    return { enabled: this.enabled, sessions: this.scopes.size, events, alive }
  }

  /**
   * 每个会话记着几件（设置页「记忆管理」用它，比 `stats()` 多一层 per-scope）。
   *
   * 只回**计数**，不回内容 —— 内容走 `list(scope)`。
   * 一次把所有会话的事件全文塞进轮询接口，几十条 × 多会话会把响应撑大，
   * 而设置页 8 秒轮询一次，那不值得。
   *
   * @returns {Array<{scope:string, total:number, alive:number, updatedAt:number|null}>}
   */
  listScopes() {
    const out = []
    for (const [scope, b] of this.scopes) {
      if (!b.events.length) continue
      out.push({
        scope,
        total: b.events.length,
        alive: b.events.filter((e) => e.strength >= this.cfg.pruneThreshold).length,
        updatedAt: b.updatedAt || null,
      })
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return out
  }

  /** 某个会话的明细（Web UI / 调试用）。 */
  list(scope) {
    const b = this._bucket(scope)
    if (!b) return []
    return b.events.map((e) => ({
      kind: e.kind,
      text: e.text,
      strength: Number(e.strength.toFixed(3)),
      hits: e.hits,
      at: e.at,
      frozen: e.strength < this.cfg.pruneThreshold,
    }))
  }

  clear(scope) {
    if (scope) { this.scopes.delete(String(scope)); this._cursor.delete(String(scope)) }
    else { this.scopes.clear(); this._cursor.clear() }
    this._touch()
    this.save()
  }
}