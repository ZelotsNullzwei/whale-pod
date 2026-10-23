/**
 * 记忆与冷却测试。
 *
 * 覆盖两处修复（2026-10-23 实机测试发现）：
 *
 *   1. 长期记忆的累计计数 —— 原来用窗口长度当"累计条数"，
 *      窗口一满就永远不再触发摘要（memory-long.json 从未生成）。
 *   2. 私聊独立冷却 —— 原来沿用群聊 15s，用户连发几条每句都要等。
 *
 * 用法：node tests/check-memory-cooldown.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { ConversationMemory, MemoryStore, makeMessage } from '../src/memory/short.js'
import { LongTermStore } from '../src/memory/long.js'
import { RuleDecisionProvider } from '../src/decision/rule.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

/** 每次跑测试用独立临时目录，避免污染 ~/.whale-pod */
function tmpHome(tag) {
  const d = path.join(os.tmpdir(), `whalepod-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

// ══════════════════════════════════════════════════════════════
console.log('=== 1. ConversationMemory.totalPushed 单调递增 ===')
{
  const mem = new ConversationMemory({ maxMessages: 5 })
  for (let i = 0; i < 12; i++) {
    mem.push({ sender: 'u1', senderName: '甲', text: `第${i}条`, at: Date.now() })
  }
  check('窗口被裁到上限 5', mem.recent().length === 5, String(mem.recent().length))
  check('totalPushed 仍是 12（不随裁剪回退）', mem.totalPushed === 12, String(mem.totalPushed))

  mem.clear()
  check('clear() 后 totalPushed 归零', mem.totalPushed === 0, String(mem.totalPushed))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. 长期记忆：窗口满了之后仍能连续多轮摘要 ===')
//
// ⚠️ 这是本次修的核心 bug。改前：summarizedCount 存窗口长度，
//    窗口满 30 后 msgs.length 恒为 30，30-30=0，摘要只可能发生一次。
{
  const home = tmpHome('multi')
  let calls = 0
  const lt = new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 5 },
    home,
    summarize: async ({ messages, previous }) => {
      calls++
      return `第${calls}次摘要（看到 ${messages.length} 条，上次：${previous ? '有' : '无'}）`
    },
    log: {},
  })

  const mem = new ConversationMemory({ maxMessages: 6 })  // 窗口故意小于累计
  const ctx = () => ({ messages: mem.recent(), total: mem.totalPushed, scene: { kind: 'group' }, self: {} })

  // 第 1 轮：攒够 5 条 → 触发摘要
  for (let i = 0; i < 5; i++) mem.push({ sender: 'u1', senderName: '甲', text: `a${i}`, at: Date.now() })
  const r1 = await lt.maybeSummarize('group:1', ctx())
  check('第 1 轮：达到阈值 → 触发摘要', r1 === true, `calls=${calls}`)
  check('第 1 轮：摘要已保存', lt.get('group:1').summary.includes('第1次摘要'))

  // 立刻再调一次：没有新消息，不该再触发
  const r1b = await lt.maybeSummarize('group:1', ctx())
  check('无新消息 → 不重复摘要', r1b === false && calls === 1, `calls=${calls}`)

  // 第 2 轮：再来 5 条（此时窗口已滚动，但 totalPushed 在涨）
  for (let i = 0; i < 5; i++) mem.push({ sender: 'u1', senderName: '甲', text: `b${i}`, at: Date.now() })
  const r2 = await lt.maybeSummarize('group:1', ctx())
  check('第 2 轮：再次触发（窗口滚动不影响）', r2 === true, `calls=${calls}`)
  check('第 2 轮：calls 累计到 2', calls === 2, String(calls))

  // 第 3 轮：继续
  for (let i = 0; i < 5; i++) mem.push({ sender: 'u1', senderName: '甲', text: `c${i}`, at: Date.now() })
  const r3 = await lt.maybeSummarize('group:1', ctx())
  check('第 3 轮：仍能触发（证明不是只触发一次）', r3 === true, `calls=${calls}`)
  check('第 3 轮：calls 累计到 3', calls === 3, String(calls))

  // 摘要内容应该是累积的
  const s = lt.get('group:1').summary
  check('摘要累积了多轮内容', s.includes('第1次摘要') && s.includes('第2次摘要') && s.includes('第3次摘要'), s.slice(0, 120))

  fs.rmSync(home, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. 长期记忆：窗口满 + 大量消息，仍按增量触发 ===')
{
  const home = tmpHome('window')
  let calls = 0
  const lt = new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 10 },
    home,
    summarize: async () => { calls++; return `摘要${calls}` },
    log: {},
  })

  // 窗口只有 5，但塞 100 条
  const mem = new ConversationMemory({ maxMessages: 5 })
  const ctx = () => ({ messages: mem.recent(), total: mem.totalPushed, scene: { kind: 'group' }, self: {} })

  for (let i = 0; i < 100; i++) {
    mem.push({ sender: 'u1', senderName: '甲', text: `m${i}`, at: Date.now() })
    await lt.maybeSummarize('group:2', ctx())
  }
  // 每 10 条触发一次 → 约 10 次
  check('100 条 / 阈值 10 → 触发约 10 次', calls >= 9 && calls <= 10, `calls=${calls}`)
  check('窗口长度始终是 5（不参与判断）', mem.recent().length === 5, String(mem.recent().length))

  fs.rmSync(home, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. 长期记忆：持久化与老文件迁移 ===')
{
  const home = tmpHome('persist')
  const lt = new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 3 }, home,
    summarize: async () => '持久化测试摘要', log: {},
  })
  const mem = new ConversationMemory({ maxMessages: 10 })
  for (let i = 0; i < 3; i++) mem.push({ sender: 'u1', senderName: '甲', text: `p${i}`, at: Date.now() })
  await lt.maybeSummarize('group:3', { messages: mem.recent(), total: mem.totalPushed, scene: {}, self: {} })

  const f = path.join(home, 'memory-long.json')
  check('落盘文件已生成', fs.existsSync(f), f)
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  check('文件里有 summarizedTotal', j.sessions['group:3']?.summarizedTotal === 3, JSON.stringify(j.sessions['group:3']))

  // 重新加载，应该能恢复
  const lt2 = new LongTermStore({ cfg: { enabled: true }, home, summarize: async () => 'x', log: {} })
  lt2.load()
  check('重新加载后摘要还在', lt2.get('group:3').summary === '持久化测试摘要')
  check('重新加载后 summarizedTotal 正确', lt2.get('group:3').summarizedTotal === 3, String(lt2.get('group:3').summarizedTotal))

  // 老文件迁移：只有 summarizedCount、没有 summarizedTotal
  const oldFile = path.join(home, 'old.json')
  fs.writeFileSync(oldFile, JSON.stringify({
    version: 1,
    sessions: { 'group:9': { summary: '老摘要', summarizedCount: 30, updatedAt: 1 } },
  }))
  const lt3 = new LongTermStore({ cfg: { enabled: true }, home, summarize: async () => 'x', log: {} })
  lt3.file = oldFile
  lt3.load()
  check('老文件：summarizedTotal 回退用 summarizedCount', lt3.get('group:9').summarizedTotal === 30, String(lt3.get('group:9').summarizedTotal))

  fs.rmSync(home, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. 长期记忆：未启用 / 无消息 / 并发 的边界 ===')
{
  const home = tmpHome('edge')
  const off = new LongTermStore({ cfg: { enabled: false }, home, summarize: async () => 'x', log: {} })
  check('未启用 → 不摘要', (await off.maybeSummarize('g', { messages: [], total: 999 })) === false)

  let calls = 0
  const on = new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 1 }, home,
    summarize: async () => { calls++; return 'ok' }, log: {},
  })
  check('total 够但 messages 为空 → 不白跑 LLM',
    (await on.maybeSummarize('g2', { messages: [], total: 100 })) === false && calls === 0)

  // 并发：同一 scope 只允许一个在跑
  let running = 0
  let maxConcurrent = 0
  const slow = new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 1 }, home,
    summarize: async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 20))
      running--
      return 'slow'
    },
    log: {},
  })
  const m2 = new ConversationMemory({ maxMessages: 10 })
  m2.push({ sender: 'u1', senderName: '甲', text: 'x', at: Date.now() })
  const ctx2 = () => ({ messages: m2.recent(), total: m2.totalPushed, scene: {}, self: {} })
  await Promise.all([
    slow.maybeSummarize('g3', ctx2()),
    slow.maybeSummarize('g3', ctx2()),
    slow.maybeSummarize('g3', ctx2()),
  ])
  check('并发调用不会同时跑多次摘要', maxConcurrent === 1, `maxConcurrent=${maxConcurrent}`)

  fs.rmSync(home, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. 私聊独立冷却：默认 1.5s，不再 15s ===')
{
  const base = {
    messages: [{ id: '1', sender: 'u1', senderName: '甲', text: '你好', isMe: false, at: Date.now() }],
    self: { qq: '9', nickname: 'Bot' },
    scene: { kind: 'private' },
    consecutiveTurns: 0,
  }

  // 默认配置
  const p = new RuleDecisionProvider({}, { random: () => 0 })
  check('默认 privateCooldownMs = 1500', p.cfg.privateCooldownMs === 1500, String(p.cfg.privateCooldownMs))
  check('群聊 cooldownMs 仍是 15000', p.cfg.cooldownMs === 15000, String(p.cfg.cooldownMs))

  // 2 秒前说过话 → 私聊应放行（群聊冷却会拦）
  const d1 = await p.decide({ ...base, sinceMyLastMessage: 2000 })
  check('私聊：距上次 2s → 正常回复（不再等 15s）', d1.reply === true, JSON.stringify(d1))

  // 1 秒前 → 仍在私聊冷却内
  const d2 = await p.decide({ ...base, sinceMyLastMessage: 1000 })
  check('私聊：距上次 1s → 仍在冷却', d2.reply === false, JSON.stringify(d2))
  check('私聊：冷却时带 defer（排队补回，不是丢弃）', typeof d2.defer?.waitMs === 'number', JSON.stringify(d2.defer))

  // 3 秒前 → 早就过了
  const d3 = await p.decide({ ...base, sinceMyLastMessage: 3000 })
  check('私聊：距上次 3s → 回复', d3.reply === true)

  // 自定义为 0 → 私聊完全不冷却
  const p0 = new RuleDecisionProvider({ privateCooldownMs: 0 }, { random: () => 0 })
  const d4 = await p0.decide({ ...base, sinceMyLastMessage: 10 })
  check('privateCooldownMs=0 → 私聊完全不冷却', d4.reply === true, JSON.stringify(d4))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. 私聊冷却不影响群聊冷却 ===')
{
  const p = new RuleDecisionProvider({ cooldownMs: 15000, privateCooldownMs: 1500 }, { random: () => 0 })
  const groupBase = {
    messages: [{ id: '1', sender: 'u1', senderName: '甲', text: '今天吃啥', isMe: false, at: Date.now() }],
    self: { qq: '9', nickname: 'Bot' },
    scene: { kind: 'group' },
    consecutiveTurns: 0,
  }
  const g1 = await p.decide({ ...groupBase, sinceMyLastMessage: 2000 })
  check('群聊：距上次 2s → 仍受 15s 冷却约束', g1.reply === false, JSON.stringify(g1))
  check('群聊：理由是冷却', /冷却/.test(g1.reason), g1.reason)

  const g2 = await p.decide({ ...groupBase, sinceMyLastMessage: 16000 })
  check('群聊：距上次 16s → 过了冷却', g2.reply !== false || !/冷却/.test(g2.reason), g2.reason)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. 多会话隔离：摘要计数互不干扰 ===')
{
  const home = tmpHome('isolate')
  let calls = 0
  const lt = new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 3 }, home,
    summarize: async ({ scene }) => { calls++; return `摘要${calls}` }, log: {},
  })
  const a = new ConversationMemory({ maxMessages: 10 })
  const b = new ConversationMemory({ maxMessages: 10 })
  for (let i = 0; i < 3; i++) {
    a.push({ sender: 'u1', senderName: '甲', text: `a${i}`, at: Date.now() })
    b.push({ sender: 'u2', senderName: '乙', text: `b${i}`, at: Date.now() })
  }
  await lt.maybeSummarize('group:A', { messages: a.recent(), total: a.totalPushed, scene: {}, self: {} })
  await lt.maybeSummarize('group:B', { messages: b.recent(), total: b.totalPushed, scene: {}, self: {} })
  check('两个会话各自摘要一次', calls === 2, String(calls))
  check('A 的计数是 3', lt.get('group:A').summarizedTotal === 3, String(lt.get('group:A').summarizedTotal))
  check('B 的计数也是 3（互不影响）', lt.get('group:B').summarizedTotal === 3, String(lt.get('group:B').summarizedTotal))

  fs.rmSync(home, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 9. 默认配置不再自相矛盾 ===')
//
// ⚠️ 原来出厂默认是 `enabled:false` + `summarizeAfter:200`，而窗口只有 30。
//    两处都错：关着 = 记忆完全不工作；200 > 30 = 就算开了也永不触发。
{
  const { createDefaultConfig } = await import('../src/config/store.js')
  const cfg = typeof createDefaultConfig === 'function' ? createDefaultConfig() : null
  if (cfg) {
    check('长期记忆默认开启', cfg.memory.long.enabled === true, String(cfg.memory.long.enabled))
    check('summarizeAfter 小于窗口上限',
      cfg.memory.long.summarizeAfter < cfg.memory.short.maxMessages,
      `${cfg.memory.long.summarizeAfter} vs ${cfg.memory.short.maxMessages}`)
  } else {
    // 没有导出的工厂函数时，直接读文件断言
    const src = fs.readFileSync(path.join(root, 'src/config/store.js'), 'utf8')
    check('store.js 里 long.enabled 默认 true', /long:\s*\{[\s\S]{0,400}?enabled:\s*true/.test(src))
    check('store.js 里 summarizeAfter 不再是 200', !/summarizeAfter:\s*200/.test(src))
  }
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
