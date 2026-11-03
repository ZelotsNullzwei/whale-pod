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
  const cfg = { enabled: false, idleMinutes: 45, speakChance: 1, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24], ...(over.cfg ?? {}) }
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
  const { s, calls } = mkScheduler({ cfg: { enabled: true, idleMinutes: 45, speakChance: 1, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24] } })
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
  cfg: { enabled: true, idleMinutes: 45, speakChance: 1, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24], ...(over.cfg ?? {}) },
})

await ok('静默不够久 → 不发言', async () => {
  const { s, calls } = speakOn({ idleMs: () => 10 * 60_000 })   // 才 10 分钟
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '45 分钟没到不该开口')
})

await ok('每日上限用完 → 不发言', async () => {
  const { s, state, calls } = speakOn({ cfg: { enabled: true, idleMinutes: 45, speakChance: 1, cooldownMinutes: 0, maxPerDay: 2, hours: [0, 24] } })
  state.speakCountGroup = 2
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '已经 2 次了（上限 2）')
})

await ok('★ 没有冷却：刚说过也照样掷骰子（冷却器已拆）', async () => {
  const { s, state, calls } = speakOn()
  state.lastSpeakAtGroup = at(9).getTime()   // 1 小时前刚说过
  await s.tick(at(10))
  /*
   * 旧行为是「180 分钟内不许再说」—— 那条已经拆了
   * （用户原话：「之前不是说取消冷却器吗」「改成全随机发言」）。
   *
   * 现在 `lastSpeakAt*` **只是记录**（观察窗/统计用），不再拦人。
   * 闸门只剩四道：额度 / 时段 / 静默够久 / 骰子。
   * 所以"刚说过"不该再挡住 —— 挡住了就说明冷却器又长回来了。
   */
  assert.equal(calls.speak, 1, '刚说过不该拦着（没有冷却了）')
})

await ok('没有可发言的会话 → 不发言', async () => {
  const { s, calls } = speakOn({ scopes: () => [] })
  await s.tick(at(10))
  assert.equal(calls.speak, 0, '没有白名单会话就不该开口')
})

await ok('半夜 → 两个都不做', async () => {
  const { s, calls } = mkScheduler({
    cfg: { enabled: true, idleMinutes: 45, speakChance: 1, cooldownMinutes: 0, maxPerDay: 3, hours: [8, 23] },
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
    cfg: { enabled: true, idleMinutes: 45, speakChance: 1, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24] },
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
    cfg: { enabled: true, idleMinutes: 45, speakChance: 1, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24] },
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
    cfg: { enabled: true, idleMinutes: 45, speakChance: 1, cooldownMinutes: 180, maxPerDay: 3, hours: [0, 24] },
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
    cfg: { enabled: true, maxPerDay: 3, idleMinutes: 1, speakChance: 1, cooldownMinutes: 0, hours: [0, 24], ...cfgOver },
    begCfg: { enabled: false },
    state,
    scopes: () => scopeList,
    onSpeak: async () => true,
    now: () => new Date('2026-10-27T10:00:00+08:00').getTime(),
    log: {},
    /*
     * ⚠️ **必须给静默**（2026-11-03 加）。
     *
     * 这些用例直接调 `_doSpeak()`，绕过了 `plan()` 那道闸门；而
     * 2026-11-03 起 `_doSpeak` **自己**也要按会话判静默
     * （见 proactive.js 的 `speakableScopes`）——不给就恒为"不够安静"，
     * 于是「私聊发言记进 speakCountPrivate」那条会假失败。
     *
     * 给足静默，让这些用例测的仍是它们原本要测的东西（额度分类 / 记账）。
     */
    idleMs: () => 999 * 60_000,
    idleMsOf: () => 999 * 60_000,
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

await ok('★ 没有冷却：lastSpeakAt 只是记录，两个类别都不拦', () => {
  const { state, sched } = mkSched(['group', 'private'], { speakChance: 1 })
  const now = new Date('2026-10-27T10:00:00+08:00').getTime()
  state.lastSpeakAtPrivate = now          // 刚在私聊主动说过
  const usable = sched.usableScopes(now)
  /*
   * 旧断言是「私聊还在冷却、群不受影响」—— 冷却拆了（2026-11-02）。
   * `lastSpeakAt*` 现在只是**记录**（观察窗结算 / 统计用），不是闸门。
   * 所以两边都该能用。
   *
   * ⚠️ 真正要守的"分类各算各的"是**额度**，不是冷却 ——
   *    那条在下面「群满但私聊还有额度」的用例里。
   */
  assert.ok(usable.some((s) => String(s).startsWith('group:')), '群该能用')
  assert.ok(
    usable.some((s) => String(s).startsWith('private:')),
    '私聊也不该被 lastSpeakAt 拦住（那不是冷却，只是记录）',
  )
})

await ok('私聊发言 → 记进 speakCountPrivate（不是 group）', async () => {
  const { state, sched } = mkSched(['private'], { speakChance: 1, cooldownMinutes: 0 })
  await sched._doSpeak(new Date('2026-10-27T10:00:00+08:00'))
  assert.equal(state.speakCountPrivate, 1, '应该记进私聊')
  assert.equal(state.speakCountGroup, 0, '不能记到群头上（这就是原 bug）')
  assert.ok(state.lastSpeakAtPrivate > 0, '应该更新私聊的冷却时间')
  assert.equal(state.lastSpeakAtGroup, 0, '不该动群的冷却时间')
})

await ok('群满但私聊还有额度 → 私聊仍可用（不被误过滤）', () => {
  const { state, sched } = mkSched(['group', 'private'], { speakChance: 1, cooldownMinutes: 0 })
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
    cfg: { enabled: true, idleMinutes: 45, speakChance: 1, cooldownMinutes: 180, maxPerDay: 3, hours: [8, 23], inGroups: true, inPrivate: false },
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

// ── 全随机发言（2026-11-02，取代冷却器）────────────────────────
/*
 * 用户原话：「之前不是说取消冷却器吗」「改成全随机发言」。
 *
 * ## 冷却器为什么被换掉
 * 它是"发言后掷一次间隔（180~300 分钟）存进 nextSpeakAt，到点才允许说"。
 * 但那仍然是**定时器** —— 攒够时间必然说，只是周期随机。
 * 实测症状：日志整天 `群：剩 2 冷却中 / 私聊：剩 2 冷却中`，
 * 她几乎冒不出来。
 *
 * ## 现在
 * `maySpeakNow()`：每 60 秒的 tick **独立掷一次**，概率 `speakChance`。
 *
 * ⚠️ **同一 tick 内只掷一次**是这条的不变量（下面单独测）：
 *    `usableScopes()` 一轮里被调用多次，每次重掷会让实际概率
 *    变成 `1-(1-p)^n` —— 累积暴涨，又变回"到点必说"。
 */
const mkRollSched = (over = {}) =>
  new ProactiveScheduler({
    cfg: {
      enabled: true, speakChance: 0.6, maxPerDay: 3, hours: [8, 23],
      inGroups: true, inPrivate: false, idleMinutes: 45, ...over.cfg,
    },
    state: over.state ?? new ProactiveState({}),
    idleMs: () => 99 * 60_000,
    scopes: () => ['group:1'],
    onSpeak: async () => true,
    log: {},
    random: over.random ?? (() => 0.5),
  })

const T0 = new Date('2026-11-02T10:00:00+08:00').getTime()

await ok('★ 全随机发言：掷中概率就是 speakChance', () => {
  // random 固定 0.5 → 0.5 < 0.6 命中；0.5 < 0.4 不命中
  assert.equal(mkRollSched({ cfg: { speakChance: 0.6 } }).maySpeakNow(T0), true, '0.5<0.6 该掷中')
  assert.equal(mkRollSched({ cfg: { speakChance: 0.4 } }).maySpeakNow(T0), false, '0.5<0.4 不该掷中')
  assert.equal(mkRollSched({ cfg: { speakChance: 0 } }).maySpeakNow(T0), false, '0 = 永不')
  assert.equal(mkRollSched({ cfg: { speakChance: 1 } }).maySpeakNow(T0), true, '1 = 必说')
})

await ok('★★ 同一 tick 内只掷一次（否则概率会累积暴涨）', () => {
  let calls = 0
  const sched = mkRollSched({ random: () => { calls++; return 0.5 } })
  const r1 = sched.maySpeakNow(T0)
  const r2 = sched.maySpeakNow(T0)
  const r3 = sched.maySpeakNow(T0 + 999)   // 同一个 60 秒桶
  assert.equal(calls, 1, `同一个 tick 只能掷 1 次，实际掷了 ${calls} 次`)
  assert.equal(r1, r2, '同 tick 结果必须一致')
  assert.equal(r2, r3, '同 tick 内（哪怕差 999ms）也要一致')
})

await ok('★ 换一个 tick 会重新掷', () => {
  let calls = 0
  const sched = mkRollSched({ random: () => { calls++; return 0.5 } })
  sched.maySpeakNow(T0)
  sched.maySpeakNow(T0 + 60_000)   // 下一个桶
  assert.equal(calls, 2, '跨 tick 必须重掷')
})

await ok('★ usableScopes 看骰子，不看冷却', () => {
  // 掷中 → 会话可用
  const hit = mkRollSched({ cfg: { speakChance: 0.6 } })
  assert.deepEqual(hit.usableScopes(T0), ['group:1'], '掷中就该可用')
  // 没掷中 → 不可用（哪怕额度还有、也没有"冷却"这回事）
  const miss = mkRollSched({ cfg: { speakChance: 0.4 } })
  assert.deepEqual(miss.usableScopes(T0), [], '没掷中就该不可用')
  /*
   * 额度用满 → 掷中也没用。
   *
   * ⚠️ `ProactiveState` 的构造函数**不吃任意字段**（只认 opts.fs / opts.file），
   *    传 `{ speakCountGroup: 3 }` 是**静默无效**的 —— 第一版就这么写错了，
   *    用例红得莫名其妙。要在构造之后**直接赋字段**。
   */
  const st = new ProactiveState({})
  st.speakCountGroup = 3
  const full = mkRollSched({ cfg: { speakChance: 0.6 }, state: st })
  assert.deepEqual(full.usableScopes(T0), [], '额度满了就算掷中也不发')
})

ok('⚠️ 源码锁：冷却器真的拆了，别又长回来', () => {
  const raw = fs.readFileSync(new URL('../src/qq/proactive.js', import.meta.url), 'utf8')
  const code = raw.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.ok(!/isCooled\s*\(/.test(code), '不该再有 isCooled 调用')
  assert.match(code, /maySpeakNow\s*\(/, '要有 maySpeakNow')
  /*
   * ⚠️ **只锁 `_doSpeak` 里不再"掷间隔"**，不锁全文件。
   *
   * `nextSpeakAtGroup = 0` 在 `resetDaily()` 里还有 —— 那是**合法的**：
   * state 里字段保留着（老存档有值），每天重置一下免得越积越脏。
   * 第一版断言"全文件不许出现 nextSpeakAtGroup =" 把这条也禁了，是**测试写太宽**。
   *
   * 真正要守的是：`_doSpeak` **发言后不再算下次时间** ——
   * 一旦又算了，就等于冷却器悄悄长回来了。
   */
  const at = code.indexOf('async _doSpeak(')
  assert.ok(at > 0, '要有 _doSpeak')
  const seg = code.slice(at, at + 2000)
  assert.ok(!/nextSpeakAt(Group|Private)\s*=/.test(seg), '_doSpeak 不该再掷"下次可发言时间"')
  assert.ok(!/cooldownJitterMinutes/.test(seg), '_doSpeak 不该再用冷却抖动')
  /*
   * 骰子必须走 `this._random` —— 否则测试没法固定，只能靠统计碰运气。
   * 顺带：`_doSpeak` 里另有一处合法的裸 `Math.random()`（随机挑一个会话），
   * 所以只锁 `maySpeakNow` 那一段。
   */
  const atRoll = code.indexOf('maySpeakNow(')
  assert.ok(atRoll > 0, '要有 maySpeakNow')
  const rollSeg = code.slice(atRoll, atRoll + 900)
  assert.match(rollSeg, /this\._random \?\? Math\.random/, '骰子要走 this._random')
})

// ── 静默必须**按会话**算（2026-11-03）──────────────────────────
/*
 * ## 事故现场
 * ```
 * 22:32:32 proactive：plan → 群里安静够久了
 * 22:32:37 proactive：[我主动] private:2129024700（私聊，2 条）
 * ```
 * 日志说"群里"，实际发到**私聊** —— 而那个私聊几分钟前才说过话。
 * 根因：门槛用全局「**最长**静默」（群静 3 小时就算过），选场却**随机**抽。
 * 两个方向都出问题：可能插进刚聊过天的会话（"乱接"），
 * 也可能让明明最安静的群永远等不到她开口（用户报的"自动发言没生效"）。
 *
 * ## 另一件事：日志把三道闸门糊成一句
 * 老 `planSpeak` 先判「额度 + 骰子」，不中就 return —— 静默状态**根本不打印**。
 * 一整天的日志全是同一句「没有可用会话（剩 3 等骰子(0.004)）」，
 * 排查只能靠翻 proactive.json 反推。下面也把它锁住。
 */
const mkQuietSched = (groupIdleMin, privIdleMin, cfgOver = {}) => {
  const state = new ProactiveState({ fs: { writeFileSync() {}, renameSync() {} }, file: '/tmp/none.json' })
  const sent = []
  const sched = new ProactiveScheduler({
    cfg: { enabled: true, maxPerDay: 3, idleMinutes: 45, speakChance: 1, hours: [0, 24], ...cfgOver },
    begCfg: { enabled: false },
    state,
    scopes: () => ['group:20001', 'private:10001'],
    // 全局值 = 两者取大（就是老代码的口径），按会话的值分开给
    idleMs: () => Math.max(groupIdleMin, privIdleMin) * 60_000,
    idleMsOf: (scope) => (String(scope).startsWith('group:') ? groupIdleMin : privIdleMin) * 60_000,
    onSpeak: async (scope) => { sent.push(scope); return true },
    now: () => at(10).getTime(),
    log: {},
  })
  return { state, sched, sent }
}

await ok('★★ 不安静的会话不进候选：群静 3 小时、私聊才 2 分钟 → 只可能是群', () => {
  const { sched } = mkQuietSched(180, 2)
  assert.deepEqual(sched.speakableScopes(at(10).getTime()), ['group:20001'],
    '刚聊过天的私聊不该进候选')
})

await ok('★★ 反过来：只有私聊安静 → 只可能是私聊', () => {
  const { sched } = mkQuietSched(2, 180)
  assert.deepEqual(sched.speakableScopes(at(10).getTime()), ['private:10001'])
})

await ok('★★ _doSpeak 只能发到"自己安静够久"的会话（旧代码会随机挑中刚聊过的那个）', async () => {
  const { sched, sent } = mkQuietSched(180, 2)
  for (let i = 0; i < 20; i++) await sched._doSpeak(at(10))   // 多掷几次，把随机性覆盖掉
  assert.ok(sent.length > 0, '该发出去了')
  assert.ok(sent.every((s) => s === 'group:20001'),
    `一次都不许发进"2 分钟前还在聊"的私聊，实际：${sent.join(',')}`)
})

await ok('★ plan 的标签按**实际**安静的会话说，不再写死"群里"', () => {
  assert.match(mkQuietSched(180, 2).sched.plan(at(10)).reason, /群里安静够久了/)
  assert.match(mkQuietSched(2, 180).sched.plan(at(10)).reason, /私聊安静够久了/)
})

await ok('★★ planSpeak 要把三道闸门**都**报出来（额度 / 骰子 / 静默）', () => {
  const { sched } = mkQuietSched(2, 2)          // 掷中（speakChance 1），但两边都不够安静
  const r = sched.planSpeak(at(10))
  assert.equal(r.ok, false)
  assert.ok(/群：剩 3/.test(r.reason), `要报群额度：${r.reason}`)
  assert.ok(/私聊：剩 3/.test(r.reason), `要报私聊额度：${r.reason}`)
  assert.ok(/掷中|没掷中/.test(r.reason), `要报这一 tick 掷没掷中：${r.reason}`)
  assert.ok(/静默/.test(r.reason), `要报静默 —— 老代码这里不打印，排查只能靠猜：${r.reason}`)
  assert.ok(/群=2分/.test(r.reason), `要带出各会话的静默分钟数：${r.reason}`)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
