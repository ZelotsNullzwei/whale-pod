/**
 * 生图链路回归测试（2026-11-06 三阶段验收）。
 *
 * 对应用户给的验收表，分三层：
 *   第 1 层 消息不丢 —— 意图/配额/发送都不许让整轮沉默
 *   第 2 层 图片能发 —— 纯图、附加图、跨群结果真实
 *   第 3 层 状态与限流 —— 确认、拒绝、主图+附加图总数
 *
 * ⚠️ 不依赖真实生图 API、不依赖真实 QQ：
 *   · 纯函数直接调（classifyDrawIntent / pickPrivateCover / buildOutgoingSegments）
 *   · 类方法用 Object.create(prototype) 挂最小依赖
 *   · 流程级保证用源码断言（改坏结构会立刻失败）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  QQBridge, classifyDrawIntent, pickPrivateCover, buildOutgoingSegments,
  PIC_REQUEST_PHRASES, PIC_REFUSE_PHRASES,
} from '../src/qq/bridge.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

/** 最小 bridge：只装被测方法要的东西 */
function makeBridge(onebot, actions = {}) {
  const b = Object.create(QQBridge.prototype)
  b.cfg = { reply: { maxChars: 500, segment: false }, actions }
  b.log = { info: () => {}, warn: () => {}, debug: () => {} }
  b.onebot = onebot
  b.stats = { replied: 0, failed: 0, silent: 0 }
  return b
}

function mockOnebot({ imageFails = false } = {}) {
  const calls = []
  let n = 1
  const respond = (payload) => {
    const isImage = Array.isArray(payload) && payload.some((s) => s?.type === 'image')
    calls.push({ isImage, payload })
    if (isImage && imageFails) return { status: 'failed', retcode: 1, wording: 'image fail' }
    return { status: 'ok', retcode: 0, data: { message_id: n++ } }
  }
  return { calls, sendGroup: async (_g, p) => respond(p), sendPrivate: async (_u, p) => respond(p) }
}

// ══════════════════════════════════════════════════════════════
console.log('\n【第 3 层】意图判断：普通聊天不许触发生图')
// ══════════════════════════════════════════════════════════════
await ok('★「我在看剧」不触发', () => {
  assert.equal(classifyDrawIntent('我在看剧').wantsPic, false)
})
await ok('★「这个图真好笑」不触发', () => {
  assert.equal(classifyDrawIntent('这个图真好笑').wantsPic, false)
})
await ok('「看到了一只猫」不触发', () => {
  assert.equal(classifyDrawIntent('看到了一只猫').wantsPic, false)
})
await ok('「快递到了」不触发（上一版加「快」就中）', () => {
  assert.equal(classifyDrawIntent('快递到了').wantsPic, false)
})
await ok('「还没吃饭呢」不触发（上一版加「还没」就中）', () => {
  assert.equal(classifyDrawIntent('还没吃饭呢').wantsPic, false)
})
await ok('「拍一张」触发', () => {
  assert.equal(classifyDrawIntent('拍一张').wantsPic, true)
})
await ok('「群里发个图」触发', () => {
  assert.equal(classifyDrawIntent('群里发个图').wantsPic, true)
})
await ok('「看看你」触发（看必须带对象）', () => {
  assert.equal(classifyDrawIntent('看看你').wantsPic, true)
})

console.log('\n【第 3 层】拒绝判断')
await ok('「不用了」= 拒绝', () => {
  assert.equal(classifyDrawIntent('不用了').saidNo, true)
})
await ok('「别拍了」= 拒绝', () => {
  assert.equal(classifyDrawIntent('别拍了').saidNo, true)
})
await ok('★「算了，还是拍一张吧」= 请求不是拒绝', () => {
  const r = classifyDrawIntent('算了，还是拍一张吧')
  assert.equal(r.wantsPic, true)
  assert.equal(r.saidNo, false)
})
await ok('「算了不拍」= 拒绝', () => {
  assert.equal(classifyDrawIntent('算了不拍').saidNo, true)
})
await ok('空消息两个都不命中', () => {
  assert.deepEqual(classifyDrawIntent(''), { wantsPic: false, saidNo: false })
})
await ok('「？」两个都不命中（不能算要拍）', () => {
  const r = classifyDrawIntent('？')
  assert.equal(r.wantsPic, false)
  assert.equal(r.saidNo, false)
})
await ok('★ 短语表里没有单字词（防止退回旧写法）', () => {
  for (const p of PIC_REQUEST_PHRASES) {
    assert.ok(p.length >= 2, `要图表混入单字：${p}`)
  }
  for (const p of PIC_REFUSE_PHRASES) {
    // 拒绝表允许两字（「别拍」），但绝不能收单字「算」「别」
    assert.ok(p.length >= 2, `拒绝表混入单字：${p}`)
  }
})

// ══════════════════════════════════════════════════════════════
console.log('\n【第 3 层】配额：主图和附加图同一套')
// ══════════════════════════════════════════════════════════════
await ok('★ 同描述第二次被去重拦住', () => {
  const b = makeBridge(mockOnebot())
  assert.equal(b._drawQuotaCheck('private:1', '对镜自拍全身').ok, true)
  b._drawQuotaCommit('private:1', '对镜自拍全身')
  assert.equal(b._drawQuotaCheck('private:1', '对镜自拍全身').ok, false)
})
await ok('★ 换描述但超次数上限也要拦住（附加图逃不掉）', () => {
  const b = makeBridge(mockOnebot(), { drawMaxPerWindow: 2, drawWindowMs: 60_000 })
  b._drawQuotaCommit('private:1', 'A')
  b._drawQuotaCommit('private:1', 'B')
  assert.equal(b._drawQuotaCheck('private:1', 'C').ok, false)
})
await ok('不同会话互相隔离', () => {
  const b = makeBridge(mockOnebot(), { drawMaxPerWindow: 1, drawWindowMs: 60_000 })
  b._drawQuotaCommit('private:1', 'A')
  assert.equal(b._drawQuotaCheck('private:1', 'B').ok, false)
  assert.equal(b._drawQuotaCheck('group:9', 'A').ok, true)
})
await ok('上限设 0 = 不限（和其他开关约定一致）', () => {
  const b = makeBridge(mockOnebot(), { drawMaxPerWindow: 0, drawDupMs: 0 })
  b._drawQuotaCommit('private:1', 'A')
  b._drawQuotaCommit('private:1', 'A')
  assert.equal(b._drawQuotaCheck('private:1', 'A').ok, true)
})

// ══════════════════════════════════════════════════════════════
console.log('\n【第 1 层】消息不丢')
// ══════════════════════════════════════════════════════════════
await ok('★ shot.skip 不再从 _handle 返回（只跳过这张图）', () => {
  assert.ok(!/if \(shot\.skip\) \{\r?\n[^\n]*\r?\n[^\n]*return/.test(SRC), 'shot.skip 分支里不该有 return')
  assert.match(SRC, /break drawMain/)
})
await ok('★ 附加图循环每张都查配额（不再绕过限流）', () => {
  const iLoop = SRC.indexOf('const extras = Array.isArray(msg.__extraMarks)')
  assert.ok(iLoop > 0)
  const body = SRC.slice(iLoop, iLoop + 4000)
  assert.match(body, /_drawQuotaCheck/)
  assert.match(body, /_drawQuotaCommit/)
})
await ok('正文为空 + 有图 → 图发出去（不丢）', async () => {
  const ob = mockOnebot()
  const b = makeBridge(ob)
  const ids = await b._send({ kind: 'private', userId: '1', scope: 'p:1' }, '', 'base64://A')
  assert.equal(ids.length, 1)
  assert.equal(ob.calls[0].isImage, true)
})
await ok('正文为空 + 无图 → 不发空消息', async () => {
  const ob = mockOnebot()
  const b = makeBridge(ob)
  const ids = await b._send({ kind: 'private', userId: '1', scope: 'p:1' }, '', null)
  assert.equal(ob.calls.length, 0)
  assert.deepEqual(ids, [])
})
await ok('★ 图发失败 + 有正文 → 正文照发（部分成功）', async () => {
  const ob = mockOnebot({ imageFails: true })
  const b = makeBridge(ob)
  const m = { kind: 'private', userId: '1', scope: 'p:1' }
  await b._send(m, '好，这就发', 'base64://A')
  assert.equal(ob.calls.some((c) => !c.isImage), true, '正文必须发出去')
  assert.equal(m.__lastSend.imageSent, false)
  assert.equal(m.__lastSend.textSent, true)
  assert.equal(m.__lastSend.allRequestedSegmentsSent, false, '应记成部分成功')
})

// ══════════════════════════════════════════════════════════════
console.log('\n【第 2 层】发送结果真实')
// ══════════════════════════════════════════════════════════════
await ok('★ cover 传裸字符串也认（附加图那条路）', () => {
  const segs = buildOutgoingSegments('', 'base64://X')
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, 'image')
})
await ok('跨群：图没发成功不能记「图发群里了」', () => {
  const i = SRC.indexOf('await this._send(msg, String(hit[1]).trim(), cover, target)')
  assert.ok(i > 0, '找不到跨群发送')
  const body = SRC.slice(i, i + 1600)
  assert.match(body, /sent\.imageSent/, '要读真实发送结果')
  assert.match(body, /话发群里了（图没发出去）/, '图失败要说清楚')
  assert.match(body, /crossGroupSkipped = 'send-fail'/, '全失败要标 skipped')
})
await ok('附加图发送失败不写「已发」', () => {
  const i = SRC.indexOf('const extras = Array.isArray(msg.__extraMarks)')
  const body = SRC.slice(i, i + 6000)
  assert.match(body, /__lastSend\?\.imageSent/)
  assert.match(body, /发送失败（不记已发）/)
})
await ok('图进群后私聊不重复带同一张', () => {
  assert.equal(pickPrivateCover({ drawnImage: { url: 'u' }, sentToGroup: true }), null)
  assert.deepEqual(pickPrivateCover({ drawnImage: { url: 'u' }, sentToGroup: false }), { url: 'u' })
})

console.log(`\n${'='.repeat(48)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
