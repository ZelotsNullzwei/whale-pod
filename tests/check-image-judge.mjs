/**
 * 纯图片消息的粗筛测试。
 *
 * 背景：决策层是纯文本分类器，看不见图，所以「像鲸鱼娘的图」一律被判
 * 「跟我无关」。现在纯图片消息绕过决策层，但先用零成本规则粗筛。
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// 造一个只带 _shouldLookAtImage 需要的字段的假 bridge
const mk = (cfg = {}) => {
  const b = Object.create(QQBridge.prototype)
  b.cfg = { reply: {}, ...cfg }
  b.log = { info: () => {}, warn: () => {} }
  return b
}

// 假记忆：recent(n) 返回给定数组
const mem = (msgs) => ({ recent: (n) => (n == null ? msgs : msgs.slice(-n)) })

const img = (extra = {}) => ({
  text: '[图片]',
  images: ['http://x/1.jpg'],
  stickerRefs: [],
  sender: '100',
  ...extra,
})

await ok('纯图片（无文字）→ 放行', () => {
  const b = mk()
  assert.equal(b._shouldLookAtImage(img(), mem([])), true)
})

await ok('图文混排（有文字）→ 不放行（走正常决策）', () => {
  const b = mk()
  const m = img({ text: '今天天气不错 [图片]' })
  // recent 里没有鱼相关、也不是熟人 → false
  assert.equal(b._shouldLookAtImage(m, mem([])), false)
})

/*
 * 表情包：**只在明确互动时放行**（2026-10-28 第五次调，用户选 B）。
 *
 * 前四次的教训都在 bridge.js / stickerGate.js 的注释里。
 * 第五次的原因：群里同一张青蛙表情包（fileid=EhSMnq3BrcHwXn2TbGaPI）
 * 出现 **4 次、它 4 次都回**，用户原话「还是反应青蛙，为啥啊」——
 * 因为这条路径原先**完全没有「是不是在跟我说话」的判断**。
 *
 * 完整判据见 tests/check-sticker-gate.mjs；这里只验证
 * `_shouldLookAtImage` 确实把那套判据接上了。
 */
const T0 = 1_793_000_000_000
const sticker = (extra = {}) => ({
  text: '[表情包]',
  images: ['http://x/1.gif'],
  stickerRefs: ['http://x/1.gif'],
  sender: '100',
  at: T0,
  ...extra,
})

await ok('表情包：被 @ → 放行', () => {
  const b = mk()
  assert.equal(b._shouldLookAtImage(sticker({ isAtMe: () => true }), mem([])), true)
})

await ok('表情包：它刚发过纯表情（斗图）→ 放行', () => {
  const b = mk()
  const history = [{ text: '[表情包]', isMe: true, at: T0 - 2000 }]
  assert.equal(b._shouldLookAtImage(sticker(), mem(history)), true)
})

await ok('表情包：群里聊别的事、它没参与 → 不接（这就是青蛙场景）', () => {
  const b = mk()
  const history = [
    { text: '我说的是显卡', isMe: true, at: T0 - 240_000 },
    { text: '3060现在为啥还3000多', isMe: false, at: T0 - 200_000 },
    { text: '打游戏没用', isMe: false, at: T0 - 190_000 },
    { text: '解锁没啥意义', isMe: false, at: T0 - 180_000 },
  ]
  // 别人互相斗图不关它的事；它 4 分钟前那句话早就过去了
  assert.equal(b._shouldLookAtImage(sticker(), mem(history)), false)
})

await ok('表情包：自己已连回两条纯表情 → 不接（防连图）', () => {
  const b = mk()
  const history = [
    { text: '[表情包]', isMe: true, at: T0 - 9000 },
    { text: '[表情包]', isMe: true, at: T0 - 3000 },
  ]
  assert.equal(b._shouldLookAtImage(sticker(), mem(history)), false)
})

await ok('表情包：只回过一条纯表情、紧跟其后 → 还接（正常斗图）', () => {
  const b = mk()
  const history = [{ text: '[表情包]', isMe: true, at: T0 - 2000 }]
  assert.equal(b._shouldLookAtImage(sticker(), mem(history)), true)
})


await ok('表情包：上下文提到鱼/鲸 → 仍然不接（不再用文本猜内容）', () => {
  const b = mk()
  const history = [
    { text: '这是蓝色大肥鱼吧', isMe: false, at: T0 - 3000 },
    { text: '哈哈', isMe: false, at: T0 - 2000 },
  ]
  // ⚠️ 这里刻意**不改**用上下文放行 —— 靠文本猜「像不像它」正是
  //    第一到第四次调都栽过的那条路
  assert.equal(b._shouldLookAtImage(sticker(), mem(history)), false)
})

await ok('表情包：单独发的、它没说过话 → 不接', () => {
  const b = mk()
  assert.equal(b._shouldLookAtImage(sticker(), mem([{ text: '嗯', isMe: false, at: T0 - 1000 }])), false)
})

await ok('没有图 → 不放行', () => {
  const b = mk()
  assert.equal(b._shouldLookAtImage({ text: '你好', images: [], stickerRefs: [] }, mem([])), false)
})

await ok('最近有人提「鱼」→ 图文混排也放行', () => {
  const b = mk()
  const m = img({ text: '看这个 [图片]' })
  const history = [{ text: '这不是大肥鱼吗', isMe: false, sender: '200' }]
  assert.equal(b._shouldLookAtImage(m, mem(history)), true)
})

await ok('最近提到「鲸」「本鱼」「白米饭」都算', () => {
  const b = mk()
  const m = img({ text: '嗯 [图片]' })
  for (const kw of ['鲸鱼娘', '本鱼在此', '白米饭！']) {
    assert.equal(b._shouldLookAtImage(m, mem([{ text: kw, isMe: false, sender: '200' }])), true, kw)
  }
})

await ok('熟人（最近说过话的人）发的图文混排 → 放行', () => {
  const b = mk()
  const m = img({ text: '看看 [图片]', sender: '100' })
  const history = [{ text: '随便聊聊', isMe: false, sender: '100' }]
  assert.equal(b._shouldLookAtImage(m, mem(history)), true)
})

await ok('陌生人发的图文混排 → 不放行', () => {
  const b = mk()
  const m = img({ text: '看看 [图片]', sender: '999' })
  const history = [{ text: '随便聊聊', isMe: false, sender: '100' }]
  assert.equal(b._shouldLookAtImage(m, mem(history)), false)
})

await ok('配置关掉 → 一律不放行', () => {
  const b = mk({ reply: { imageJudge: false } })
  assert.equal(b._shouldLookAtImage(img(), mem([])), false)
})

await ok('@我 + 发图 → 不当纯图片（交给决策层按被@处理）', () => {
  const b = mk()
  const m = img({ text: '@3039392113 [图片]' })
  assert.equal(b._shouldLookAtImage(m, mem([])), false)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)