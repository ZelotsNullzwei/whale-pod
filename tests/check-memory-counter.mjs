/**
 * 「记忆计数回退」的回归测试（2026-10-29）。
 *
 * ## 现象
 * 41 分钟里长期摘要跑了**两次**（白花一次模型调用）：
 * ```
 * 23:14:44  已更新摘要（累计 41 条）
 * 23:14:55  重启（taskkill /T /F）
 * 23:15:45  计数回退（23 < 41）→ 基线归零
 * 23:15:55  又更新摘要（累计 23 条）   ← 同一批内容被再摘一遍
 * ```
 *
 * ## 根因（两处）
 * 1. **短期记忆没有 `flush()`**，`index.js` 的关闭钩子里也没人调 `save()`
 *    → 只靠 2 秒防抖落盘 → 被硬杀时最后那批 `totalPushed` 永久丢失
 * 2. **回退时一概归零** → 把"丢增量"当成"过夜重置" → 重复摘要
 *
 * ## 两种回退必须分开
 * | | 形态 | 该怎么处理 |
 * |---|---|---|
 * | 过夜重置（短期记忆过期) | `60 → 2`（剩 3%） | 归零，让新内容尽快摘要 |
 * | 丢增量（硬杀/崩溃） | `41 → 23`（剩 56%） | 对齐到当前总数，**不要重摘** |
 *
 * 判据：**回退后还剩多少比例**。剩 ≥40% 视为丢增量。
 * 把"重置"误判成"丢增量"只会晚一点开始攒；反过来才会白摘一次 ——
 * 所以阈值故意偏向"丢增量"。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore } from '../src/memory/short.js'
import { LongTermStore } from '../src/memory/long.js'

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

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'))

// ── ① flush()：不再只靠 2 秒防抖 ───────────────────────────
ok('push 之后 flush() 立刻写盘（不等 2 秒防抖）', () => {
  const dir = tmpDir()
  const store = new MemoryStore({ dir, log: {} })
  const m = store.get('group:1')
  m.push({ text: '第一句', senderName: '甲', sender: '111111111' })
  m.push({ text: '第二句', senderName: '甲', sender: '111111111' })
  assert.equal(m.totalPushed, 2)
  assert.ok(!fs.existsSync(store.file), '还没 flush 时不该已经落盘（防抖未到点）')
  store.flush()
  assert.ok(fs.existsSync(store.file), 'flush 之后必须落盘')
  const j = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  assert.equal(j.sessions['group:1'].totalPushed, 2, 'totalPushed 必须写进去')
  assert.equal(j.sessions['group:1'].messages.length, 2)
})

ok('flush() 之后新进程能读回同一个 totalPushed（这是丢增量的反面）', () => {
  const dir = tmpDir()
  const a = new MemoryStore({ dir, log: {} })
  for (let i = 0; i < 5; i++) a.get('private:9').push({ text: `第${i}句`, senderName: '乙', sender: '9' })
  a.flush()
  const b = new MemoryStore({ dir, log: {} })
  b.load()
  assert.equal(b.get('private:9').totalPushed, 5, '重启后不该回退 —— 回退会触发重复摘要')
})

ok('没有脏数据时 flush() 什么都不做（不报错）', () => {
  const store = new MemoryStore({ dir: tmpDir(), log: {} })
  store.flush()
  assert.equal(fs.existsSync(store.file), false)
})

// ── ② 回退分级 ─────────────────────────────────────────────
function mkLong(summarize) {
  return new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 20 },
    summarize: summarize ?? (async () => '【人】\n111111111 | 甲 | x'),
    log: {},
  })
}
const MSGS = Array.from({ length: 25 }, (_, i) => ({ text: `m${i}`, senderName: '甲', sender: '111111111' }))

const HOUR = 3600_000

await okAsync('丢增量（41 → 23，摘要在本会话内）→ **不重复摘要**', async () => {
  let calls = 0
  const store = mkLong(async () => { calls++; return '【人】\n111111111 | 甲 | x' })
  const m = store.get('group:1')
  const now = Date.now()
  m.summarizedTotal = 41
  m.updatedAt = now                      // 摘要刚在本会话内发生
  const did = await store.maybeSummarize('group:1', {
    messages: MSGS, total: 23, sessionStartedAt: now - HOUR,
  })
  assert.equal(did, false, '不该摘 —— 这会白花一次调用')
  assert.equal(calls, 0)
  assert.equal(m.summarizedTotal, 23, '基线应对齐到当前总数')
})

await okAsync('过夜重置（60 → 37，摘要属于上个会话）→ 归零并**真的摘要**', async () => {
  let calls = 0
  const store = mkLong(async () => { calls++; return '【人】\n111111111 | 甲 | x' })
  const m = store.get('group:2')
  const now = Date.now()
  m.summarizedTotal = 60
  m.updatedAt = now - 10 * HOUR         // 摘要是昨天下午的
  const did = await store.maybeSummarize('group:2', {
    messages: MSGS, total: 37, sessionStartedAt: now - HOUR,   // 会话是今早才建的
  })
  assert.equal(did, true, '37 ≥ 20，该摘要（否则「记不住事」那个 bug 回来）')
  assert.equal(calls, 1)
  assert.equal(m.summarizedTotal, 37)
})

await okAsync('⚠️ 不传 sessionStartedAt（老调用）→ 保守按"重置"处理', async () => {
  let calls = 0
  const store = mkLong(async () => { calls++; return '【人】\n111111111 | 甲 | x' })
  const m = store.get('group:5')
  m.summarizedTotal = 60
  m.updatedAt = Date.now()
  const did = await store.maybeSummarize('group:5', { messages: MSGS, total: 37 })
  assert.equal(did, true, '不知道会话边界时，宁可多摘一次也别把新内容冻住')
  assert.equal(calls, 1)
})

await okAsync('没回退的正常增量照旧（23 → 43 直接摘）', async () => {
  let calls = 0
  const store = mkLong(async () => { calls++; return '【人】\n111111111 | 甲 | x' })
  const m = store.get('group:4')
  m.summarizedTotal = 23
  const did = await store.maybeSummarize('group:4', { messages: MSGS, total: 43 })
  assert.equal(did, true)
  assert.equal(calls, 1)
  assert.equal(m.summarizedTotal, 43)
})

// ── ③ 最要命的那个：载入的会话必须也能触发落盘 ─────────────
/*
 * ⚠️ 原来 `onChange` 只在 `get()` 的「新建会话」分支里挂，`load()` 不挂。
 * 于是：重启 → 会话全部从磁盘载入 → 都不触发 touch() → **短期记忆当场冻结**。
 * 实测 `memory-short.json` 停在 20:52:33，中间 35 条私聊消息一个字没存。
 */
ok('⚠️ 载入的会话 push 之后必须标脏（否则永远不会落盘）', () => {
  const dir = tmpDir()
  const a = new MemoryStore({ dir, log: {} })
  a.get('group:1').push({ text: '旧消息', senderName: '甲', sender: '111111111' })
  a.flush()

  const b = new MemoryStore({ dir, log: {} })
  b.load()
  assert.equal(b._dirty, false, '刚载入时不该脏')
  b.get('group:1').push({ text: '新消息', senderName: '甲', sender: '111111111' })
  assert.equal(b._dirty, true, 'push 之后必须标脏 —— 否则 2 秒防抖永远起不来，记忆冻结')
})

ok('载入 → push → flush → 新进程能看到两条（端到端）', () => {
  const dir = tmpDir()
  const a = new MemoryStore({ dir, log: {} })
  a.get('private:9').push({ text: '第一句', senderName: '乙', sender: '9' })
  a.flush()

  const b = new MemoryStore({ dir, log: {} })
  b.load()
  b.get('private:9').push({ text: '第二句', senderName: '乙', sender: '9' })
  b.flush()

  const c = new MemoryStore({ dir, log: {} })
  c.load()
  const m = c.get('private:9')
  assert.equal(m.totalPushed, 2, 'totalPushed 必须跟着涨')
  assert.equal(m.messages.length, 2)
  assert.equal(m.messages[1].text, '第二句')
})

ok('载入的会话也带 createdAt（供 long.js 分辨回退成因）', () => {
  const dir = tmpDir()
  const a = new MemoryStore({ dir, log: {} })
  const t0 = Date.now() - 1000
  a.get('group:7').push({ text: 'x', senderName: '甲', sender: '111111111' })
  a.get('group:7').createdAt = t0
  a.flush()
  const b = new MemoryStore({ dir, log: {} })
  b.load()
  assert.equal(b.get('group:7').createdAt, t0, 'createdAt 要能持久化')
})

// ── ④ 源码锁 ──────────────────────────────────────────────
ok('index.js 的关闭钩子必须调 memory.flush()', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'index.js'), 'utf8')
  assert.match(src, /shutdown\.push\(\(\) => memory\.flush\(\)\)/, '不 flush 就会丢 totalPushed')
})

ok('long.js 的回退必须按「摘要属于哪个会话」分级（不能写死归零）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'memory', 'long.js'), 'utf8')
  assert.match(src, /sessionStartedAt/, '要用会话创建时间判断，不能只看比例')
  assert.match(src, /lostIncrements/, '要区分"丢增量"和"过夜重置"')
  assert.ok(
    !/keepRatio/.test(src),
    '不能用"回退比例"当判据 —— 过夜后聊几十句比例同样高（实测 60→37 剩 62%）',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)