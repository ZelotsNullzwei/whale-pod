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

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
