/**
 * 「指代一张旧图」的回归测试（2026-10-30）。
 *
 * ## 用户报的问题
 * ```
 * 21:19:15 「[图片]」 → 已附图 → [我]「阿哈的祝福还带图配文？这待遇不低啊」   ✅ 看了
 * 21:19:24 「[图片]」 → 已附图 → [我]「许愿阿哈不歪，结果阿哈自己出皮肤了」     ✅ 看了
 * 21:21:54 「这个」   → **没附图** → [我]「这图我这边糊成一团，看不清」   ← 就是这个
 * ```
 * 「这个」是**纯文本**，而附图规则只认"当前消息自带的图"—— 那条规则是
 * 2026-10-27 为了修「发过一张图之后，接下来每条纯文本都重附旧图」故意收紧的。
 * 收紧是对的，但**指代旧图时它手上什么都没有**，只能回"看不清"。
 *
 * ## 修法（核心是"别乱挂"）
 *   · **强指代**（这张图 / 图里 / 刚才那张…）→ 往前找 **6 条**
 *   · **弱指代**（开头的 这个 / 那个）    → **只认紧挨着的前一条**
 * 宁可漏（它就老实说"看不清"），也别挂一张不相干的图上去。
 *
 * ⚠️ 这条测试的重点是**不挂**那几个用例 —— 乱挂比不挂更糟：
 * 模型会拿着错图一本正经地聊，用户看到的是"它怎么答非所问"。
 */
import assert from 'node:assert/strict'
import {
  QQBridge, REFER_IMAGE_STRONG, REFER_IMAGE_WEAK, IMG_REFER_NOTE,
} from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── ① 强指代正则 ─────────────────────────────────────────
ok('强指代：话里带"图"字的都认', () => {
  for (const t of ['那张图是啥', '图里写的什么', '我刚才那张图呢', '看图上那个字', '我发的那张']) {
    assert.ok(REFER_IMAGE_STRONG.test(t), `应命中：${t}`)
  }
})

ok('强指代：不带"图"的普通话不认', () => {
  for (const t of ['你好', '吃了没', '这个好吃', '刚才下雨了', '上一条消息我看了']) {
    assert.ok(!REFER_IMAGE_STRONG.test(t), `不该命中：${t}`)
  }
})

// ── ② 弱指代正则（只认开头）──────────────────────────────
ok('弱指代：开头指代词命中', () => {
  for (const t of ['这个', '那个呢', '这张什么意思', '@某群友 这个', '（这个）']) {
    assert.ok(REFER_IMAGE_WEAK.test(t), `应命中：${t}`)
  }
})

ok('弱指代：句中的"这个"不算（常是语气词）', () => {
  for (const t of ['我喜欢这个', '还行吧这个', '算了那个不要了']) {
    assert.ok(!REFER_IMAGE_WEAK.test(t), `不该命中（不在开头）：${t}`)
  }
})

// ── ③ 说明文案 ───────────────────────────────────────────
ok('说明文案：明说"图是旧的"，并要求对不上就直说', () => {
  assert.match(IMG_REFER_NOTE, /这次附的图是\*\*旧的\*\*/)
  assert.match(IMG_REFER_NOTE, /别把这张图当成"刚发给你的"/)
  assert.match(IMG_REFER_NOTE, /没看到你说的那张图/, '要允许它承认找不到 —— 别硬凑')
})

// ── ④ _collectImages 的行为 ──────────────────────────────
const fakeOnebot = {
  fetchImage: async () => ({ dataUrl: 'data:image/png;base64,' + Buffer.from('PNG').toString('base64'), mime: 'image/png' }),
  call: async () => ({ data: {} }),
}
const fakeGateway = {
  providers: ['fake'],
  makeImageBlock: async ({ base64, mediaType }) => ({
    type: 'image', attachment: { attachmentId: 'sha256:' + String(base64).slice(0, 6), mediaType, width: 10, height: 10, bytes: 3 },
  }),
}
const mkBridge = () => new QQBridge({
  cfg: { reply: { imagesEnabled: true, maxImages: 2 } },
  onebot: fakeOnebot, gateway: fakeGateway,
  decision: {}, memory: {}, persona: {}, log: {},
})

/** 造一条历史消息。uid 用 userId 和 sender 两种字段各来几份（两种形态线上都见过）。 */
const msg = (text, { imgs = [], me = false, uid = '222' } = {}) => ({
  userId: uid, sender: uid, text, images: imgs, at: Date.now(), isMe: me,
})

const URL_A = 'http://x/a.jpg'
const URL_B = 'http://x/b.jpg'

await okAsync('★ 实测那个 case：「[图] [图] 这个」→ 补上最近那张', async () => {
  const out = await mkBridge()._collectImages([
    msg('你好'),
    msg('[图片]', { imgs: [URL_A] }),
    msg('[图片]', { imgs: [URL_B] }),
    msg('这个'),                       // ← 当前这条，纯文本
  ])
  assert.equal(out.size, 1, '应当补上 1 张')
  assert.ok(out.has(URL_B), '应当是**最近**那张（不是最早那张）')
})

await okAsync('同一人优先：别人也发过图时，取自己那张', async () => {
  const out = await mkBridge()._collectImages([
    msg('[图片]', { imgs: [URL_B], uid: '999' }),   // 别人发的（更近？不，在前）
    msg('[图片]', { imgs: [URL_A], uid: '222' }),   // 自己发的
    msg('这个', { uid: '222' }),
  ])
  assert.ok(out.has(URL_A), '同一个人发的优先 —— 指代通常指向自己刚发的')
})

await okAsync('⚠️ 弱指代只回溯 1 条：图在 2 条之前 → 不挂', async () => {
  const out = await mkBridge()._collectImages([
    msg('[图片]', { imgs: [URL_A] }),
    msg('随便说点什么'),
    msg('这个'),                       // 中间隔了一条 → 不能确定指的是图
  ])
  assert.equal(out.size, 0, '宁可漏，也别乱挂')
})

await okAsync('强指代回溯 6 条：图在 3 条之前 → 挂上', async () => {
  const out = await mkBridge()._collectImages([
    msg('打头'),
    msg('[图片]', { imgs: [URL_A] }),
    msg('嗯'),
    msg('对'),
    msg('那张图里写的啥'),              // ← 强指代
  ])
  assert.ok(out.has(URL_A), '强指代应当找得到')
})

await okAsync('⚠️ 回归：普通纯文本**不能**重附旧图（2026-10-27 修过的问题）', async () => {
  for (const t of ['？', '这里啊', '好的', '今天天气不错']) {
    const out = await mkBridge()._collectImages([
      msg('[图片]', { imgs: [URL_A] }),
      msg(t),
    ])
    assert.equal(out.size, 0, `「${t}」不该附图`)
  }
})

await okAsync('往回 6 条都没有图 → 不挂（不越界找更早的）', async () => {
  const many = [msg('[图片]', { imgs: [URL_A] })]
  for (let i = 0; i < 8; i++) many.push(msg('填充' + i))
  many.push(msg('那张图呢'))
  const out = await mkBridge()._collectImages(many)
  assert.equal(out.size, 0, '超出回溯窗口就不找 —— 太久远的图挂上去只会误导')
})

await okAsync('当前消息自带图时行为不变（优先当前那张）', async () => {
  const out = await mkBridge()._collectImages([
    msg('[图片]', { imgs: [URL_A] }),
    msg('[图片]', { imgs: [URL_B] }),   // ← 当前这条自带图
  ])
  assert.equal(out.size, 1)
  assert.ok(out.has(URL_B), '用当前的，不去回溯')
})

// ── ⑤ 源码锁 ─────────────────────────────────────────────
ok('源码锁：说明要拼进 extras（不能只塞进 mediaHint —— 它对纯文本是空的）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /imgReferrer \? IMG_REFER_NOTE : ''/, 'extras 里要有这一段')
  // `hasMedia` 的判据是文本里的媒体标记 —— 指代旧图的消息**没有**它
  assert.match(src, /const hasMedia = \/\\\[表情包/, 'hasMedia 仍按原来的判据')
})

ok('⚠️ 源码锁：判断要**提前**到 system prompt 之前（_collectImages 太靠后）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const atEarly = src.indexOf('const imgReferrer = this._pickReferencedImage(mem.recent(8))')
  const atExtras = src.indexOf("imgReferrer ? IMG_REFER_NOTE : ''")
  const atCollect = src.indexOf('this._collectImages(history, imgReferrer)')
  assert.ok(atEarly > 0, '应在 _generate 里提前算')
  assert.ok(atExtras > atEarly, 'extras 用它 —— 必须在它之后')
  assert.ok(atCollect > atExtras, '_collectImages 在最后')
  // _collectImages 的调用点（`history = mem.recent(30)` 之后）远在 extras 之后，
  // 所以"在 _collectImages 里顺便判断"是来不及的 —— 这条锁防止改回去。
  const lines = src.split('\n')
  const lineOf = (idx) => src.slice(0, idx).split('\n').length
  assert.ok(lineOf(atEarly) < lineOf(atExtras), '提前判断的行号要小于 extras')
  assert.equal(lines.length > 0, true)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)