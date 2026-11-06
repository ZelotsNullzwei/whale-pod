/**
 * 阶段一验收：**消息不能丢**。
 *
 * 用户口径：「先验收消息不丢：shot.skip、生成失败、图片失败，普通文字都必须能发出来。」
 *
 * ## 这一层守四件事
 * ① 正文为空 + 有图 → 图要发（附加图靠这条活下来）
 * ② 正文为空 + 没图 → 不发空消息
 * ③ 有正文 + 图发失败 → 正文照样发出去
 * ④ 只发图不说话了 → 不能整轮丢弃
 *
 * 用 mock 的 onebot，不碰真 QQ、不碰真生图。
 */
import assert from 'node:assert/strict'
import { QQBridge, buildOutgoingSegments } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 造一个假的 onebot：记录每次调用，可控制成败 */
function mockOnebot({ imageFails = false, textFails = false } = {}) {
  const calls = []
  let n = 1
  const respond = (payload) => {
    const isImage = Array.isArray(payload) && payload.some((s) => s?.type === 'image')
    calls.push({ isImage, payload })
    if (isImage && imageFails) return { status: 'failed', retcode: 1, wording: 'image fail' }
    if (!isImage && textFails) return { status: 'failed', retcode: 1, wording: 'text fail' }
    return { status: 'ok', retcode: 0, data: { message_id: n++ } }
  }
  return {
    calls,
    sendGroup: async (_gid, payload) => respond(payload),
    sendPrivate: async (_uid, payload) => respond(payload),
  }
}

/** 造一个最小可用的 bridge（只装 _send 需要的东西） */
function makeBridge(onebot) {
  const b = Object.create(QQBridge.prototype)
  b.cfg = { reply: { maxChars: 500, segment: false } }
  b.log = { info: () => {}, warn: () => {}, debug: () => {} }
  b.onebot = onebot
  b.stats = { replied: 0, failed: 0, silent: 0 }
  return b
}

const privMsg = () => ({ kind: 'private', userId: '10001', scope: 'private:10001' })

console.log('=== 1. 纯图片发送（原来被空正文守卫拦掉）===')
await ok('★ 正文为空 + 有图 → 图能发出去', async () => {
  const ob = mockOnebot()
  const b = makeBridge(ob)
  const m = privMsg()
  const ids = await b._send(m, '', 'base64://AAAA')
  assert.equal(ob.calls.length, 1, '应该发了一条')
  assert.equal(ob.calls[0].isImage, true, '发的应该是图片段')
  assert.equal(ids.length, 1, '要拿到 message_id')
  assert.equal(m.__lastSend?.imageSent, true)
})

await ok('正文为空 + 没有图 → 不发空消息', async () => {
  const ob = mockOnebot()
  const b = makeBridge(ob)
  const ids = await b._send(privMsg(), '', null)
  assert.equal(ob.calls.length, 0, '不该发任何东西')
  assert.deepEqual(ids, [])
})

await ok('只刮掉标记（正文变空）+ 有图 → 仍然发图', async () => {
  const ob = mockOnebot()
  const b = makeBridge(ob)
  const m = privMsg()
  await b._send(m, '[等:5]', 'base64://BBBB')
  assert.equal(ob.calls.length, 1)
  assert.equal(ob.calls[0].isImage, true)
})

console.log('\n=== 2. 图片失败不能拖累正文 ===')
await ok('★ 图发失败 + 有正文 → 正文照发', async () => {
  const ob = mockOnebot({ imageFails: true })
  const b = makeBridge(ob)
  const m = privMsg()
  await b._send(m, '好，这就发', 'base64://CCCC')
  const textSent = ob.calls.some((c) => !c.isImage)
  assert.equal(textSent, true, '正文必须发出去')
  assert.equal(m.__lastSend?.imageSent, false, '图没发成功不能记成功')
  assert.equal(m.__lastSend?.textSent, true)
  assert.equal(m.__lastSend?.allRequestedSegmentsSent, false, '部分成功')
})

await ok('图失败时 failedSegments 要记下来', async () => {
  const ob = mockOnebot({ imageFails: true })
  const b = makeBridge(ob)
  const m = privMsg()
  await b._send(m, '正文', 'base64://DDDD')
  assert.deepEqual(m.__lastSend?.failedSegments, ['image'])
})

console.log('\n=== 3. 真实结果不能靠"调用过"冒充 ===')
await ok('★ 图段失败 → imageSent 必须是 false（不能看 sentIds 非空就当真）', async () => {
  const ob = mockOnebot({ imageFails: true })
  const b = makeBridge(ob)
  const m = privMsg()
  const ids = await b._send(m, '文字', 'base64://EEEE')
  assert.ok(ids.length > 0, '正文确实拿到了 message_id')
  assert.equal(m.__lastSend?.imageSent, false, '但图没发成功')
})

await ok('图和正文都成功 → allRequestedSegmentsSent = true', async () => {
  const ob = mockOnebot()
  const b = makeBridge(ob)
  const m = privMsg()
  await b._send(m, '文字', 'base64://FFFF')
  assert.equal(m.__lastSend?.textSent, true)
  assert.equal(m.__lastSend?.imageSent, true)
  assert.equal(m.__lastSend?.allRequestedSegmentsSent, true)
})

console.log('\n=== 4. 分段/表情仍正常 ===')
await ok('正文为空但有表情段 → 表情照发（不能被空正文守卫吃掉）', async () => {
  const ob = mockOnebot()
  const b = makeBridge(ob)
  const m = privMsg()
  /*
   * ⚠️ `[表情:14]` 走 set_msg_emoji_like 那条路，不走 buildOutgoingSegments；
   *    这里测的是"剥完正文为空、但有可发送段时不能直接返回"这个契约本身 ——
   *    直接用 buildOutgoingSegments 验证。
   */
  const segs = buildOutgoingSegments('[表情:14]', null)
  assert.ok(segs.some((s) => s.kind === 'face'), '表情应该成为一个可发送段')
})

await ok('纯文字正常路径不受影响', async () => {
  const ob = mockOnebot()
  const b = makeBridge(ob)
  const m = privMsg()
  const ids = await b._send(m, '今天好累', null)
  assert.equal(ids.length, 1)
  assert.equal(m.__lastSend?.textSent, true)
  assert.equal(m.__lastSend?.imageSent, false)
})

console.log('\n=== 5. buildOutgoingSegments 的纯图契约 ===')
await ok('★ cover 有图、text 为空 → 只有 image 段', () => {
  const segs = buildOutgoingSegments('', { url: 'base64://X' })
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, 'image')
})

await ok('cover 没图、text 为空 → 一个段都没有', () => {
  assert.deepEqual(buildOutgoingSegments('', null), [])
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
