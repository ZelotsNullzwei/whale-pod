/**
 * 摘要的时间触发（2026-11-06 用户：「按照时间来呢」）。
 *
 * 原来只按条数：满 20 条才摘。安静时一小时也凑不满，
 * 「刚说的重要的事」要等很久才进记忆。
 *
 * 现在两条腿走：条数到 20 **或** 距上次摘要超过 everyMinutes 分钟（且有新消息）。
 *
 * 守什么：
 * - long.js 里有时间判断，且 everyMinutes=0 时等于关闭
 * - bridge 有定时器（每 60 秒看一眼），没有新消息不花钱
 * - 配置默认 20 分钟
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

console.log('=== 1. long.js：时间也能触发 ===')
ok('★ 有 everyMinutes / timedOut 判据', () => {
  const s = read('src/memory/long.js')
  assert.match(s, /const everyMinutes = Number\(ctx\.everyMinutes/)
  assert.match(s, /timedOut/)
  assert.match(s, /unsummarized > 0/)
})
ok('★ 0 等于关闭（回到纯条数）', () => {
  const s = read('src/memory/long.js')
  assert.match(s, /everyMinutes > 0/)
})
ok('★ force 可跳过条数闸', () => {
  assert.match(read('src/memory/long.js'), /ctx\.force !== true/)
})

console.log('\n=== 2. bridge：定时器 ===')
ok('★ 有 _summaryClock 且只在新消息时摘', () => {
  const s = read('src/qq/bridge.js')
  assert.match(s, /_summaryClock\(\)/)
  assert.match(s, /total <= Number\(long\?\.summarizedTotal/)
  assert.match(s, /setInterval\(\(\) => this\._summaryClock\(\), 60_000\)/)
})
ok('★ 把 everyMinutes 传进 maybeSummarize', () => {
  assert.match(read('src/qq/bridge.js'), /everyMinutes: Number\(this\.cfg\?\.memory\?\.long\?\.everyMinutes/)
})

console.log('\n=== 3. 配置默认 ===')
ok('★ 默认 20 分钟', () => {
  assert.match(read('src/config/store.js'), /everyMinutes: 20/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
