/**
 * 路由策略**真的接线了**（2026-11-02）。
 *
 * ## 背景：它原来是装饰
 * 面板上一直有个「路由策略」下拉（free-first / free-only / self-only），
 * 但查下来 **没有任何人读它** —— `resolveCandidates()` 和 bridge 的
 * `_candidates()` 读的是 freeProviders / freeOrder / selfModels / catalog /
 * fallback / disabledProviders，**没有一个读 strategy**。
 * 它的去向只有：按钮高亮、一条横幅、`/health` 里原样回显。
 * **点它什么都不会变。**
 *
 * 而且前提也没了：DSH 渠道包（14 个免费渠道）已整个拆掉 →
 * 「免费渠道」这个类别不存在了 → free-only 和 self-only 变成同一个意思。
 *
 * ## 现在
 * 三个策略由 `deriveRouting()` 翻译成路由真正用的两个开关：
 *   fallback.enabled（官方兜底开不开）+ 要额外排除哪些渠道
 *
 * ⚠️ **排除名单是算出来的临时值，不写回配置** ——
 *    否则用户切回别的策略时那份名单还留在他配置里，渠道会莫名消失。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeStrategy, deriveRouting, STRATEGIES } from '../src/gateway/strategy.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const CTX = {
  fallbackEnabled: true,
  disabled: ['手填禁用的'],
  providers: ['magpie', 'deepseek-official', 'ollama'],
  officialId: 'deepseek-official',
}

// ── 1. 老取值要能归一 ─────────────────────────────────────────
ok('★ 老配置的 free-first / free-only 自动归一', () => {
  assert.equal(normalizeStrategy('free-first'), 'self-first')
  assert.equal(normalizeStrategy('free-only'), 'self-only')
  assert.equal(normalizeStrategy('self-first'), 'self-first')
  assert.equal(normalizeStrategy('official-only'), 'official-only')
  assert.equal(normalizeStrategy(undefined), 'self-first', '空值退回默认')
  assert.equal(normalizeStrategy('乱写的'), 'self-first', '不认识的值退回默认，别崩')
})

// ── 2. 三个策略各自推导出什么 ──────────────────────────────────
ok('★ self-first：保留配置里的 fallback 开关，不动排除名单', () => {
  const r = deriveRouting('self-first', CTX)
  assert.equal(r.fallbackEnabled, true)
  assert.deepEqual(r.disabled, ['手填禁用的'], '不该额外排除任何人')
})

ok('★ self-only：关掉官方兜底 **并且**把官方排出去', () => {
  const r = deriveRouting('self-only', CTX)
  assert.equal(r.fallbackEnabled, false, '官方兜底要关')
  /*
   * ⚠️ 这是实测踩出来的：官方那条**同时存在于两个地方** ——
   *    ① gateway.fallback（router 的老机制）
   *    ② **渠道列表**（2026-11-02 起它作为普通渠道挂进 allChannels）
   *    只关 ① 的话，self-only 名义上"不用官方"，实际照样会被 ② 选中 ——
   *    一个看着生效、其实没生效的开关。所以两个都要管。
   */
  assert.ok(r.disabled.includes('deepseek-official'), '官方那条也要排出去（它现在是普通渠道）')
  assert.ok(r.disabled.includes('手填禁用的'), '用户自己的排除名单要保留')
})

ok('★ official-only：把**所有非官方**的排出去，且不改配置', () => {
  const r = deriveRouting('official-only', CTX)
  assert.equal(r.fallbackEnabled, true)
  assert.ok(r.disabled.includes('magpie'), 'magpie 要被临时排除')
  assert.ok(r.disabled.includes('ollama'), 'ollama 要被临时排除')
  assert.ok(!r.disabled.includes('deepseek-official'), '官方自己不能被排')
  assert.ok(r.disabled.includes('手填禁用的'), '用户自己的排除名单要保留')
  // 不写回配置 —— 这里只是返回值，检查原 ctx 没被改
  assert.deepEqual(CTX.disabled, ['手填禁用的'], '不能改到调用方传进来的数组')
})

ok('★ 未知策略退回 self-first（别因为一个错值把渠道全禁了）', () => {
  const r = deriveRouting('瞎写', CTX)
  assert.equal(r.strategy, 'self-first')
  assert.deepEqual(r.disabled, ['手填禁用的'])
})

ok(`三个策略名：${STRATEGIES.join(' / ')}`, () => {
  assert.deepEqual(STRATEGIES, ['self-first', 'self-only', 'official-only'])
})

// ── 3. ★★ 源码锁：真的接到路由上了吗 ───────────────────────────
ok('★★ bridge 的 _candidates 必须调 deriveRouting（原来它只认 disabledProviders）', () => {
  const src = read('src/qq/bridge.js')
  const at = src.indexOf('_candidates()')
  assert.ok(at > 0)
  const end = src.indexOf('\n  }\n', at)
  const body = src.slice(at, end > at ? end : at + 4000)
  assert.match(body, /deriveRouting\(/, '要调 deriveRouting')
  assert.match(body, /routing\.disabled/, '排除名单要用推导出来的那份')
  assert.match(body, /routing\.fallbackEnabled/, 'fallback 开关要用推导出来的那个')
})

ok('★★ 网关那条路也要接（/v1/chat/completions 的 auto 解析）', () => {
  const src = read('src/gateway/server.js')
  const at = src.indexOf('resolveCandidates(requestedModel')
  assert.ok(at > 0, '要有 resolveCandidates 调用')
  const seg = src.slice(Math.max(0, at - 700), at + 700)
  assert.match(seg, /deriveRouting\(/, '要调 deriveRouting')
  assert.match(seg, /disabledProviders: routing\.disabled/)
  assert.match(seg, /enabled: routing\.fallbackEnabled/)
})

ok('★★ strategy 必须从配置传到 bridge（原来根本没传）', () => {
  const src = read('src/index.js')
  const at = src.indexOf('new QQBridge(')
  assert.ok(at > 0)
  const seg = src.slice(at, at + 2500)
  assert.match(seg, /strategy: cfg\.gateway\?\.strategy/, 'bridge 的 cfg 里要有 strategy')
})

ok('★ 界面上是新的三个选项（老的两个已经没有意义了）', () => {
  const a = read('src/web/assets.js')
  assert.match(a, /'self-first':\s*'自备渠道优先/, '要有 self-first 的说明')
  assert.match(a, /'self-only':\s*'只用自备渠道/, '要有 self-only 的说明')
  assert.match(a, /'official-only':\s*'只用内置官方/, '要有 official-only 的说明')
  assert.match(a, /data-strat=/, '按钮仍走 data-strat')
})

ok('★ 配置默认值是 self-first（不是老的 free-first）', () => {
  const s = read('src/config/store.js')
  assert.match(s, /strategy:\s*'self-first'/, '默认值要更新')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)