/**
 * 图发出来之后别再补一句话（2026-11-06）。
 *
 * 用户：「图发出来之后是完全没必要了吧」。
 *
 * ## 现场
 * ```
 * 16:52:11 她「行，全身。」
 * 16:52:13 她 [图]
 * 16:52:17 她「（拍了拍裙摆，站到镜子前）行，全身给你看，别眨眼。」
 * ```
 * 图本身已经回答了"给你看"，后面这句多余，还占一屏。
 *
 * ## 规则
 * 这条要发图 → **正文丢弃**。
 * 不丢的情况：
 *   · 有动作结果要说明（禁言/改名/签名/发群 —— notes 非空）
 *   · 正文里有链接，或剥掉括号动作后 >= 30 字（不只是"给你看"）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/**
 * 把 `_handle` 里那段判定**原样复刻**成纯函数（测逻辑，不测副作用）。
 * ⚠️ 改 bridge 里那段时要同步改这里。
 */
function shouldDropText({ text, hasCover, notes = [], enabled = true }) {
  if (!hasCover || !enabled || notes.length > 0) return false
  const t = String(text ?? '').trim()
  const substantive = t.replace(/^[（(][^）)]*[）)]/, '').trim()
  // ⚠️ 空串也要丢（纯动作旁白，配上图已经是完整表达）
  return substantive.length < 30 && !/https?:\/\//.test(substantive)
}

console.log('=== 1. 线上那句要被丢掉 ===')
ok('★「（拍了拍裙摆，站到镜子前）行，全身给你看，别眨眼。」→ 丢', () => {
  const t = '（拍了拍裙摆，站到镜子前）行，全身给你看，别眨眼。'
  assert.equal(shouldDropText({ text: t, hasCover: true }), true)
})

ok('短句「行，全身。」→ 丢', () => {
  assert.equal(shouldDropText({ text: '行，全身。', hasCover: true }), true)
})

ok('纯动作旁白「（抬眼看你）」→ 丢（本来就只是旁白）', () => {
  assert.equal(shouldDropText({ text: '（抬眼看你）', hasCover: true }), true)
})

console.log('\n=== 2. 该留的还得留 ===')
ok('★ 有动作结果要说明（禁言/改名/发群）→ 留', () => {
  assert.equal(shouldDropText({ text: '行，全身。', hasCover: true, notes: ['发群里了'] }), false)
})

ok('★ 实质内容 >= 30 字 → 留（不只是"给你看"）', () => {
  const long = '这张是刚拍的对镜全身，灯有点偏黄，床头那盏没关，你要是觉得太暗我换个角度再拍一张给你挑。'
  assert.ok(long.length >= 30)
  assert.equal(shouldDropText({ text: long, hasCover: true }), false)
})

ok('正文里有链接 → 留', () => {
  assert.equal(shouldDropText({ text: '地址在这 https://x.y/z', hasCover: true }), false)
})

ok('没图 → 一律不动正文', () => {
  assert.equal(shouldDropText({ text: '行，全身。', hasCover: false }), false)
})

ok('开关关掉 → 回到"图 + 文"', () => {
  assert.equal(shouldDropText({ text: '行，全身。', hasCover: true, enabled: false }), false)
})

console.log('\n=== 3. 源码里真的有这段 && 可配 ===')
ok('★ bridge 里有丢弃逻辑和日志', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /imageNoText/)
  assert.match(src, /图已经说明白了，丢弃附带的正文/)
})

ok('★ 默认开启', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /imageNoText !== false/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
