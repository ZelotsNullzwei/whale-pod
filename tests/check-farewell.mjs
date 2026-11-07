/**
 * 收尾就归档（2026-11-07 用户：「只要对话里出现结束性的话就自动归档」）。
 *
 * 原来只有两条触发：满 20 条 / 安静 10 分钟。
 * 但「晚安、先这样、拜拜、去忙了」这种话本身就是对话结束的信号 ——
 * 等她安静 10 分钟才开始摘，等于白白挂着一段已经结束的对话。
 *
 * 守什么：
 * - 常见收尾语都认（晚安/睡了/先这样/拜拜/再见/不聊了/先撤/去忙/早点休息/下次聊…）
 * - **追问句不算**：「你要睡了吗」「准备睡了？」只是问，不是收尾
 * - 长句不算（>14 字），避免「我今天很早就睡了」被当成结束
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
const yes = (t) => p._isFarewell.call({}, t)
const no = (t) => !p._isFarewell.call({}, t)

console.log('=== 1. 该认的收尾 ===')
for (const t of ['晚安', '睡了', '那我先睡了，晚安', '先这样吧', '拜拜', '不聊了', '我先撤了', '去忙了', '早点休息', '下次聊', '我走了']) {
  ok(`「${t}」→ 是收尾`, () => assert.ok(yes(t)))
}

console.log('\n=== 2. 不该认的 ===')
for (const t of ['你要睡了吗', '准备睡了？', '你今天怎么这么早就睡了，是不是不舒服啊', '晚安这个词挺好听', '我走了两步就崴脚了']) {
  ok(`「${t}」→ 不算`, () => assert.ok(no(t), '误判成收尾了'))
}

console.log('\n=== 3. 边界 ===')
ok('空串 / 空格 → 不算', () => {
  assert.ok(no(''))
  assert.ok(no('   '))
})
ok('带感叹号/波浪号也认', () => {
  assert.ok(yes('晚安！'))
  assert.ok(yes('睡啦～'))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
