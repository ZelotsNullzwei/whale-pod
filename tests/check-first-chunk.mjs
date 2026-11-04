/**
 * 首块超时（2026-11-04）。
 *
 * ## 现场（群里 15:14:23）
 * ```
 * 15:14:23  决策 → 发言，llm.stream() 也返回了
 * 15:15:57  本条带 1 张图发给 magpie…        ← 第一块 94 秒后才来
 * 15:15:57  生成期间群里又说了 4 条且没叫我，本条回复已过时，丢弃
 * ```
 * 期间她**既不回也不做别的** —— 用户看到的就是「半天没动静」。
 *
 * 原因：`openFirstAvailable` 里 `await first` 是无上限的，只有底下 HTTP
 * 默认超时能兜。现在给了 `firstChunkMs`（默认 30s，按当天 159 次生成的
 * p50 4.4s / p90 11.5s / p99 45.2s 定的）。
 */
import assert from 'node:assert/strict'
import { openFirstAvailable } from '../src/gateway/router.js'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 永远不吐 chunk 的流（模拟上游卡住）。 */
const stuck = (label) => ({
  label,
  stream: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  }),
})

/** 立刻吐一句就结束的流。 */
const fast = (label, text = 'hello') => ({
  label,
  stream: () => ({
    [Symbol.asyncIterator]: () => {
      let i = 0
      return {
        next: async () => (i++ === 0
          ? { done: false, value: { type: 'text', delta: text } }
          : { done: true, value: undefined }),
      }
    },
  }),
})

console.log('=== 1. 卡住的上游会被掐掉 ===')
await ok('首块超时 → 抛错（不再无限等）', async () => {
  const t0 = Date.now()
  await assert.rejects(
    () => openFirstAvailable({
      llm: stuck(),
      candidates: [{ provider: 'p', model: 'm' }],
      request: {},
      firstChunkMs: 120,
    }),
    /首块超时/,
  )
  const ms = Date.now() - t0
  assert.ok(ms < 2000, `应很快返回，实际 ${ms}ms`)
})

await ok('第一个卡住、第二个正常 → 用第二个（故障转移没坏）', async () => {
  const r = await openFirstAvailable({
    llm: { stream: (o) => (o.model === 'bad' ? stuck('bad').stream() : fast('ok').stream()) },
    candidates: [{ provider: 'p', model: 'bad' }, { provider: 'p', model: 'ok' }],
    request: {},
    firstChunkMs: 120,
  })
  assert.equal(r.picked?.model, 'ok')
})

console.log('=== 2. 正常路径不受影响 ===')
await ok('首块正常 → 立即返回，不等到超时', async () => {
  const t0 = Date.now()
  const r = await openFirstAvailable({
    llm: fast(),
    candidates: [{ provider: 'p', model: 'm' }],
    request: {},
    firstChunkMs: 5000,
  })
  assert.equal(r.picked?.model, 'm')
  const ms = Date.now() - t0
  assert.ok(ms < 1000, `不该等到 5s，实际 ${ms}ms`)
})

await ok('firstChunkMs=0 → 关掉这道闸（旧行为）', async () => {
  // 只验"正常流照样通"，不验证"永不返回"（那会挂住测试）
  const r = await openFirstAvailable({
    llm: fast(),
    candidates: [{ provider: 'p', model: 'm' }],
    request: {},
    firstChunkMs: 0,
  })
  assert.equal(r.picked?.model, 'm')
})

// ── 2. 生成途中过时 → 不再等（2026-11-04）────────────────────
//
// 首块超时只管"连上"，连上之后一句话说 40 秒照样白等。
// `_generateGuarded` 在生成期间每 500ms 复查一次过时判据，
// 一命中就放弃 —— 判据复用 `_checkSuperseded`，语义不变。
{
  const mem = { recent: () => [] }
  const probe = (extra = {}) => ({
    _generate: () => new Promise(() => {}),   // 永不返回：模拟上游慢慢吐
    _checkSuperseded: () => null,
    ...extra,
  })

  await ok('群聊：生成途中一旦过时，立刻放弃（不再干等）', async () => {
    const t0 = Date.now()
    const r = await QQBridge.prototype._generateGuarded.call(
      probe({ _checkSuperseded: () => ({ count: 3 }) }),
      { scope: 'group:1' }, mem, { kind: 'group' }, {}, 1,
    )
    assert.equal(r?.__stale, true, '应当以"过时"返回')
    assert.equal(r.count, 3)
    assert.ok(Date.now() - t0 < 2000, `不该等到生成结束，实际 ${Date.now() - t0}ms`)
  })

  await ok('群聊：没过时就正常等结果', async () => {
    const r = await QQBridge.prototype._generateGuarded.call(
      probe({ _generate: async () => ({ text: '在的' }) }),
      { scope: 'group:1' }, mem, { kind: 'group' }, {}, 1,
    )
    assert.equal(r?.text, '在的')
  })

  await ok('私聊：没有"话题被岔开"，不装这道闸', async () => {
    const r = await QQBridge.prototype._generateGuarded.call(
      probe({
        _generate: async () => ({ text: '私聊照回' }),
        _checkSuperseded: () => { throw new Error('私聊不该调用过时判据') },
      }),
      { scope: 'private:1' }, mem, { kind: 'private' }, {}, 1,
    )
    assert.equal(r?.text, '私聊照回')
  })

  await ok('生成报错照样往上抛（别被 race 吞掉）', async () => {
    await assert.rejects(
      () => QQBridge.prototype._generateGuarded.call(
        probe({ _generate: async () => { throw new Error('上游 500') } }),
        { scope: 'group:1' }, mem, { kind: 'group' }, {}, 1,
      ),
      /上游 500/,
    )
  })
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)