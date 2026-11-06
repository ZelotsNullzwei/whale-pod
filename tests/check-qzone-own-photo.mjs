/**
 * 发说说时**只带她自己的照片**，绝不把对方的表情包带出去（2026-11-06）。
 *
 * ## 用户原话
 * 「她会把我表情包带出去而不是自己的照片」
 *
 * ## 原来的 bug
 * ```js
 * let imgs = msg.images                                  // 当前这条（对方发的）
 * if (imgs.length < 2) imgs = 最近 8 条里 !isMe 的图      // 还是对方的
 * ```
 * **两条路都只收别人的图**，她自己的照片一条都不看。
 * 于是「发个空间」= 把他的表情包原样贴到她的 QQ 空间 —— 公开动作，发出去收不回。
 *
 * ## 现在的优先级
 * ① `selfPhoto`（这一轮她自己刚生成的那张，bridge 传入）
 * ② 她自己在最近消息里发过的图（`isMe`）
 * ③ 正文里明确要求「这张/刚发的」时才收对方的图
 * ④ 都没有 → **不带图**（宁可纯文字说说，也不能把他的表情包发到她空间）
 */
import assert from 'node:assert/strict'
import { runQQMarkers } from '../src/qq/qqActions.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const mkOnebot = () => {
  const calls = []
  return {
    calls,
    _sendPreferHttp: async (a, p) => { calls.push({ a, p }); return { status: 'ok', retcode: 0, data: { tid: 'T1' } } },
  }
}

/** 跑一次 [说说:…]，返回发给 send_qzone_msg 的 images */
async function run({ arg, msgImages = [], recent = [], selfPhoto = null }) {
  const onebot = mkOnebot()
  await runQQMarkers({
    items: [{ id: 'qzone', arg }],
    onebot,
    msg: { messageId: 'm1', scope: 'private:1', images: msgImages },
    mem: { recent: () => recent },
    selfPhoto,
    log: { info: () => {}, warn: () => {} },
  })
  const call = onebot.calls.find((c) => c.a === 'send_qzone_msg')
  assert.ok(call, '应该调了 send_qzone_msg')
  return call.p.images
}

console.log('=== 1. 只带她自己的 ===')
await ok('★ 她刚生成照片 + 对方发了表情包 → **只带她的**（线上那个 bug）', async () => {
  const imgs = await run({
    arg: '今天天气不错',
    msgImages: ['https://x/user-sticker.jpg'],
    recent: [{ isMe: false, images: ['https://x/user-sticker.jpg'] }],
    selfPhoto: { url: 'base64://SELFPIC' },
  })
  assert.deepEqual(imgs, ['base64://SELFPIC'])
  assert.ok(!JSON.stringify(imgs).includes('user-sticker'), '绝不能带对方的表情包')
})

await ok('她自己最近发过图（isMe）→ 用那张', async () => {
  const imgs = await run({
    arg: '发个空间',
    recent: [
      { isMe: false, images: ['https://x/theirs.jpg'] },
      { isMe: true, images: ['https://x/mine.jpg'] },
    ],
  })
  assert.deepEqual(imgs, ['https://x/mine.jpg'])
})

await ok('selfPhoto 优先于她自己历史里的图', async () => {
  const imgs = await run({
    arg: '发个空间',
    recent: [{ isMe: true, images: ['https://x/old-mine.jpg'] }],
    selfPhoto: { url: 'base64://NEW' },
  })
  assert.deepEqual(imgs, ['base64://NEW'])
})

console.log('\n=== 2. 没有她自己的图时 ===')
await ok('★ 只有对方的表情包、正文也没提 → **不带图**（宁可纯文字）', async () => {
  const imgs = await run({
    arg: '随便说点什么',
    msgImages: ['https://x/sticker.jpg'],
    recent: [{ isMe: false, images: ['https://x/sticker.jpg'] }],
  })
  assert.equal(imgs, undefined, '不该带任何图')
})

await ok('对方明确说「把这张发空间」→ 才收对方那张', async () => {
  const imgs = await run({
    arg: '把这张发空间',
    msgImages: ['https://x/pic.jpg'],
  })
  assert.deepEqual(imgs, ['https://x/pic.jpg'])
})

await ok('「刚才那张」也算明确要求', async () => {
  const imgs = await run({
    arg: '刚才那张发一下空间',
    msgImages: ['https://x/pic2.jpg'],
  })
  assert.deepEqual(imgs, ['https://x/pic2.jpg'])
})

console.log('\n=== 3. 边界 ===')
await ok('她有自己的图 + 正文要求对方的图 → 两张都在（去重、最多 9）', async () => {
  const imgs = await run({
    arg: '把这张也发空间',
    msgImages: ['https://x/theirs.jpg'],
    recent: [{ isMe: true, images: ['https://x/mine.jpg'] }],
  })
  assert.ok(imgs.includes('https://x/mine.jpg'))
  assert.ok(imgs.includes('https://x/theirs.jpg'))
})

await ok('说说内容为空 → 根本不发', async () => {
  const onebot = mkOnebot()
  await runQQMarkers({
    items: [{ id: 'qzone', arg: '   ' }],
    onebot,
    msg: { messageId: 'm1', scope: 'private:1', images: [] },
    mem: { recent: () => [] },
    log: { info: () => {}, warn: () => {} },
  })
  assert.equal(onebot.calls.length, 0)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
