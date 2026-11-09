/**
 * photoCapturePipeline 单测（纯函数，mock 图片处理操作）
 */
import assert from 'node:assert/strict'
import { processImage, decideRetry, buildAuditRecord } from '../src/qq/photoCapturePipeline.js'

let pass = 0, fail = 0
async function ok(name, fn) {
  try { await fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}
const BUF = Buffer.alloc(2048, 1)
function recorder() {
  const calls = []
  return {
    calls,
    cropRegion: async (b, a, z) => { calls.push(['cropRegion', a, z]); return b },
    cropBottom: async (b, r) => { calls.push(['cropBottom', r]); return b },
    eraseCornerWatermark: async (b) => { calls.push(['erase']); return b },
  }
}

console.log('=== processImage ===')
await ok('普通图：cropBottom(配置值) + 擦水印', async () => {
  const ops = recorder()
  const r = await processImage(BUF, { shot: { framingInfo: {} }, imgCfg: { cropBottom: 0.1 }, ops })
  assert.equal(r.ok, true)
  assert.deepEqual(ops.calls, [['cropBottom', 0.1], ['erase']])
})
await ok('全身图：cropBottom(0.06) + 擦水印', async () => {
  const ops = recorder()
  const r = await processImage(BUF, { shot: { framingInfo: { feet: true } }, imgCfg: { cropBottom: 0.1 }, ops })
  assert.equal(r.ok, true)
  assert.deepEqual(ops.calls, [['cropBottom', 0.06], ['erase']])
})
await ok('部位特写（腿）：先 cropRegion(0.42,1.0) 再正常裁底', async () => {
  const ops = recorder()
  const r = await processImage(BUF, { shot: { framingInfo: { bodyPart: '腿' } }, imgCfg: { cropBottom: 0.08 }, ops })
  assert.equal(r.ok, true)
  assert.deepEqual(ops.calls, [['cropRegion', 0.42, 1], ['cropBottom', 0.08], ['erase']])
})
await ok('锁骨/胸部不裁（表里没有）', async () => {
  const ops = recorder()
  const r = await processImage(BUF, { shot: { framingInfo: { bodyPart: '胸部' } }, imgCfg: {}, ops })
  assert.equal(r.ok, true)
  assert.equal(ops.calls[0][0], 'cropBottom')
})
await ok('空/过小 → ok:false，不抛', async () => {
  const r = await processImage(Buffer.alloc(10), { shot: {}, imgCfg: {}, ops: recorder() })
  assert.equal(r.ok, false)
  assert.match(r.reason, /过小|空/)
})
await ok('无 ops 也不崩（降级为原样返回）', async () => {
  const r = await processImage(BUF, { shot: { framingInfo: {} }, imgCfg: {}, ops: {} })
  assert.equal(r.ok, true)
  assert.equal(r.buf.length, BUF.length)
})

console.log('\n=== decideRetry ===')
await ok('capture violation → 重拍', async () => {
  const d = decideRetry({ capture: { status: 'violation', violation: 'phone_visible', why: '有手机' } })
  assert.equal(d.retry, true)
  assert.match(d.reasons.join(), /capture:phone_visible/)
})
await ok('capture uncertain → 不重拍', async () => {
  const d = decideRetry({ capture: { status: 'uncertain', why: '看不清' } })
  assert.equal(d.retry, false)
})
await ok('capture pass + 旧审核通过 → 不重拍', async () => {
  const d = decideRetry({ legacyViolation: false, capture: { status: 'pass' } })
  assert.equal(d.retry, false)
})
await ok('旧审核不合格 → 重拍', async () => {
  const d = decideRetry({ legacyViolation: true, legacyWhy: '手脚数量:4 臂' })
  assert.equal(d.retry, true)
  assert.match(d.reasons.join(), /旧审核/)
})
await ok('两者都违规 → 只重拍一次，记录两条原因', async () => {
  const d = decideRetry({ legacyViolation: true, legacyWhy: '多手', capture: { status: 'violation', violation: 'phone_visible' } })
  assert.equal(d.retry, true)
  assert.equal(d.reasons.length, 2)
})
await ok('已重拍过 → 即使 violation 也不再重拍', async () => {
  const d = decideRetry({ capture: { status: 'violation' }, alreadyRetried: true })
  assert.equal(d.retry, false)
})
await ok('无审核器（capture=null）且旧审核通过 → 不重拍', async () => {
  assert.equal(decideRetry({ capture: null, legacyViolation: false }).retry, false)
})

console.log('\n=== buildAuditRecord ===')
await ok('字段齐全且 capture 被裁剪为摘要', async () => {
  const rec = buildAuditRecord({
    scope: 'private:1', mode: 'front_selfie',
    original: { legacy: { ok: false, why: '多手' }, capture: { status: 'violation', violation: 'phone_visible', why: 'x', confidence: 0.9 } },
    retried: true, retry: { legacy: { ok: true, why: '' }, capture: { status: 'pass', why: 'ok', confidence: 0.8 } },
    finalChoice: 'retry', cacheKey: 'drawPrompt', ms: 1234,
  })
  assert.equal(rec.scope, 'private:1')
  assert.equal(rec.mode, 'front_selfie')
  assert.equal(rec.original.capture.status, 'violation')
  assert.equal(rec.original.capture.confidence, 0.9)
  assert.equal(rec.retried, true)
  assert.equal(rec.retry.capture.status, 'pass')
  assert.equal(rec.finalChoice, 'retry')
  assert.equal(rec.cacheKey, 'drawPrompt')
  assert.ok(rec.at)
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
