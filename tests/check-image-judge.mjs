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
 * 表情包：放行 + 只防连发（2026-10-27 第四次调）。
 *
 * 三次失败的尝试都在 bridge.js 注释里，核心教训：
 * **表情包和真图片一样，代码看不见它有没有字。**
 * 有字的梗图字就是全部内容，没字的表情是纯语气 ——
 * 这个取舍只能靠看图，用文本上下文猜必然错。
 */
await ok('表情包：正常情况放行（让它自己看）', () => {
  const b = mk()
  const m = { text: '[表情包]', images: ['http://x/1.gif'], stickerRefs: ['http://x/1.gif'], sender: '100' }
  // 群里聊的正是跟它有关的事 —— 这时候必须看
  const history = [
    { text: '这画的是我吧', isMe: true },
    { text: '这你不禁言他', isMe: false },
  ]
  assert.equal(b._shouldLookAtImage(m, mem(history)), true)
})

await ok('表情包：群里聊别的事时也放行（判断交给模型）', () => {
  const b = mk()
  const m = { text: '[表情包]', images: ['http://x/1.gif'], stickerRefs: ['http://x/1.gif'], sender: '100' }
  const history = [
    { text: '3060现在为啥还3000多', isMe: false },
    { text: '打游戏没用', isMe: false },
    { text: '解锁没啥意义', isMe: false },
  ]
  // 不再用「有人在说话」当判据 —— 那条判据把「在聊它」也误伤了
  assert.equal(b._shouldLookAtImage(m, mem(history)), true)
})

await ok('表情包：自己已经连回两条纯表情 → 不再看（防斗图）', () => {
  const b = mk()
  const m = { text: '[表情包]', images: ['http://x/1.gif'], stickerRefs: ['http://x/1.gif'], sender: '100' }
  const history = [
    { text: '[表情包]', isMe: true },
    { text: '[表情包]', isMe: true },
  ]
  assert.equal(b._shouldLookAtImage(m, mem(history)), false)
})

await ok('表情包：只回过一条纯表情 → 还看', () => {
  const b = mk()
  const m = { text: '[表情包]', images: ['http://x/1.gif'], stickerRefs: ['http://x/1.gif'], sender: '100' }
  const history = [{ text: '[表情包]', isMe: true }]
  assert.equal(b._shouldLookAtImage(m, mem(history)), true)
})


await ok('表情包：上下文提到鱼/鲸 → 放行（可能在玩梗）', () => {
  const b = mk()
  const m = { text: '[表情包]', images: ['http://x/1.gif'], stickerRefs: ['http://x/1.gif'], sender: '100' }
  const history = [
    { text: '这是蓝色大肥鱼吧', isMe: false },
    { text: '哈哈', isMe: false },
  ]
  assert.equal(b._shouldLookAtImage(m, mem(history)), true)
})

await ok('表情包：单独发的、群里没热聊 → 放行（可能是梗图）', () => {
  const b = mk()
  const m = { text: '[表情包]', images: ['http://x/1.gif'], stickerRefs: ['http://x/1.gif'], sender: '100' }
  const history = [{ text: '嗯', isMe: false }]
  assert.equal(b._shouldLookAtImage(m, mem(history)), true)
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