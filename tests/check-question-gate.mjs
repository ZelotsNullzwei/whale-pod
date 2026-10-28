/**
 * 「提问就要答」兜底测试（2026-10-28）。
 *
 * 用户原话：「问要回啊，这都没回」
 *
 * 实测背景：群里问「你知道祀是谁吗」，决策层判「这段跟我无关」→ 沉默，
 * 于是连搜索都没走到（搜索在生成层，生成层只在决策说"回"之后才跑）。
 */
import assert from 'node:assert/strict'
import { applyQuestionOverride } from '../src/qq/questionGate.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const silent = (reason = '模型判断：这段跟我无关') => ({ reply: false, probability: 0, reason })

// ── 核心：真提问要覆盖成回答 ────────────────────────────────
ok('「你知道祀是谁吗」沉默 → 改成回答', () => {
  const r = applyQuestionOverride(silent(), '你知道祀是谁吗')
  assert.equal(r.reply, true, '应该改成回答')
  assert.equal(r.probability, 1)
  assert.match(r.reason, /提问需查资料/)
  assert.equal(r.provider, 'question')
})

ok('「祀强吗」沉默 → 改成回答', () => {
  const r = applyQuestionOverride(silent(), '祀强吗')
  assert.equal(r.reply, true)
})

ok('「这季新番有啥好看的」沉默 → 改成回答', () => {
  const r = applyQuestionOverride(silent(), '这季新番有啥好看的')
  assert.equal(r.reply, true)
})

ok('原本 defer（冷却排队）→ 被清掉，改成直接回答', () => {
  const d = { reply: false, defer: { waitMs: 5000 }, reason: '冷却中' }
  const r = applyQuestionOverride(d, '你知道祀是谁吗')
  assert.equal(r.reply, true)
  assert.equal(r.defer, null, 'defen 应被清掉')
})

ok('默认给了 delayMs（有打字节奏，不是秒回）', () => {
  const r = applyQuestionOverride(silent(), '祀是谁啊')
  assert.ok(r.delayMs > 0, `delayMs 应 > 0，实际 ${r.delayMs}`)
})

// ── 不能误伤：这些必须保持沉默 ──────────────────────────────
ok('寒暄「你吃了吗」→ 保持沉默', () => {
  const r = applyQuestionOverride(silent(), '你吃了吗')
  assert.equal(r.reply, false, '寒暄不该被当成查资料')
})

ok('寒暄「睡了吗」→ 保持沉默', () => {
  assert.equal(applyQuestionOverride(silent(), '睡了吗').reply, false)
})

ok('反问「你不是才吃过吗」→ 保持沉默（曾被搜出公众号封面图）', () => {
  assert.equal(applyQuestionOverride(silent(), '你不是才吃过吗').reply, false)
})

ok('日常问「今天中午吃什么」→ 保持沉默', () => {
  assert.equal(applyQuestionOverride(silent(), '今天中午吃什么').reply, false)
})

ok('普通陈述「今天好累」→ 保持沉默', () => {
  assert.equal(applyQuestionOverride(silent(), '今天好累').reply, false)
})

// ── 边界 ──────────────────────────────────────────────────
ok('本来就是 reply → 原样返回（同一个对象引用）', () => {
  const d = { reply: true, probability: 0.8 }
  const r = applyQuestionOverride(d, '你知道祀是谁吗')
  assert.equal(r, d, '不该复制/改动')
})

ok('自己发的消息（isMe）→ 不覆盖', () => {
  const r = applyQuestionOverride(silent(), '你知道祀是谁吗', { isMe: true })
  assert.equal(r.reply, false)
})

ok('enabled:false → 完全尊重决策层', () => {
  const r = applyQuestionOverride(silent(), '你知道祀是谁吗', { enabled: false })
  assert.equal(r.reply, false)
})

ok('空/非对象输入 → 不抛异常', () => {
  assert.equal(applyQuestionOverride(null, '你知道祀是谁吗'), null)
  assert.equal(applyQuestionOverride(undefined, 'x'), undefined)
})

ok('空文本 → 保持沉默', () => {
  assert.equal(applyQuestionOverride(silent(), '').reply, false)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
