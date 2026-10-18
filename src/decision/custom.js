/**
 * 自定义决策者：把判断交给用户自己的 HTTP 服务。
 *
 * 用途：
 *   - 用户想用别的决策模型（自训练的分类器、别的厂商的 API）
 *   - 用户想接规则引擎（Drools 之类）
 *   - 本地跑个小模型做「该不该说话」
 *
 * 协议（WhalePod → 用户服务）：
 *   POST <url>
 *   Authorization: Bearer <token>   （token 为空则不带）
 *   { scene, self, messages, sinceMyLastMessageMs, consecutiveTurns }
 *
 * 期望响应（宽松解析）：
 *   { reply: true, probability: 0.8, reason: '...', delayMs: 1200 }
 *   或 { decision: 'reply'|'silent', confidence: 0.8 }
 */

import { DecisionProvider } from './provider.js'

export class CustomDecisionProvider extends DecisionProvider {
  id = 'custom'
  label = '自定义 HTTP 决策服务'

  constructor(cfg = {}, deps = {}) {
    super()
    this.cfg = {
      enabled: cfg.enabled === true,
      url: cfg.url ?? '',
      token: cfg.token ?? '',
      timeoutMs: cfg.timeoutMs ?? 8000,
    }
    this.log = deps.log ?? {}
    this.fetchImpl = deps.fetch ?? globalThis.fetch
  }

  async probe() {
    if (!this.cfg.enabled) return { ok: false, detail: '未启用（decision.custom.enabled = false）' }
    if (!this.cfg.url) return { ok: false, detail: '未配置 url' }
    return { ok: true, detail: `已配置：${this.cfg.url}` }
  }

  async decide(input) {
    if (!this.cfg.enabled) throw new Error('custom 未启用')
    if (!this.cfg.url) throw new Error('custom 未配置 url')

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs)
    let res
    try {
      res = await this.fetchImpl(this.cfg.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify({
          scene: input.scene,
          self: input.self,
          sinceMyLastMessageMs: Number.isFinite(input.sinceMyLastMessage) ? input.sinceMyLastMessage : null,
          consecutiveTurns: input.consecutiveTurns,
          messages: (input.messages ?? []).slice(-12),
        }),
        signal: ctl.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`custom HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`)
    }
    const json = await res.json()
    return this._parse(json)
  }

  _parse(json) {
    let reply = json?.reply
    let probability = json?.probability ?? json?.confidence

    if (typeof reply !== 'boolean') {
      const d = String(json?.decision ?? json?.choice ?? '').toLowerCase()
      if (d === 'reply' || d === 'yes' || d === 'true') reply = true
      else if (d === 'silent' || d === 'no' || d === 'false') reply = false
      else throw new Error(`custom 返回无法解析：${JSON.stringify(json).slice(0, 200)}`)
    }

    return {
      reply,
      probability: typeof probability === 'number' ? probability : (reply ? 0.7 : 0.3),
      reason: json?.reason ?? 'custom provider',
      delayMs: typeof json?.delayMs === 'number' ? json.delayMs : undefined,
      cost: typeof json?.cost === 'number' ? json.cost : undefined,
      raw: json,
    }
  }
}
