/**
 * 「拍了吗 / 图呢」也算要图（2026-11-08）。
 *
 * ## 现场
 * ```
 * 19:14:27  他「拍了吗」
 * 19:14:32  bridge：画图跳过 —— 他没说要拍（先问"拍什么、怎么拍"）
 * 19:14:34  她「没有。刚才那条说拍了，图没跟上，本鲸重来。」
 * ```
 * 判定要图的短语表里没有「拍了吗」，于是她写了 `[画图:…]` 也被闸门跳过 ——
 * 嘴上说拍了、图根本没生成。
 *
 * 守什么：
 * ① 催图类句子（拍了吗/图呢/照片呢/重新拍）→ wantsPic
 * ② 别误伤（今天天气不错 / 我看看书）
 */
import assert from 'node:assert/strict'
import { classifyDrawIntent } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 催图类要放行 ===')
for (const t of ['拍了吗', '拍了没', '图呢', '照片呢', '重新拍', '再拍一张']) {
  ok(`★ 「${t}」→ wantsPic`, () => {
    assert.equal(classifyDrawIntent(t).wantsPic, true)
  })
}

console.log('\n=== 2. 别误伤 ===')
ok('★ 「今天天气不错」不是要图', () => {
  assert.equal(classifyDrawIntent('今天天气不错').wantsPic, false)
})
ok('★ 「我看看书」不是要图', () => {
  assert.equal(classifyDrawIntent('我看看书').wantsPic, false)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
