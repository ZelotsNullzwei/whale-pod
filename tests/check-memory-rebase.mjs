/**
 * 长期摘要「计数回退」的回归测试（2026-10-28）。
 *
 * ## 这个 bug 有多严重
 *
 * 用户报「记不住事」，查出来 `memory-long.json` **整整 24 小时没更新**。
 *
 * 实测：
 *   短期 totalPushed    = 37
 *   长期 summarizedTotal = 60
 *   unsummarized = 37 - 60 = -23  → 永远 < summarizeAfter(20) → 摘要永不触发
 *
 * 根因：两个计数器生命周期不同。
 *   · 短期记忆 6h 过期 → 隔夜重启后会话整个不恢复 → totalPushed 归零
 *   · 长期 summarizedTotal 不会跟着归零
 *
 * 所以**每天早上的第一次聊天都会触发**，而且要累计到
 * `summarizedTotal + 20` 条才可能回正 —— 以 60 计就是 80 条，
 * 实际等于「长期记忆永久冻结」。
 */
import assert from 'node:assert/strict'
import { LongTermStore } from '../src/memory/long.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 造一个只做内存操作的 store，summarize 立即返回固定文本。 */
function mkStore(opts = {}) {
  const calls = []
  const store = new LongTermStore({
    cfg: {
      enabled: true,
      summarizeAfter: opts.summarizeAfter ?? 20,
    },
    summarize: async (ctx) => {
      calls.push(ctx)
      return `【事】这是第 ${calls.length} 次摘要`
    },
    log: {},
  })
  return { store, calls }
}

const fakeMsgs = (n) =>
  Array.from({ length: n }, (_, i) => ({ isMe: i % 2 === 0, text: `消息${i}`, senderName: 'x' }))

// ── 核心：回退场景 ──────────────────────────────────────────
await ok('计数回退（37 < 60）→ 重置基线并真的摘要', async () => {
  const { store, calls } = mkStore()
  const m = store.get('private:1')
  m.summarizedTotal = 60

  const did = await store.maybeSummarize('private:1', {
    messages: fakeMsgs(30),
    total: 37,
  })

  assert.equal(did, true, '应该摘要（修复前这里是 false，永远不摘）')
  assert.equal(calls.length, 1, 'summarize 应该被调用一次')
  assert.equal(m.summarizedTotal, 37, '摘要后基线应该等于当前累计数')
})

await ok('回退但消息不够（5 条）→ 重置基线但不摘要', async () => {
  const { store, calls } = mkStore()
  const m = store.get('private:1')
  m.summarizedTotal = 60

  const did = await store.maybeSummarize('private:1', {
    messages: fakeMsgs(5),
    total: 5,
  })

  assert.equal(did, false, '5 条不够 20，不该摘要')
  assert.equal(calls.length, 0)
  assert.equal(m.summarizedTotal, 0, '基线仍应被重置（否则下次还是负数）')
})

// ── 正常场景不能被误伤 ────────────────────────────────────
await ok('正常累积（55 > 30，差 25）→ 摘要', async () => {
  const { store, calls } = mkStore()
  const m = store.get('private:1')
  m.summarizedTotal = 30

  const did = await store.maybeSummarize('private:1', {
    messages: fakeMsgs(30),
    total: 55,
  })

  assert.equal(did, true)
  assert.equal(calls.length, 1)
  assert.equal(m.summarizedTotal, 55)
})

await ok('正常累积但不够（40 - 30 = 10）→ 不摘要', async () => {
  const { store, calls } = mkStore()
  const m = store.get('private:1')
  m.summarizedTotal = 30

  const did = await store.maybeSummarize('private:1', {
    messages: fakeMsgs(30),
    total: 40,
  })

  assert.equal(did, false)
  assert.equal(calls.length, 0)
  assert.equal(m.summarizedTotal, 30, '正常路径不该动基线')
})

// ── 边界 ──────────────────────────────────────────────────
await ok('相等（20 - 20 = 0）→ 不误触发', async () => {
  const { store, calls } = mkStore()
  const m = store.get('private:1')
  m.summarizedTotal = 20
  const did = await store.maybeSummarize('private:1', { messages: fakeMsgs(30), total: 20 })
  assert.equal(did, false)
  assert.equal(calls.length, 0)
})

await ok('刚好等于阈值（40 - 20 = 20）→ 触发', async () => {
  const { store, calls } = mkStore()
  const m = store.get('private:1')
  m.summarizedTotal = 20
  const did = await store.maybeSummarize('private:1', { messages: fakeMsgs(30), total: 40 })
  assert.equal(did, true, '>= 阈值就该摘要')
})

await ok('回退后能连续正常工作（不再卡住）', async () => {
  const { store, calls } = mkStore()
  const m = store.get('private:1')
  m.summarizedTotal = 60

  // 第一次：回退 + 摘要
  await store.maybeSummarize('private:1', { messages: fakeMsgs(30), total: 37 })
  assert.equal(m.summarizedTotal, 37)

  // 再攒 20 条
  const did2 = await store.maybeSummarize('private:1', { messages: fakeMsgs(30), total: 57 })
  assert.equal(did2, true, '回退修好后，后续应该按正常节奏继续摘要')
  assert.equal(m.summarizedTotal, 57)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
