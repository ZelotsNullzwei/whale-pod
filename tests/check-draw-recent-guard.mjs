/**
 * 画图闸门 / 意图分类（2026-11-10；按评审意见 v2 调整）
 *
 * ## 事故
 * ```
 * 12:47:12 「来张自拍看看」→ 画图 → 发图
 * 12:47:46 「挑呗」        → 又画一张（连发两张）
 * ```
 * 根因：闸门条件 `&& !drewRecently` 把拦截分支整个跳过 → 直接放行再画。
 *
 * ## 评审后的调整
 * 1. **功能开关最高优先级**：`drawEnabled=false` 时不画、**也不问**（原来会先问）。
 * 2. `askBeforeDraw=false` 是"免确认模式"：允许按模型输出画，会放宽闸门 —— 写进矩阵。
 * 3. "明确重画"从 `PIC_REQUEST_PHRASES` 拆出成 `REDRAW_PHRASES` / `classifyRedrawIntent`，
 *    避免影响"首次要图"在别处（看图判断 / 群聊限制 / 部位特写 / 确认状态）的语义。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyDrawIntent, classifyRedrawIntent, decideDrawGate } from '../src/qq/bridge.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

console.log('=== 1. 意图分类：首次要图 vs 重画（分表）===')
ok('★「挑呗」不是要图', () => {
  for (const t of ['挑呗', '挑呗，选第二张', '这张不错', '这张好点']) {
    assert.equal(classifyDrawIntent(t).wantsPic, false, `${t} 不该算首次要图`)
  }
})

ok('★「换一张 / 重拍」属于"重画"，不属于"首次要图"', () => {
  /* 这三个原表里没有同义子串 → 必须只能算"重画" */
  for (const t of ['换一张', '重拍', '换个姿势拍']) {
    assert.equal(classifyRedrawIntent(t).redraw, true, `${t} 应算重画`)
    assert.equal(classifyDrawIntent(t).wantsPic, false, `${t} 不应混进首次要图（会扩大原表语义）`)
  }
  /* 「再来一张」「再发一张」本来就会命中既有的「来一张/发一张」（首次要图），只要求也算重画 */
  for (const t of ['再来一张', '再发一张']) {
    assert.equal(classifyRedrawIntent(t).redraw, true, `${t} 应算重画`)
  }
})

ok('★ 否定语境不算重画（覆盖多种搭配）', () => {
  /*
   * 2026-11-10 评审：否定排除原来只覆盖少数表达式，
   * 「别换个姿势」「不要重新拍」「不用再发一张」会漏 → 用户说不要了还出图。
   */
  const neg = [
    '别再重拍了', '不要换一张', '先不重画',
    '别换个姿势', '不要重新拍', '不用再发一张',
    '先别重拍，等等再说', '这张不错，不用换一张',
  ]
  for (const t of neg) assert.equal(classifyRedrawIntent(t).redraw, false, `${t} 不该算重画`)
})

ok('★ 转折句：否定一个、肯定另一个 → 仍算重画', () => {
  for (const t of ['不是换一张，是换个姿势', '不要换一张，要重拍']) {
    assert.equal(classifyRedrawIntent(t).redraw, true, `${t} 应算重画`)
  }
})

ok('首次要图仍正常（来张自拍看看）', () => {
  assert.equal(classifyDrawIntent('来张自拍看看').wantsPic, true)
  assert.equal(classifyRedrawIntent('来张自拍看看').redraw, false)
})

console.log('\n=== 2. 闸门矩阵（含优先级）===')
ok('★ 功能开关关闭 → 不画、也不问（最高优先级）', () => {
  for (const drewRecently of [true, false]) {
    for (const allowDraw of [true, false]) {
      const r = decideDrawGate({ drawEnabled: false, askBeforeDraw: true, allowDraw, drewRecently })
      assert.equal(r.draw, false, `开关关还画了（allow=${allowDraw},drew=${drewRecently}）`)
      assert.equal(r.ask, false, '关掉后不该还去问')
    }
  }
})

ok('★ 明确重画 → 画（可绕过"刚画过"）', () => {
  const r = decideDrawGate({ redrawRequested: true, drewRecently: true, allowDraw: false })
  assert.equal(r.draw, true)
})

ok('★ 免确认模式 askBeforeDraw=false → 画（并在文档里写明会放宽）', () => {
  const r = decideDrawGate({ askBeforeDraw: false, allowDraw: false, drewRecently: false })
  assert.equal(r.draw, true)
  assert.equal(r.ask, false)
})

ok('★ 明确要图 → 画', () => {
  assert.equal(decideDrawGate({ allowDraw: true }).draw, true)
})

ok('★ 没要 + 刚画过 → 不画、不问', () => {
  assert.deepEqual(decideDrawGate({ allowDraw: false, drewRecently: true }), { draw: false, ask: false, reason: '刚画过，没明确要新的' })
})

ok('★ 没要 + 没刚画过 → 不画、改问', () => {
  const r = decideDrawGate({ allowDraw: false, drewRecently: false })
  assert.equal(r.draw, false)
  assert.equal(r.ask, true)
})

console.log('\n=== 3. 事故时序复演（只该画 1 次）===')
ok('★「来张自拍看看」画 1 张，「挑呗」不再画、也不问', () => {
  let draws = 0, asks = 0, lastDrewAt = 0
  const turn = (text, nowMs) => {
    const { wantsPic } = classifyDrawIntent(text)
    const redraw = classifyRedrawIntent(text).redraw
    const drewRecently = lastDrewAt > 0 && nowMs - lastDrewAt < 5 * 60_000
    const g = decideDrawGate({ allowDraw: wantsPic, redrawRequested: redraw, drewRecently })
    if (g.ask) asks++
    if (g.draw) { draws++; lastDrewAt = nowMs }
    return g
  }
  const t0 = 1_800_000_000_000
  turn('来张自拍看看', t0)
  turn('挑呗', t0 + 30_000)
  assert.equal(draws, 1, `应只画 1 张，实际 ${draws}`)
  assert.equal(asks, 0, '刚画过不该再问')
})

ok('★ 但「换一张」在刚画过时仍要画', () => {
  let draws = 0
  const lastDrewAt = 1_800_000_000_000
  const nowMs = lastDrewAt + 30_000
  const { wantsPic } = classifyDrawIntent('换一张')
  const redraw = classifyRedrawIntent('换一张').redraw
  const drewRecently = nowMs - lastDrewAt < 5 * 60_000
  if (decideDrawGate({ allowDraw: wantsPic, redrawRequested: redraw, drewRecently }).draw) draws++
  assert.equal(draws, 1)
})

console.log('\n=== 4. 接线与表结构锁 ===')
ok('★ `_handle` 走 decideDrawGate，且没有 `&& !drewRecently` 旧条件', () => {
  assert.ok(!/askBeforeDraw[^\n]*&&\s*!drewRecently/.test(src), '旧条件又回来了')
  assert.match(src, /decideDrawGate\(\{/, '_handle 没有调用 decideDrawGate')
  assert.match(src, /redrawRequested,/, '没把 redrawRequested 传进闸门')
})
ok('★ 重画词不在 PIC_REQUEST_PHRASES 里（分表）', () => {
  const i = src.indexOf('export const PIC_REQUEST_PHRASES')
  const seg = src.slice(i, src.indexOf(']', i))
  for (const w of ['换一张', '重拍', '再来一张']) {
    assert.ok(!seg.includes(`'${w}'`), `PIC_REQUEST_PHRASES 里还有「${w}」`)
  }
  assert.match(src, /export const REDRAW_PHRASES/, '缺 REDRAW_PHRASES')
})
ok('★ 被拦下时补一句、不静默', () => {
  assert.match(src, /gateSkipRecent && !String\(text \?\? ''\)\.trim\(\)/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
