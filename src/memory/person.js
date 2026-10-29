// @ts-check
/**
 * 人物档案 —— 按 **QQ 号**记人，不按昵称。
 *
 * ## 为什么不能用昵称当主键
 *
 * 同一个人在群里会换昵称（「风宝」「不是不是风宝」「风宝（攒抽版）」…），
 * 昵称还可能和别人的撞。用昵称做 key 的后果：
 *
 *   · 改一次昵称 = 变成一个新的人，之前的印象全丢
 *   · 两个人昵称相近 = 印象串在一起，A 的隐私出现在 B 的档案里
 *
 * QQ 号是稳定的，所以档案一律以 `sender`（QQ 号）为主键，
 * 昵称只作为**别名**累积在 `aliases` 里，用于展示和消歧。
 *
 * ## 存什么
 *
 * ```json
 * {
 *   "u:2129024700": {
 *     "id": "2129024700",
 *     "aliases": ["风宝", "不是不是风宝"],
 *     "impression": "爱攒抽、爱发图，说话随意，遇到不懂的会拿玩笑带过",
 *     "facts": ["在杭州读高中", "玩绝区零"],
 *     "firstSeen": 1792979561420,
 *     "lastSeen":  1792980123456,
 *     "seen": 137
 *   }
 * }
 * ```
 *
 * `impression` 是**覆盖式**的（新印象替换旧的），`facts` 是**累积式**的
 * 但去重且有上限 —— 事实是判断依据，印象是结论。
 *
 * ## 跨会话
 *
 * 档案**不按群隔离**：一个人在 A 群和 B 群是同一个人，
 * 在私聊里说的话也该影响 bot 对他的理解（这是「记住一个人」的本意）。
 *
 * ⚠️ 但这带来一个必须守住的边界：**档案是用来理解他的，不是用来
 *    在别的群里复述他的话**。所以这里只存「印象/事实」这种高度概括的
 *    东西，不存原始对话 —— 原始对话留在各会话自己的记忆里。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 每个人最多留几条事实（再多 prompt 装不下，也没必要）。 */
const MAX_FACTS = 12
/** 别名最多留几个（换昵称很勤，留最近几个够了）。 */
const MAX_ALIASES = 6
/** 印象字符上限 —— 一个人两行以内。 */
const MAX_IMPRESSION_CHARS = 120

/**
 * 把各种来源的 id 规范成档案 key。
 *
 * 统一加 `u:` 前缀，将来若要支持别的平台（`d:` Discord）不会撞。
 *
 * @param {string|number} id
 * @returns {string}
 */
export function personKey(id) {
  const s = String(id ?? '').trim()
  return s ? `u:${s}` : ''
}

/** 一个 QQ 号下的一条档案。 */
export class PersonProfile {
  /** @param {string} id QQ 号 */
  constructor(id) {
    this.id = String(id)
    /** @type {string[]} 昵称别名，最近的在最后 */
    this.aliases = []
    /** @type {string} 一句印象（覆盖式） */
    this.impression = ''
    /** @type {string[]} 稳定事实（累积、去重、有上限） */
    this.facts = []
    /** @type {number|null} 第一次见到 */
    this.firstSeen = null
    /** @type {number|null} 最后一次说话 */
    this.lastSeen = null
    /** @type {number} 说过多少句 */
    this.seen = 0
  }

  /**
   * 记一次出现（每收到一条他的消息就调）。
   *
   * @param {string} name 当前昵称
   * @param {number} at 时间戳
   */
  touch(name, at) {
    const n = String(name ?? '').trim()
    // 昵称变了就追加到别名末尾（不重排已有的，避免展示时跳来跳去）
    if (n && !this.aliases.includes(n)) {
      this.aliases.push(n)
      if (this.aliases.length > MAX_ALIASES) this.aliases = this.aliases.slice(-MAX_ALIASES)
    }
    if (this.firstSeen === null) this.firstSeen = at
    this.lastSeen = at
    this.seen += 1
  }

  /**
   * 更新印象。**覆盖**，不是追加 —— 这是「蒸馏」的核心。
   *
   * @param {string} text
   */
  setImpression(text) {
    const s = String(text ?? '').trim().replace(/\s+/g, ' ')
    if (!s) return
    this.impression = s.length > MAX_IMPRESSION_CHARS
      ? `${s.slice(0, MAX_IMPRESSION_CHARS - 1)}…`
      : s
  }

  /**
   * 记一条事实。去重 + 上限（旧的先淘汰）。
   *
   * @param {string} text
   */
  addFact(text) {
    const s = String(text ?? '').trim().replace(/\s+/g, ' ')
    if (!s) return
    // 已有同一条就不重复加 —— 反复提同一件事不该刷屏
    if (this.facts.includes(s)) return
    this.facts.push(s)
    if (this.facts.length > MAX_FACTS) this.facts = this.facts.slice(-MAX_FACTS)
  }

  /** 展示用名字：最近用过的昵称。 */
  get displayName() {
    return this.aliases[this.aliases.length - 1] || this.id
  }

  toJSON() {
    return {
      id: this.id,
      aliases: this.aliases,
      impression: this.impression,
      facts: this.facts,
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      seen: this.seen,
    }
  }

  /**
   * 渲染成给 LLM 看的一行。
   *
   * 只给「当前说话人」和「常聊的人」用，所以必须短。
   */
  toPromptLine() {
    const parts = []
    if (this.impression) parts.push(this.impression)
    if (this.facts.length > 0) parts.push(this.facts.slice(0, 4).join('、'))
    if (parts.length === 0) return ''
    // 括号里标 QQ 号 —— 模型偶尔会用它区分重名的人
    return `- ${this.displayName}（${this.id}）：${parts.join('；')}`
  }
}

/** 全体人物档案，落到 `<home>/people.json`。 */
export class PeopleStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] 数据目录
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    this.file = opts.home ? path.join(opts.home, 'people.json') : null
    /** @type {Map<string, PersonProfile>} key = `u:<QQ号>` */
    this.people = new Map()
    this._now = opts.now ?? (() => Date.now())
    this._dirty = false
    /** 日志（可空）。只用来把「落盘失败」这种沉默问题暴露出来。 */
    this.log = opts.log ?? {}
    if (this.file) this.load()
  }

  load() {
    if (!this.file) return
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw)
      for (const [key, v] of Object.entries(data?.people ?? {})) {
        if (!v || typeof v !== 'object') continue
        const id = String(v.id ?? key.replace(/^u:/, ''))
        if (!id) continue
        const p = new PersonProfile(id)
        if (Array.isArray(v.aliases)) p.aliases = v.aliases.filter((x) => typeof x === 'string').slice(-MAX_ALIASES)
        if (typeof v.impression === 'string') p.impression = v.impression.slice(0, MAX_IMPRESSION_CHARS)
        if (Array.isArray(v.facts)) p.facts = v.facts.filter((x) => typeof x === 'string').slice(-MAX_FACTS)
        if (Number.isFinite(v.firstSeen)) p.firstSeen = v.firstSeen
        if (Number.isFinite(v.lastSeen)) p.lastSeen = v.lastSeen
        if (Number.isFinite(v.seen)) p.seen = v.seen
        this.people.set(personKey(id), p)
      }
    } catch {
      // 首次运行 / 文件坏了 —— 从空开始，不阻断启动
    }
  }

  save() {
    /*
     * ⚠️ 两条「静默失败」的路径都要能看见（2026-10-29 修）。
     *
     * 之前这里 `if (!this.file) return` + `catch {}` 全吞 ——
     * 结果 `people.json` **从来没写出来过**，日志里却一个字都没有，
     * 只能靠人肉去磁盘上数文件才发现。沉默的失败比报错难查得多。
     *
     * 现在：两条路径各告警**一次**（`_warnedX` 去重，避免每 30 秒 flush 刷屏）。
     * 默认 `log={}` 时是 no-op，不改变任何既有行为。
     */
    if (!this.file) {
      if (!this._warnedNoFile) {
        this._warnedNoFile = true
        this.log?.warn?.('人物档案未启用落盘（没给 home）—— 重启后人物印象会丢')
      }
      return
    }
    try {
      const people = {}
      for (const [key, p] of this.people) people[key] = p.toJSON()
      const tmp = `${this.file}.tmp`
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, people }), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
      this._dirty = false
    } catch (e) {
      // 写失败不影响主流程，但必须**留痕**（否则下次还是查不到）
      if (!this._warnedSaveErr) {
        this._warnedSaveErr = true
        this.log?.warn?.(`人物档案落盘失败（${this.file}）：${String(e?.message ?? e)}`)
      }
    }
  }

  /**
   * 记一次出现。每收到一条非机器人消息就调 —— 很轻（只更新内存 + 标记脏）。
   *
   * @param {string|number} id QQ 号
   * @param {string} name 昵称
   * @param {number} [at]
   * @returns {PersonProfile|null}
   */
  touch(id, name, at = this._now()) {
    const key = personKey(id)
    if (!key) return null
    let p = this.people.get(key)
    if (!p) {
      p = new PersonProfile(String(id))
      this.people.set(key, p)
    }
    p.touch(name, at)
    this._dirty = true
    return p
  }

  /** @param {string|number} id */
  get(id) {
    return this.people.get(personKey(id)) ?? null
  }

  /**
   * 取「跟当前说话人最相关的一批人」—— 用于注入 prompt。
   *
   * 排序：当前说话人优先，其余按最近活跃时间倒序。
   *
   * @param {object} [opts]
   * @param {string|number} [opts.self] 当前说话人的 QQ 号（排最前）
   * @param {number} [opts.limit=6]
   * @param {string[]} [opts.alsoIds] 额外优先的人（比如本条消息 @ 到的人）
   * @returns {PersonProfile[]}
   */
  relevant({ self, limit = 6, alsoIds = [] } = {}) {
    /** @type {PersonProfile[]} */
    const out = []
    const used = new Set()
    const push = (p) => {
      if (!p || used.has(p.id) || out.length >= limit) return
      // 没有任何可展示内容的人不占位置
      if (!p.impression && p.facts.length === 0) return
      used.add(p.id)
      out.push(p)
    }
    // 1. 当前说话人
    if (self !== undefined && self !== null) push(this.get(self))
    // 2. 被 @ 的人
    for (const id of alsoIds) push(this.get(id))
    // 3. 其余按最近活跃
    const rest = [...this.people.values()]
      .filter((p) => !used.has(p.id))
      .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
    for (const p of rest) push(p)
    return out
  }

  /**
   * 渲染成 prompt 段落。没人有档案时返回空串（不占 prompt）。
   *
   * @param {object} [opts] 同 {@link relevant}
   */
  toPrompt(opts = {}) {
    const list = this.relevant(opts)
    if (list.length === 0) return ''
    const lines = list.map((p) => p.toPromptLine()).filter(Boolean)
    if (lines.length === 0) return ''
    return `【你认识的几个人】\n${lines.join('\n')}`
  }

  /** 给界面看的快照。 */
  stats() {
    const all = [...this.people.values()]
    return {
      count: all.length,
      // 有实际内容的才算「有效档案」
      described: all.filter((p) => p.impression || p.facts.length > 0).length,
      people: all
        .filter((p) => p.impression || p.facts.length > 0)
        .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
        .slice(0, 50)
        .map((p) => ({
          id: p.id,
          name: p.displayName,
          aliases: p.aliases,
          impression: p.impression,
          facts: p.facts,
          seen: p.seen,
          lastSeen: p.lastSeen,
        })),
    }
  }

  /** 清掉一个人（界面用）。 */
  forget(id) {
    const key = personKey(id)
    const had = this.people.delete(key)
    if (had) this.save()
    return had
  }

  /** 脏了就写盘（定期调，避免每条消息都写文件）。 */
  flush() {
    if (this._dirty) this.save()
  }
}

export default PeopleStore
