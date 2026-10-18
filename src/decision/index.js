/**
 * 决策层装配：按配置创建 provider 并组装降级链。
 *
 * 优先级（配置里 decision.order，默认 rule 单独兜底）：
 *
 *   provider: 'rule'    → [rule]
 *   provider: 'jev'     → [jev, rule]        （jev 失败自动落 rule）
 *   provider: 'custom'  → [custom, rule]
 *   provider: 'auto'    → [jev, custom, rule]（谁配置好了用谁）
 *
 * 设计原则：**永远以 rule 收尾** —— 保证任何异常都有一条零成本安全网。
 */

import { DecisionRegistry } from './provider.js'
import { RuleDecisionProvider } from './rule.js'
import { JevDecisionProvider } from './jev.js'
import { CustomDecisionProvider } from './custom.js'

/**
 * @param {object} cfg 完整的 decision 配置
 * @param {object} [deps]
 * @param {object} [deps.credentials]
 * @param {object} [deps.log]
 * @param {Function} [deps.fetch]
 * @param {Function} [deps.random]  注入随机源（测试用）
 * @returns {DecisionRegistry}
 */
export function createDecisionLayer(cfg = {}, deps = {}) {
  const rule = new RuleDecisionProvider(
    {
      ...(cfg.rule ?? {}),
      // 注意用 !== undefined 而不是 ??：0 是合法值（测试与"不要延迟"场景）
      delayMin: cfg.delay?.min !== undefined ? cfg.delay.min : undefined,
      delayMax: cfg.delay?.max !== undefined ? cfg.delay.max : undefined,
    },
    { random: deps.random },
  )
  const jev = new JevDecisionProvider(cfg.jev ?? {}, deps)
  const custom = new CustomDecisionProvider(cfg.custom ?? {}, deps)

  const registry = new DecisionRegistry({
    order: resolveOrder(cfg),
    fallbackOnError: cfg.fallbackOnError !== false,
    log: deps.log,
  })

  registry.register(rule).register(jev).register(custom)

  // 阈值：probability 低于它就当作"不说"。
  // 放在注册表外面（由调用方决定），因为不同 provider 的概率尺度不同；
  // 这里挂一个便利方法。
  registry.threshold = typeof cfg.threshold === 'number' ? cfg.threshold : 0.5

  /**
   * 便利方法：decide + 阈值过滤 + 延迟建议。
   * 调用方一般只用这个。
   */
  registry.shouldReply = async (input) => {
    const d = await registry.decide(input)
    const threshold = registry.threshold
    const pass = applyThreshold(d, threshold)
    // 延迟：优先用 provider 给的；否则用配置区间随机
    let delayMs = d.delayMs
    if (pass && delayMs === undefined) {
      const lo = cfg.delay?.min ?? 800
      const hi = cfg.delay?.max ?? 3500
      delayMs = Math.round(lo + (deps.random ?? Math.random)() * (hi - lo))
    }
    return { ...d, reply: pass, delayMs: pass ? delayMs : undefined, threshold }
  }

  /** 决策结果的中文摘要（给日志和 Web UI 用）。 */
  registry.explain = (d) => {
    if (!d) return '(无决策)'
    const p = d.probability === undefined ? '?' : d.probability.toFixed(2)
    return `${d.reply ? '发言' : '沉默'} (p=${p}, 来源=${d.provider}${d.reason ? ', ' + d.reason : ''})`
  }

  return registry
}

/**
 * 阈值过滤：把"想不想说"变成"到底说不说"。
 *
 * ⚠️ 阈值的适用范围要分清，否则会出现**自相矛盾**的界面：
 *
 *   · `rule` 这类 provider **自己已经掷过骰子** —— 它返回的 `reply` 就是
 *     最终结论，`probability` 是"回复意愿"（掷骰子之前的权重），不是置信度。
 *     再拿阈值筛一遍 = 二次过滤，界面上就会出现「概率 0.80 … 本次保持沉默」
 *     这种看着像坏了的组合（实测用户就是这么反馈的）。所以它标 `decided:true`，
 *     这里直接采信、不再过阈值。
 *
 *   · `jev` / `custom` 返回的是**软概率**（模型说"我 0.7 想插话"），
 *     这时阈值才有意义 —— 低于它就不说。
 *
 * @param {object} d          provider 的决策结果
 * @param {number} threshold  阈值（0~1）
 * @returns {boolean} 最终是否发言
 */
export function applyThreshold(d, threshold) {
  if (!d?.reply) return false
  if (d.decided === true) return true                 // 已决，直接采信
  if (d.probability === undefined) return true         // 没给概率，按愿意处理
  return d.probability >= threshold
}

/** 按配置决定尝试顺序。 */
function resolveOrder(cfg = {}) {
  const which = String(cfg.provider ?? 'rule').toLowerCase()
  if (which === 'rule') return ['rule']
  if (which === 'jev') return dedupeTail(['jev', 'rule'])
  if (which === 'custom') return dedupeTail(['custom', 'rule'])
  if (which === 'auto') return ['jev', 'custom', 'rule']
  // 未知值：退到最安全
  return ['rule']
}

function dedupeTail(list) {
  return [...new Set(list)]
}
