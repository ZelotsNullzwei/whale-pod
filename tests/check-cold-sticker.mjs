/**
 * 群里冷场 + 只发了个表情包 → 回一个「？」或一个表情（2026-11-07）。
 *
 * ## 现场
 * 用户：「我在无上下文管理的情况发表情，应该扣'？'或者同类意义的表情
 *        而不是现在这样」。
 *
 * 「现在这样」是两条路：
 *   · 落到决策层 → 模型判「先不接，还在听」→ 沉默（实测连发 5 次都沉默）
 *   · 被 `_shouldLookAtImage` 抓走 → 调模型看图，还容易说一串
 *
 * ## 守什么
 * - 冷场（最近 8 条里她没说过话、没人 @/引用她）+ 纯表情包 → 命中
 * - 她刚说过话 / 被 @ / 有文字 / 私聊 / 引用她的消息 → 不命中（交回原逻辑）
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const memOf = (list) => ({ recent: (n) => (n ? list.slice(-n) : list) })

console.log('=== 1. 什么算「冷场纯表情」===')
ok('★ 群里 + 只有表情包 + 她没说过话 → 命中', () => {
  const msg = { kind: 'group', text: '[表情包]' }
  assert.equal(p._isColdSticker.call({}, msg, memOf([{ isMe: false, text: '在吗' }])), true)
})
ok('带标签的表情包也命中', () => {
  assert.equal(p._isColdSticker.call({}, { kind: 'group', text: '[表情包:无语]' }, memOf([])), true)
})
ok('光秃秃的 [表情] 也算', () => {
  assert.equal(p._isColdSticker.call({}, { kind: 'group', text: '[表情]' }, memOf([])), true)
})

console.log('\n=== 2. 不算冷场的都别抢 ===')
ok('★ 她刚说过话 → 不命中（有上下文，该正常接）', () => {
  const msg = { kind: 'group', text: '[表情包]' }
  assert.equal(p._isColdSticker.call({}, msg, memOf([{ isMe: true, text: '嗯' }])), false)
})
ok('★ 被 @ → 不命中', () => {
  assert.equal(p._isColdSticker.call({}, { kind: 'group', text: '[表情包]', mentionsMe: true }, memOf([])), false)
})
ok('★ 表情带文字 → 不命中', () => {
  assert.equal(p._isColdSticker.call({}, { kind: 'group', text: '看这个[表情包]' }, memOf([])), false)
})
ok('★ 私聊 → 不命中', () => {
  assert.equal(p._isColdSticker.call({}, { kind: 'private', text: '[表情包]' }, memOf([])), false)
})
ok('★ 引用的是她的消息 → 不命中', () => {
  const msg = { kind: 'group', text: '[表情包]', replyTo: '9' }
  assert.equal(p._isColdSticker.call({}, msg, memOf([{ isMe: true, id: '9' }])), false)
})

console.log('\n=== 3. 源码锁 ===')
ok('★ 冷场分支必须排在「看图判断」之前（否则又被抓去调模型）', async () => {
  const fs = await import('node:fs')
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const iCold = SRC.indexOf('this._isColdSticker(msg, mem)')
  const iImg = SRC.indexOf('this._shouldLookAtImage(msg, mem)')
  assert.ok(iCold > 0, '没有冷场分支')
  assert.ok(iCold < iImg, '冷场分支排在看图之后 —— 纯表情还是会被抓去调模型')
})
ok('★ 回「？」或表情，不调模型', async () => {
  const fs = await import('node:fs')
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const i = SRC.indexOf('async _replyColdSticker')
  const seg = SRC.slice(i, i + 1200)
  assert.match(seg, /useQuestion \? '？' : '\[表情包\]'/, '没有「？/表情」二选一')
  assert.ok(!/this\._generate\(/.test(seg), '不该调生成模型')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
