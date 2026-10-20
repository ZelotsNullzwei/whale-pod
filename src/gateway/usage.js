import fs from 'node:fs'
import path from 'node:path'

/**
 * 用量统计：把每次 LLM 调用的 token 用量记下来，并估算费用。
 *
 * 为什么要独立一个模块：
 *   网关的 HTTP 入口（/v1/chat/completions）和 QQ 机器人内部的调用
 *   （bridge 直接 stream()）**走的是两条路**。只统计前者的话，用户在
 *   总览页看到的永远是 0 —— 而 QQ 才是实际烧 token 的地方。
 *
 * 费用怎么算：
 *   免费渠道实际花费是 0，但"如果用官方 API 要多少钱"对用户仍有价值
 *   （能直观看出省了多少）。所以按 PROVIDER_PRICES 里的公开价估算，
 *   并在 UI 上标明"估算"。
 */

/**
 * 各家模型的参考价（美元 / 百万 token）。
 *
 * ⚠️ 这些是**公开挂牌价**，用于估算"省了多少钱"，不用于计费。
 *    拿不到价格的渠道一律按 0 计（宁可少算也不虚报）。
 *    价格会变，这里只放长期稳定的主力模型。
 */
export const PRICES = {
  // ── DeepSeek 官网价（美元 / 百万 token）──────────────────────────
  //
  // ⚠️ 搜索用的 deepseek-flash 走的是 DeepSeek **官方付费 API**，
  //    不是免费渠道 —— 这一项是真花钱的，别在面板上把它算成 0。
  //
  //    2026-10-20 用真实余额 + 后台账单反推过：
  //      · 单价与下表一致（约 ¥1/M 输入、¥2/M 输出）
  //      · 但也确认了单次搜索的真实成本是 **¥0.002 ~ ¥0.02**，
  //        差异全在输入量：每次搜索会把 10~20 个网页的正文塞进上下文
  //        （2~3 万 token），输出只有几百。
  //
  //    所以搜索省钱的关键是**控制网页数**（max_uses），不是换输出更便宜的模型。
  // https://api-docs.deepseek.com/quick_start/pricing
  'deepseek-v4.1': { in: 0.28, out: 0.42 },
  'deepseek-v4': { in: 0.28, out: 0.42 },
  'deepseek-v3': { in: 0.27, out: 1.10 },
  'deepseek-flash': { in: 0.14, out: 0.28 },
  'deepseek': { in: 0.28, out: 0.42 },   // 兜底：任何未列出的 deepseek-*

  // ── 智谱 GLM 官网价 ─────────────────────────────────────────────
  // https://open.bigmodel.cn/pricing
  'glm-5.3-flash': { in: 0.05, out: 0.10 },
  'glm-5.3': { in: 0.60, out: 2.20 },
  'glm-5.2': { in: 0.60, out: 2.20 },
  'glm-5.1': { in: 0.60, out: 2.20 },
  'glm-5v': { in: 0.80, out: 3.00 },
  'glm-4': { in: 0.10, out: 0.30 },

  // ── 月之暗面 Kimi 官网价 ────────────────────────────────────────
  // https://platform.moonshot.cn/docs/pricing
  'kimi-k3': { in: 0.55, out: 2.20 },
  'kimi-k2.8': { in: 0.55, out: 2.20 },
  'kimi-k2.7': { in: 0.50, out: 2.00 },
  'kimi-k2.6': { in: 0.50, out: 2.00 },

  // ── MiniMax 官网价 ─────────────────────────────────────────────
  // https://www.minimaxi.com/pricing
  'minimax-m3.1-flash': { in: 0.10, out: 0.40 },
  'minimax-m3': { in: 0.30, out: 1.20 },

  // ── MiMo 官网价 ────────────────────────────────────────────────
  'mimo-v2.6': { in: 0.10, out: 0.40 },

  // ── 阶跃 StepFun 官网价 ────────────────────────────────────────
  'step-5': { in: 0.50, out: 2.00 },

  // ── OpenAI 官网价 ──────────────────────────────────────────────
  // https://openai.com/api/pricing
  'gpt-6.1': { in: 1.25, out: 10.00 },
  'gpt-6': { in: 1.25, out: 10.00 },
  'gpt-5.6': { in: 1.10, out: 4.40 },
  'gpt-5.5': { in: 1.10, out: 4.40 },
  'gpt-5.4': { in: 1.10, out: 4.40 },
  'gpt-5.3': { in: 1.10, out: 4.40 },
  'gpt-5': { in: 1.10, out: 4.40 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'gpt-4o': { in: 2.50, out: 10.00 },

  // ── Anthropic Claude 官网价 ────────────────────────────────────
  'claude-sonnet-4': { in: 3.00, out: 15.00 },
  'claude-3-5-sonnet': { in: 3.00, out: 15.00 },
  'claude-haiku': { in: 0.80, out: 4.00 },
  'claude-opus': { in: 15.00, out: 75.00 },

  // ── Google Gemini 官网价 ───────────────────────────────────────
  'gemini-3.8-flash': { in: 0.10, out: 0.40 },
  'gemini-3.5-flash': { in: 0.10, out: 0.40 },
  'gemini-2.0-flash': { in: 0.10, out: 0.40 },
  'gemini-1.5-pro': { in: 1.25, out: 5.00 },
  'gemini': { in: 0.10, out: 0.40 },      // 兜底：未列出的 gemini-*

  // ── xAI Grok 官网价 ───────────────────────────────────────────
  'grok-4': { in: 2.00, out: 10.00 },

  // ── 其它 ───────────────────────────────────────────────────────
  'nemotron': { in: 0.10, out: 0.40 },
  'mercury': { in: 0.25, out: 1.00 },
  'pareto': { in: 0.30, out: 1.20 },
  'longcat': { in: 0.10, out: 0.40 },
  'qwen-max': { in: 1.60, out: 6.40 },
}

/** 按模型名找价格（前缀匹配，越长的前缀优先）。 */
export function priceOf(model) {
  const m = String(model ?? '').toLowerCase()
  if (!m) return null

  // 模型名可能带渠道前缀（`workbuddy/deepseek-v4.1-flash`）或后缀
  // （`-free`、`:free`、`-1017`、`-sg`）。先剥掉再匹配，
  // 否则同一个模型换个渠道就走不到价格了。
  //
  // ⚠️ 计费口径与渠道无关：**一律按该模型厂商官网的挂牌价**。
  //    即使走的是免费渠道，也在面板上按官网价折算 —— 用户要看的是
  //    "这些用量如果按原价买要多少钱"，而不是"我在这个渠道花了多少"。
  const bare = m
    .replace(/^[a-z0-9_.-]+\//, '')          // 去掉 provider/ 前缀
    .replace(/(:free|-free|-sg|-\d{3,})$/, '') // 去掉免费/区域/版本后缀

  const keys = Object.keys(PRICES).sort((a, b) => b.length - a.length)
  // 先匹配剥干净的名字，再退回原始串（兼容表里带前缀的条目）
  for (const k of keys) {
    if (bare.includes(k)) return PRICES[k]
  }
  for (const k of keys) {
    if (m.includes(k)) return PRICES[k]
  }
  return null
}

/**
 * 估算一次调用的费用（美元）。
 * @returns {number} 拿不到价格时返回 0
 */
export function estimateCost({ model, tokensIn = 0, tokensOut = 0 }) {
  const p = priceOf(model)
  if (!p) return 0
  return (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out
}

/**
 * 用量累计器。
 *
 * 记录维度：总计 + 按渠道（provider）+ 按模型 + 按来源（gateway / qq）。
 * 全部保留在内存里 —— 重启归零。这对一个本地机器人够用，也避免了
 * 写盘带来的复杂度和隐私问题。
 */
export class UsageTracker {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] 数据目录。给了就把统计落盘到
   *   `<home>/usage.json`，重启后接着累计；不给就是纯内存（测试用）。
   */
  constructor(opts = {}) {
    this.file = opts.home ? path.join(opts.home, 'usage.json') : null
    this.reset()
    if (this.file) this.load()
  }

  /**
   * 从磁盘恢复历史累计。
   *
   * ⚠️ 为什么需要：这些计数器原本只在内存里，每次重启归零 —— 用户看到的是
   *    「昨天用了 24K tokens，今天一开变成 0」，完全无法据它判断用量趋势。
   *    费用也是一样，跨天累计才有意义。
   *
   * 读失败（文件不存在 / 损坏）就当新的一天开始，不阻断启动。
   */
  load() {
    if (!this.file) return
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw)
      // 只认白名单字段，避免旧版本或手改的文件带进奇怪的东西
      if (Number.isFinite(data.calls)) this.calls = data.calls
      if (Number.isFinite(data.failed)) this.failed = data.failed
      if (Number.isFinite(data.tokensIn)) this.tokensIn = data.tokensIn
      if (Number.isFinite(data.tokensOut)) this.tokensOut = data.tokensOut
      if (Number.isFinite(data.costUsd)) this.costUsd = data.costUsd
      if (Number.isFinite(data.startedAt)) this.startedAt = data.startedAt
      if (data.lastAt) this.lastAt = data.lastAt
      if (data.byProvider && typeof data.byProvider === 'object') this.byProvider = data.byProvider
      if (data.bySource && typeof data.bySource === 'object') this.bySource = data.bySource
      if (data.byModel && typeof data.byModel === 'object') this.byModel = data.byModel
      this._restored = true
    } catch {
      // 文件不存在或损坏 —— 从零开始，不报错
    }
  }

  /** 落盘（原子写）。失败不影响统计本身，只丢弃这次持久化。 */
  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = JSON.stringify({
        startedAt: this.startedAt,
        calls: this.calls,
        failed: this.failed,
        tokensIn: this.tokensIn,
        tokensOut: this.tokensOut,
        costUsd: this.costUsd,
        lastAt: this.lastAt,
        byProvider: this.byProvider,
        bySource: this.bySource,
        byModel: this.byModel,
      })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, payload, { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch { /* ignore */ }
  }

  reset() {
    this.startedAt = Date.now()
    this.calls = 0
    this.failed = 0
    this.tokensIn = 0
    this.tokensOut = 0
    this.costUsd = 0
    /** provider → { calls, tokensIn, tokensOut, costUsd, models:Set } */
    this.byProvider = {}
    /** source → { calls, tokensIn, tokensOut, costUsd } */
    this.bySource = {}
    this.byModel = {}
    /** 最近若干次调用（供 UI 展示实时流水） */
    this.recent = []
    this.lastAt = null
  }

  /**
   * 记一次调用。
   *
   * @param {object} o
   * @param {string} [o.provider]  渠道 id
   * @param {string} [o.model]     模型名
   * @param {string} [o.source]    'gateway' | 'qq' | 'decision' | …
   * @param {number} [o.tokensIn]
   * @param {number} [o.tokensOut]
   * @param {boolean} [o.ok]
   * @param {number} [o.ms]        总耗时
   * @param {number} [o.ttftMs]    首字延迟（用户感知的"反应速度"）
   * @param {number} [o.reasonChars] 推理内容长度 —— 推理模型会把 token 吃光、正文变空
   * @param {number} [o.textChars]   正文长度
   * @param {string} [o.error]
   */
  record(o = {}) {
    this.calls++
    const ok = o.ok !== false
    if (!ok) this.failed++
    const tin = Number(o.tokensIn) || 0
    const tout = Number(o.tokensOut) || 0
    const cost = estimateCost({ model: o.model, tokensIn: tin, tokensOut: tout })

    // ⚠️ token 为 0 时不要累加费用 —— 有些渠道不返回 usage，
    //    硬算会让"预计金额"忽高忽低，还不如标成"未知"。
    this.tokensIn += tin
    this.tokensOut += tout
    this.costUsd += cost
    this.lastAt = Date.now()
    // 每次调用后落盘。写入是几十字节的 JSON，代价可忽略；
    // 换成定时批量写反而会丢最后几次调用。
    this.save()

    const ttft = Number(o.ttftMs) || 0
    const ms = Number(o.ms) || 0
    const rc = Number(o.reasonChars) || 0
    const tc = Number(o.textChars) || 0
    // 有推理、有 token、但正文为空 —— 这是"推理把预算吃光"的典型症状。
    // 单独统计它，用户才知道该给多少 token 或该换哪个模型。
    const emptyText = ok && tc === 0 && (rc > 0 || tout > 0) ? 1 : 0

    const bump = (map, key) => {
      if (!key) return null
      const e = map[key] ?? (map[key] = {
        calls: 0, failed: 0, tokensIn: 0, tokensOut: 0, costUsd: 0,
        msSum: 0, ttftSum: 0, ttftN: 0, reasonChars: 0, textChars: 0, emptyText: 0,
        lastMs: 0, lastError: null, lastAt: 0,
      })
      e.calls++
      if (!ok) { e.failed++; if (o.error) e.lastError = String(o.error).slice(0, 160) }
      e.tokensIn += tin
      e.tokensOut += tout
      e.costUsd += cost
      if (ms) e.msSum += ms
      if (ttft) { e.ttftSum += ttft; e.ttftN++ }
      e.reasonChars += rc
      e.textChars += tc
      e.emptyText += emptyText
      e.lastMs = ms || e.lastMs
      e.lastAt = Date.now()
      return e
    }

    const pv = bump(this.byProvider, o.provider)
    if (pv && o.model) {
      pv.models = pv.models || {}
      pv.models[o.model] = (pv.models[o.model] ?? 0) + 1
    }
    bump(this.bySource, o.source || 'unknown')
    bump(this.byModel, o.model)

    this.recent.unshift({
      at: this.lastAt, provider: o.provider ?? null, model: o.model ?? null,
      source: o.source ?? 'unknown', tokensIn: tin, tokensOut: tout,
      costUsd: cost, ok,
      ms: ms || null, ttftMs: ttft || null,
      reasonChars: rc, textChars: tc,
      error: o.error ?? null,
    })
    if (this.recent.length > 100) this.recent.length = 100
  }

  /** 供 UI 用的快照。 */
  snapshot() {
    const providers = Object.entries(this.byProvider).map(([id, v]) => ({
      id, calls: v.calls, failed: v.failed,
      tokensIn: v.tokensIn, tokensOut: v.tokensOut, costUsd: round6(v.costUsd),
      models: Object.keys(v.models ?? {}).length,
      avgMs: v.calls ? Math.round((v.msSum || 0) / v.calls) : null,
    })).sort((a, b) => b.calls - a.calls)

    return {
      uptimeMs: Date.now() - this.startedAt,
      calls: this.calls,
      failed: this.failed,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      tokensTotal: this.tokensIn + this.tokensOut,
      costUsd: round6(this.costUsd),
      /** 折人民币，便于国内用户直观理解（汇率写死不联网） */
      costCny: round6(this.costUsd * 7.2),
      lastAt: this.lastAt,
      byProvider: providers,
      bySource: Object.entries(this.bySource).map(([k, v]) => ({
        source: k, calls: v.calls, failed: v.failed,
        tokensIn: v.tokensIn, tokensOut: v.tokensOut, costUsd: round6(v.costUsd),
      })).sort((a, b) => b.calls - a.calls),
      byModel: Object.entries(this.byModel).map(([k, v]) => ({
        model: k, calls: v.calls, tokensIn: v.tokensIn, tokensOut: v.tokensOut,
        costUsd: round6(v.costUsd),
      })).sort((a, b) => b.calls - a.calls),
      // ── 性能统计（按"渠道/模型"）────────────────────────────
      //
      // 这是**纯统计，不做任何自动限制** —— 哪些模型快、哪些慢、
      // 哪些总是空回复，交给用户看数据自己决定。
      modelStats: this.modelStats(),
      recent: this.recent.slice(0, 30),
      /** 估算说明：UI 上要标明"这是估算" */
      note: '费用按各厂商官网挂牌价折算，与实际渠道无关',
    }
  }

  /**
   * 按 (渠道, 模型) 汇总性能。
   *
   * 字段都是"可直接比较"的：
   *   avgMs     平均总耗时            —— 慢的模型一眼能看出来
   *   avgTtft   平均首字延迟          —— 用户感知的"反应快不快"
   *   emptyRate 空回复率              —— 推理吃光 token 的典型症状
   *   failRate  失败率                —— 限流/不可用
   *
   * 按调用次数降序；UI 可以让用户按任意列排。
   */
  modelStats() {
    const out = []
    for (const [model, v] of Object.entries(this.byModel)) {
      const provs = Object.entries(this.byProvider)
        .filter(([, pv]) => pv.models && pv.models[model])
        .map(([id]) => id)
      out.push({
        model,
        providers: provs,
        calls: v.calls,
        failed: v.failed,
        failRate: v.calls ? round4(v.failed / v.calls) : 0,
        avgMs: v.calls ? Math.round((v.msSum || 0) / v.calls) : null,
        lastMs: v.lastMs || null,
        avgTtft: v.ttftN ? Math.round(v.ttftSum / v.ttftN) : null,
        reasonChars: v.reasonChars || 0,
        textChars: v.textChars || 0,
        emptyText: v.emptyText || 0,
        emptyRate: v.calls ? round4((v.emptyText || 0) / v.calls) : 0,
        lastError: v.lastError ?? null,
        lastAt: v.lastAt ?? null,
      })
    }
    return out.sort((a, b) => b.calls - a.calls)
  }
}

function round4(n) {
  return Math.round((Number(n) || 0) * 1e4) / 1e4
}

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6
}
