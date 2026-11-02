/**
 * 路由策略 —— 把面板上那个下拉翻译成**路由真正用的开关**。
 *
 * ## 为什么要有这个模块
 *
 * 面板上一直有个「路由策略」下拉，三个选项：
 * ```
 * free-first   免费渠道优先，全失败才走付费兜底
 * free-only    只用免费渠道
 * self-only    只用自备渠道
 * ```
 * 但 2026-11-02 查下来：**它根本没接线** ——
 * `resolveCandidates()` 和 bridge 的 `_candidates()` 读的是
 * `freeProviders / freeOrder / selfModels / catalog / fallback / disabledProviders`，
 * **没有一个读 `strategy`**。
 *
 * `strategy` 的去向只有两处，都在界面里：
 *   · `assets.js` 决定哪个按钮高亮
 *   · `assets.js` 决定要不要显示一条"渠道可用率偏低"的横幅
 * 外加 `/health` 把它原样回显。**也就是说：点它什么都不会变。**
 *
 * ## 而且它的前提也没了
 * 2026-11-02 把 DSH 的渠道包（那 14 个免费渠道）整个拆掉之后，
 * 「免费渠道」这个**类别**已经不存在了。现在的两类是：
 *   · **自备渠道** —— 手填的 / DSH 自动发现的（magpie）/ 本地端点
 *   · **内置官方** —— 凭据里的 `DEEPSEEK_API_KEY`，是**付费**的
 *
 * 所以这里重新定义三个策略，并且**真的接到开关上**。
 *
 * ## 真实存在的两个旋钮
 * 路由那一侧只有两个开关有实际效果：
 *   ① `fallback.enabled` —— 官方那条兜底用不用
 *   ② `disabledProviders` —— 哪些渠道排除在外
 *
 * 三个策略就是这两个开关的三种组合，没有别的。
 */

/** 三个策略的**名字**（配置里存的值）。 */
export const STRATEGIES = ['self-first', 'self-only', 'official-only']

/** 旧取值 → 新取值。老配置里还写着 free-first / free-only。 */
const LEGACY = {
  'free-first': 'self-first',
  'free-only': 'self-only',
  /*
   * `self-only` 本身保留（含义没变：只用自备）。
   *
   * ⚠️ 顺带一个发现：拆掉免费渠道之后，`free-only` 和 `self-only`
   *    **变成了同一个意思**（都没有"免费渠道"了）。
   *    所以旧配置里的 `free-only` 直接归到 `self-only`。
   */
}

/**
 * 把配置里的值规整成三个合法策略之一。
 *
 * @param {unknown} v 配置里读出来的值（可能是老的 free-first）
 * @returns {'self-first'|'self-only'|'official-only'}
 */
export function normalizeStrategy(v) {
  const s = String(v ?? '').trim()
  if (STRATEGIES.includes(s)) return s
  if (LEGACY[s]) return LEGACY[s]
  return 'self-first'
}

/**
 * 按策略推导出**路由真正用的开关**。
 *
 * ⚠️ 这里**只算，不改配置** —— 用户的 `disabledProviders` 是他的显式设置，
 *    不该被一个下拉悄悄改写。所以"要额外排除谁"是**算出来的临时值**，
 *    传进路由时用，不落盘。
 *
 * @param {unknown} strategy 面板上的取值（可以带旧的）
 * @param {object} ctx
 * @param {boolean} [ctx.fallbackEnabled] 配置里 `gateway.fallback.enabled`
 * @param {string[]} [ctx.disabled] 配置里 `gateway.disabledProviders`
 * @param {string[]} [ctx.providers] 已知的全部 provider id
 * @param {string} [ctx.officialId] 内置官方那条的 id（通常是 deepseek-official）
 * @returns {{strategy:string, fallbackEnabled:boolean, disabled:string[], why:string}}
 */
export function deriveRouting(strategy, ctx = {}) {
  const s = normalizeStrategy(strategy)
  const configuredFallback = ctx.fallbackEnabled !== false
  const disabled = Array.isArray(ctx.disabled) ? [...ctx.disabled] : []
  const providers = Array.isArray(ctx.providers) ? ctx.providers : []
  const officialId = ctx.officialId || 'deepseek-official'

  if (s === 'self-only') {
    /*
     * 只用自备：**两种机制都要关**。
     *
     * ⚠️ 这是实测踩出来的：官方那条（`deepseek-official`）现在同时存在于
     *    **两个地方**，只关一个不够：
     *      ① `gateway.fallback` —— router 的"付费兜底"分支（老机制）
     *      ② **渠道列表**（`llm.providers`）—— 2026-11-02 起它作为一条
     *         普通渠道挂进 `allChannels`，所以 bridge 的 auto 也能选到它
     *
     *    只关 ① 的话，`self-only` 名义上"不用官方"，实际照样会被 ② 选中 ——
     *    一个**看起来生效、其实没生效**的开关，正是这次要修的那类毛病。
     *
     * 所以：关 fallback **并且**把官方 id 加进排除名单。
     */
    const extra = officialId && providers.includes(officialId) && !disabled.includes(officialId)
      ? [officialId]
      : []
    return {
      strategy: s,
      fallbackEnabled: false,
      disabled: [...disabled, ...extra],
      why: '只用自备渠道：官方兜底关闭（完全不花官方额度）',
    }
  }

  if (s === 'official-only') {
    /*
     * 只用官方：把**所有不是官方的**渠道排除掉。
     *
     * ⚠️ 这里必须"算"，不能写进配置 ——
     *    否则用户切回别的策略时，那份排除名单还留在他配置里，渠道会莫名其妙消失。
     *    （这正是我一开始想避免的做法，写在这里免得后人改回去。）
     */
    const extra = providers.filter((p) => p && p !== officialId && !disabled.includes(p))
    return {
      strategy: s,
      fallbackEnabled: true,
      disabled: [...disabled, ...extra],
      why: `只用内置官方（临时排除 ${extra.length} 个自备渠道；不改你的配置）`,
    }
  }

  // self-first（默认）
  return {
    strategy: s,
    fallbackEnabled: configuredFallback,
    disabled,
    why: configuredFallback
      ? '自备渠道优先，全挂了才走官方兜底'
      : '自备渠道优先（官方兜底被单独关掉了）',
  }
}

/** 给人看的一句话说明（界面下拉用）。 */
export function describeStrategy(v) {
  switch (normalizeStrategy(v)) {
    case 'self-only':
      return '只用自备渠道 —— 完全不碰官方额度，全挂了就报错'
    case 'official-only':
      return '只用内置官方 —— 想固定用 DeepSeek 官方时选'
    default:
      return '自备渠道优先，全失败才走官方兜底 —— 最省钱'
  }
}