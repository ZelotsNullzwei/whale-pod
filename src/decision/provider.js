/**
 * 决策层接口定义（活人感的抽象）。
 *
 * ## 为什么单独一层
 *
 * 纯 LLM 机器人「呆」的根本原因是**逢消息必回** —— 真人不是这样：
 * 真人先判断「这句话是不是在问我 / 现在插话合适吗 / 我刚说过话要不要歇一会」，
 * 再决定说不说、说什么。
 *
 * 所以拆成两层：
 *   决策层（本文件）→ 该不该说话？概率多少？（便宜、快、结构化）
 *   表达层（LLM）   → 说什么？          （贵、慢、生成式）
 *
 * Jev（TypeSafe AI 的 System One）就是这个决策层的成熟实现，但它**是付费服务**，
 * 所以这里设计成**可插拔 + 可降级**：
 *
 *   [jev]（可选，需 TYPESAFE_API_KEY）→ [custom]（HTTP 回调）→ [rule]（内置，永远可用）
 *
 * 任何一层失败/未配置，都自动降到下一层。最差情况退回内置规则状态机，
 * 保证「不崩、不静默、只是没那么聪明」。
 */

/**
 * @typedef {object} DecisionInput
 * @property {Array<{id:string,sender:string,senderName?:string,text:string,at:number,mentionsMe:boolean,isMe:boolean}>} messages
 *   最近的群/私聊消息，按时间升序。至少包含触发本次判断的那条。
 * @property {{qq:string,nickname:string}} self  我是谁
 * @property {{kind:'group'|'private',groupId?:string,groupName?:string,userId?:string}} scene  场景
 * @property {number} sinceMyLastMessage  距我上次发言多久（ms）；没说过话时是 Infinity
 * @property {number} consecutiveTurns    我连续发言了几轮
 * @property {number} [now]               当前时间戳（便于测试注入）
 */

/**
 * @typedef {object} Decision
 * @property {boolean} reply        要不要说话
 * @property {number} [probability] 说话意愿 0..1（Jev 会返回；规则层给启发式值）
 * @property {string} [reason]      简短理由（用于调试与 UI 展示）
 * @property {number} [delayMs]     建议延迟多久再发（像人一样别秒回）
 * @property {number} [cost]        本次判断的成本（元），用于用量统计
 * @property {string} [provider]    哪个实现给的结论（jev/rule/custom）
 * @property {object} [raw]         原始返回（调试用，UI 里默认折叠）
 */

/**
 * 决策提供者基类。
 *
 * 实现者只需覆盖 `id` / `label` / `probe()` / `decide()`。
 * 失败时**抛错**即可 —— 注册表会自动降级，不用自己兜底。
 */
export class DecisionProvider {
  /** @type {string} */
  id = 'base'
  /** @type {string} 界面显示名 */
  label = 'Base'
  /** @type {number|undefined} 单次调用估算成本（元） */
  costPerCall = undefined

  /**
   * 可用性探测：配置是否齐全、服务是否可达。
   * @returns {Promise<{ok:boolean, detail:string}>}
   */
  async probe() {
    return { ok: false, detail: 'not implemented' }
  }

  /**
   * 核心：该不该说话。
   * @param {DecisionInput} input
   * @returns {Promise<Decision>}
   */
  async decide(_input) {
    throw new Error('not implemented')
  }
}

/**
 * 决策注册表：管理多个 provider，按优先级尝试，失败自动降级。
 */
export class DecisionRegistry {
  /**
   * @param {object} opts
   * @param {string[]} opts.order            优先级（provider id 列表）
   * @param {boolean} [opts.fallbackOnError] 失败是否降级（默认 true）
   * @param {object} [opts.log]
   */
  constructor(opts = {}) {
    this.order = opts.order ?? ['rule']
    this.fallbackOnError = opts.fallbackOnError !== false
    this.log = opts.log ?? {}
    /** @type {Map<string, DecisionProvider>} */
    this.providers = new Map()
    /** 运行期统计 */
    this.stats = { calls: 0, byProvider: {}, errors: 0, lastError: null, fallbacks: 0 }
  }

  /** 注册一个 provider。 */
  register(provider) {
    if (!provider?.id) throw new Error('provider 必须有 id')
    this.providers.set(provider.id, provider)
    return this
  }

  /** 当前生效的 provider（按 order 找第一个已注册的）。 */
  active() {
    for (const id of this.order) {
      const p = this.providers.get(id)
      if (p) return p
    }
    return null
  }

  /**
   * 依次尝试 order 里的 provider，直到有一个成功返回。
   *
   * 「成功」的定义是**没抛错** —— provider 返回 reply:false 也是合法结论
   * （它是在说"现在不该说话"，不是失败）。
   *
   * @param {DecisionInput} input
   * @returns {Promise<Decision>}
   */
  async decide(input) {
    this.stats.calls++
    const errors = []

    for (const id of this.order) {
      const p = this.providers.get(id)
      if (!p) continue
      const t0 = Date.now()
      try {
        const d = await p.decide(input)
        /*
         * ⚠️ **先 `...d` 全量透传，再覆盖要规范化的几个字段**（2026-10-28 改）。
         *
         * 原来这里是**白名单**（只列 reply/probability/reason/delayMs/cost/
         * provider/raw/ms/decided/defer）—— 任何**新加的**字段都会被静默吃掉。
         * 同一个坑已经踩过两次：
         *
         *   · `defer`（见下面那段注释）——
         *     「冷却中，晚点补回」的世界变成「直接丢弃」。
         *
         *   · `emojiReply`（2026-10-28，用户报「一直找图」+「还是反应青蛙」）——
         *     rule 对纯表情消息返回 `emojiReply: true`，含义是
         *     「**只回一个收藏表情，不调模型**」。白名单里没有它 →
         *     bridge 的 `if (d.emojiReply)` 永远不成立 → **每次都走生成层**：
         *       · 白花一次模型调用
         *       · 把表情包的图喂给模型 → 它开始描述画面（「这青蛙看着
         *         还挺心宽体胖的」）→ 正是用户抱怨的那句
         *       · 还有机会输出 `[找图:...]` → 反复联网找图
         *
         * 白名单的本意是「别把 provider 内部状态泄给上层」，但代价太大 ——
         * 加字段的人不会记得回来登记。所以改成透传 + 覆盖。
         */
        const out = {
          ...d,
          reply: Boolean(d?.reply),
          probability: typeof d?.probability === 'number' ? d.probability : undefined,
          // provider 用注册表里的 id，不信 provider 自己填的
          provider: p.id,
          ms: Date.now() - t0,
          cost: d?.cost ?? p.costPerCall,
          // provider 自己已经做出最终二元结论（如 rule 掷过骰子）→ 标 true。
          // 外层 shouldReply 看到它就不再套阈值，避免二次过滤造成
          // 「概率 0.8 却沉默」这种自相矛盾的界面。见 decision/index.js。
          decided: d?.decided === true,
          /**
           * ⚠️ `defer` **必须透传**（2026-10-23 修，现在由 `...d` 覆盖）。
           *
           * 它是「冷却中，晚点补回」的标记 —— rule 在冷却分支返回
           * `defer:{waitMs}`，bridge 看到它就排队重试而不是丢弃。
           * tests/check-concurrency.mjs 第 8 项盯着它。
           */
          defer: d?.defer,
        }
        this.stats.byProvider[p.id] = (this.stats.byProvider[p.id] ?? 0) + 1
        if (errors.length > 0) {
          this.stats.fallbacks++
          this.log.info?.(`decision: ${p.id} 成功（此前 ${errors.length} 个失败）`)
        }
        return out
      } catch (err) {
        const msg = String(err?.message ?? err)
        errors.push(`${p.id}: ${msg}`)
        this.stats.errors++
        this.stats.lastError = { provider: p.id, message: msg, at: Date.now() }
        this.log.warn?.(`decision: ${p.id} 失败 — ${msg}`)
        if (!this.fallbackOnError) break
      }
    }

    // 全部失败：返回一个保守的默认结论（不回话），而不是抛错把上层带崩
    const last = this.providers.get('rule')
    if (last && !this.order.includes('rule')) {
      try {
        const d = await last.decide(input)
        return { ...d, provider: 'rule', reason: `降级到 rule（${errors.join('; ') || '无可用 provider'}）`, ms: 0 }
      } catch { /* 连 rule 都挂了 */ }
    }

    this.log.warn?.(`decision: 所有 provider 都失败，保守判定为不回复`)
    return {
      reply: false,
      probability: 0,
      reason: `所有决策提供者失败：${errors.join('; ')}`,
      provider: 'none',
      ms: 0,
    }
  }

  /** 探测所有 provider 的可用性（供 Web UI 展示）。 */
  async probeAll() {
    const out = []
    for (const [id, p] of this.providers) {
      const t0 = Date.now()
      try {
        const r = await p.probe()
        out.push({ id, label: p.label, ok: Boolean(r?.ok), detail: r?.detail ?? '', ms: Date.now() - t0, costPerCall: p.costPerCall })
      } catch (err) {
        out.push({ id, label: p.label, ok: false, detail: String(err?.message ?? err), ms: Date.now() - t0, costPerCall: p.costPerCall })
      }
    }
    return { order: this.order, active: this.active()?.id ?? null, providers: out, stats: this.stats }
  }
}
