/**
 * reviewHands（手部结构审核）+ combineCaptureResults（结果合并）
 */
import assert from 'node:assert/strict'
import { reviewHands, combineCaptureResults } from '../src/qq/captureCheck.js'

let pass = 0, fail = 0
async function ok(name, fn) { try { await fn(); console.log('  OK  ' + name); pass++ } catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ } }
const BUF = Buffer.alloc(2048, 1)
const ask = (ret) => async () => ret

console.log('=== reviewHands ===')
await ok('1 手 1 臂、左右正常、结构正常 → pass', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 1, ask: ask({ hands: 1, arms: 1, same_side: false, anatomy_ok: true, why: 'ok', confidence: 0.9 }) })
  assert.equal(r.status, 'pass'); assert.equal(r.ok, true); assert.equal(r.violation, null)
})
await ok('2 手 > 允许 1 → violation/extra_hands/fatal', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 1, ask: ask({ hands: 2, arms: 2, same_side: false, anatomy_ok: true }) })
  assert.equal(r.status, 'violation'); assert.equal(r.violation, 'extra_hands'); assert.equal(r.severity, 'fatal'); assert.equal(r.ok, false)
})
await ok('手臂 3 条 → violation/limb_count/fatal', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 1, ask: ask({ hands: 2, arms: 3, same_side: false, anatomy_ok: true }) })
  assert.equal(r.violation, 'limb_count'); assert.equal(r.severity, 'fatal')
})
await ok('两只同侧手 → violation/hand_mismatch/fatal', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 2, ask: ask({ hands: 2, arms: 2, same_side: true, anatomy_ok: true, why: '两只都是左手' }) })
  assert.equal(r.violation, 'hand_mismatch'); assert.equal(r.severity, 'fatal')
})
await ok('解剖异常（拇指/腕）→ violation/hand_anatomy/fatal', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 1, ask: ask({ hands: 1, arms: 1, same_side: false, anatomy_ok: false }) })
  assert.equal(r.violation, 'hand_anatomy'); assert.equal(r.severity, 'fatal')
})
await ok('same_side=null → uncertain', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 2, ask: ask({ hands: 2, arms: 2, same_side: null, anatomy_ok: true }) })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})
await ok('空图 → uncertain', async () => {
  const r = await reviewHands({ buf: Buffer.alloc(10), maxVisibleHands: 1, ask: ask({ hands: 0, arms: 0 }) })
  assert.equal(r.status, 'uncertain')
})
await ok('视觉异常 → uncertain（绝不 pass）', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 1, ask: async () => { throw new Error('boom') } })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})

console.log('\n=== combineCaptureResults ===')
await ok('fatal 优先于普通 violation', async () => {
  const c = combineCaptureResults([
    { status: 'violation', violation: 'body_subject', severity: 'normal', reviewer: 'no_body_subject', why: 'x' },
    { status: 'violation', violation: 'extra_hands', severity: 'fatal', reviewer: 'hands', why: 'y' },
  ])
  assert.equal(c.violation, 'extra_hands'); assert.equal(c.severity, 'fatal')
})
await ok('有 violation 时不被 uncertain 覆盖', async () => {
  const c = combineCaptureResults([
    { status: 'uncertain', reviewer: 'hands', why: 'u' },
    { status: 'violation', violation: 'phone_visible', severity: 'normal', reviewer: 'no_phone', why: 'p' },
  ])
  assert.equal(c.status, 'violation'); assert.equal(c.violation, 'phone_visible')
})
await ok('无 violation、有 uncertain → uncertain', async () => {
  const c = combineCaptureResults([{ status: 'pass', reviewer: 'a' }, { status: 'uncertain', reviewer: 'hands', why: 'u' }])
  assert.equal(c.status, 'uncertain'); assert.equal(c.ok, null)
})
await ok('全 pass → pass', async () => {
  const c = combineCaptureResults([{ status: 'pass', reviewer: 'a', why: 'ok' }, { status: 'pass', reviewer: 'hands', why: 'ok' }])
  assert.equal(c.status, 'pass'); assert.equal(c.ok, true)
})
await ok('空列表 → null', async () => { assert.equal(combineCaptureResults([]), null) })

console.log('\n=== 对镜自拍：持机手 + 一只自然手 ===')
await ok('对镜自拍：2 手在 max=2 下通过（左右各一、结构正常）', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 2, ask: ask({ hands: 2, arms: 2, same_side: false, anatomy_ok: true, why: '一手持机一手垂放', confidence: 0.95 }) })
  assert.equal(r.status, 'pass'); assert.equal(r.ok, true); assert.equal(r.violation, null)
})
await ok('对镜自拍：3 手在 max=2 下 → violation/extra_hands/fatal', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 2, ask: ask({ hands: 3, arms: 2, same_side: false, anatomy_ok: true }) })
  assert.equal(r.status, 'violation'); assert.equal(r.violation, 'extra_hands'); assert.equal(r.severity, 'fatal')
})
await ok('对镜自拍：2 手同侧 → violation/hand_mismatch', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 2, ask: ask({ hands: 2, arms: 2, same_side: true, anatomy_ok: true }) })
  assert.equal(r.violation, 'hand_mismatch')
})
await ok('对镜自拍：2 手但左右无法判断（same_side=null）→ uncertain（不冒充通过）', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 2, ask: ask({ hands: 2, arms: 2, same_side: null, anatomy_ok: true }) })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})

console.log('\n=== 服务错误 vs 模型拿不准（fail-closed 依据）===')
await ok('三次解析都失败 → uncertain 且 serviceError=true', async () => {
  let calls = 0
  const askNull = async () => { calls++; return null }
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 1, ask: askNull })
  assert.equal(r.status, 'uncertain'); assert.equal(r.serviceError, true); assert.equal(calls, 3, '应重试两次')
})
await ok('第一次失败、第二次成功 → 用第二次结果（重试生效）', async () => {
  let calls = 0
  const askSeq = async () => (++calls === 1 ? null : { hands: 1, arms: 1, same_side: false, anatomy_ok: true, why: 'ok', confidence: 0.9 })
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 1, ask: askSeq })
  assert.equal(r.status, 'pass'); assert.equal(calls, 2)
})
await ok('JSON 正常但字段 null（模型拿不准）→ uncertain 且 serviceError=false', async () => {
  const r = await reviewHands({ buf: BUF, maxVisibleHands: 2, ask: ask({ hands: 2, arms: 2, same_side: null, anatomy_ok: true }) })
  assert.equal(r.status, 'uncertain'); assert.equal(r.serviceError, false)
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
