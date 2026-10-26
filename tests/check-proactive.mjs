/**
 * check-proactive.mjs —— 主动行为调度器。
 *
 * 重点验证「闸门」：主动发言最容易招人烦，所以每条限制都得真的生效。
 *   1. 时段限制（半夜不说话 / 跨夜时段）
 *   2. 每日上限
 *   3. 全局冷却
 *   4. 静默时长
 *   5. 两个开关互不影响
 *   6. 跨天重置
 */

import assert from 'node:assert/strict'
import { dayKey, inActiveHours, ProactiveState, ProactiveScheduler } from '../src/qq/proactive.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

const at = (h, m = 0) => new Date(2026, 9, 26, h, m, 0)   // 10 月 26 日

console.log('主动行为调度器')

// ── 时段 ─────────────────────────────────────────────────────
await ok('inActiveHours：8-23 允许，凌晨不放', () => {
  assert.equal(inActiveHours([8, 23], at(10)), true, '上午该允许')
  assert.equal(inActiveHours([8, 23], at(23)), false, '23 点整已经出界（右开）')
  assert.equal(inActiveHours([8, 23], at(3)), false, '凌晨不放')
})

await ok('inActiveHours：跨夜时段', () => {
  // [22, 6] = 22:00 到次日 5:59
  assert.equal(inActiveHours([22, 6], at(23)), true)
  assert.equal(inActiveHours([22, 6], at(3)), true)
  assert.equal(inActiveHours([22, 6], at(12)), false)
})

await ok('inActiveHours：空配置不限时段', () => {
  assert.equal(inActiveHours([], at(3)), true)
  assert.equal(inActiveHours(undefined, at(3)), true)
})

// ── dayKey ──────────────────────────────────────────────────
await ok('dayKey 用本地时区', () => {
  assert.equal(dayKey(new Date(2026, 9, 26, 7, 30)), '2026-10-26')
})

// ── 状态跨天重置 ────────────────────────────────────────────
await ok('跨天把每日计数清零', () => {
  const s = new ProactiveState()
  s.begCount = 2
  s.speakCount = 3
  s.day = '2026-10-25'
  const reset = s.rollDay(at(10))
  assert.equal(reset, true)
  assert.equal(s.begCount, 0)
  assert.equal(s.speakCount, 0)
  assert.equal(s.day, '2026-10-26')
})

await ok('同一天不重置', () => {
  const s = new ProactiveState()
  s.day = dayKey(at(10))
  s.speakCount = 2
  assert.equal(s.rollDay(at(11)), false)
  assert.equal(s.speakCount, 2)
})

// ── 开关互不影响 ────────────────────────────────────────────
const mkScheduler = (over = {}) => {
  const state = new ProactiveState()
  const calls = { beg: 0, speak: 0 }
  const s = new ProactiveScheduler({
    cfg: { enabled: false, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24], ...(over.cfg ?? {}) },
    begCfg: { enabled: false, checkIntervalMinutes: 60, maxPerDay: 3, ...(over.begCfg ?? {}) },
    state,
    now: () => at(10).getTime(),
    checkBalance: over.checkBalance ?? (async () => true),
    onBeg: async () => { calls.beg++; return true },
    onSpeak: async () => { calls.speak++; return true },
    scopes: over.scopes ?? (() => ['group:1']),
    idleMs: over.idleMs ?? (() => 999 * 60_000),
  })
  return { s, state, calls }
}

await ok('两个开关都关 → 什么都不做', () => {
  const { s } = mkScheduler()
  const p = s.plan(at(10))
  assert.equal(p.beg, false)
  assert.equal(p.speak, false)
})

await ok('只开讨钱 → 只讨钱，不发言', async () => {
  const { s, calls } = mkScheduler({ begCfg: { enabled: true, checkIntervalMinutes: 60, maxPerDay: 3 } })
  await s.tick(at(10))
  assert.equal(calls.beg, 1, '该讨一次')
  assert.equal(calls.speak, 0, '不该发言')
})

await ok('只开发言 → 只发言，不讨钱', async () => {
  const { s, calls } = mkScheduler({ cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24] } })
  await s.tick(at(10))
  assert.equal(calls.beg, 0, '讨钱没开，不该讨')
  assert.equal(calls.speak, 1, '该发言')
})

// ── 发言的各种闸门 ──────────────────────────────────────────
const speakOn = (over = {}) => mkScheduler({
  cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24], ...(over.cfg ?? {}) },
  ...over,
})

await ok('静默不够久 → 不发言', async () => {
  const { s, calls } = speakOn({ idleMs: () => 10 * 60_000 })   // 才 10 分钟
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '45 分钟没到不该开口')
})

await ok('每日上限用完 → 不发言', async () => {
  const { s, state, calls } = speakOn({ cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 0, maxPerDay: 2, hours: [0, 24] } })
  state.speakCount = 2
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '已经 2 次了（上限 2）')
})

await ok('冷却期内 → 不发言', async () => {
  const { s, state, calls } = speakOn()
  state.lastSpeakAt = at(9).getTime()   // 1 小时前说过（冷却 180 分钟）
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '冷却还没过')
})

await ok('没有可发言的会话 → 不发言', async () => {
  const { s, calls } = speakOn({ scopes: () => [] })
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '没有白名单会话就不该开口')
})

await ok('半夜 → 两个都不做', async () => {
  const { s, calls } = mkScheduler({
    cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 0, maxPerDay: 3, hours: [8, 23] },
    begCfg: { enabled: true, checkIntervalMinutes: 60, maxPerDay: 3 },
  })
  s.plan = s.plan.bind(s)
  const p = s.plan(at(3))
  assert.equal(p.beg, false)
  assert.equal(p.speak, false)
  assert.match(p.reason, /时段/)
})

// ── 执行后的记账 ────────────────────────────────────────────
await ok('发言成功后记一次 + 记时间', async () => {
  const { s, state } = speakOn()
  await s.tick(at(10))
  assert.equal(state.speakCount, 1)
  assert.equal(state.lastSpeakAt, at(10).getTime())
})

await ok('讨钱成功后才记次数', async () => {
  const { s, state } = mkScheduler({ begCfg: { enabled: true, checkIntervalMinutes: 60, maxPerDay: 3 } })
  await s.tick(at(10))
  assert.equal(state.begCount, 1)
})

await ok('余额不低 → 不记账', async () => {
  const { s, state, calls } = mkScheduler({
    begCfg: { enabled: true, checkIntervalMinutes: 60, maxPerDay: 3 },
    checkBalance: async () => false,
  })
  await s.tick(at(10))
  assert.equal(calls.beg, 0, '余额正常不该讨')
  assert.equal(state.begCount, 0)
})

await ok('讨钱发送失败 → 不记账（留给下次）', async () => {
  const state = new ProactiveState()
  const s = new ProactiveScheduler({
    cfg: { enabled: false },
    begCfg: { enabled: true, checkIntervalMinutes: 60, maxPerDay: 3 },
    state,
    checkBalance: async () => true,
    onBeg: async () => false,        // 发送失败
    scopes: () => ['group:1'],
    idleMs: () => 0,
  })
  await s.tick(at(10))
  assert.equal(state.begCount, 0, '失败不该占用今天的次数')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
