/**
 * 接线编排测试（runCaptureReview）—— 真正验证原图→审核→重拍→选图 的控制流
 * 用假 legacyCheck / captureReviewer / retry 模拟各分支；不依赖网关。
 * 另含 mode 字段真实契约断言（调用真实 planShot，不用假 shot）。
 */
import assert from 'node:assert/strict'
import { runCaptureReview } from '../src/qq/photoCapturePipeline.js'
import { pickReviewer, reviewNoPhone, reviewNoBodySubject } from '../src/qq/captureCheck.js'
import { planShot } from '../src/photo/index.js'

let pass = 0, fail = 0
async function ok(name, fn) {
  try { await fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}
const B = (n = 2048) => Buffer.alloc(n, 1)
const leg = (okv, why = '') => async () => ({ ok: okv, why })
const cap = (status, violation = null) => async () => ({ status, ok: status === 'pass' ? true : (status === 'violation' ? false : null), reviewer: 'x', violation, why: status, confidence: 0.9 })

console.log('=== 编排：重拍决策 ===')
await ok('原图 violation → 调用一次重拍，最终选重拍图', async () => {
  let calls = 0
  const r = await runCaptureReview({
    buf: B(), mode: 'front_selfie', legacyCheck: leg(true),
    captureReviewer: cap('violation', 'phone_visible'),
    retry: async () => { calls++; return B(4096) },
  })
  assert.equal(calls, 1)
  assert.equal(r.retried, true)
  assert.equal(r.finalChoice, 'retry')
  assert.equal(r.finalBuf.length, 4096)
})
await ok('pass → 不重拍', async () => {
  let calls = 0
  const r = await runCaptureReview({ buf: B(), legacyCheck: leg(true), captureReviewer: cap('pass'), retry: async () => { calls++; return B(4096) } })
  assert.equal(calls, 0); assert.equal(r.retried, false); assert.equal(r.finalChoice, 'original')
})
await ok('uncertain → 不重拍', async () => {
  let calls = 0
  const r = await runCaptureReview({ buf: B(), legacyCheck: leg(true), captureReviewer: cap('uncertain'), retry: async () => { calls++; return B(4096) } })
  assert.equal(calls, 0); assert.equal(r.finalChoice, 'original')
})
await ok('旧审核不合格 → 重拍', async () => {
  let calls = 0
  const r = await runCaptureReview({ buf: B(), legacyCheck: leg(false, '多手'), captureReviewer: cap('pass'), retry: async () => { calls++; return B(4096) } })
  assert.equal(calls, 1); assert.equal(r.finalChoice, 'retry')
})

console.log('\n=== 编排：重拍失败保留原图 ===')
await ok('重拍返回 null（生成/下载/处理失败）→ 保留原图', async () => {
  const orig = B(2048)
  const r = await runCaptureReview({ buf: orig, legacyCheck: leg(true), captureReviewer: cap('violation'), retry: async () => null })
  assert.equal(r.retried, false); assert.equal(r.finalChoice, 'original'); assert.equal(r.finalBuf, orig)
})
await ok('重拍抛异常 → 保留原图', async () => {
  const orig = B(2048)
  const r = await runCaptureReview({ buf: orig, legacyCheck: leg(true), captureReviewer: cap('violation'), retry: async () => { throw new Error('boom') } })
  assert.equal(r.retried, false); assert.equal(r.finalBuf, orig)
})
await ok('重拍图过小（<1024）→ 视为失败，保留原图', async () => {
  const orig = B(2048)
  const r = await runCaptureReview({ buf: orig, legacyCheck: leg(true), captureReviewer: cap('violation'), retry: async () => B(10) })
  assert.equal(r.retried, false); assert.equal(r.finalBuf, orig)
})

console.log('\n=== 编排：异常隔离（评审重点） ===')
await ok('旧审核已判违规 + Capture 抛异常 → 仍重拍（异常不得覆盖 legacy）', async () => {
  let calls = 0
  const r = await runCaptureReview({
    buf: B(), legacyCheck: leg(false, '多手'),
    captureReviewer: async () => { throw new Error('capture boom') },
    retry: async () => { calls++; return B(4096) },
  })
  assert.equal(r.qcFirst.legacy.ok, false, 'legacy 违规必须保留')
  assert.equal(r.qcFirst.capture.status, 'uncertain', 'capture 异常转 uncertain')
  assert.equal(calls, 1, '应触发重拍')
})
await ok('Capture 判违规 + 旧审核抛异常 → 仍重拍（legacy 放行不覆盖 capture）', async () => {
  let calls = 0
  const r = await runCaptureReview({
    buf: B(), legacyCheck: async () => { throw new Error('legacy boom') },
    captureReviewer: cap('violation', 'body_subject'),
    retry: async () => { calls++; return B(4096) },
  })
  assert.equal(r.qcFirst.legacy.ok, true, '旧审核异常按放行')
  assert.equal(r.qcFirst.capture.status, 'violation')
  assert.equal(calls, 1)
})

console.log('\n=== 编排：重拍后复审只记录 ===')
await ok('重拍图仍 violation → 不二次重拍，仍用重拍图', async () => {
  let calls = 0
  const r = await runCaptureReview({
    buf: B(), legacyCheck: leg(true), captureReviewer: cap('violation', 'phone_visible'),
    retry: async () => { calls++; return B(4096) },
  })
  assert.equal(calls, 1, '最多一次重拍')
  assert.equal(r.finalChoice, 'retry')
  assert.ok(r.qcRetry && r.qcRetry.capture.status === 'violation')
})
await ok('reviewEnabled=false → 不检查、不重拍', async () => {
  let calls = 0
  const r = await runCaptureReview({ buf: B(), reviewEnabled: false, legacyCheck: leg(false), captureReviewer: cap('violation'), retry: async () => { calls++; return B(4096) } })
  assert.equal(calls, 0); assert.equal(r.finalChoice, 'original')
})
await ok('finalBuf 与最终写入缓存的对象一致（同一引用）', async () => {
  const retryBuf = B(4096)
  const r = await runCaptureReview({ buf: B(), legacyCheck: leg(true), captureReviewer: cap('violation'), retry: async () => retryBuf })
  assert.equal(r.finalBuf, retryBuf, '调用方写入的应是同一个 buffer')
})
await ok('无审核器（captureReviewer=null）+ 旧审核通过 → 不重拍', async () => {
  let calls = 0
  const r = await runCaptureReview({ buf: B(), legacyCheck: leg(true), captureReviewer: null, retry: async () => { calls++; return B(4096) } })
  assert.equal(calls, 0)
})

console.log('\n=== mode 契约：真实 planShot 返回 + pickReviewer ===')
const baseCfg = {}
const shotMode = (scene, extra = {}) => planShot({ scene, slot: 'evening', outfit: '浅灰吊带+短裤', hair: '披发', scope: 'mode:' + Math.random(), imageCfg: baseCfg, ...extra })
await ok('前置自拍 → shot.plan.mode=front_selfie 且选中 reviewNoPhone', async () => {
  const s = shotMode('前置自拍，自然笑一下')
  assert.equal(s.plan.mode, 'front_selfie')
  assert.equal(pickReviewer(s.plan.mode), reviewNoPhone)
})
await ok('对镜自拍 → mirror_selfie 且不启用专项 reviewer', async () => {
  const s = shotMode('对镜全身自拍，站在衣柜前')
  assert.equal(s.plan.mode, 'mirror_selfie')
  assert.equal(pickReviewer(s.plan.mode), null)
})
await ok('后置拍物 → rear_selfie 且选中 reviewNoBodySubject', async () => {
  const s = shotMode('把漫画拍给你看')
  assert.equal(s.plan.mode, 'rear_selfie')
  assert.equal(pickReviewer(s.plan.mode), reviewNoBodySubject)
})
await ok('第一人称 → first_person 且不启用专项 reviewer', async () => {
  const s = shotMode('第一人称 端着杯子喝水')
  assert.equal(s.plan.mode, 'first_person')
  assert.equal(pickReviewer(s.plan.mode), null)
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
