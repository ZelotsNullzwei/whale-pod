/**
 * 手部门禁：shouldBlockSend 语义 + runCaptureReview.block + 缓存/发送不发生
 */
import assert from 'node:assert/strict'
import { shouldBlockSend, runCaptureReview } from '../src/qq/photoCapturePipeline.js'

let pass = 0, fail = 0
async function ok(name, fn) { try { await fn(); console.log('  OK  ' + name); pass++ } catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ } }
const B = (n = 2048) => Buffer.alloc(n, 1)

console.log('=== shouldBlockSend ===')
ok('fatal 手部违规（初审）→ block', () => {
  assert.equal(shouldBlockSend({ capture: { status: 'violation', violation: 'extra_hands', severity: 'fatal' } }).block, true)
})
ok('复审致命违规 → block', () => {
  assert.equal(shouldBlockSend({ capture: { status: 'pass' }, retryCapture: { status: 'violation', violation: 'hand_mismatch', severity: 'fatal' } }).block, true)
})
ok('legacy 不合格不算严重（不再一律阻断）', () => {
  assert.equal(shouldBlockSend({ legacy: { ok: false, why: '多手' } }).block, false)
})
ok('rear_selfie body_subject fatal → 阻断', () => {
  const r = shouldBlockSend({ capture: { status: 'violation', violation: 'body_subject', severity: 'fatal' } })
  assert.equal(r.block, true)
  assert.match(r.reason, /body_subject/)
})
ok('phone_visible 仍按原策略不在结构门禁阻断', () => {
  assert.equal(shouldBlockSend({ capture: { status: 'violation', violation: 'phone_visible' } }).block, false)
})
ok('审核不可用（reviewSkipped）→ block', () => {
  assert.equal(shouldBlockSend({ reviewSkipped: true }).block, true)
})

console.log('\n=== runCaptureReview.block + 缓存/发送不发生 ===')
async function pipeline(opts) {
  const store = { cache: 0, send: 0 }
  const sel = await runCaptureReview({
    buf: B(8192), mode: 'rear_selfie', requireReview: true, failClosed: opts.failClosed === true,
    shrink: async () => B(4096),
    legacyCheck: opts.legacy ?? (async () => ({ ok: true, why: '' })),
    captureReviewer: opts.capture,
    retry: opts.retry ?? (async () => B(8192)),
    log: {},
  })
  if (!sel.block) { store.cache++; store.send++ }
  return { sel, store }
}

await ok('初审 fatal → 重拍成功且复审 pass → 不阻断、写缓存并发送（用重拍图）', async () => {
  let n = 0
  const { sel, store } = await pipeline({
    capture: async () => (n++ === 0 ? { status: 'violation', violation: 'extra_hands', severity: 'fatal', why: '2 手' } : { status: 'pass', why: 'ok' }),
  })
  assert.equal(sel.block, false); assert.equal(sel.finalChoice, 'retry')
  assert.deepEqual(store, { cache: 1, send: 1 })
})
await ok('初审 fatal + 复审仍 fatal → block，缓存/发送均不发生', async () => {
  const { sel, store } = await pipeline({ capture: async () => ({ status: 'violation', violation: 'hand_anatomy', severity: 'fatal', why: '结构异常' }) })
  assert.equal(sel.block, true)
  assert.match(String(sel.reason), /hand_anatomy/)
  assert.deepEqual(store, { cache: 0, send: 0 })
})
await ok('rear_selfie body_subject 初审违规、复审通过 → 放行复审图', async () => {
  let n = 0
  const { sel, store } = await pipeline({ capture: async () => n++ === 0
    ? { status: 'violation', violation: 'body_subject', severity: 'fatal', why: '出现肩膀' }
    : { status: 'pass', why: '只见手和物品' } })
  assert.equal(sel.block, false)
  assert.equal(sel.finalChoice, 'retry')
  assert.deepEqual(store, { cache: 1, send: 1 })
})
await ok('rear_selfie body_subject 复审仍违规 → 阻断缓存与发送', async () => {
  const { sel, store } = await pipeline({ capture: async () => ({ status: 'violation', violation: 'body_subject', severity: 'fatal', why: '出现躯干' }) })
  assert.equal(sel.block, true)
  assert.match(sel.reason, /body_subject/)
  assert.deepEqual(store, { cache: 0, send: 0 })
})
await ok('初审 fatal + 重拍失败 → block（无更优图）', async () => {
  const { sel, store } = await pipeline({
    capture: async () => ({ status: 'violation', violation: 'extra_hands', severity: 'fatal' }),
    retry: async () => null,
  })
  assert.equal(sel.block, true); assert.deepEqual(store, { cache: 0, send: 0 })
})
await ok('普通 uncertain（信息不足、非服务错误）→ 不阻断，按放行发送原图', async () => {
  const { sel, store } = await pipeline({ capture: async () => ({ status: 'uncertain', why: '手部信息不足', serviceError: false }) })
  assert.equal(sel.block, false); assert.deepEqual(store, { cache: 1, send: 1 })
})
await ok('审核服务异常（requireReview）→ fail closed，block', async () => {
  const { sel, store } = await pipeline({ capture: async () => ({ status: 'uncertain', why: '视觉服务异常', serviceError: true }), failClosed: true })
  assert.equal(sel.block, true); assert.deepEqual(store, { cache: 0, send: 0 })
})
await ok('无审核器 + requireReview → reviewSkipped 阻断', async () => {
  const { sel, store } = await pipeline({ capture: null, failClosed: true })
  assert.equal(sel.block, true); assert.deepEqual(store, { cache: 0, send: 0 })
})
await ok('审核服务异常 + 默认（failClosed=false）→ 降级放行：照发、记录 degraded', async () => {
  const { sel, store } = await pipeline({ capture: async () => ({ status: 'uncertain', why: '视觉识别失败（两次）', serviceError: true }) })
  assert.equal(sel.block, false)
  assert.equal(sel.degraded, true)
  assert.deepEqual(store, { cache: 1, send: 1 })
})
await ok('requireReview=false（手部门禁关闭）→ fatal 也不阻断', async () => {
  const sel = await runCaptureReview({
    buf: B(8192), mode: 'rear_selfie', requireReview: false,
    shrink: async () => B(4096),
    legacyCheck: async () => ({ ok: true, why: '' }),
    captureReviewer: async () => ({ status: 'violation', violation: 'extra_hands', severity: 'fatal' }),
    retry: async () => B(8192), log: {},
  })
  assert.equal(sel.block, false)
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
