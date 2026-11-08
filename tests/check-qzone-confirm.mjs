/**
 * 说说确认闸（2026-11-08 用户：「叫她发的话应该先和我发照片确认，然后再发」）。
 *
 * 守什么：
 * ① 私聊里 `[说说:…]` 不会直接发，先把图发给他看、问一句
 * ② 他说「发吧/行」→ 真发；「不发/换一张」→ 丢掉
 * ③ `_qzoneAnswer` 判得准（长句不误判）
 * ④ 源码锁：确认闸在 `_handle` 里、且在生成之前
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
const flat = src.split(String.fromCharCode(13)).join('')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 流程存在性（源码） ===')
ok('★ 有 _askQzoneConfirm（先发图确认）', () => {
  assert.match(flat, /async _askQzoneConfirm\(/)
})
ok('★ 有 _sendQzoneNow（确认后才真发）', () => {
  assert.match(flat, /async _sendQzoneNow\(/)
})
ok('★ 有 _makeQzoneImage（只生成、不发送）', () => {
  assert.match(flat, /async _makeQzoneImage\(/)
})
ok('★ 有 _qzoneAnswer（判他的回答）', () => {
  assert.match(flat, /_qzoneAnswer\(text\)/)
})
ok('★ 钩子调的是 _askQzoneConfirm（不再直接发）', () => {
  assert.match(flat, /_askQzoneConfirm\(pq\)/)
  assert.ok(!/_postQzoneWithImage\(pq\)\.catch/.test(flat), '不能再直接发')
})

console.log('\n=== 2. 判他的回答 ===')
ok('★ 「不发/换一张」算拒绝', () => {
  assert.match(flat, /不发\|不行\|别发\|不要发/)
})
ok('★ 只有短句才算回答（长句不误判）', () => {
  assert.match(flat, /t\.length > 12/)
})
ok('★ 回答只在私聊处理', () => {
  const i = flat.indexOf('const pq = this._qzonePending')
  assert.ok(i > 0, '没找到 pending 处理')
  const seg = flat.slice(Math.max(0, i - 600), i)
  assert.match(seg, /startsWith\('private:'\)/)
})

console.log('\n=== 3. 顺序锁 ===')
ok('★ 确认闸在 _handle 里，且在生成之前', () => {
  const iHandle = flat.indexOf('async _handle(msg, seq)')
  const iGate = flat.indexOf('const ans = this._qzoneAnswer(msg.text)')
  const iGen = flat.indexOf('await this._generate(msg, mem, scene, self', iGate)
  assert.ok(iHandle >= 0, '没找到 _handle')
  assert.ok(iGate > iHandle, `确认闸必须在 _handle 内（handle=${iHandle} gate=${iGate}）`)
  assert.ok(iGen > iGate, `确认闸要在生成之前（gate=${iGate} gen=${iGen}）`)
})

console.log('\n=== 4. 超时保护 ===')
ok('★ pending 超过 30 分钟就不算数', () => {
  assert.match(flat, /30 \* 60_000/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
