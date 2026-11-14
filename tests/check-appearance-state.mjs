/**
 * 聊天里的发型/穿搭状态（2026-11-11）——言行一致
 */
import assert from 'node:assert/strict'
import { detectSaidHair, detectSaidOutfitText } from '../src/qq/appearanceState.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const now = 1_800_000_000_000
const msg = (text, isMe = true, ageMin = 1) => ({ text, isMe, at: now - ageMin * 60_000 })

console.log('=== 1. 发型 ===')
ok('★ 她说「扎马尾」→ 出图用马尾', () => {
  assert.match(detectSaidHair([msg('你要看马尾的话，本鲸扎起来'), msg('行')], now), /马尾/)
})
ok('★ 「扎成丸子头」优先丸子头', () => {
  assert.match(detectSaidHair([msg('盘起来吧，扎成丸子头')], now), /丸子头/)
})
ok('她说「披着，没顾上梳」→ 披发', () => {
  assert.match(detectSaidHair([msg('披着的，早上没顾上梳')], now), /披着/)
})
ok('超过 2 小时的不算', () => {
  assert.equal(detectSaidHair([msg('扎马尾', true, 121)], now), '')
})
ok('用户说的不算（只看她自己说的）', () => {
  assert.equal(detectSaidHair([msg('你扎马尾吧', false)], now), '')
})
ok('模糊表述不当依据', () => {
  assert.equal(detectSaidHair([msg('头发今天有点烦')], now), '')
})

console.log('\n=== 2. 穿搭 ===')
ok('★ 她最近说过的换装会取出来（交给衣柜映射）', () => {
  const extract = (t) => (/我(换|穿)了(.+)/.exec(t)?.[2] ?? '')
  const raw = detectSaidOutfitText([msg('我换了那件白衬衫'), msg('哦')], now, 2 * 3600e3, extract)
  assert.match(raw, /白衬衫/)
})
ok('超过时间窗不算', () => {
  const extract = (t) => (/我(换|穿)了(.+)/.exec(t)?.[2] ?? '')
  assert.equal(detectSaidOutfitText([msg('我换了白衬衫', true, 121)], now, 2 * 3600e3, extract), '')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
