/**
 * 禁言标记与安全校验测试。
 *
 * 重点是**安全边界**：这是唯一一个模型能对其他群友造成实际影响的能力，
 * 所以每个「不该放行」的分支都必须有测试。
 */
import assert from 'node:assert/strict'
import {
  extractBanMarkers, stripBanMarkers, validateBan,
  describeBanMinutes, MAX_BAN_MINUTES, DEFAULT_BAN_MINUTES,
} from '../src/qq/groupAdmin.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── 标记解析 ────────────────────────────────────────────────
ok('提取 [禁言:QQ:分钟]', () => {
  const m = extractBanMarkers('行 [禁言:123450005:5]')
  assert.equal(m.length, 1)
  assert.equal(m[0].userId, '123450005')
  assert.equal(m[0].minutes, 5)
})

ok('省略分钟用默认值', () => {
  const m = extractBanMarkers('[禁言:123450005]')
  assert.equal(m[0].minutes, DEFAULT_BAN_MINUTES)
})

ok('兼容全角冒号', () => {
  const m = extractBanMarkers('[禁言：123450005：3]')
  assert.equal(m[0].userId, '123450005')
  assert.equal(m[0].minutes, 3)
})

ok('QQ 号位数不对不算标记', () => {
  assert.equal(extractBanMarkers('[禁言:123]').length, 0)
  assert.equal(extractBanMarkers('[禁言:1234567890123]').length, 0)
})

ok('剥掉标记不留空壳', () => {
  assert.equal(stripBanMarkers('[禁言:123450005:5]').trim(), '')
})

ok('剥标记保留正文', () => {
  assert.equal(stripBanMarkers('行 [禁言:123450005:5] 你歇会'), '行 你歇会')
})

// ── 校验：该放行的 ─────────────────────────────────────────
const members = [
  { user_id: 123450003, role: 'admin' },   // 机器人自己（也是管理员）
  { user_id: 1111111, role: 'owner' },
  { user_id: 2222222, role: 'admin' },
  { user_id: 123450005, role: 'member' },
]

ok('普通成员可以禁', () => {
  const v = validateBan({ userId: '123450005', minutes: 5, selfId: '123450003', members })
  assert.equal(v.ok, true)
  assert.equal(v.minutes, 5)
})

ok('时长超上限被压到 10 分钟', () => {
  const v = validateBan({ userId: '123450005', minutes: 999, selfId: '123450003', members })
  assert.equal(v.ok, true)
  assert.equal(v.minutes, MAX_BAN_MINUTES)
})

ok('时长 0 或负数被拒', () => {
  assert.equal(validateBan({ userId: '123450005', minutes: 0, selfId: '123450003', members }).ok, false)
  assert.equal(validateBan({ userId: '123450005', minutes: -5, selfId: '123450003', members }).ok, false)
})

// ── 校验：必须拒绝的 ───────────────────────────────────────
ok('群主也可以禁（管理员自己能解开）', () => {
  const v = validateBan({ userId: '1111111', minutes: 5, selfId: '123450003', members })
  assert.equal(v.ok, true)
})

ok('管理员也可以禁', () => {
  const v = validateBan({ userId: '2222222', minutes: 5, selfId: '123450003', members })
  assert.equal(v.ok, true)
})

ok('不能禁言自己', () => {
  const v = validateBan({ userId: '123450003', minutes: 5, selfId: '123450003', members })
  assert.equal(v.ok, false)
  assert.match(v.reason, /自己/)
})

ok('不在群里的人被拒', () => {
  const v = validateBan({ userId: '999999999', minutes: 5, selfId: '123450003', members })
  assert.equal(v.ok, false)
  assert.match(v.reason, /不在群里/)
})

ok('QQ 号格式不对被拒', () => {
  assert.equal(validateBan({ userId: 'abc', minutes: 5, selfId: '123450003', members }).ok, false)
  assert.equal(validateBan({ userId: '', minutes: 5, selfId: '123450003', members }).ok, false)
})

ok('同一人一小时内不能重复禁言', () => {
  const now = Date.now()
  const hist = { perUser: new Map([['123450005', now - 1000]]), perDay: 1 }
  const v = validateBan({ userId: '123450005', minutes: 5, selfId: '123450003', members, history: hist, now })
  assert.equal(v.ok, false)
  assert.match(v.reason, /一小时/)
})

ok('超过一小时可以再禁', () => {
  const now = Date.now()
  const hist = { perUser: new Map([['123450005', now - 3700_000]]), perDay: 1 }
  const v = validateBan({ userId: '123450005', minutes: 5, selfId: '123450003', members, history: hist, now })
  assert.equal(v.ok, true)
})

ok('每日上限 10 次', () => {
  const hist = { perUser: new Map(), perDay: 10 }
  const v = validateBan({ userId: '123450005', minutes: 5, selfId: '123450003', members, history: hist })
  assert.equal(v.ok, false)
  assert.match(v.reason, /上限/)
})

// ── 文案 ───────────────────────────────────────────────────
ok('分钟数说成人话', () => {
  assert.equal(describeBanMinutes(1), '1 分钟')
  assert.equal(describeBanMinutes(5), '5 分钟')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)