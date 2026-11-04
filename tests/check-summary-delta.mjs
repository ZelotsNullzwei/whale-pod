/**
 * 摘要写回**只覆盖新增消息**（2026-11-04）。
 *
 * ## 改之前是什么样
 * 每次摘要都把 `msgs`（整个 30 条窗口）连同旧摘要一起重压一遍：
 * ```
 * 第 1 代：m1..m30           → 摘要 A
 * 第 2 代：摘要 A + m27..m56  → 摘要 B   ← m27..m30 被压第 2 次
 * 第 3 代：摘要 B + m53..m82  → 摘要 C   ← m53..m56 被压第 3 次
 * ```
 * 同一句话被反复改写，信息一层层磨掉 —— 私聊 685 条最后只剩 343 字
 * （0.5 字/条）就是这么来的。
 *
 * ## 守什么
 * ① 第一次摘要：增量 = 全部（还没摘要过）
 * ② 第二次：**只送新增的那几条**，旧消息一条都不重送
 * ③ 旧摘要仍然通过 `previous` 送进去（模型要在已有印象上更新，不能忘掉更早的）
 * ④ 增量不够阈值 → 一次都不调（不白花 LLM）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LongTermStore } from '../src/memory/long.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sum-'))

/** 造一条消息。`at` 递增，方便断言"送进去的是哪几条"。 */
const msg = (i) => ({
  text: `第${i}条`,
  sender: '10001',
  senderName: '甲',
  at: 1_700_000_000_000 + i * 1000,
})

function mkStore() {
  const seen = []
  const store = new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 20, maxChars: 12000, injectChars: 3000 },
    home: dir,
    summarize: async ({ messages, previous }) => {
      seen.push({ texts: messages.map((m) => m.text), previous })
      // 必须带【人】—— 否则 merge() 走"整段替换"分支，测的就不是写回了
      return `【人】\n10001 | 甲 | 常来聊两句\n\n【事】\n在聊「${messages.at(-1)?.text ?? ''}」\n`
    },
    log: {},
  })
  return { store, seen }
}

console.log('=== 1. 第一次摘要：增量 = 全部（窗口比阈值还小）===')
await ok('total=25、窗口 25 → 送 25 条', async () => {
  const { store, seen } = mkStore()
  const msgs = Array.from({ length: 25 }, (_, i) => msg(i + 1))
  const did = await store.maybeSummarize('group:1', { messages: msgs, total: 25 })
  assert.equal(did, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].texts.length, 25)
  assert.equal(store.get('group:1').summarizedTotal, 25)
})

console.log('\n=== 2. 第二次：只送新增，旧消息不重压 ===')
await ok('窗口滚到 30 条、累计 45 → 只送最新 20 条', async () => {
  const { store, seen } = mkStore()
  // 先摘第一轮
  await store.maybeSummarize('group:1', {
    messages: Array.from({ length: 25 }, (_, i) => msg(i + 1)),
    total: 25,
  })
  const first = seen[0].previous
  assert.equal(first, '', '第一轮没有旧摘要')

  // 再聊 20 条：窗口只留最近 30 条（26..75 里取最新的 30）
  const window = Array.from({ length: 30 }, (_, i) => msg(i + 16))
  const did = await store.maybeSummarize('group:1', { messages: window, total: 45 })
  assert.equal(did, true)
  assert.equal(seen.length, 2)
  assert.equal(seen[1].texts.length, 20, '只该送新增的 20 条')
  assert.equal(seen[1].texts[0], '第26条', '新增的起点是 26，不是窗口头')
  assert.equal(seen[1].texts.at(-1), '第45条')
  assert.ok(!seen[1].texts.includes('第1条'), '第一轮已经摘过的消息一条都不该重送')
})

await ok('旧摘要仍然作为 previous 送进去', async () => {
  const { store, seen } = mkStore()
  await store.maybeSummarize('group:1', { messages: [msg(1), msg(2), msg(3)], total: 20 })
  const prev = store.get('group:1').summary
  assert.match(prev, /【事】/)
  await store.maybeSummarize('group:1', {
    messages: Array.from({ length: 20 }, (_, i) => msg(i + 4)),
    total: 40,
  })
  assert.match(seen[1].previous, /【事】/, '旧摘要必须带上，否则【事】会断代')
})

console.log('\n=== 3. 不够阈值就一次都不调 ===')
await ok('累计 46、已摘到 45 → 不调模型', async () => {
  const { store, seen } = mkStore()
  await store.maybeSummarize('group:1', {
    messages: Array.from({ length: 30 }, (_, i) => msg(i + 1)),
    total: 45,
  })
  const n = seen.length
  const did = await store.maybeSummarize('group:1', {
    messages: Array.from({ length: 30 }, (_, i) => msg(i + 1)),
    total: 46,
  })
  assert.equal(did, false)
  assert.equal(seen.length, n, '不该多一次 LLM 调用')
})

console.log('\n=== 4. 窗口比增量还短 → 整窗送（宁可多压，不丢新内容）===')
await ok('增量 40、窗口只有 5 条 → 送 5 条', async () => {
  const { store, seen } = mkStore()
  await store.maybeSummarize('group:1', {
    messages: Array.from({ length: 20 }, (_, i) => msg(i + 1)),
    total: 20,
  })
  await store.maybeSummarize('group:1', {
    messages: Array.from({ length: 5 }, (_, i) => msg(i + 21)),
    total: 60,
  })
  assert.equal(seen[1].texts.length, 5)
  assert.equal(seen[1].texts.at(-1), '第25条')
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)