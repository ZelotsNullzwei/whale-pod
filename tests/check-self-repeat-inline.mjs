/**
 * **单条消息内部**的自我重复截断（2026-11-08）。
 *
 * ⚠️ 和 `check-self-repeat.mjs`（2026-11-04）不是同一件事：
 *   · 那个管**跨消息**内容重复（同一意思在几条里说三遍）
 *   · 这个管**一条消息内部**把开头又抄了一遍
 *
 * ## 现场（私聊 14:29:12）
 * ```
 * （耳鳍抖了抖）现在才两点半不到，吃完就躺啊
 * 本鲸下午没安排，看你怎么说
 * （耳鳍抖了抖）现在才两点半不到，吃完就躺啊   ← 开场又写了一遍
 * ```
 *
 * 守什么：
 * ① 真重复要截掉，且**保留换行**（早期版用 join 拼，把两行粘成了一行）
 * ② 正常文本一个字都不动
 * ③ 短句重复（「哈哈哈哈哈」）不算 —— 人真会这么说
 * ④ 短文本（<16 字）不处理
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
const fake = { log: { info: () => {} } }
const run = (t) => p._stripSelfRepeat.call(fake, t)

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 真重复要截 ===')
ok('★ 首尾同句 → 只留一次', () => {
  const t = '（耳鳍抖了抖）现在才两点半不到，吃完就躺啊\n\n本鲸下午没安排，看你怎么说\n（耳鳍抖了抖）现在才两点半不到，吃完就躺啊'
  const out = run(t)
  assert.ok(out.length < t.length, '没截断')
  assert.equal(out.split('吃完就躺啊').length - 1, 1, '重复句应该只剩一次')
})

ok('★ 截断后保留换行（不粘成一行）', () => {
  const t = '（撇嘴）行吧，你说什么就是什么，我不跟你争。\n\n不过下次记得早点说。\n\n（撇嘴）行吧，你说什么就是什么，我不跟你争。'
  const out = run(t)
  assert.ok(out.includes('\n'), '换行被吃掉了')
  assert.ok(out.includes('不过下次记得早点说'), '中段不该丢')
})

console.log('\n=== 2. 不该动的别动 ===')
ok('★ 正常两段对话不变', () => {
  const t = '（尾巴抬起来）可算到了。\n\n趁热吃，别放凉了再动筷子。'
  assert.equal(run(t), t)
})

ok('★ 短句重复（哈哈哈哈）不误杀', () => {
  const t = '哈哈哈哈哈，你这也太逗了。哈哈哈哈哈。'
  assert.equal(run(t), t)
})

ok('★ 短文本（<16 字）不处理', () => {
  const t = '好。好。好。'
  assert.equal(run(t), t)
})

console.log('\n=== 3. 接入点 ===')
ok('★ _send 里调用它（否则只写不生效）', () => {
  const src = String(p._send)
  assert.match(src, /_stripSelfRepeat/, '_send 没有调用 _stripSelfRepeat')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
