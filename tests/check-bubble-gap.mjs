/**
 * 气泡之间的停顿（2026-11-08）。
 *
 * 用户两句话定了规则：
 *   ①「没人打字这么快」—— 三条气泡两秒喷完像机器
 *   ②「短的话快，长的肯定慢」—— 停顿按字数算
 *   ③「进入场景了就另说」—— 正戏里短句连发是正常的，不能硬等
 *
 * 守什么：
 * ① 普通节奏按 90ms/字，夹在 [300, 6000]
 * ② 场景内更快（35ms/字，夹在 [200, 1500]），且同样字数一定比普通短
 * ③ `bubbleGapMs = 0` 能整体关掉；给正数就是固定间隔
 * ④ `_send` 里真的用了它，并且把 inScene 传进去了
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
/* 抖动固定成 1.0（_rand=0.5 → 0.85+0.15=1.0），这样数字可断言 */
const fake = { _rand: () => 0.5 }
const gap = (len, reply = {}, opts = {}) => p._bubbleGapMs.call(fake, 'a'.repeat(len), reply, opts)

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 普通节奏：按字数 ===')
ok('★ 越长的气泡等得越久', () => {
  const short = gap(3)
  const mid = gap(10)
  const long = gap(30)
  assert.ok(short < mid, `3字(${short}) 应短于 10字(${mid})`)
  assert.ok(mid < long, `10字(${mid}) 应短于 30字(${long})`)
})
ok('★ 太短的不低于下限 300ms', () => {
  assert.equal(gap(1), 300)
})
ok('★ 太长的封在 6000ms', () => {
  assert.equal(gap(500), 6000)
})

console.log('\n=== 2. 场景内另说 ===')
ok('★ 同样字数，场景内一定更快', () => {
  for (const n of [3, 10, 30, 100]) {
    const normal = gap(n)
    const scene = gap(n, {}, { inScene: true })
    assert.ok(scene < normal, `${n} 字：场景内(${scene}) 应该快于普通(${normal})`)
  }
})
ok('★ 场景内下限 200ms、上限 1500ms', () => {
  assert.equal(gap(1, {}, { inScene: true }), 200)
  assert.equal(gap(500, {}, { inScene: true }), 1500)
})

console.log('\n=== 3. 开关 ===')
ok('★ bubbleGapMs = 0 → 不停顿', () => {
  assert.equal(gap(30, { bubbleGapMs: 0 }), 0)
})
ok('★ 给正数 → 固定间隔', () => {
  assert.equal(gap(3, { bubbleGapMs: 1200 }), 1200)
})

console.log('\n=== 4. 接入点 ===')
ok('★ _send 里调用并把 inScene 传进去', () => {
  const src = String(p._send)
  assert.match(src, /_bubbleGapMs/, '_send 没有调用 _bubbleGapMs')
  assert.match(src, /inScene/, '_send 没有把 inScene 传进去')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
