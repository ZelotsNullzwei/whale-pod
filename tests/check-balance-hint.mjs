/**
 * 「余额低」提示词片段测试（2026-10-28）。
 *
 * 用户原话：「要饭感觉今天触发很多次了」。
 *
 * 真因：提示词里那段「钱包只剩 ¥X」的提醒，本意是「最多提一次」，
 * 但用来防重复的 `_balanceWarned` **只被赋值、从没被判断** ——
 * 于是余额一旦低于阈值，**每一次生成**都挂着这句话，
 * 它每条回复都在念叨钱包。
 *
 * 注意：真正的「讨钱」（发一条 @某人 的讨钱消息）一次都没发过，
 * 用户看到的复读全部来自这段提示词。
 */
import assert from 'node:assert/strict'
import { buildBalanceHint } from '../src/qq/balanceHint.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

ok('余额不低 → 不挂提示', () => {
  assert.equal(buildBalanceHint({ low: false, warned: false, cny: 1.5 }), '')
})

ok('余额低但已经提醒过 → 闭嘴（这就是「要饭很多次」的修法）', () => {
  assert.equal(buildBalanceHint({ low: true, warned: true, cny: 1.5 }), '')
})

ok('余额低 + 还没提醒 → 挂一次，且带上金额', () => {
  const s = buildBalanceHint({ low: true, warned: false, cny: 1.54 })
  assert.ok(s.includes('1.54'), `应带金额，实际：${s.slice(0, 80)}`)
  assert.ok(s.includes('Token'), '应提到 Token')
})

ok('金额缺失 → 用 0，不出现 NaN', () => {
  const s = buildBalanceHint({ low: true, warned: false })
  assert.ok(!s.includes('NaN'), s.slice(0, 80))
  assert.ok(s.includes('¥0'))
})

ok('文案不再说「最多提一两次」（避免诱导它反复提）', () => {
  const s = buildBalanceHint({ low: true, warned: false, cny: 2 })
  assert.ok(s.includes('只说这一次'), '应明确只说一次')
})

// ── 模拟多轮：只在第一轮出现 ──────────────────────────────
ok('模拟 5 轮余额持续偏低：只有第 1 轮挂提示', () => {
  // 复刻 bridge 里的用法：先算 hint（用旧 warned），再更新 warned
  let warned = false
  const low = true
  const hits = []
  for (let i = 0; i < 5; i++) {
    hits.push(buildBalanceHint({ low, warned, cny: 1.5 }) !== '')
    warned = low             // 对应 `this._balanceWarned = this._balanceLow`
  }
  assert.deepEqual(hits, [true, false, false, false, false], `实际：${JSON.stringify(hits)}`)
})

ok('余额恢复后再降低 → 可以再提一次', () => {
  let warned = false
  const step = (low) => {
    const h = buildBalanceHint({ low, warned, cny: 1.5 }) !== ''
    warned = low
    return h
  }
  assert.equal(step(true), true, '第一次低 → 提')
  assert.equal(step(true), false, '持续低 → 不提')
  assert.equal(step(false), false, '恢复了 → 不提，并重置 warned')
  assert.equal(step(true), true, '再次变低 → 可以再提一次')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)