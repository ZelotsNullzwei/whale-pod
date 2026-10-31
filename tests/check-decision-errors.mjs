/**
 * 决策层的**错误可见性** + 模型名前缀容错（2026-10-30）。
 *
 * ## 一次真实事故（10 小时，1037 次决策失败）
 *
 * 用户报「它又沉默了」。查日志只看到：
 * ```
 * decision/model：解析不出 verdict（原始=""），重试 1/1
 * decision: model 失败 — 模型返回无法解析：""
 * decision: rule 成功（此前 1 个失败）
 * ```
 *
 * 三层原因叠加，而**最下面是"错误被静默吞掉"** —— 它让上面两层隐形：
 *
 * ### ① 决策层没指定模型 → provider 也 undefined
 * `decision.model.model = ""`（语义：跟随模型选择）→
 * `_ask` 里 `provider: undefined` → fallback 的 `byId.get(undefined)` →
 * 「未配置的渠道」。
 *
 * ### ② 模型名前缀重复两次
 * `magpie/magpie/workbuddy-ai/deepseek-v4.1-flash`，
 * `stripProviderPrefix` 只剥一层 → 上游 **404**（22~48ms，正常调用 1300ms）。
 *
 * ### ③ ★ 错误信号被吞（本文件的重点）
 * `fallback.errorChunk()` 返回的是
 * `{ type: 'finish', reason: { kind: 'error', failure: { message } } }`
 * —— dsh 流契约的 **finish + error**，**不是** `type: 'error'`。
 * 而 `_ask` 只判 `type === 'error'` → **永远不抛** → 返回空串。
 *
 * 所以 404 在日志里被写成了"解析不出 verdict"。
 */
import assert from 'node:assert/strict'
import { ModelDecisionProvider } from '../src/decision/model.js'
import { stripProviderPrefix } from '../src/gateway/fallback.js'

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

/** 造一个假 llm：stream() 按给定 chunk 序列吐。 */
const fakeLlm = (chunks) => ({
  stream: async function* () { for (const c of chunks) yield c },
})

const mkProvider = (chunks, cfg = {}) => new ModelDecisionProvider(
  { model: 'magpie/workbuddy-ai/deepseek-v4.1-flash', ...cfg },
  { llm: fakeLlm(chunks), log: { warn() {}, info() {}, error() {} } },
)

/** 最小可用的决策输入 */
const INPUT = { scope: 'group:1', sender: '1', senderName: '甲', text: '在吗', messages: [] }

// ① 正常正文
await okAsync('正常 text-delta → 拼出 verdict', async () => {
  const p = mkProvider([
    { type: 'reasoning-delta', text: '让我想想 reply 还是 wait' },
    { type: 'text-delta', text: 'repl' },
    { type: 'text-delta', text: 'y' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const raw = await p._ask(INPUT)
  assert.equal(raw, 'reply', 'reasoning-delta 不能混进正文')
})

// ② ★ 核心回归：finish + error 必须抛，不能静默变空串
await okAsync('⚠️ finish+error（fallback 的真实形状）必须抛错，不能返回空串', async () => {
  const p = mkProvider([
    { type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 404：model not found' } } },
  ])
  await assert.rejects(
    () => p._ask(INPUT),
    (e) => /HTTP 404/.test(e.message),
    '错误信息必须冒出来 —— 十小时里就是这里吞掉的',
  )
})

await okAsync('type=error 的旧形状仍然要抛（不能只修一半）', async () => {
  const p = mkProvider([{ type: 'error', message: '连接失败' }])
  await assert.rejects(() => p._ask(INPUT), (e) => /连接失败/.test(e.message))
})

await okAsync('finish+stop 正常收尾不抛', async () => {
  const p = mkProvider([
    { type: 'text-delta', text: 'wait' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(await p._ask(INPUT), 'wait')
})

// ③ 模型名前缀容错
ok('⚠️ stripProviderPrefix 循环剥（magpie/magpie/… → …）', () => {
  assert.equal(
    stripProviderPrefix('magpie/magpie/workbuddy-ai/deepseek-v4.1-flash', 'magpie'),
    'workbuddy-ai/deepseek-v4.1-flash',
    '重复前缀必须剥干净，只剥一层就会 404',
  )
  assert.equal(stripProviderPrefix('magpie/a/b', 'magpie'), 'a/b')
  assert.equal(stripProviderPrefix('magpie/magpie/magpie/x', 'magpie'), 'x')
  assert.equal(stripProviderPrefix('a/b', 'magpie'), 'a/b', '没有前缀就不动')
  assert.equal(stripProviderPrefix('', 'magpie'), '')
  // `'magpie/magpie'` 剥一层后是 `'magpie'`，此时不再以 `'magpie/'` 开头，
  // 循环自然停下 → 返回 `'magpie'`（一个裸名字，无害）。
  // ⚠️ 这里原来我写成期望 `'magpie/magpie'` —— 断言写错了，不是代码错。
  assert.equal(stripProviderPrefix('magpie/magpie', 'magpie'), 'magpie', '剥到不剩前缀就停，不会变空串')
})

// ④ 源码锁：`_ask` 必须认 finish+error
ok('源码锁：_ask 必须处理 finish + reason.kind=error', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/decision/model.js', import.meta.url), 'utf8')
  assert.match(src, /reason\?\.kind === 'error'/, '必须判 finish 的 error 形状')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)