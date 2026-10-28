/**
 * 决策结果**字段透传**测试（2026-10-28）。
 *
 * ## 为什么要专门盯这个
 *
 * `DecisionRegistry.decide()` 原来是**字段白名单** —— 只挑它认识的字段
 * 重建一个对象，其余**静默丢掉**。同一个坑踩过两次：
 *
 *   · `defer`（2026-10-23）
 *     rule 返回「冷却中，晚点补回」→ 白名单没这个字段 → bridge 收不到
 *     → 走到「真的不想回」分支把消息丢弃。用户看到「问了不理我」。
 *
 *   · `emojiReply`（2026-10-28，用户报「一直找图」）
 *     rule 对纯表情返回 `emojiReply:true`（含义：只发一个收藏表情、
 *     **不调模型**）→ 白名单没它 → bridge 的 `if (d.emojiReply)` 永不成立
 *     → **每次都走生成层**：
 *       · 白花一次模型调用
 *       · 把表情包的图喂给模型 → 它描述画面（「这青蛙看着还挺心宽体胖的」）
 *       · 还可能输出 `[找图:...]` → 反复联网找图
 *
 * 现在改成 `...d` 全量透传 + 覆盖。这个测试锁住「任何 provider 字段
 * 都能到达 bridge」—— 以后加字段不用再回来登记。
 */
import assert from 'node:assert/strict'
import { DecisionRegistry } from '../src/decision/provider.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 造一个返回指定结果的假 provider。 */
function mkRegistry(result, id = 'fake') {
  const reg = new DecisionRegistry({ order: [id], log: {} })
  reg.register({
    id,
    costPerCall: 0.001,
    async probe() { return { ok: true, detail: '' } },
    async decide() { return result },
  })
  return reg
}

await ok('emojiReply 必须透传（这是「青蛙」和「一直找图」的直接原因）', async () => {
  const reg = mkRegistry({
    reply: true,
    emojiReply: true,
    probability: 0.18,
    reason: '纯表情/图片（在刷梗图）→ 回一个表情（不调模型）',
    decided: true,
    delayMs: 400,
  })
  const d = await reg.decide({ messages: [] })
  assert.equal(d.emojiReply, true, 'emojiReply 被吃掉了 → bridge 会去调模型')
  assert.equal(d.reply, true)
  assert.equal(d.reason.includes('不调模型'), true)
})

await ok('defer 必须透传（冷却排队，历史 bug）', async () => {
  const reg = mkRegistry({ reply: false, reason: '冷却中', defer: { waitMs: 12000 } })
  const d = await reg.decide({ messages: [] })
  assert.deepEqual(d.defer, { waitMs: 12000 })
})

await ok('未知的新字段也要透传（防第三次踩同一个坑）', async () => {
  const reg = mkRegistry({
    reply: true,
    delayMs: 1,
    // 将来才会加的字段，现在就该活着到达上层
    someBrandNewField: { a: 1 },
    anotherOne: 'keep-me',
  })
  const d = await reg.decide({ messages: [] })
  assert.deepEqual(d.someBrandNewField, { a: 1 })
  assert.equal(d.anotherOne, 'keep-me')
})

await ok('规范化字段仍然生效：provider 用注册表 id', async () => {
  const reg = mkRegistry({ reply: true, provider: '我在撒谎', reason: 'x' }, 'rule')
  const d = await reg.decide({ messages: [] })
  assert.equal(d.provider, 'rule', 'provider 必须以注册表 id 为准')
})

await ok('reply 被强制转成 boolean', async () => {
  const reg = mkRegistry({ reply: 'yes', reason: 'x' })
  const d = await reg.decide({ messages: [] })
  assert.equal(d.reply, true)
})

await ok('probability 非数字时归 undefined（不是 NaN 传播）', async () => {
  const reg = mkRegistry({ reply: true, probability: 'high', reason: 'x' })
  const d = await reg.decide({ messages: [] })
  assert.equal(d.probability, undefined)
})

await ok('decided 只在严格 true 时成立', async () => {
  const reg = mkRegistry({ reply: true, decided: 'true', reason: 'x' })
  const d = await reg.decide({ messages: [] })
  assert.equal(d.decided, false, '字符串 "true" 不算')
})

await ok('ms / cost 由注册表补齐', async () => {
  const reg = mkRegistry({ reply: true, reason: 'x' })
  const d = await reg.decide({ messages: [] })
  assert.equal(typeof d.ms, 'number')
  assert.equal(d.cost, 0.001, 'provider 没给 cost 时用 costPerCall')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)