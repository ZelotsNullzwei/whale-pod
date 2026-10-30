/**
 * 两处「静默失效」的回归测试（2026-10-29）。
 *
 * ## 背景：用户问「思考强度的选择真的有作用吗」
 *
 * 查下来：**没有作用，而且是两处静默叠加**。
 *
 * ① `fallback.js` 的 `buildBody` 构造请求体时**没有 reasoning_effort 字段**
 *    → 调用方设的 `reasoningEffort` 到这一层就被丢掉（连日志都没有）。
 * ② `bridge.js` 的等级校验：渠道**没声明**任何等级时走那条「什么都不做」的
 *    分支 → `ok` 保持 false → 压根不设，且**不报警**。
 *
 * 两处都是沉默的 —— 所以「配了 low、从来没生效」这件事查了很久才发现。
 *
 * ## 实测：magpie 其实认（所以两处都该放开）
 *
 * 直接打 `127.0.0.1:3425`，同一段 8.3k 字真实 prompt：
 * ```
 * 不传      7140ms   reasoning 662 字
 * low       2958ms   reasoning 106 字   ← 快 2.4 倍
 * medium    4515ms   reasoning 353 字
 * high      3384ms   reasoning 118 字
 * ```
 * 四档正文都通顺（都接住了同一个梗），看不出质量差别。
 *
 * ⚠️ 字段名必须是 **`reasoning_effort`（下划线）**。实测
 *    `reasoning: {effort: ...}` 与 `thinking: {type: ...}` **都无效**。
 *
 * ## 另一件：日程生成不该卡在回复路径
 *
 * `_ensureDayPlan()` 在 `_generate` 里被 `await`，而它是一次**完整模型调用** ——
 * 实测那一次**单独花了 42 秒**（16:47:44 收到 → 16:48:26 生成 → 16:48:30 才发出）。
 * 所以「今天第一条特别慢」的元凶不是生成，是它。现在改成 `wait: false`。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const repo = path.resolve(import.meta.dirname, '..')
/** 只看代码行，丢掉落单的注释行。 */
function codeLines(rel) {
  return fs.readFileSync(path.join(repo, rel), 'utf8')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('*/'))
}

// ── ① fallback 必须转发 reasoning_effort ────────────────────
ok('fallback.js 的 buildBody 必须把 reasoningEffort 转成 reasoning_effort', () => {
  const lines = codeLines('src/gateway/fallback.js')
  const i = lines.findIndex((l) => l.startsWith('function buildBody('))
  assert.ok(i >= 0, '应能找到 buildBody')
  const block = lines.slice(i, i + 40).join('\n')
  assert.match(block, /body\.reasoning_effort\s*=/, '必须写进请求体，否则上游根本收不到')
  assert.match(block, /o\.reasoningEffort/, '来源字段名是 reasoningEffort（内部名）')
})

ok('字段名是下划线的 reasoning_effort（实测 `reasoning`/`thinking` 都无效）', () => {
  const src = fs.readFileSync(path.join(repo, 'src/gateway/fallback.js'), 'utf8')
  assert.match(src, /reasoning_effort/, '必须是 reasoning_effort')
  // 不能写成别家的形态
  const lines = codeLines('src/gateway/fallback.js').filter((l) => l.includes('reasoning'))
  for (const l of lines) {
    assert.ok(!/body\.reasoning\b/.test(l), `不该用 body.reasoning（无效字段名）：${l}`)
  }
})

// ── ② bridge 的等级校验：没声明时也要照传 ───────────────────
ok('bridge：渠道没声明等级时要**照传**（原来静默不传）', () => {
  const lines = codeLines('src/qq/bridge.js')
  const i = lines.findIndex((l) => l.includes('不支持推理等级'))
  assert.ok(i >= 0, '应能找到等级校验分支')
  const block = lines.slice(i, i + 22).join('\n')
  assert.match(block, /else\s*\{/, '要有 else 分支处理「一个等级都没声明」的情况')
  assert.match(block, /没声明推理等级/, '并且要有日志 —— 静默才是这次查这么久的原因')
  assert.match(block, /ok = true/, '没声明时应当照传（有兜底，最坏是等级不生效）')
})

ok('bridge：仍然保留「不支持就去掉等级重试」的兜底', () => {
  const src = fs.readFileSync(path.join(repo, 'src/qq/bridge.js'), 'utf8')
  assert.match(src, /delete request\.reasoningEffort/, '兜底不能丢：否则上游不认时会整轮失败')
})

// ── ③ 日程生成不该卡在回复路径 ──────────────────────────────
ok('_ensureDayPlan 必须支持 wait:false', () => {
  const lines = codeLines('src/qq/bridge.js')
  const i = lines.findIndex((l) => l.includes('async _ensureDayPlan('))
  assert.ok(i >= 0, '应能找到 _ensureDayPlan')
  assert.match(lines[i], /\{\s*wait\s*=\s*true\s*\}\s*=\s*\{\}/, '签名要带 wait 开关')
  const block = lines.slice(i, i + 30).join('\n')
  assert.match(block, /if \(wait\) await/, '只在 wait 时才等')
})

ok('生成路径不能 await 日程生成（那次实测 42 秒）', () => {
  const lines = codeLines('src/qq/bridge.js')
  assert.ok(
    !lines.some((l) => /^await this\._ensureDayPlan\(\)$/.test(l)),
    '不该再有裸的 `await this._ensureDayPlan()` —— 它会卡住当条回复',
  )
  assert.ok(
    lines.some((l) => l.includes('_ensureDayPlan({ wait: false })')),
    '调用点应显式传 wait: false',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)