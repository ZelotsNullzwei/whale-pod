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

console.log('\n=== 编排：审核缩图共用（缩放回归） ===')
await ok('旧审核与 Capture 收到同一份缩图（引用相同，且不是原图）', async () => {
  const orig = B(8192)
  const small = B(2048)
  let shrinkCalls = 0
  const seen = []
  const r = await runCaptureReview({
    buf: orig,
    shrink: async () => { shrinkCalls++; return small },
    legacyCheck: async (b) => { seen.push(['legacy', b]); return { ok: true, why: '' } },
    captureReviewer: async ({ buf: b }) => { seen.push(['capture', b]); return { status: 'pass', ok: true, violation: null, why: '', confidence: 0.9 } },
    retry: async () => null,
  })
  assert.equal(shrinkCalls, 1, "原图只应缩一次")
  assert.equal(seen.length, 2)
  assert.equal(seen[0][1], small, "旧审核应收到缩图")
  assert.equal(seen[1][1], small, "Capture 应收到同一份缩图")
  assert.notEqual(seen[0][1], orig)
  assert.equal(r.finalBuf, orig, "发送用原图，不受缩图影响")
})
await ok('重拍复审同样使用缩图（缩图被调用两次）', async () => {
  const retryBuf = B(8192)
  const small1 = B(2048)
  const small2 = B(3072)
  const seq = [small1, small2]
  let i = 0
  const seen = []
  const r = await runCaptureReview({
    buf: B(8192),
    shrink: async () => seq[i++],
    legacyCheck: async (b) => { seen.push(b); return { ok: true, why: '' } },
    captureReviewer: async ({ buf: b }) => { seen.push(b); return { status: i === 1 ? 'violation' : 'pass', ok: null, violation: 'phone_visible', why: '', confidence: 0.9 } },
    retry: async () => retryBuf,
  })
  assert.equal(i, 2, "原图与重拍图各缩一次")
  assert.equal(seen[2], small2, "重拍复审应收到缩图2")
  assert.equal(r.finalBuf, retryBuf, "发送用重拍原图（全分辨率）")
})
await ok('缩图失败 → 放行、不重拍、保留原图', async () => {
  const orig = B(2048)
  let retryCalls = 0
  let capCalls = 0
  const r = await runCaptureReview({
    buf: orig,
    shrink: async () => { throw new Error('shrink boom') },
    legacyCheck: async () => ({ ok: false, why: '多手' }),
    captureReviewer: async () => { capCalls++; return { status: 'violation' } },
    retry: async () => { retryCalls++; return B(4096) },
  })
  assert.equal(retryCalls, 0, "缩图失败不应重拍")
  assert.equal(capCalls, 0, "缩图失败不调用 Capture")
  assert.equal(r.qcFirst.legacy.ok, true)
  assert.match(r.qcFirst.legacy.why, /缩图失败放行/)
  assert.equal(r.finalBuf, orig)
})

console.log('\n=== 编排：缩图“返回原图”失败形态（生产真实情况） ===')
await ok('shrink 返回原 Buffer（同一引用）→ 放行、不调审核器、不重拍', async () => {
  const orig = B(8192)
  let leg = 0, cap = 0, retry = 0
  const r = await runCaptureReview({ buf: orig, shrink: async (b) => b,
    legacyCheck: async () => { leg++; return { ok: false, why: 'x' } },
    captureReviewer: async () => { cap++; return { status: 'violation' } },
    retry: async () => { retry++; return B(4096) },
  })
  assert.equal(leg, 0, "不应调用旧审核")
  assert.equal(cap, 0, "不应调用 Capture")
  assert.equal(retry, 0, "不应重拍")
  assert.match(r.qcFirst.legacy.why, /缩图失败放行/)
  assert.equal(r.finalBuf, orig)
})
await ok('shrink 返回空 Buffer → 放行、不调审核器', async () => {
  let leg = 0
  const r = await runCaptureReview({ buf: B(8192), shrink: async () => Buffer.alloc(0), legacyCheck: async () => { leg++; return { ok: false } }, retry: async () => B(4096) })
  assert.equal(leg, 0)
  assert.match(r.qcFirst.legacy.why, /缩图失败放行/)
})
await ok('shrink 返回非 Buffer（undefined）→ 放行', async () => {
  let leg = 0
  const r = await runCaptureReview({ buf: B(8192), shrink: async () => undefined, legacyCheck: async () => { leg++; return { ok: false } } })
  assert.equal(leg, 0)
  assert.match(r.qcFirst.legacy.why, /缩图失败放行/)
})
await ok('shrink 返回更大的 Buffer（未变小）→ 视为不可用', async () => {
  let leg = 0
  const r = await runCaptureReview({ buf: B(2048), shrink: async () => B(4096), legacyCheck: async () => { leg++; return { ok: false } } })
  assert.equal(leg, 0)
  assert.match(r.qcFirst.legacy.why, /缩图失败放行/)
})
await ok('重拍缩图返回原图 → 不把全分辨率交给审核器，仍用重拍图、不二次重拍', async () => {
  const retryBuf = B(8192)
  let i = 0
  let capCalls = 0
  const r = await runCaptureReview({
    buf: B(8192),
    shrink: async (b) => { i++; return i === 1 ? B(2048) : b }, /* 第二次（重拍复审）返回原图 */
    legacyCheck: async () => ({ ok: true, why: '' }),
    captureReviewer: async () => { capCalls++; return { status: i === 1 ? 'violation' : 'pass', ok: null, violation: 'phone_visible' } },
    retry: async () => retryBuf,
  })
  assert.equal(capCalls, 1, "复审不应调用 Capture")
  assert.equal(r.retried, true)
  assert.equal(r.finalChoice, "retry")
  assert.equal(r.finalBuf, retryBuf)
  assert.equal(r.qcRetry.skipped, '复审缩图不可用')
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
