/**
 * 事件记忆层（2026-11-04）。
 *
 * ## 守什么
 * ① 衰减公式对：24h 半衰期 = ×0.5，私聊 48h 慢一倍
 * ② 冻结线：<0.1 **不注入但数据留着**（"忘" ≠ "丢"）
 * ③ 复活 + 迟滞：冻到 0.02 的事被重提 → 先回 0.15 再 +0.5，不会回到 1
 * ④ 强化只认"她真用上了"，且有冷却
 * ⑤ 抽取节流：攒够条数才调模型；计数回退（重启）要能自愈，不能永久停摆
 * ⑥ 落盘能回读（强度、游标都在）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EventStore,
  EVENT_DEFAULTS,
  EXTRACT_PROMPT,
  parseExtracted,
  decayStrength,
  usedInReply,
  relativeTime,
} from '../src/memory/events.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const H = 3600_000
const quiet = { log: {} }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-events-'))

console.log('=== 1. 衰减公式 ===')
ok('24 小时 = 一半', () => {
  assert.equal(decayStrength(1, 24 * H, 24), 0.5)
  assert.equal(decayStrength(1, 48 * H, 24), 0.25)
})
ok('私聊 48 小时才一半（比群里忘得慢）', () => {
  assert.equal(decayStrength(1, 24 * H, 48), Math.SQRT1_2)
  assert.equal(decayStrength(1, 48 * H, 48), 0.5)
})
ok('时间/半衰期非法时不乱来', () => {
  assert.equal(decayStrength(1, 0, 24), 1)
  assert.equal(decayStrength(1, H, 0), 1)
  assert.equal(decayStrength(NaN, H, 24), 0)
  assert.ok(decayStrength(1, 1000 * H, 24) <= 1)
})

console.log('\n=== 2. 冻结 / 复活 / 迟滞 ===')
ok('24h 后强度 0.5，还活着', () => {
  const s = new EventStore({ cfg: {}, ...quiet })
  const t0 = 1_700_000_000_000
  s.remember('group:1', [{ kind: 'promise', text: '给他留一碗饭' }], { now: t0 })
  const act = s.active('group:1', { now: t0 + 24 * H })
  assert.equal(act.length, 1)
  assert.ok(Math.abs(act[0].strength - 0.5) < 1e-9)
})

ok('4 天后 <0.1 → 冻结：不注入、但数据还在', () => {
  const s = new EventStore({ cfg: {}, ...quiet })
  const t0 = 1_700_000_000_000
  s.remember('group:1', [{ kind: 'promise', text: '给他留一碗饭' }], { now: t0 })
  assert.equal(s.toPrompt('group:1', { now: t0 + 96 * H }), '')
  assert.equal(s.list('group:1').length, 1, '数据必须留着')
  assert.equal(s.list('group:1')[0].frozen, true)
})

ok('被重提 → 复活到 0.15 再 +0.5（迟滞，不回到 1）', () => {
  const s = new EventStore({ cfg: {}, ...quiet })
  const t0 = 1_700_000_000_000
  s.remember('group:1', [{ kind: 'promise', text: '给他留一碗饭' }], { now: t0 })
  // 冻到几乎没了
  s.active('group:1', { now: t0 + 200 * H })
  const before = s.list('group:1')[0].strength
  assert.ok(before < EVENT_DEFAULTS.pruneThreshold)
  const r = s.remember('group:1', [{ kind: 'promise', text: '给他留一碗饭' }], { now: t0 + 200 * H })
  assert.equal(r.revived, 1)
  const after = s.list('group:1')[0].strength
  assert.ok(after > EVENT_DEFAULTS.pruneThreshold, '必须活过来')
  assert.ok(after < 1, '不该一碰就满格')
})

ok('同义重提不重复记（包含关系也算同一件）', () => {
  const s = new EventStore({ cfg: {}, ...quiet })
  const t0 = 1_700_000_000_000
  s.remember('group:1', [{ kind: 'fact', text: '周末常去图书馆' }], { now: t0 })
  s.remember('group:1', [{ kind: 'fact', text: '常去图书馆' }], { now: t0 + 1000 })
  assert.equal(s.list('group:1').length, 1)
  assert.equal(s.list('group:1')[0].hits, 2)
})

console.log('\n=== 3. 强化（她用上了没有） ===')
ok('字面重叠判"用上了"，无关回复判"没用上"', () => {
  assert.equal(usedInReply('答应给他留一碗饭', '行，我给你留一碗米饭'), true)
  assert.equal(usedInReply('答应给他留一碗饭', '今天好热啊'), false)
})
ok('真用上 → +0.1；同一个冷却期内不重复加', () => {
  const s = new EventStore({ cfg: {}, ...quiet })
  const t0 = 1_700_000_000_000
  s.remember('private:42', [{ kind: 'promise', text: '给他留一碗饭' }], { now: t0 })
  const prompt = s.toPrompt('private:42', { now: t0 })
  assert.match(prompt, /留一碗饭/)
  const n1 = s.reinforceFromReply('private:42', '我给你留一碗饭来着', { now: t0 + 1000 })
  assert.equal(n1, 1)
  const s1 = s.list('private:42')[0].strength
  s.toPrompt('private:42', { now: t0 + 2000 })
  const n2 = s.reinforceFromReply('private:42', '我给你留一碗饭来着', { now: t0 + 3000 })
  assert.equal(n2, 0, '冷却期内不该再加')
  assert.equal(s.list('private:42')[0].strength, s1)
})
ok('没用上就不加', () => {
  const s = new EventStore({ cfg: {}, ...quiet })
  const t0 = 1_700_000_000_000
  s.remember('private:42', [{ kind: 'fact', text: '这周在赶毕设' }], { now: t0 })
  s.toPrompt('private:42', { now: t0 })
  const n = s.reinforceFromReply('private:42', '哈哈哈好', { now: t0 + 1000 })
  assert.equal(n, 0)
})

console.log('\n=== 4. 提示词长什么样 ===')
ok('带标题、类型标签、相对时间', () => {
  const s = new EventStore({ cfg: {}, ...quiet })
  const t0 = 1_700_000_000_000
  s.remember('group:1', [
    { kind: 'promise', text: '给他留一碗饭' },
    { kind: 'fact', text: '周末常去图书馆' },
  ], { now: t0 })
  const p = s.toPrompt('group:1', { now: t0 + 3 * H })
  assert.match(p, /^## 今天记着的事/)
  assert.match(p, /\[答应过\] 给他留一碗饭（3 小时前）/)
  assert.match(p, /\[他说过\] 周末常去图书馆（3 小时前）/)
  assert.match(p, /不是新消息/)
})
ok('超出注入预算就截断，不会塞爆提示词', () => {
  const s = new EventStore({ cfg: { injectMax: 2 }, ...quiet })
  const t0 = 1_700_000_000_000
  s.remember('group:1', [1, 2, 3, 4].map((i) => ({ kind: 'fact', text: `第${i}件事` })), { now: t0 })
  const p = s.toPrompt('group:1', { now: t0 })
  assert.equal((p.match(/^- /gm) ?? []).length, 2)
})
ok('关掉开关 → 一条都不注入', () => {
  const s = new EventStore({ cfg: { enabled: false }, ...quiet })
  s.remember('group:1', [{ kind: 'fact', text: '周末常去图书馆' }], { now: 1 })
  assert.equal(s.toPrompt('group:1'), '')
})

console.log('\n=== 5. 抽取解析 ===')
ok('认得出四种类型，全角竖线/冒号也认', () => {
  const items = parseExtracted([
    'promise | 给他留一碗饭',
    'fact：周末常去图书馆',
    'state｜这周在赶毕设',
    '- name | 管他叫老陈',
  ].join('\n'))
  assert.deepEqual(items.map((x) => x.kind), ['promise', 'fact', 'state', 'name'])
  assert.equal(items[0].text, '给他留一碗饭')
})
ok('NONE / 解释性文字 / 未知类型一律丢', () => {
  assert.deepEqual(parseExtracted('NONE'), [])
  assert.deepEqual(parseExtracted('好的，我来看看：\n没有'), [])
  assert.deepEqual(parseExtracted('mood | 他今天不开心'), [])
})

console.log('\n=== 6. 抽取节流 + 游标自愈 ===')
await (async () => {
  const calls = []
  const s = new EventStore({
    cfg: { extractAfter: 3 },
    ...quiet,
    extract: async ({ messages }) => {
      calls.push(messages.map((m) => m.text))
      return 'promise | 给他留一碗饭'
    },
  })
  const msgs = (n) => Array.from({ length: n }, (_, i) => ({ text: `m${i}`, sender: '1', senderName: '甲' }))
  await okAsync('没攒够条数 → 一次都不调模型', async () => {
    const r = await s.maybeExtract({ scope: 'group:1', messages: msgs(2), total: 2 })
    assert.equal(r, false)
    assert.equal(calls.length, 0)
  })
  await okAsync('攒够了 → 调一次，且只把新增的送进去', async () => {
    const r = await s.maybeExtract({ scope: 'group:1', messages: msgs(3), total: 3 })
    assert.equal(r, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].length, 3)
    assert.equal(s.list('group:1')[0].text, '给他留一碗饭')
  })
  await okAsync('同一批不重复抽', async () => {
    await s.maybeExtract({ scope: 'group:1', messages: msgs(3), total: 3 })
    assert.equal(calls.length, 1)
  })
  await okAsync('计数回退（重启）→ 游标归零，之后还能抽', async () => {
    await s.maybeExtract({ scope: 'group:1', messages: msgs(1), total: 1 })
    assert.equal(calls.length, 1, '回退本身不该抽')
    await s.maybeExtract({ scope: 'group:1', messages: msgs(4), total: 4 })
    assert.equal(calls.length, 2, '归零后攒够 3 条要能重新抽')
  })
  await okAsync('抽取抛错不影响，也不反复重试把余额打穿', async () => {
    const boom = new EventStore({
      cfg: { extractAfter: 2 },
      ...quiet,
      extract: async () => { throw new Error('掉线') },
    })
    assert.equal(await boom.maybeExtract({ scope: 'g', messages: msgs(2), total: 2 }), false)
    assert.equal(await boom.maybeExtract({ scope: 'g', messages: msgs(2), total: 2 }), false)
    assert.equal(boom.stats().events, 0)
  })
})()

console.log('\n=== 7. 落盘回读 ===')
ok('强度/命中次数/游标都能存回去', () => {
  const dir = tmp()
  const t0 = 1_700_000_000_000
  const a = new EventStore({ cfg: {}, dir, ...quiet })
  a.remember('group:9', [{ kind: 'promise', text: '给他留一碗饭' }], { now: t0 })
  a.active('group:9', { now: t0 + 24 * H })
  a.flush()

  const b = new EventStore({ cfg: {}, dir, ...quiet })
  b.load()
  const list = b.list('group:9')
  assert.equal(list.length, 1)
  assert.equal(list[0].text, '给他留一碗饭')
  assert.ok(Math.abs(list[0].strength - 0.5) < 1e-6, '强度要跟着落盘')
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n=== 8. 配置默认值 / 提示词自洽 ===')
ok('默认值跟 MaiBot 的比例一致（迟滞：revive > prune）', () => {
  assert.ok(EVENT_DEFAULTS.reviveTo > EVENT_DEFAULTS.pruneThreshold)
  assert.equal(EVENT_DEFAULTS.halfLifeHours, 24)
  assert.equal(EVENT_DEFAULTS.privateHalfLifeHours, 48)
})
ok('抽取提示词带着两个占位符（index.js 要替换它们）', () => {
  assert.ok(EXTRACT_PROMPT.includes('{known}'))
  assert.ok(EXTRACT_PROMPT.includes('{messages}'))
  // ⚠️ 模板字符串里绝不能出现反引号 —— 会把提示词截断（踩过两次）
  assert.ok(!EXTRACT_PROMPT.includes('`'))
})
ok('相对时间说法正常', () => {
  assert.equal(relativeTime(30_000), '刚刚')
  assert.equal(relativeTime(50 * 60_000), '50 分钟前')
  assert.equal(relativeTime(3 * H), '3 小时前')
  assert.equal(relativeTime(26 * H), '昨天')
})

console.log('\n=== 9. bridge 接线：一进一出（_touchEvents）===')
/*
 * 这一节不造完整的 QQBridge —— 只要原型上的那一个方法。
 * `_touchEvents` 的全部依赖就是 `this.events` / `this.log` / 传进来的 mem，
 * 用 `Object.create` 拿原型既跑的是**真代码**，又不用拖起 onebot/网关。
 */
const { QQBridge } = await import('../src/qq/bridge.js')
const probe = (events) => {
  const b = Object.create(QQBridge.prototype)
  b.events = events
  b.log = {}
  return b
}
const memOf = (msgs, total = msgs.length) => ({
  recent: (n) => (n == null ? msgs : msgs.slice(-n)),
  totalPushed: total,
})

ok('刚发出去的回复 → 交给 reinforceFromReply', () => {
  const calls = []
  const b = probe({
    enabled: true,
    reinforceFromReply: (...a) => calls.push(a),
    maybeExtract: async () => false,
  })
  b._touchEvents('group:1', memOf([{ isMe: true, text: '我给你留一碗饭', at: Date.now() }]), {})
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'group:1')
  assert.equal(calls[0][1], '我给你留一碗饭')
})

ok('很久以前的自己消息 → 不强化（那是历史，不是这一轮）', () => {
  const calls = []
  const b = probe({
    enabled: true,
    reinforceFromReply: (...a) => calls.push(a),
    maybeExtract: async () => false,
  })
  b._touchEvents('group:1', memOf([{ isMe: true, text: '我给你留一碗饭', at: Date.now() - 5 * 60_000 }]), {})
  assert.equal(calls.length, 0)
})

ok('别人说的话不算"她用上了"', () => {
  const calls = []
  const b = probe({
    enabled: true,
    reinforceFromReply: (...a) => calls.push(a),
    maybeExtract: async () => false,
  })
  b._touchEvents('group:1', memOf([{ isMe: false, text: '我给你留一碗饭', at: Date.now() }]), {})
  assert.equal(calls.length, 0)
})

await okAsync('抽取是异步派出去的，参数带着 scope/messages/total', async () => {
  const seen = []
  const b = probe({
    enabled: true,
    reinforceFromReply: () => 0,
    maybeExtract: async (o) => { seen.push(o); return false },
  })
  const msgs = [{ isMe: false, text: 'a' }, { isMe: false, text: 'b' }]
  b._touchEvents('private:7', memOf(msgs, 9), { kind: 'private' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].scope, 'private:7')
  assert.equal(seen[0].total, 9)
  assert.deepEqual(seen[0].messages.map((m) => m.text), ['a', 'b'])
})

ok('没有事件层（老调用/测试）→ 一声不响，不抛错', () => {
  const b = probe(null)
  b._touchEvents('group:1', memOf([{ isMe: true, text: 'x', at: Date.now() }]), {})
})

ok('事件层被关掉 → 强化和抽取都不调', () => {
  const calls = []
  const b = probe({
    enabled: false,
    reinforceFromReply: (...a) => calls.push(a),
    maybeExtract: async () => { calls.push('extract'); return false },
  })
  b._touchEvents('group:1', memOf([{ isMe: true, text: 'x', at: Date.now() }]), {})
  assert.equal(calls.length, 0)
})

console.log('\n=== 10. 抽了但没抽到 → 游标也要落盘 ===')
await okAsync('重启后同一批不重抽（省一次白花的 LLM 调用）', async () => {
  const dir = tmp()
  let calls = 0
  const a = new EventStore({
    cfg: { extractAfter: 2 },
    dir,
    log: {},
    extract: async () => { calls++; return 'NONE' },
  })
  const msgs = [{ text: 'a', sender: '1', senderName: '甲' }, { text: 'b', sender: '1', senderName: '甲' }]
  assert.equal(await a.maybeExtract({ scope: 'group:5', messages: msgs, total: 2 }), false)
  assert.equal(calls, 1)
  a.flush()

  const b = new EventStore({
    cfg: { extractAfter: 2 },
    dir,
    log: {},
    extract: async () => { calls++; return 'NONE' },
  })
  b.load()
  await b.maybeExtract({ scope: 'group:5', messages: msgs, total: 2 })
  assert.equal(calls, 1, '重启后不该把同一批再抽一遍')
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)