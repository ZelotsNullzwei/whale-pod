/**
 * 归档触发：安静就归档（2026-11-06 用户：「一定时间没人说话就自动归档」）。
 *
 * 之前只按条数（满 20 条），安静时段一小时也凑不满 → 刚说的重要的事一直不进记忆。
 * 中间的尝试是「距上次摘要满 N 分钟」，但那样热聊时也会到点，白花调用。
 *
 * 现在：每 60 秒看一眼，**某个会话距最后一条消息 >= idleMinutes 且有未归档消息**
 * 才摘一次 → 冷场即归档，热聊不打扰、不花钱。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const read = (p) => fs.readFileSync('D:/DSH WorkSpace/whale-pod/' + p, 'utf8')

console.log('=== 1. 触发条件：安静 ===')
ok('★ 用 idleMinutes + 最后一条消息时间', () => {
  const s = read('src/qq/bridge.js')
  assert.match(s, /const idleMinutes = Number\(this\.cfg\?\.memory\?\.long\?\.idleMinutes/)
  assert.match(s, /mem\.recent\?\.\(1\)/, '要取最后一条消息的时间')
  assert.match(s, /now - lastMsgAt < idleMinutes \* 60_000/, '还在聊就不摘')
})
ok('★ 没有新消息不花调用', () => {
  assert.match(read('src/qq/bridge.js'), /total <= Number\(long\?\.summarizedTotal/)
})
ok('★ 仍然每 60 秒看一眼', () => {
  assert.match(read('src/qq/bridge.js'), /setInterval\(\(\) => this\._summaryClock\(\), 60_000\)/)
})

console.log('\n=== 2. 配置 ===')
ok('★ 默认 idleMinutes=10、everyMinutes=0', () => {
  const s = read('src/config/store.js')
  assert.match(s, /idleMinutes: 10/)
  assert.match(s, /everyMinutes: 0/)
})

console.log('\n=== 3. force 仍能跳条数闸 ===')
ok('long.js 里 force !== true 判据还在', () => {
  assert.match(read('src/memory/long.js'), /ctx\.force !== true/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
