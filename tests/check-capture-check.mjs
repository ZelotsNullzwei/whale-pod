/**
 * captureCheck 单元测试（mock 底层视觉接口；真实图片测试见离线脚本）
 */
import assert from 'node:assert/strict'
import { reviewNoPhone, reviewNoBodySubject, pickReviewer } from '../src/qq/captureCheck.js'

let pass = 0, fail = 0
async function ok(name, fn) {
  try { await fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}
const BUF = Buffer.alloc(2048, 1)
const mkAsk = (ret) => async () => ret
const throwsAsk = async () => { throw new Error('boom') }

console.log('=== 契约与基本分支 ===')
await ok('pass：无手机 → pass / ok=true / violation=null', async () => {
  const r = await reviewNoPhone({ buf: BUF, ask: mkAsk({ phone_visible: false, why: '无手机', confidence: 0.9 }) })
  assert.equal(r.status, 'pass'); assert.equal(r.ok, true); assert.equal(r.violation, null); assert.equal(r.confidence, 0.9)
})
await ok('violation：有手机 → violation / ok=false / phone_visible', async () => {
  const r = await reviewNoPhone({ buf: BUF, ask: mkAsk({ phone_visible: true, why: '脸侧有手机' }) })
  assert.equal(r.status, 'violation'); assert.equal(r.ok, false); assert.equal(r.violation, 'phone_visible')
})
await ok('uncertain：模型给 null → ok=null（不得静默 pass）', async () => {
  const r = await reviewNoPhone({ buf: BUF, ask: mkAsk({ phone_visible: null, why: '拿不准' }) })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})

console.log('\n=== 空图 / 异常 / 超时 ===')
await ok('空 Buffer → uncertain', async () => {
  const r = await reviewNoPhone({ buf: Buffer.alloc(10), ask: mkAsk({ phone_visible: false }) })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})
await ok('视觉调用抛异常 → uncertain（不得 pass）', async () => {
  const r = await reviewNoPhone({ buf: BUF, ask: throwsAsk })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})
await ok('解析失败（ask 返回 null）→ uncertain', async () => {
  const r = await reviewNoBodySubject({ buf: BUF, ask: mkAsk(null) })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})

console.log('\n=== rear：允许手/前臂、不误判漫画人物 ===')
await ok('只有一只手/前臂 → pass', async () => {
  const r = await reviewNoBodySubject({ buf: BUF, ask: mkAsk({ body_subject: false, why: '只有手', confidence: 0.8 }) })
  assert.equal(r.status, 'pass'); assert.equal(r.ok, true)
})
await ok('漫画/照片里的人物 → pass（不误判为拍摄者）', async () => {
  const r = await reviewNoBodySubject({ buf: BUF, ask: mkAsk({ body_subject: false, why: '漫画人物，非本人' }) })
  assert.equal(r.status, 'pass')
})
await ok('躯干/腿脚入画 → violation/body_subject', async () => {
  const r = await reviewNoBodySubject({ buf: BUF, ask: mkAsk({ body_subject: true, why: '左侧有躯干和腿' }) })
  assert.equal(r.status, 'violation'); assert.equal(r.violation, 'body_subject')
})
await ok('无法区分手臂与躯干 → uncertain', async () => {
  const r = await reviewNoBodySubject({ buf: BUF, ask: mkAsk({ body_subject: null, why: '分不清' }) })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})

console.log('\n=== 隔离与选择 ===')
await ok('两个 reviewer 不互相污染', async () => {
  const [a, b] = await Promise.all([
    reviewNoPhone({ buf: BUF, ask: mkAsk({ phone_visible: true, why: 'x' }) }),
    reviewNoBodySubject({ buf: BUF, ask: mkAsk({ body_subject: false, why: 'y' }) }),
  ])
  assert.equal(a.reviewer, 'no_phone'); assert.equal(a.violation, 'phone_visible')
  assert.equal(b.reviewer, 'no_body_subject'); assert.equal(b.violation, null)
})
await ok('pickReviewer：front→no_phone、rear→no_body、first_person/mirror→null', () => {
  assert.equal(pickReviewer('front_selfie'), reviewNoPhone)
  assert.equal(pickReviewer('rear_selfie'), reviewNoBodySubject)
  assert.equal(pickReviewer('first_person'), null)
  assert.equal(pickReviewer('mirror_selfie'), null)
})
await ok('置信度缺失时为 null（不编造）', async () => {
  const r = await reviewNoPhone({ buf: BUF, ask: mkAsk({ phone_visible: false, why: '' }) })
  assert.equal(r.confidence, null)
})
await ok('ok 与 status 严格对应', async () => {
  for (const [ret, st, okv] of [[{ phone_visible: false }, 'pass', true], [{ phone_visible: true }, 'violation', false], [{ phone_visible: null }, 'uncertain', null]]) {
    const r = await reviewNoPhone({ buf: BUF, ask: mkAsk(ret) })
    assert.equal(r.status, st); assert.equal(r.ok, okv)
  }
})

console.log('\n=== 超时路径（AbortError） ===')
await ok('AbortError（超时）→ uncertain，不得 pass', async () => {
  const abortAsk = async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e }
  const r = await reviewNoPhone({ buf: BUF, ask: abortAsk })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
  const r2 = await reviewNoBodySubject({ buf: BUF, ask: abortAsk })
  assert.equal(r2.status, 'uncertain'); assert.equal(r2.ok, null)
})
await ok('DOMException 形态的 TimeoutError → uncertain', async () => {
  const tAsk = async () => { const e = new Error('TimeoutError'); e.name = 'TimeoutError'; throw e }
  const r = await reviewNoBodySubject({ buf: BUF, ask: tAsk })
  assert.equal(r.status, 'uncertain'); assert.equal(r.ok, null)
})

console.log('\n=== confidence 取值范围 ===')
await ok('合法 0~1 → 透传', async () => {
  for (const v of [0, 0.5, 1]) {
    const r = await reviewNoPhone({ buf: BUF, ask: mkAsk({ phone_visible: false, confidence: v }) })
    assert.equal(r.confidence, v)
  }
})
await ok('越界/非有限 → null', async () => {
  for (const v of [-0.1, 1.01, 2, NaN, Infinity, '0.9', undefined]) {
    const r = await reviewNoPhone({ buf: BUF, ask: mkAsk({ phone_visible: false, confidence: v }) })
    assert.equal(r.confidence, null, '非法值 ' + String(v) + ' 应为 null')
  }
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
