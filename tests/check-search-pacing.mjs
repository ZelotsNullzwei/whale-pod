/**
 * 搜索节流：**每小时限次**（src/gateway/pacing.js）。
 *
 * ## 这个文件为什么长这样（原来叫"峰谷策略"，被撤了）
 *
 * 用户说「加一个谷·峰期不同的搜索策略，更加省钱」。我照 DeepSeek 官网口径
 * 实现了峰谷，然后**量了一下能省多少**：
 * ```
 * 官网：空闲价 = 高峰价的一半；「Search 每 1,000 次 5元」← ★ 固定价，不分峰谷
 * 231 条真实样本：一次搜索 模型开销 空闲 ¥0.00242 / 高峰 ¥0.00485
 * 搜索接口费 ¥0.0050/次（固定）
 * → 峰谷能省的 ¥0.0024 **不到搜索费的一半** ✗ 方向不成立
 * ```
 * 用户当时两句提醒都对：**「输出价格又不会少」**（输出只占 7.5%）、
 * **「那这是搜索工具价格」**（固定的 ¥0.005 才是主体）。
 *
 * **→ 省钱只有一条路：少搜。** 所以这里不碰时段，只管"一小时搜几次"。
 *
 * ## 本文件锁住的
 * ① 一小时滑窗：同小时内搜满就拦，**一小时后自动释放**
 * ② **被拦下的那次不计数**（拦了但没搜，计数不能涨）
 * ③ `hourlyMax: 0` = **不限**（跟 `maxPerDay` 的约定一致 —— 填 0 不是"一次都不许"）
 * ④ `enabled: false` = 完全不管
 * ⑤ **不依赖本机时区**（已经不判时段了 —— 这条留着防以后手滑加回来）
 */
import assert from 'node:assert/strict'
import { SearchPacing, DEFAULT_HOURLY_MAX } from '../src/gateway/pacing.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const T0 = Date.UTC(2026, 10, 2, 3, 0)   // 固定基准时刻，跟机器时区无关

ok('★ 默认每小时 3 次', () => {
  assert.equal(DEFAULT_HOURLY_MAX, 3)
  const p = new SearchPacing({ now: () => T0 })
  assert.equal(p.allow({}).max, 3, '不配就该用默认 3')
})

ok('★★★ 同一小时搜满 hourlyMax 就拦', () => {
  let t = T0
  const p = new SearchPacing({ now: () => t })
  for (let i = 0; i < 3; i++) {
    assert.equal(p.allow({}).ok, true, `第 ${i + 1} 次该放行`)
    p.note(); t += 60_000
  }
  const r = p.allow({})
  assert.equal(r.ok, false, '★ 第 4 次该被拦')
  assert.equal(r.used, 3, '要如实报"已经 3 次"（日志才好写）')
  assert.equal(r.max, 3)
})

ok('★★ 一小时后自动释放（每条各自滑出去）', () => {
  /*
   * ⚠️ **第一版这条断言我写错了**：三条记录打在 T0 / T0+60s / T0+120s，
   *    而我只等到 `T0 + 3_600_001` —— 距**最后一条**才 59 分钟，窗口里还剩 2 条。
   *    我当时的断言写"该是 0"，于是红了，**看着像滑窗坏了** ✗。
   *    其实那正是"真滑窗"的表现（每条各自到期），旁边那条测试就在证明这件事。
   *    → 要全过期，得从**最后一条**往后数一小时。
   */
  let t = T0
  const p = new SearchPacing({ now: () => t })
  for (let i = 0; i < 3; i++) { p.note(); t += 60_000 }   // T0 / +60s / +120s
  assert.equal(p.allow({}).ok, false, '刚满 3 次，该拦')

  // 从**最后一条**（T0+120s）往后一小时零 1 毫秒 → 三条全滑出去
  const t2 = T0 + 120_000 + 3_600_001
  assert.equal(p.usedThisHour(t2), 0, '从最后一条起满一小时，窗口该空了')
  assert.equal(p.allow({}).ok, true, '★ 空了就该放行')
})

ok('★★ 滑窗是真滑的（不是"整点清零"）', () => {
  /*
   * ⚠️ 这条防的是"按自然小时清零"的实现 —— 那样在 10:59 和 11:01 各搜 3 次
   *    就能在 2 分钟内搜 6 次（跨了个整点就白送额度）。
   */
  let t = T0
  const p = new SearchPacing({ now: () => t })
  p.note(t - 3_500_000)                     // 58 分钟前一次
  p.note(t - 100_000)                       // 100 秒前一次
  p.note(t - 1_000)                         // 1 秒前一次
  assert.equal(p.allow({}).ok, false, '三次都还在这一小时内 → 该拦')
  // 让最早那次滑出去
  const t2 = T0 + 200_000
  assert.equal(p.usedThisHour(t2), 2, '58 分钟前那次该滑出去了')
  assert.equal(p.allow({}).ok, true, '滑出去一个名额就该放行')
})

ok('★★★ 被拦下的那次**不计数**（跟 SearchQuota.take 同一个道理）', () => {
  const t = T0
  const p = new SearchPacing({ now: () => t })
  p.note(); p.note(); p.note()
  assert.equal(p.allow({}).ok, false, '该拦')
  assert.equal(p.usedThisHour(t), 3, '★ 拦了但没搜 —— 计数必须还是 3（不能"问一次就 +1"）')
})

ok('★★ `hourlyMax: 0` = 不限（不是"一次都不许"）', () => {
  const t = T0
  const p = new SearchPacing({ now: () => t })
  for (let i = 0; i < 20; i++) {
    assert.equal(p.allow({ hourlyMax: 0 }).ok, true, `hourlyMax=0 时第 ${i + 1} 次也不该拦`)
    p.note()
  }
})

ok('★★ `enabled:false` 完全不干预', () => {
  const t = T0
  const p = new SearchPacing({ now: () => t })
  for (let i = 0; i < 30; i++) p.note()
  assert.equal(p.allow({ enabled: false }).ok, true, '关掉就该放行')
})

ok('★ 上限可配', () => {
  const t = T0
  const p = new SearchPacing({ now: () => t })
  p.note(); p.note()
  assert.equal(p.allow({ hourlyMax: 5 }).ok, true, '配 5 就该放行')
  assert.equal(p.allow({ hourlyMax: 1 }).ok, false, '配 1 就该拦')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)