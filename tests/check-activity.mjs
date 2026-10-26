/**
 * check-activity.mjs —— 活跃天数逻辑验证。
 *
 * 覆盖三件事：
 *   1. 日期 key 用**本地时区**（不是 UTC）—— 否则东八区凌晨会少算一天
 *   2. 同一天重复 touch 幂等，跨天才 +1
 *   3. 落盘 / 恢复正确，坏数据不炸
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ActivityTracker, localDayKey } from '../src/gateway/activity.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

console.log('活跃天数')

// ── 1. 本地时区 ────────────────────────────────────────────────
ok('localDayKey 用本地时区，不是 UTC', () => {
  // 本地时间 2026-03-05 07:30。UTC 会把它算成前一天（东八区 07:30 = UTC 23:30 前一天）
  const d = new Date(2026, 2, 5, 7, 30, 0)
  assert.equal(localDayKey(d), '2026-03-05')
})

ok('localDayKey 补零', () => {
  assert.equal(localDayKey(new Date(2026, 0, 9)), '2026-01-09')
})

// ── 2. touch 语义 ──────────────────────────────────────────────
ok('首次 touch 记一天', () => {
  const a = new ActivityTracker()
  const isNew = a.touch(new Date(2026, 2, 5, 10, 0))
  assert.equal(isNew, true)
  assert.equal(a.stats().totalDays, 1)
})

ok('同一天重复 touch 幂等', () => {
  const a = new ActivityTracker()
  a.touch(new Date(2026, 2, 5, 10, 0))
  const again = a.touch(new Date(2026, 2, 5, 23, 59))
  assert.equal(again, false, '同一天不该算新的一天')
  assert.equal(a.stats().totalDays, 1)
})

ok('跨天 +1，中间断档不补', () => {
  const a = new ActivityTracker()
  a.touch(new Date(2026, 2, 5, 10, 0))
  a.touch(new Date(2026, 2, 9, 10, 0)) // 跳过 6/7/8
  assert.equal(a.stats().totalDays, 2, '断档的三天不该被补上')
})

// ── 3. stats 字段 ─────────────────────────────────────────────
ok('stats 返回首末日与今天状态', () => {
  const a = new ActivityTracker()
  a.touch(new Date(2026, 2, 5, 10, 0))
  a.touch(new Date(2026, 2, 7, 10, 0))
  const s = a.stats(new Date(2026, 2, 7, 20, 0))
  assert.equal(s.totalDays, 2)
  assert.equal(s.firstDay, '2026-03-05')
  assert.equal(s.lastDay, '2026-03-07')
  assert.equal(s.todayActive, true, '今天有活动')
})

ok('今天没活动时 todayActive=false', () => {
  const a = new ActivityTracker()
  a.touch(new Date(2026, 2, 5, 10, 0))
  const s = a.stats(new Date(2026, 2, 8, 10, 0))
  assert.equal(s.todayActive, false)
})

// ── 4. 落盘 / 恢复 ────────────────────────────────────────────
ok('落盘后能恢复', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-act-'))
  const a1 = new ActivityTracker({ home })
  a1.touch(new Date(2026, 2, 5, 10, 0))
  a1.touch(new Date(2026, 2, 6, 10, 0))

  const a2 = new ActivityTracker({ home })
  assert.equal(a2.stats().totalDays, 2, '重启后应恢复 2 天')
  assert.equal(a2.stats().firstDay, '2026-03-05')

  fs.rmSync(home, { recursive: true, force: true })
})

ok('文件损坏不炸，从零开始', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-act-bad-'))
  fs.writeFileSync(path.join(home, 'activity.json'), '{ not json')

  const a = new ActivityTracker({ home })
  assert.equal(a.stats().totalDays, 0)
  // 仍可正常记
  a.touch(new Date(2026, 2, 5, 10, 0))
  assert.equal(a.stats().totalDays, 1)

  fs.rmSync(home, { recursive: true, force: true })
})

ok('过滤掉格式不对的日期', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-act-filter-'))
  fs.writeFileSync(
    path.join(home, 'activity.json'),
    JSON.stringify({ days: ['2026-03-05', 'bad', 123, null, '2026-3-5'] }),
  )
  const a = new ActivityTracker({ home })
  assert.equal(a.stats().totalDays, 1, '只留 YYYY-MM-DD')
  assert.equal(a.stats().firstDay, '2026-03-05')

  fs.rmSync(home, { recursive: true, force: true })
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
