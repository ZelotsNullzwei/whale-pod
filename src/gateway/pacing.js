/**
 * 搜索节流：**每小时限次**。
 *
 * ## 这个文件原来是"峰谷策略"，被我撤掉了 —— 理由记在这儿，免得以后重走
 *
 * 起因是用户说「可以加一个谷·峰期不同的搜索策略，更加省钱」。
 * 我照 DeepSeek 官网的口径实现了峰谷（周末/工作日 9-12、14-18），
 * 然后**量了一下能省多少**：
 * ```
 * 官网 pricing 页（2026-11-03 抓）：
 *   (2) 空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
 *       9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日
 *       全天均为空闲时段。
 *   模型价（deepseek-flash，每百万 tokens）：
 *       输入(缓存未命中) 空闲 1元 / 高峰 2元      输出 空闲 4元 / 高峰 8元
 *   「Search  每 1,000 次成功请求  5元」          ← ★ 固定价，**不分峰谷**
 *
 * 231 条真实日志样本：一次搜索  输入 1,863 tokens / 输出 140 tokens
 *   模型开销：空闲 ¥0.00242   高峰 ¥0.00485   （差 ¥0.00242，而且是**上界**）
 *   搜索接口费：¥0.0050/次（固定）
 *
 * → **峰谷能省的 ¥0.0024 不到搜索费的一半**，方向不成立 ✗
 * ```
 *
 * ★ 用户当时两句提醒都对：
 *   · 「输出价格又不会少」     —— 输出只占 7.5%，峰谷对它是"减半"，绝对值才 ¥0.0006
 *   · 「那这是搜索工具价格」   —— **¥0.005 的固定费才是主体**，而它不分峰谷
 *
 * **结论：要省钱只有一条路 —— 少搜。跟峰谷无关。**
 * 所以这个文件改成只管"每小时搜几次"，**不碰时段**（也就没有时区/周末/节假日那堆坑）。
 *
 * ## 它跟 `SearchQuota`（每日上限）的分工
 * ```
 * SearchQuota   管"一天最多几次"   落盘，跨重启还在   ← 省钱的总闸
 * SearchPacing  管"一小时最多几次"  内存，重启即清     ← 防"某个小时连搜"
 * ```
 * **两个都要**：日上限是总账，小时上限防的是"判据发疯时一口气搜掉半天的额度"。
 *
 * ## 为什么小时限次不落盘
 * 它是**短期节流**，判的是一小时内的突发。重启后从头计完全可以接受 ——
 * 而"总量"那条线由 `SearchQuota` 落盘兜着，所以这里松一点漏不掉钱。
 */

/** 默认每小时上限。 */
export const DEFAULT_HOURLY_MAX = 3

/**
 * 一小时滑动窗口的搜索限次器。
 *
 * 只做一件事：**同一小时内搜满 `hourlyMax` 次之后，拦住后面的**。
 */
export class SearchPacing {
  /**
   * @param {object} [opts]
   * @param {(lv:string,msg:string)=>void} [opts.log]
   * @param {() => number} [opts.now]  注入时钟（测试要确定性）
   */
  constructor(opts = {}) {
    this.log = opts.log ?? null
    this._now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    /** 最近一小时内每次搜索的时刻 */
    this.hits = []
  }

  /** 清掉一小时前的记录。 */
  _trim(now) {
    const cut = now - 3_600_000
    if (this.hits.length && this.hits[0] < cut) this.hits = this.hits.filter((x) => x >= cut)
  }

  /** 这一小时已经搜了几次。 */
  usedThisHour(now = this._now()) {
    this._trim(now)
    return this.hits.length
  }

  /**
   * 现在能不能搜。
   *
   * @param {object} [cfg] `qq.search.pacing`
   * @param {boolean} [cfg.enabled]      默认 true；false = 完全不干预
   * @param {number}  [cfg.hourlyMax]    每小时上限，默认 3
   * @returns {{ok:boolean, used:number, max:number}}
   */
  allow(cfg = {}) {
    const now = this._now()
    /*
     * ⚠️ **不能用 `Number(x) || 默认值`** —— `0 || 3` 得 3，于是"填 0 = 不限"这条约定
     *    会被静默吞掉（写成 0 反而变成"每小时 3 次"，比不填还严）。
     *    这是经典的 `||` / `??` 陷阱，测试逮到过。
     */
    const raw = cfg?.hourlyMax
    const max = (raw === undefined || raw === null || raw === '')
      ? DEFAULT_HOURLY_MAX
      : Number(raw)
    const used = this.usedThisHour(now)
    if (cfg?.enabled === false) return { ok: true, used, max }
    // max <= 0 视为不限（跟 `maxPerDay` 的约定一致：填 0 = 不限，不是"一次都不许"）
    if (!Number.isFinite(max) || max <= 0) return { ok: true, used, max: 0 }
    return { ok: used < max, used, max }
  }

  /** **搜索真的发生了**才记 —— 被拦下的那次不该计数（跟 `SearchQuota.take()` 同一个道理）。 */
  note(now = this._now()) {
    this.hits.push(now)
    this._trim(now)
    return this.hits.length
  }
}