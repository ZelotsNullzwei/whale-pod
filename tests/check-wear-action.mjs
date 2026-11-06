/**
 * 换衣服必须真落地（2026-11-06）。
 *
 * ## 现场（私聊）
 * ```
 * 16:14:50 他「不是说换短女仆吗」
 * 16:15:42 她「换好了，看吧。」        ← wearing.json 还是空的 {}
 * 16:23:53 他「这不是完全没变吗」
 * 16:24:13 她「（一僵）……我光嘴上说，手没动。」
 * ```
 * 根因：换衣服原来**只是画标志性套装时的副作用**，她不画图就永远落不了地。
 *
 * ## 修法
 * ① 独立标记 `[换装:描述]`（别名 `[换衣服:…]`）—— 不画图也生效
 * ② 谎报闸加 `wear`：说「换好了/换上了」但没有 `did.wear` → 重写一次
 *
 * 守什么：
 * - 「还没换」「这就换」「等会换」不算谎报（她明确说了还没做）
 * - 真换了（[换装:] 或画了标志性那套）不拦
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQBridge } from '../src/qq/bridge.js'
import { setWearing, wearingFor, clearWearing } from '../src/memory/wearing.js'

const p = QQBridge.prototype
const claim = (text, did, ctx = '') => p._falseClaim.call({}, text, did, ctx)

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 谎报闸：说了"换好了"但没换 ===')
ok('★ 线上原句「换好了，看吧。」→ 抓到', () => {
  assert.ok(claim('换好了，看吧。', {}))
})

ok('真换了（did.wear）→ 不拦', () => {
  assert.equal(claim('换好了，看吧。', { wear: true }), null)
})

ok('「还没换」「这就换」「等会换」不算谎报', () => {
  for (const t of ['还没换呢，等我一下', '这就换，别催', '等会儿换', '我不换']) {
    assert.equal(claim(t, {}), null, `不该抓：${t}`)
  }
})

ok('「换上了」也算（同一类说法）', () => {
  assert.ok(claim('换上了，你回头看', {}))
})

console.log('\n=== 2. [换装:] 真的写进"今天穿的" ===')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-wear-'))
ok('★ 换装后，wearingFor 立刻能读到（当天有效）', async () => {
  // 用独立数据目录，别动线上那份
  const W = await import(`../src/memory/wearing.js?t=${Date.now()}`)
  W.configureWearState({ home: dir })
  const k = '2026-11-06'
  W.setWearing(k, { text: '短款女仆装', kind: 'custom' })
  const got = W.wearingFor(k, 'afternoon')
  assert.equal(got?.text, '短款女仆装')
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('★ 晚上（睡衣时段）自动让位 → 读不到', async () => {
  const W = await import(`../src/memory/wearing.js?t=${Date.now()}-2`)
  W.configureWearState({ home: dir })
  const k = '2026-11-06'
  W.setWearing(k, { text: '短款女仆装' })
  assert.equal(W.wearingFor(k, 'evening'), null)
  assert.equal(W.wearingFor(k, 'night'), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('第二天自动作废', async () => {
  const W = await import(`../src/memory/wearing.js?t=${Date.now()}-3`)
  W.configureWearState({ home: dir })
  W.setWearing('2026-11-06', { text: '短款女仆装' })
  assert.equal(W.wearingFor('2026-11-07', 'afternoon'), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n=== 3. 提示词里必须教这个标记 ===')
ok('★ 提示词含 [换装:…] 的说明（否则她不会写）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /\[换装:一句话描述\]/)
  assert.match(src, /说了"换好了"就必须写/)
})

ok('★ 源码里真的解析 [换装:…] 和别名 [换衣服:…]', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /换装\|换衣服/)
})

console.log('\n=== 4. 换衣服不再触发画图（用户：「我叫她换他会一直发图」）===')
ok('★ 「换就换，等着」→ 只要求 [换装:]，**不要求**画图', () => {
  const r = claim('换就换，等着', {})
  assert.equal(r?.kind, 'wear', `应该是 wear，实际 ${r?.kind}`)
})

ok('★ 「正在换」也算 wear（不是 draw）', () => {
  const r = claim('正在换，别催', {})
  assert.equal(r?.kind, 'wear')
})

ok('真画图的话「这就拍」仍然要求 draw（这条不能丢）', () => {
  assert.equal(claim('这就拍，等我', {})?.kind, 'draw')
})

ok('★ 提示词明确写"换衣服不要自动配图"', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /换衣服不要自动配图/)
})

console.log('\n=== 5. 画图频率上限（防止一直发图）===')
ok('★ 源码里有按会话的次数闸，且可配', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /drawMaxPerWindow/)
  assert.match(src, /drawWindowMs/)
})

ok('★ 默认上限是有限值（不是 0 = 不限）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /drawMaxPerWindow \?\? 2/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
