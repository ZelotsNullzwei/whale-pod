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
import { ModelDecisionProvider } from './model.js'

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

  // 模型自主判断 —— 让模型看上下文回答 reply/wait/stop，
  // 而不是靠 rule.js 那套概率打分。用哪个模型由 cfg.model.model 决定。
  const model = new ModelDecisionProvider(cfg.model ?? {}, deps)

  const registry = new DecisionRegistry({
    order: resolveOrder(cfg),
    fallbackOnError: cfg.fallbackOnError !== false,
    log: deps.log,
  })

  registry.register(rule).register(jev).register(custom).register(model)

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
    /*
     * 延迟：优先用 provider 给的；否则**按这条消息有多难**挑档位
     * （2026-10-30 加）。
     *
     * 用户的两句话：
     *   · 「真人回消息不会每次都一样的时间」
     *   · 「简单的就快速回，稍微难一点的就思考一点」
     *
     * 原来只有一个区间（800~3500 均匀随机）—— 实测 60 次「决策→发出」
     * 全挤在 2~10 秒，**一次 <2 秒都没有**，这就是机械感的来源。
     * 现在分三档，简单的能秒回、难的真的会"想一下"。
     */
    const tier = gradeDelayTier(input)
    let delayMs = d.delayMs
    if (pass && delayMs === undefined) {
      // 档位配置缺失时退回原区间 —— 老 config.json 里只有 {min,max}，
      // 所以「normal」档和旧行为**逐字节等价**。
      const t = (tier !== 'normal' && cfg.delay?.[tier]) || cfg.delay || {}
      const lo = t.min ?? 800
      const hi = t.max ?? 3500
      delayMs = Math.round(lo + (deps.random ?? Math.random)() * (hi - lo))
    }
    // ⚠️ 把档位带出去 —— 不然改完只能量"总时长"，
    //    分不清是档位没生效还是生成变慢了。
    return { ...d, reply: pass, delayMs: pass ? delayMs : undefined, threshold, delayTier: tier }
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

/**
 * 这条消息「有多难」—— 决定回得多快。
 *
 * ## 用户的原话
 *   · 「真人回消息不会每次都一样的时间」
 *   · 「简单的就快速回，稍微难一点的就思考一点」
 *
 * ## 为什么需要它
 * 原来只有一个区间（800~3500 均匀随机）。实测 60 次「决策→发出」：
 * ```
 * 最小 2.0s  中位 5.1s  最大 9.8s
 * <2 秒: 0/60      ← 一次都没有
 * >15 秒: 0
 * ```
 * 全挤在 2~10 秒 —— 这就是"每次都差不多"的机械感来源。
 *
 * ## 判据全是**免费的**
 * 不额外调模型，只看这条消息的文字特征。
 *
 * ⚠️ 决策发生在**联网搜索之前**，所以这里拿不到"要不要搜"的信息，
 *    只能从文字推（问句数量、疑问词、长度）。
 *
 * ⚠️ 这只是"回得多快"的一半 —— 另一半是 `bridge.js` 的**合并窗口**
 *    （先等对方把话说完）。两者配合才是用户要的效果：
 *    等他打完 → 简单的马上接、难的想一下。
 *
 * @param {object} input 决策层输入（`messages` 是最近的对话）
 * @returns {'easy'|'normal'|'hard'}
 */
export function gradeDelayTier(input) {
  const msgs = Array.isArray(input?.messages) ? input.messages : []
  const last = msgs[msgs.length - 1]
  const text = String(last?.text ?? '').trim()
  // 去掉媒体标记再数 —— 「[表情包]」不算"内容多"
  const bare = text
    .replace(/\[(表情包(?::[^\]]*)?|表情:\d+|图片|SILENT)\]/g, '')
    .trim()
  const len = bare.length

  /*
   * ⚠️ **纯标点/空的先判掉**（「？」「？？？」「……」）。
   *
   * 第一版没这一步，于是「？？？」被下面的 `asks >= 2` 判成 hard ——
   * 可它明显是"最简单的那种回复"，该秒回。
   * 问号多 ≠ 问题难：一串问号只是"人呢？"。
   */
  const PUNCT_ONLY = /^[？?！!。.…~、，,\s]+$/
  if (bare === '' || PUNCT_ONLY.test(bare)) return 'easy'

  const asks = (bare.match(/[？?]/g) ?? []).length

  /*
   * ⚠️ **先判"难"，再判"简单"**（顺序是有意的）。
   *
   * 第一版写反了：`len <= 6 → easy` 放在前面，于是「为什么会这样」（6 字）
   * 被判成 easy —— **短句永远走不到"难"那一支**。
   * 短不等于简单：「为啥」「怎么办」就是要想一下的。
   *
   * ⚠️ 也别把裸「怎么」放进来：「怎么了」只是问"发生什么了"，
   *    那该**快**回。所以只收「怎么办 / 怎么弄 / 怎么搞」这种求助形态，
   *    再加「怎么回事」/「咋回事」这种"要解释"的。
   */
  const HARD =
    /(为什么|为啥|怎么回事|咋回事|怎么会|怎么办|怎么弄|怎么搞|如何|是不是|真的吗|你觉得|解释|讲讲|说说|有什么(区别|不同)|哪个好|推荐|帮我|值得|应该选)/
  if (asks >= 2 || HARD.test(bare) || len >= 60) return 'hard'

  // ── 简单：极短、单纯的招呼 ───────────────────────────────
  const SIMPLE = /^(哈+|嗯+|哦+|啊+|咦+|诶+|在吗|在不在|早|晚安|早上好|晚上好|你好)$/
  if (len <= 6 || SIMPLE.test(bare)) return 'easy'

  return 'normal'
}

/** 按配置决定尝试顺序。 */
function resolveOrder(cfg = {}) {
  const which = String(cfg.provider ?? 'rule').toLowerCase()
  if (which === 'rule') return ['rule']
  if (which === 'jev') return dedupeTail(['jev', 'rule'])
  if (which === 'custom') return dedupeTail(['custom', 'rule'])
  // 模型自主判断：先问模型，模型挂了/解析失败就落回 rule
  if (which === 'model') return dedupeTail(['model', 'rule'])
  if (which === 'auto') return ['model', 'jev', 'custom', 'rule']
  // 未知值：退到最安全
  return ['rule']
}

function dedupeTail(list) {
  return [...new Set(list)]
}
