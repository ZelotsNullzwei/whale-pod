/**
 * 表情包闸门测试（2026-10-28，用户选 B：只在明确互动时回）。
 *
 * 真实翻车：群里那张青蛙表情包（fileid=EhSMnq3BrcHwXn2TbGaPI）
 * 出现 4 次，它 4 次都回了。用户原话「还是反应青蛙，为啥啊」。
 */
import assert from 'node:assert/strict'
import { shouldAnswerSticker, isPureStickerText } from '../src/qq/stickerGate.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const T = 1_793_000_000_000
const SELF = '3039392113'

/** 造一条消息。 */
const m = (o = {}) => ({
  id: o.id ?? Math.random().toString(36).slice(2),
  sender: o.sender ?? '2129024700',
  senderName: o.senderName ?? '番茄',
  text: o.text ?? '[表情包]',
  at: o.at ?? T,
  isMe: o.isMe === true,
  replyTo: o.replyTo ?? null,
})

/** 模拟「群里一直在聊别的、它 4 分钟前说过一句话」。 */
function othersChatting() {
  return [
    m({ isMe: true, text: '我说的是显卡', at: T - 240_000 }),
    ...Array.from({ length: 12 }, (_, i) => m({ text: `别人第${i}句`, at: T - 200_000 + i * 1000 })),
  ]
}

// ── 明确互动：放行 ──────────────────────────────────────────
ok('被 @ → 放行（明确点名）', () => {
  assert.equal(shouldAnswerSticker({ msg: m(), selfId: SELF, recent: othersChatting(), atMe: true }), true)
})

ok('msg.isAtMe() 返回 true → 放行', () => {
  const msg = { ...m(), isAtMe: () => true }
  assert.equal(shouldAnswerSticker({ msg, selfId: SELF, recent: othersChatting() }), true)
})

ok('引用它自己的消息 → 放行', () => {
  const mine = m({ isMe: true, id: 'my-1', text: '我刚说的', at: T - 300_000 })
  const msg = m({ replyTo: 'my-1' })
  assert.equal(shouldAnswerSticker({ msg, selfId: SELF, recent: [mine] }), true)
})

ok('斗图：它上一条是纯表情、2 秒前 → 放行', () => {
  const mine = m({ isMe: true, text: '[表情包]', at: T - 2000 })
  assert.equal(shouldAnswerSticker({ msg: m({ at: T }), selfId: SELF, recent: [mine] }), true)
})

ok('它刚说完文字，同一人 5 秒后甩表情 → 放行', () => {
  const mine = m({ isMe: true, text: '行行行，是我', at: T - 5000 })
  assert.equal(shouldAnswerSticker({ msg: m({ at: T }), selfId: SELF, recent: [mine] }), true)
})

// ── 核心：那只青蛙现在的下场 ────────────────────────────────
ok('【青蛙场景】别人在聊、它 4 分钟前说过话 → 不接', () => {
  assert.equal(
    shouldAnswerSticker({ msg: m({ at: T }), selfId: SELF, recent: othersChatting() }),
    false,
    '这就是「还是反应青蛙」要修掉的情形',
  )
})

ok('没有任何自己发言 → 不接', () => {
  const recent = [m({ text: '别人说的话' }), m({ text: '又是别人' })]
  assert.equal(shouldAnswerSticker({ msg: m(), selfId: SELF, recent }), false)
})

ok('它上次说话是 40 秒前（超过 20s 窗口）→ 不接', () => {
  const mine = m({ isMe: true, text: '随便一句', at: T - 40_000 })
  assert.equal(shouldAnswerSticker({ msg: m({ at: T }), selfId: SELF, recent: [mine] }), false)
})

ok('它上次发的是表情，但已过 60s → 不接', () => {
  const mine = m({ isMe: true, text: '[表情包]', at: T - 90_000 })
  assert.equal(shouldAnswerSticker({ msg: m({ at: T }), selfId: SELF, recent: [mine] }), false)
})

// ── 防连发上限 ─────────────────────────────────────────────
ok('防连发：最近 3 条自己发言里有 2 条纯表情 → 即使斗图也不接', () => {
  const recent = [
    m({ isMe: true, text: '[表情包]', at: T - 90_000 }),
    m({ isMe: true, text: '说了句话', at: T - 60_000 }),
    m({ isMe: true, text: '[表情:5]', at: T - 3000 }),
  ]
  assert.equal(shouldAnswerSticker({ msg: m({ at: T }), selfId: SELF, recent }), false)
})

ok('防连发不该拦 @ —— 被点名时永远回', () => {
  const recent = [
    m({ isMe: true, text: '[表情包]', at: T - 90_000 }),
    m({ isMe: true, text: '[表情包]', at: T - 30_000 }),
  ]
  assert.equal(
    shouldAnswerSticker({ msg: m({ at: T }), selfId: SELF, recent, atMe: true }),
    true,
  )
})

// ── isPureStickerText ──────────────────────────────────────
ok('isPureStickerText 认得纯表情', () => {
  assert.equal(isPureStickerText('[表情包]'), true)
  assert.equal(isPureStickerText('[表情:5]'), true)
  assert.equal(isPureStickerText('[表情包]\n[表情:13]'), true)
})

ok('isPureStickerText 不把「表情+文字」当纯表情', () => {
  assert.equal(isPureStickerText('[表情包]\n行行行'), false)
  assert.equal(isPureStickerText('就是一句话'), false)
  assert.equal(isPureStickerText(''), false)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)