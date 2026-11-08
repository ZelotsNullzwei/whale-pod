/**
 * 外出频率（2026-11-08）。
 *
 * 用户：「随机特殊事件呢，一周一次，或者一个月一次？出门逛街或者其他的」
 * 以及：「不然空间内容就成分享生活，容易成流水账」。
 *
 * 守什么：
 * ① 频率：市区 ≈ 每周 1 次、远门 ≈ 每月 1 次、附近每周 2 次左右
 * ② 多数时间**在家**（她独居、多数时候待着，不能天天在外面）
 * ③ 同一天调用两次结果一致（确定性，不然聊天记录和日程对不上）
 */
import assert from 'node:assert/strict'
import { outingForDay } from '../src/memory/outing.js'

const DAY = 86_400_000
const start = Date.UTC(2026, 10, 9)   // 2026-11-09

function stats(days = 90) {
  const cnt = { none: 0, nearby: 0, city: 0, trip: 0 }
  for (let i = 0; i < days; i++) {
    const k = new Date(start + i * DAY).toISOString().slice(0, 10)
    cnt[outingForDay(k).kind] += 1
  }
  return cnt
}

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const s = stats(90)
const weeks = 90 / 7

console.log('=== 90 天分布 ===')
console.log(' ', JSON.stringify(s))

console.log('\n=== 1. 频率 ===')
ok('★ 市区约每周一次（8~18 次/90天）', () => {
  assert.ok(s.city >= 8 && s.city <= 18, `city=${s.city}`)
})
ok('★ 出远门约每月一次（2~6 次/90天）', () => {
  assert.ok(s.trip >= 2 && s.trip <= 6, `trip=${s.trip}`)
})
ok('★ 附近约每周两次（14~30 次/90天）', () => {
  assert.ok(s.nearby >= 14 && s.nearby <= 30, `nearby=${s.nearby}`)
})
ok('★ 多数时间在家（>45%）', () => {
  assert.ok(s.none / 90 > 0.45, `none=${s.none}`)
})

console.log('\n=== 2. 确定性 ===')
ok('★ 同一天两次调用结果一致', () => {
  const a = outingForDay('2026-11-14')
  const b = outingForDay('2026-11-14')
  assert.deepEqual(a, b)
})

console.log('\n=== 3. 不再是"天天出门" ===')
ok('★ 90 天里出门天数 < 60%', () => {
  const out = s.city + s.trip + s.nearby
  assert.ok(out / 90 < 0.6, `出门 ${out}/90`)
})

console.log(`\n（周数 ≈ ${weeks.toFixed(1)}）`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
