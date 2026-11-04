/**
 * 引用的**内容**能不能进提示词（2026-11-01）。
 *
 * 用户原话：「QQ的引用功能她是不是看不见」
 *
 * 查下来是**半瞎**：
 *   ① 解析层只拿到被引用消息的 **id**（reply 段里就这一个字段）
 *   ② 决策层会用这个 id 判断「在跟谁说话」
 *   ③ **生成层完全没用它** —— `buildChatMessages` 一次都没读过 replyTo
 *
 * 于是引用一条**滚出 30 条窗口**的消息时，机器人手里只有一串数字，
 * 完全不知道被引用的是什么，只能当普通一句来答。
 *
 * 现在：窗口内直接拿内容；窗口外走 `get_msg` 取回；取不到也要如实说。
 * （决策层那一半见 check-quote.mjs，别混。）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildChatMessages } from '../src/qq/bridge.js'
import { makeMessage, normalizeQuote } from '../src/memory/short.js'
import { resolveAddressee } from '../src/decision/rule.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const T = 1_793_000_000_000
const SELF = '123450003'
const SELF_NAME = '蓝色大鲸鱼'

/** 造一条历史消息。 */
const m = (o = {}) => makeMessage({
  id: o.id ?? Math.random().toString(36).slice(2),
  sender: o.sender ?? '123450002',
  senderName: o.senderName ?? '阿乙',
  text: o.text ?? '随便一句',
  at: o.at ?? T,
  isMe: o.isMe === true,
  replyTo: o.replyTo ?? null,
  quote: o.quote ?? null,
})

/** 取出送进 prompt 的纯文本（最后一条）。 */
function lastText(history) {
  const msgs = buildChatMessages({ system: 'sys', history, selfId: SELF, selfName: SELF_NAME })
  const tail = msgs[msgs.length - 1]
  return (tail?.content ?? []).map((b) => b.text ?? '').join('')
}

// ── 渲染：窗口内的引用 ─────────────────────────────────────
ok('引用窗口内的消息 → 渲染出「引用谁的话：什么」', () => {
  const quoted = m({ id: 'q1', senderName: '阿乙', text: '这个怎么样', at: T - 5000 })
  const cur = m({ text: '我觉得不行', replyTo: 'q1', quote: { sender: '阿乙', text: '这个怎么样' } })
  const t = lastText([quoted, cur])
  assert.match(t, /（引用阿乙的话：这个怎么样）/, `实际：${t}`)
  assert.match(t, /我觉得不行/, '正文不能被引用挤掉')
})

ok('引用自己的话 → 说「你自己」，不是「某人」', () => {
  const cur = m({ text: '对', replyTo: 'q2', quote: { sender: '', text: '本鱼说过这句', isMe: true } })
  const t = lastText([cur])
  assert.match(t, /（引用你自己的话：本鱼说过这句）/, `实际：${t}`)
})

ok('引用排在说话人之后、正文之前', () => {
  const cur = m({ text: '正文在这', replyTo: 'q3', quote: { sender: '阿乙', text: '被引用的原话' } })
  const t = lastText([cur])
  const iWho = t.indexOf('阿乙: ')
  const iQuote = t.indexOf('（引用阿乙的话：')
  const iBody = t.indexOf('正文在这')
  assert.ok(iWho >= 0, `没有说话人前缀：${t}`)
  assert.ok(iWho < iQuote, '引用不该跑到说话人前面')
  assert.ok(iQuote < iBody, '引用必须在正文之前')
})

ok('长引用截到 60 字（不挤占正文）', () => {
  const long = '很长的原话'.repeat(30) // 150 字
  const cur = m({ text: '嗯', replyTo: 'q4', quote: { sender: '阿乙', text: long } })
  const t = lastText([cur])
  // ⚠️ 必须从「（引用」之后再找「）」—— 前面还有个时间戳的「（5 分钟前）」
  const i0 = t.indexOf('（引用')
  const i1 = t.indexOf('）', i0)
  const body = t.slice(i0, i1 + 1)
  assert.ok(body.endsWith('…）'), `没截断：${body}`)
  assert.ok(body.length <= 60 + '（引用阿乙的话：'.length + '…）'.length, `截得太松：${body.length}`)
})

// ── 渲染：取不到内容 ───────────────────────────────────────
ok('有 replyTo 但内容没取到 → 如实说，别装没看见', () => {
  const cur = m({ text: '这个呢', replyTo: 'gone', quote: null })
  const t = lastText([cur])
  assert.match(t, /（引用了一条消息，但内容没取到）/, `实际：${t}`)
})

ok('没有引用 → 不出现任何「引用」字样', () => {
  const t = lastText([m({ text: '普通一句' })])
  assert.ok(!t.includes('引用'), `实际：${t}`)
})

// ── normalizeQuote ────────────────────────────────────────
ok('normalizeQuote：空壳 → null（不占字段）', () => {
  assert.equal(normalizeQuote(null), null)
  assert.equal(normalizeQuote({}), null)
  assert.equal(normalizeQuote({ text: '', sender: '' }), null)
  assert.equal(normalizeQuote({ text: '   ' }), null)
})

ok('normalizeQuote：保留内容并补 isMe', () => {
  assert.deepEqual(normalizeQuote({ sender: '阿乙', text: '原话' }), {
    sender: '阿乙', text: '原话', isMe: false,
  })
  assert.deepEqual(normalizeQuote({ text: '我说的', isMe: true }), {
    sender: '', text: '我说的', isMe: true,
  })
})

ok('makeMessage 会把 quote 带上（要随记忆一起落盘）', () => {
  const msg = makeMessage({ text: 'x', quote: { sender: '阿乙', text: '原话' } })
  assert.equal(msg.quote.text, '原话')
})

// ── 决策层：窗口外的引用不再一律「不确定」 ──────────────────
const self = { qq: SELF, nickname: SELF_NAME, aliases: ['鱼', '鲸鱼'] }

ok('窗口外引用**我自己** → 判「在跟我说」（原来一律 unclear）', () => {
  const cur = m({ text: '你昨天说的那个', replyTo: 'far-away', quote: { text: '昨天的原话', isMe: true } })
  const r = resolveAddressee([cur], self, [])
  assert.equal(r.who, 'me', `实际：${JSON.stringify(r)}`)
})

ok('窗口外引用**别人** → 判「在跟别人说」', () => {
  const cur = m({ text: '这个怎么样', replyTo: 'far-away', quote: { sender: '阿乙', text: '阿乙的原话' } })
  const r = resolveAddressee([cur], self, [])
  assert.equal(r.who, 'other', `实际：${JSON.stringify(r)}`)
})

ok('窗口外、内容也取不到 → 仍然老实说 unclear（不硬猜）', () => {
  const cur = m({ text: '这个怎么样', replyTo: 'far-away', quote: null })
  const r = resolveAddressee([cur], self, [])
  assert.equal(r.who, 'unclear', `实际：${JSON.stringify(r)}`)
})

// ── 回归：窗口内的引用仍然优先按窗口里那条判 ─────────────────
ok('窗口内引用 → 仍按窗口里那条判（quote 不会盖掉它）', () => {
  const mine = m({ id: 'in-win', isMe: true, text: '我说的' })
  // 故意给一个矛盾的 quote（说成别人），验证窗口内的证据优先
  const cur = m({ text: '嗯', replyTo: 'in-win', quote: { sender: '阿乙', text: '错的' } })
  const r = resolveAddressee([mine, cur], self, [])
  assert.equal(r.who, 'me', `实际：${JSON.stringify(r)}`)
})

// ── 源码锁：面板也要看得到引用（2026-11-01） ────────────────
//
// ⚠️ 这条锁的来由：**输入端**早上就修好了（提示词里有引用内容），
//    但**面板显示**没跟上 —— 一条正文为空的「纯引用」在界面上只剩空气泡，
//    用户看着像"她收到一条空消息还不理人"。
//    同一个功能在日志里是对的、在面板上像坏的。
//    所以两边都锁住，免得以后谁改 `_record` 时把 quote 又丢掉。
const bridgeSrc = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
const assetsSrc = fs.readFileSync(new URL('../src/web/assets.js', import.meta.url), 'utf8')

ok('_record 会把 quote / replyTo 一起记下来（面板要显示）', () => {
  const i = bridgeSrc.indexOf('_record(msg, decision, replyText, outcome)')
  assert.ok(i > 0, '找不到 _record 方法')
  const body = bridgeSrc.slice(i, i + 1800)
  assert.match(body, /quote:/, '_record 里没有 quote 字段了 —— 面板会退回空气泡')
  assert.match(body, /replyTo:/, '_record 里没有 replyTo —— 分不清「没引用」和「引用没取到」')
})

ok('面板会渲染 r.quote', () => {
  assert.ok(assetsSrc.includes('r.quote'), 'assets.js 不再渲染 r.quote 了')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
