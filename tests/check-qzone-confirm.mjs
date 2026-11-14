/**
 * 说说确认闸：`_qzoneAnswer`（2026-11-10）
 *
 * ## 事故前提
 * 发说说前会私聊问「这张发空间行吗？」——**空间是公开的**，判错就是对外误发。
 * 旧实现只看「含不含『行』」：
 * ```
 * 「这行吗」→ yes   ❌（问句）
 * 「行了」  → yes   ❌（歧义）
 * ```
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const b = Object.create(QQBridge.prototype)
const ans = (t) => b._qzoneAnswer(t)

console.log('=== 1. 明确确认 ===')
ok('★ 明确说发 → yes', () => {
  for (const t of ['发', '发吧', '发出去', '好的', '嗯', '嗯嗯', '行', '行吧', '行啊', '可以', '就这个', '确认', '确定', '发一下']) {
    assert.equal(ans(t), 'yes', `「${t}」应是确认`)
  }
})

console.log('\n=== 2. 疑问句绝不算确认（公开空间误发风险）===')
ok('★ 带问号/吗/呢/正反问 → null', () => {
  for (const t of ['这行吗', '可以吗', '行不行', '发不发', '好看吗', '嗯？', '发了？', '好不好', '可不可以', '行吗']) {
    assert.equal(ans(t), null, `「${t}」是问句，不能当确认`)
  }
})

console.log('\n=== 3. 否定优先 ===')
ok('★ 说不发/换一张 → no', () => {
  for (const t of ['别发', '不行', '不要发', '换一张', '重拍', '算了', '不好看', '删了', '先不', '不用']) {
    assert.equal(ans(t), 'no', `「${t}」应是否定`)
  }
})

console.log('\n=== 4. 其它 ===')
ok('空 / 超长 → null', () => {
  assert.equal(ans(''), null)
  assert.equal(ans('   '), null)
  assert.equal(ans('这句话有点太长了超过十二个字符了吧'), null)
})
ok('★「这行吗」不能 yes（回归旧 bug）', () => {
  assert.notEqual(ans('这行吗'), 'yes')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
