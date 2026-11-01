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
import fs from 'node:fs'
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
  s.speakCountGroup = 3
  s.day = '2026-10-25'
  const reset = s.rollDay(at(10))
  assert.equal(reset, true)
  assert.equal(s.begCount, 0)
  assert.equal(s.speakCountGroup, 0)
  assert.equal(s.speakCountPrivate, 0)
  assert.equal(s.day, '2026-10-26')
})

await ok('同一天不重置', () => {
  const s = new ProactiveState()
  s.day = dayKey(at(10))
  s.speakCountGroup = 2
  assert.equal(s.rollDay(at(11)), false)
  assert.equal(s.speakCountGroup, 2)
})

// ── 开关互不影响 ────────────────────────────────────────────
/*
 * ⚠️ 把 state.day 对齐到测试用的日期。
 *
 * `ProactiveState` 构造时用 `dayKey()` 取**真实今天**初始化，而本测试
 * 用的是固定的 `at(10)` = 2026-10-26。只要真实日期不是 10-26，
 * `rollDay()` 就会判定「跨天了」，把 speakCount / begCount **清零** ——
 * 于是「每日上限用完 → 不发言」这条永远测不到，还会偶尔失败。
 *
 * 真实症状（2026-10-27 跑）：期望 speak=0，实际 1，
 * 因为上限计数被跨天重置了。
 */
const mkScheduler = (over = {}) => {
  const state = new ProactiveState()
  state.day = dayKey(at(10))   // 让「今天」= 测试里的那天
  const calls = { beg: 0, speak: 0 }
  /*
   * ⚠️ 调度器现在读的是 `cfgSource` / `begCfgSource`（getter），
   * 不再是 `cfg` / `begCfg`。这里必须跟着改成函数，否则传进去的配置
   * 被**静默忽略**、全部走默认值 —— 测试会「通过」但什么也没测到。
   */
  const cfg = { enabled: false, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24], ...(over.cfg ?? {}) }
  const begCfg = { enabled: false, checkIntervalMinutes: 60, maxPerDay: 3, ...(over.begCfg ?? {}) }
  const s = new ProactiveScheduler({
    cfgSource: () => cfg,
    begCfgSource: () => begCfg,
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
/*
 * ⚠️ `cfg` 必须在 `...over` **之后**展开。
 *
 * 原来写的是 `{ cfg: {...默认}, ...over }` —— over 里带了 cfg 时
 * 会把合并好的配置整个覆盖掉（默认值全丢），于是 maxPerDay 之类的
 * 用例拿到 undefined，测试静默失效（这个用例一直没测到东西）。
 */
const speakOn = (over = {}) => mkScheduler({
  ...over,
  cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24], ...(over.cfg ?? {}) },
})

await ok('静默不够久 → 不发言', async () => {
  const { s, calls } = speakOn({ idleMs: () => 10 * 60_000 })   // 才 10 分钟
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '45 分钟没到不该开口')
})

await ok('每日上限用完 → 不发言', async () => {
  const { s, state, calls } = speakOn({ cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 0, maxPerDay: 2, hours: [0, 24] } })
  state.speakCountGroup = 2
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '已经 2 次了（上限 2）')
})

await ok('冷却期内 → 不发言', async () => {
  const { s, state, calls } = speakOn()
  // 冷却按**类别**各算各的（2026-10-28）：speakOn 默认是 group:1，所以动群的时间戳
  state.lastSpeakAtGroup = at(9).getTime()   // 1 小时前说过（冷却 180 分钟）
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
  assert.equal(state.speakCountGroup, 1)
  assert.equal(state.lastSpeakAtGroup, at(10).getTime())
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

// ── 讨钱失败后要让位给发言 ────────────────────────────────────
await ok('讨钱失败 → 同一轮里发言顶上', async () => {
  const state = new ProactiveState()
  const calls = { beg: 0, speak: 0 }
  const s = new ProactiveScheduler({
    cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24] },
    begCfg: { enabled: true, checkIntervalMinutes: 60, maxPerDay: 3 },
    state,
    now: () => at(10).getTime(),
    checkBalance: async () => false,          // 余额查不到 / 正常
    onBeg: async () => { calls.beg++; return false },
    onSpeak: async () => { calls.speak++; return true },
    scopes: () => ['group:1'],
    idleMs: () => 999 * 60_000,
  })
  await s.tick(at(10))
  assert.equal(calls.beg, 0, '余额不低不该真讨')
  assert.equal(calls.speak, 1, '讨钱没做成时发言要顶上')
})

await ok('讨钱真的发出去了 → 同一轮不再发言', async () => {
  const state = new ProactiveState()
  const calls = { beg: 0, speak: 0 }
  const s = new ProactiveScheduler({
    cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24] },
    begCfg: { enabled: true, checkIntervalMinutes: 60, maxPerDay: 3 },
    state,
    now: () => at(10).getTime(),
    checkBalance: async () => true,
    onBeg: async () => { calls.beg++; return true },
    onSpeak: async () => { calls.speak++; return true },
    scopes: () => ['group:1'],
    idleMs: () => 999 * 60_000,
  })
  await s.tick(at(10))
  assert.equal(calls.beg, 1)
  assert.equal(calls.speak, 0, '同一轮只做一件事，避免像刷屏')
})

await ok('planSpeak 单独判断可用', () => {
  const state = new ProactiveState()
  const s = new ProactiveScheduler({
    cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24] },
    begCfg: { enabled: false },
    state,
    onSpeak: async () => true,
    scopes: () => ['group:1'],
    idleMs: () => 999 * 60_000,
  })
  assert.equal(s.planSpeak(at(10)).ok, true)
  assert.match(s.planSpeak(at(10)).reason, /可以发言/)
})


// ── 群 / 私聊额度分开算（2026-10-27 用户要求）────────────────
function mkSched(kinds, cfgOver = {}) {
  const state = new ProactiveState({ fs: { writeFileSync() {}, renameSync() {} }, file: '/tmp/none.json' })
  /*
   * ⚠️ 生产代码 `computeScopes()` 返回的是**字符串**（`group:123` / `private:456`），
   *    不是对象！这里原来造的是 `{ kind: 'private', scope: ... }` 对象，
   *    于是 `s.kind` 在测试里有值、在真机上恒为 undefined ——
   *    测试全绿但线上「私聊发言被记成群」+「群满了私聊也被过滤」。
   *    2026-10-28 发现这个 test/production 口径不一致，正是它掩盖了真 bug。
   */
  const scopeList = kinds.map((k, i) => (k === 'private' ? `private:1000${i}` : `group:2000${i}`))
  const sched = new ProactiveScheduler({
    cfg: { enabled: true, maxPerDay: 3, idleMinutes: 1, cooldownMinutes: 0, hours: [0, 24], ...cfgOver },
    begCfg: { enabled: false },
    state,
    scopes: () => scopeList,
    onSpeak: async () => true,
    now: () => new Date('2026-10-27T10:00:00+08:00').getTime(),
    log: {},
  })
  return { state, sched }
}

await ok('群额度用完不影响私聊额度', () => {
  const { state, sched } = mkSched(['group', 'private'])
  state.speakCountGroup = 3
  assert.equal(sched.speakLeft('group'), 0)
  assert.equal(sched.speakLeft('private'), 3)
})

await ok('私聊额度用完不影响群额度', () => {
  const { state, sched } = mkSched(['group', 'private'])
  state.speakCountPrivate = 3
  assert.equal(sched.speakLeft('group'), 3)
  assert.equal(sched.speakLeft('private'), 0)
})

await ok('scopesWithQuota 只留还有额度的类别', () => {
  const { state, sched } = mkSched(['group', 'private'])
  state.speakCountGroup = 3
  const list = sched.scopesWithQuota()
  assert.equal(list.length, 1, '应该只剩私聊')
  assert.ok(String(list[0]).startsWith('private:'), `剩下的应该是私聊，实际 ${list[0]}`)
})

await ok('两类都满 → planSpeak 报出各自剩余', () => {
  const { state, sched } = mkSched(['group', 'private'])
  state.speakCountGroup = 3
  state.speakCountPrivate = 3
  const r = sched.planSpeak(new Date('2026-10-27T10:00:00+08:00'))
  assert.equal(r.ok, false)
  assert.ok(/群：剩 0/.test(r.reason), `reason 要说明群剩多少，实际：${r.reason}`)
  assert.ok(/私聊：剩 0/.test(r.reason), `reason 要说明私聊剩多少，实际：${r.reason}`)
})

await ok('老 state.json 只有 speakCount → 迁移进群额度', () => {
  /*
   * ⚠️ ProactiveState **没有静态 fromJSON**，反序列化只发生在
   *    `load()` 里（`file` + `fs` 齐了才调）。所以测试要给一个
   *    假的 fs 去「读」那段老 JSON —— 直接传 opts.data 是无效的
   *    （这坑当场踩过两次）。
   */
  const oldJson = JSON.stringify({ day: dayKey(new Date()), speakCount: 2 })
  const st = new ProactiveState({
    file: '/tmp/fake-state.json',
    fs: {
      readFileSync: () => oldJson,
      writeFileSync() {},
      renameSync() {},
    },
  })
  assert.equal(st.speakCountGroup, 2, '未知来源的消耗算进群（保守）')
  assert.equal(st.speakCountPrivate, 0, '私聊不该被扣')
})

// ── scope 是字符串 / 分类冷却（2026-10-28 用户报「群里主动发言没触发」）──
await ok('kindOf 能解析字符串 scope', () => {
  const { sched } = mkSched(['group', 'private'])
  assert.equal(sched.kindOf('private:10000'), 'private')
  assert.equal(sched.kindOf('group:20000'), 'group')
  assert.equal(sched.kindOf('private:'), 'private')
  assert.equal(sched.kindOf(undefined), 'group', '兜底当群，不能崩')
})

await ok('私聊刚说过 → 群不受影响（分类冷却）', () => {
  const { state, sched } = mkSched(['group', 'private'], { cooldownMinutes: 180 })
  const now = new Date('2026-10-27T10:00:00+08:00').getTime()
  state.lastSpeakAtPrivate = now          // 刚在私聊主动说过
  const usable = sched.usableScopes(now)
  assert.ok(usable.some((s) => String(s).startsWith('group:')), '群应该还能说')
  assert.ok(!usable.some((s) => String(s).startsWith('private:')), '私聊应该还在冷却')
})

await ok('群里刚说过 → 私聊不受影响', () => {
  const { state, sched } = mkSched(['group', 'private'], { cooldownMinutes: 180 })
  const now = new Date('2026-10-27T10:00:00+08:00').getTime()
  state.lastSpeakAtGroup = now
  const usable = sched.usableScopes(now)
  assert.ok(usable.some((s) => String(s).startsWith('private:')), '私聊应该还能说')
  assert.ok(!usable.some((s) => String(s).startsWith('group:')), '群应该还在冷却')
})

await ok('私聊发言 → 记进 speakCountPrivate（不是 group）', async () => {
  const { state, sched } = mkSched(['private'], { cooldownMinutes: 0 })
  await sched._doSpeak(new Date('2026-10-27T10:00:00+08:00'))
  assert.equal(state.speakCountPrivate, 1, '应该记进私聊')
  assert.equal(state.speakCountGroup, 0, '不能记到群头上（这就是原 bug）')
  assert.ok(state.lastSpeakAtPrivate > 0, '应该更新私聊的冷却时间')
  assert.equal(state.lastSpeakAtGroup, 0, '不该动群的冷却时间')
})

await ok('群满但私聊还有额度 → 私聊仍可用（不被误过滤）', () => {
  const { state, sched } = mkSched(['group', 'private'], { cooldownMinutes: 0 })
  state.speakCountGroup = 3               // 群说满
  const usable = sched.usableScopes(Date.now())
  assert.equal(usable.length, 1, '应该只剩私聊')
  assert.ok(String(usable[0]).startsWith('private:'), `实际：${usable[0]}`)
})

// ── 「说了没人接就别再说了」（2026-10-31 加）─────────────────────
/*
 * ## 为什么加这条
 * 主动发言原来是**纯定时**：安静够 45 分钟就开口，3 次配额用完为止 ——
 * 本质是「**到点必须说一句**」。而真人不是：**说了一句没人接，第二次就不太想说了。**
 *
 * 参考麦麦（MaiBot）的 `idle_backoff.py`：连续"无事可做"之后**指数退避**，
 * 越来越不愿意说话。它甚至整个项目都**没有** proactive 功能。
 *
 * 判定：发言后开 30 分钟观察窗，窗内有人说话 → streak 归零；
 * 没人说话 → streak+1；streak >= 2 → 当天不再主动开口。
 */
const mkAckSched = (state, idleMinFn) =>
  new ProactiveScheduler({
    cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 180, maxPerDay: 3, hours: [8, 23], inGroups: true, inPrivate: false },
    state,
    idleMs: idleMinFn,
    scopes: () => ['group:1'],
    onSpeak: async () => true,
    log: {},
  })

await ok('★ 说了没人接 → streak +1', () => {
  const T0 = new Date('2026-10-31T10:00:00+08:00').getTime()
  const state = new ProactiveState({})
  let idleMin = 60
  const sched = mkAckSched(state, () => idleMin * 60_000)
  state.lastSpeakAtGroup = T0
  state.pendingAckGroup = true
  idleMin = 100 // 发言后又过 40 分钟，仍没人说话
  sched.settleAck(new Date(T0 + 40 * 60_000))
  assert.equal(state.ignoredStreakGroup, 1, '应记 1 次没人接')
  assert.equal(state.pendingAckGroup, false, '结算完要清掉 pending，别重复计')
})

await ok('★ 连续两次没人接 → 当天不再开口', () => {
  const T0 = new Date('2026-10-31T10:00:00+08:00').getTime()
  const state = new ProactiveState({})
  let idleMin = 60
  const sched = mkAckSched(state, () => idleMin * 60_000)
  // 第一次
  state.lastSpeakAtGroup = T0
  state.pendingAckGroup = true
  idleMin = 100
  sched.settleAck(new Date(T0 + 40 * 60_000))
  // 第二次
  state.lastSpeakAtGroup = T0 + 60 * 60_000
  state.pendingAckGroup = true
  idleMin = 140
  sched.settleAck(new Date(T0 + 100 * 60_000))
  assert.equal(state.ignoredStreakGroup, 2)
  idleMin = 200
  const p = sched.plan(new Date(T0 + 160 * 60_000))
  assert.equal(p.speak, false, '★ 连说两次没人理，就不该再说了')
})

await ok('★ 有人在观察窗内接话 → streak 归零（不是"没人理"）', () => {
  const T0 = new Date('2026-10-31T10:00:00+08:00').getTime()
  const state = new ProactiveState({})
  state.lastSpeakAtGroup = T0
  state.pendingAckGroup = true
  state.ignoredStreakGroup = 1
  // 发言后 10 分钟有人说过话 → idleMs(10) < 距发言(40)
  const sched = mkAckSched(state, () => 10 * 60_000)
  sched.settleAck(new Date(T0 + 40 * 60_000))
  assert.equal(state.ignoredStreakGroup, 0, '有人接就要归零')
})

await ok('有人刚说过话 → 顺手把碰壁感清掉', () => {
  const T0 = new Date('2026-10-31T10:00:00+08:00').getTime()
  const state = new ProactiveState({})
  state.ignoredStreakGroup = 2
  state.ignoredStreakPrivate = 1
  const sched = mkAckSched(state, () => 60_000) // 1 分钟前有人说话
  sched.settleAck(new Date(T0))
  assert.equal(state.ignoredStreakGroup, 0)
  assert.equal(state.ignoredStreakPrivate, 0)
})

await ok('还没到 30 分钟观察窗 → 不动 streak', () => {
  const T0 = new Date('2026-10-31T10:00:00+08:00').getTime()
  const state = new ProactiveState({})
  let idleMin = 10
  const sched = mkAckSched(state, () => idleMin * 60_000)
  state.lastSpeakAtGroup = T0
  state.pendingAckGroup = true
  sched.settleAck(new Date(T0 + 10 * 60_000)) // 才过 10 分钟
  assert.equal(state.ignoredStreakGroup, 0, '窗没结束不该判')
  assert.equal(state.pendingAckGroup, true, 'pending 要留着，等窗结束再结算')
})

ok('⚠️ 源码锁：settleAck 必须读写 this.state（第一版写成 this.* 静默失效）', () => {
  /*
   * 第一版把字段写成调度器自己的 `this.xxx` —— 但它们在 `this.state` 上。
   * 于是 `pendingAck` 恒 undefined → `continue` → **整个结算静默不生效**，
   * 探针里 streak 一直是 0 才暴露。这种"静默不生效"最坑，必须锁住。
   *
   * ⚠️ 查之前**必须剥掉注释**：解释这件事的注释里就写着那个错误写法，
   *    裸正则会把注释匹配上、报假失败（这个会话第 N 次撞注释了）。
   */
  const raw = fs.readFileSync(new URL('../src/qq/proactive.js', import.meta.url), 'utf8')
  const code = raw
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  const at = code.indexOf('settleAck(')
  assert.ok(at > 0, '要有 settleAck')
  const seg = code.slice(at, at + 1600)
  assert.match(seg, /const st = this\.state/, '要先取 this.state')
  assert.ok(
    !/[^.\w]this\.(pendingAck|ignoredStreak)/.test(seg),
    '不能直接用 this.pendingAck*/this.ignoredStreak*（它们在 state 上）',
  )
})

ok('⚠️ 源码锁：speakHint 不能再命令它「按『今天我』的状态说」', () => {
  /*
   * 那句就是「橘子」事故的源头 —— 它等于让模型**念日程表**：
   * 「洗漱完煮了八个速冻小馄饨，汤里放了紫菜、虾皮和几滴香油…」
   * 结果主动发言变成日记朗读（「福是真福，就是橘子吃完手黏」）。
   *
   * 现在改成：「今天我」只是**背景**，别人问才答，不要主动念。
   */
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = src.indexOf('const speakHint = idle < FRESH_MS')
  assert.ok(at > 0, '要能找到 speakHint')
  const seg = src.slice(at, at + 2200)
  assert.ok(
    !/按「今天我」的状态说/.test(seg),
    '不能再说「按『今天我』的状态说」—— 那就是让它念日程表',
  )
  assert.match(seg, /不要主动念日程/, '要明确禁止主动念日程')
  assert.match(seg, /\[SILENT\]/, '要允许沉默')
  assert.match(seg, /别因为/, '要写明"别因为该说话了就硬凑"')
})

// ── 随机冷却（2026-10-31）─────────────────────────────────────
/*
 * 用户原话：「定时发言就不要了，改成随机发言？群里和私聊都是」。
 *
 * 固定 `cooldownMinutes: 180` = 每天差不多同一时刻冒泡，很机械。
 * 现在实际间隔 = `cooldownMinutes ~ cooldownMinutes + cooldownJitterMinutes`
 * （默认 180~300 分钟），**每次发言掷一次**并存进 `nextSpeakAt*`。
 *
 * ⚠️ 关键是"只掷一次"：如果每 tick 重掷，累积概率会暴涨，又变回"到点必说"。
 */
const mkCoolSched = (state, t0) =>
  new ProactiveScheduler({
    cfg: { enabled: true, idleMinutes: 45, cooldownMinutes: 180, cooldownJitterMinutes: 120, maxPerDay: 3, hours: [8, 23], inGroups: true, inPrivate: false },
    state,
    idleMs: () => 99 * 60_000,
    scopes: () => ['group:1'],
    onSpeak: async () => true,
    log: {},
    random: () => 0.5,
  })

await ok('★ 随机冷却：发言后掷一次，间隔落在 180~300 分钟', () => {
  const T0 = new Date('2026-10-31T10:00:00+08:00').getTime()
  const sched = mkCoolSched(new ProactiveState({}))
  // random=0.5 → 180 + 0.5*120 = 240 分钟
  const base = 180 * 60_000
  const jit = 120 * 60_000
  sched.state.nextSpeakAtGroup = T0 + base + Math.round(0.5 * jit)
  assert.equal(sched.isCooled('group', T0 + 200 * 60_000), false, '200 分钟还没到 240，冷却中')
  assert.equal(sched.isCooled('group', T0 + 240 * 60_000), true, '240 分钟到了')
})

await ok('随机冷却：jitter=0 时退回固定 180（老行为）', () => {
  const T0 = new Date('2026-10-31T10:00:00+08:00').getTime()
  const state = new ProactiveState({})
  const sched = new ProactiveScheduler({
    cfg: { enabled: true, cooldownMinutes: 180, cooldownJitterMinutes: 0, maxPerDay: 3, hours: [8, 23], inGroups: true, inPrivate: false },
    state, idleMs: () => 99 * 60_000, scopes: () => ['group:1'], onSpeak: async () => true, log: {},
  })
  state.lastSpeakAtGroup = T0
  state.nextSpeakAtGroup = 0 // 没掷过 → 退回 lastSpeakAt + base
  assert.equal(sched.isCooled('group', T0 + 179 * 60_000), false)
  assert.equal(sched.isCooled('group', T0 + 181 * 60_000), true)
})

ok('⚠️ 源码锁：_doSpeak 的随机冷却必须走可注入的随机源', () => {
  const raw = fs.readFileSync(new URL('../src/qq/proactive.js', import.meta.url), 'utf8')
  const code = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const at = code.indexOf('async _doSpeak(')
  assert.ok(at > 0, '要有 _doSpeak')
  const seg = code.slice(at, at + 2400)
  assert.match(seg, /cooldownJitterMinutes/, '要用抖动配置')
  assert.match(seg, /nextSpeakAtGroup|nextSpeakAtPrivate/, '要存下次可发言时间')
  /*
   * ⚠️ 只锁**冷却那行**用注入的随机源。
   * `_doSpeak` 里还有一处合法的裸 `Math.random()` ——
   * `list[Math.floor(Math.random() * list.length)]`（随机挑一个会话）。
   * 第一版断言"整段不许出现 Math.random()"把这条也禁了，是**测试写太宽**。
   */
  assert.match(
    seg,
    /const rnd = \(this\._random \?\? Math\.random\)\(\)/,
    '随机冷却要走 this._random（否则测试没法固定）',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
