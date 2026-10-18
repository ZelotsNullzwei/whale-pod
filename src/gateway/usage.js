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
  'deepseek-v3': { in: 0.27, out: 1.10 },
  'deepseek-v4': { in: 0.27, out: 1.10 },
  'deepseek-v4.1': { in: 0.27, out: 1.10 },
  'gpt-4o': { in: 2.50, out: 10.00 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'claude-3-5-sonnet': { in: 3.00, out: 15.00 },
  'claude-sonnet-4': { in: 3.00, out: 15.00 },
  'gemini-1.5-pro': { in: 1.25, out: 5.00 },
  'gemini-2.0-flash': { in: 0.10, out: 0.40 },
  'glm-4': { in: 0.10, out: 0.30 },
  'qwen-max': { in: 1.60, out: 6.40 },
}

/** 按模型名找价格（前缀匹配，越长的前缀优先）。 */
export function priceOf(model) {
  const m = String(model ?? '').toLowerCase()
  if (!m) return null
  const keys = Object.keys(PRICES).sort((a, b) => b.length - a.length)
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
  constructor() {
    this.reset()
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
      note: '费用按公开挂牌价估算，免费渠道实际支出为 0',
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
