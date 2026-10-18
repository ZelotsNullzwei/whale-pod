/**
 * Jev 决策者（TypeSafe AI 的 System One）—— **可选**。
 *
 * ## 什么是 Jev
 *
 * Jev 是 TypeSafe AI 的「System One」决策模型：**非生成式**，
 * 输入状态、输出结构化判断 + 概率。它不做对话，只做判断。
 *
 * 典型用法（社区里的共识）：
 *   > jev 决定该不该说话，LLM 决定说什么
 *
 * ## 成本
 *
 * 社区数据：约 **$0.00002 / 次**（`dsh-jev-interceptor` README）。
 * 按群聊每天 500 次判断算，约 ¥0.07/天 ≈ **¥2/月**。
 * 所以它是「活人感」里最便宜的一块，但仍是付费项 —— 因此做成开关。
 *
 * ## 降级
 *
 *   未配置 key   → probe() 返回 ok:false，注册表直接跳过
 *   超时/报错    → 抛错，注册表自动降到下一层（rule）
 *
 * ## 关于 API 形状
 *
 * ⚠️ 这里按社区插件的公开描述实现「HTTP 调用 + 结构化结果」。
 * 真实端点和鉴权方式以 TypeSafe 官方文档为准（docs.typesafe.ai）；
 * 若与官方不符，改 `_buildRequest` / `_parseResponse` 两个方法即可，
 * 上层逻辑不用动。
 */

import { DecisionProvider } from './provider.js'

export class JevDecisionProvider extends DecisionProvider {
  id = 'jev'
  label = 'Jev（TypeSafe System One，付费）'
  /** 约 $0.00002 ≈ ¥0.00015 */
  costPerCall = 0.00015

  /**
   * @param {object} cfg  decision.jev 配置
   * @param {object} deps
   * @param {object} deps.credentials   Credentials 实例
   * @param {object} [deps.log]
   * @param {Function} [deps.fetch]     可注入（测试用）
   */
  constructor(cfg = {}, deps = {}) {
    super()
    this.cfg = {
      enabled: cfg.enabled === true,
      baseUrl: cfg.baseUrl ?? 'https://api.typesafe.ai',
      credentialRef: cfg.credentialRef ?? 'TYPESAFE_API_KEY',
      timeoutMs: cfg.timeoutMs ?? 8000,
    }
    this.credentials = deps.credentials
    this.log = deps.log ?? {}
    this.fetchImpl = deps.fetch ?? globalThis.fetch
  }

  /** 取 key（支持直接配置或从凭据层读）。 */
  get key() {
    if (!this.credentials) return ''
    const v = this.credentials.getRaw?.(this.cfg.credentialRef)
    return typeof v === 'string' ? v : ''
  }

  async probe() {
    if (!this.cfg.enabled) return { ok: false, detail: '未启用（decision.jev.enabled = false）' }
    if (!this.key) return { ok: false, detail: `缺少 ${this.cfg.credentialRef}（在 DSH 凭据里配置）` }
    return { ok: true, detail: `已配置（端点 ${this.cfg.baseUrl}，约 ¥${this.costPerCall}/次）` }
  }

  async decide(input) {
    if (!this.cfg.enabled) throw new Error('jev 未启用')
    const key = this.key
    if (!key) throw new Error(`缺少 ${this.cfg.credentialRef}`)

    const { url, init } = this._buildRequest(input, key)
    const t0 = Date.now()

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs)
    let res
    try {
      res = await this.fetchImpl(url, { ...init, signal: ctl.signal })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`jev HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`)
    }

    const json = await res.json()
    const decision = this._parseResponse(json, input)
    decision.raw = json
    decision.cost = this.costPerCall
    this.log.info?.(`jev: reply=${decision.reply} p=${decision.probability} (${Date.now() - t0}ms)`)
    return decision
  }

  /**
   * 构造请求。
   *
   * 设计成「一次批量评估」的形状 —— Jev 的强项是结构化打分，
   * 我们只问一个问题：「此刻该不该在群里说话？给个概率」。
   */
  _buildRequest(input, key) {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}/v1/evaluate`
    const body = {
      task: 'should-reply',
      context: {
        scene: input.scene,
        self: input.self,
        sinceMyLastMessageMs: Number.isFinite(input.sinceMyLastMessage) ? input.sinceMyLastMessage : null,
        consecutiveTurns: input.consecutiveTurns,
        // 只给最近的上下文，控制成本
        messages: (input.messages ?? []).slice(-12).map((m) => ({
          sender: m.senderName ?? m.sender,
          text: m.text,
          at: m.at,
          mentionsMe: Boolean(m.mentionsMe),
          isMe: Boolean(m.isMe),
        })),
      },
      // 让 Jev 在候选里打分（它擅长在选项间比较）
      candidates: [
        { id: 'reply', label: '现在应该发言' },
        { id: 'silent', label: '现在不该发言' },
      ],
      options: { returnProbability: true },
    }
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
      },
    }
  }

  /**
   * 解析响应。
   *
   * 兼容几种可能形状（官方 schema 未公开稳定）：
   *   { choice: 'reply', probability: 0.8 }
   *   { choices: [{id:'reply', probability:0.8}, ...] }
   *   { decision: 'reply', confidence: 0.8 }
   */
  _parseResponse(json, _input) {
    let choice = json?.choice ?? json?.decision ?? null
    let probability = json?.probability ?? json?.confidence ?? null

    if (!choice && Array.isArray(json?.choices) && json.choices.length > 0) {
      const best = json.choices.reduce((a, b) => ((b.probability ?? b.score ?? 0) > (a.probability ?? a.score ?? 0) ? b : a))
      choice = best.id ?? best.label ?? null
      probability = best.probability ?? best.score ?? null
    }

    if (choice == null) {
      throw new Error(`jev 返回无法解析：${JSON.stringify(json).slice(0, 200)}`)
    }

    const reply = choice === 'reply' || choice === true || choice === 'yes'
    return {
      // ⚠️ 这里**不设 `decided`** —— jev 给的是软概率（模型说"我 0.7 想插话"），
      //    外层 shouldReply 会用 decision.threshold 再筛一道，这才是阈值
      //    该起作用的地方。对比 rule.js：那个自己掷过骰子，所以标了 decided。
      reply,
      probability: typeof probability === 'number' ? probability : (reply ? 0.7 : 0.3),
      reason: `Jev: ${choice}`,
      // Jev 不返回延迟建议，由调用方按人格设定
    }
  }
}
