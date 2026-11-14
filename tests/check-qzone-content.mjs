/**
 * 说说内容构成（2026-11-11，2026-11-12 修订）：
 * 自拍/穿搭/食物物品/天气。
 * 2026-11-12 用户口径：自拍改走对镜（前置手持自拍手机总入画）；
 * 生活小事改后置拍物（不硬画手/人）。所以 selfie→mirror_selfie、scene→rear_selfie。
 */
import assert from 'node:assert/strict'
import { CONTENT_RATIO, pickContentType, composeContent } from '../src/qq/qzoneProactive.js'
import { planShot } from '../src/photo/index.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 长期配比 ===')
ok('★ 100 次选择接近 45/25/20/10', () => {
  const state = { typeCounts: {} }
  const avail = ['selfie', 'outfit', 'scene', 'weather']
  const got = { selfie: 0, outfit: 0, scene: 0, weather: 0 }
  for (let i = 0; i < 100; i++) {
    const t = pickContentType(state, avail)
    got[t]++
    state.typeCounts[t] = (state.typeCounts[t] ?? 0) + 1
  }
  for (const k of avail) {
    assert.ok(Math.abs(got[k] - CONTENT_RATIO[k] * 100) <= 10, `${k}=${got[k]}`)
  }
})
ok('只给可用类型（没有穿搭就不选 outfit）', () => {
  assert.notEqual(pickContentType({ typeCounts: {} }, ['selfie', 'scene']), 'outfit')
})

console.log('\n=== 2. 拍摄动机 ===')
ok('★ 自拍 → mirror_selfie（2026-11-12：改对镜，避免前置手持手机入画）', () => {
  const c = composeContent('selfie', { hair: '披着，头发有点乱' })
  assert.equal(c.mode, 'mirror_selfie'); assert.ok(c.text.length > 4)
})
ok('★ 穿搭 → mirror_selfie', () => {
  const c = composeContent('outfit', { outfit: '白色蕾丝发带，浅灰短袖家居T恤，深蓝棉布长裤' })
  assert.equal(c.mode, 'mirror_selfie')
})
ok('★ 天气 → rear_selfie（后置拍物，不拍人）', () => {
  const c = composeContent('weather', { weather: '多云，二十度，有点风' })
  assert.equal(c.mode, 'rear_selfie'); assert.ok(!/你|您/.test(c.text))
})
ok('★ 生活小事 → rear_selfie（后置拍物；事实来自 smallThing）', () => {
  const c = composeContent('scene', { smallThing: '把洗手台的肥皂盒刷干净了' })
  assert.equal(c.mode, 'rear_selfie'); assert.match(c.text, /肥皂盒/)
})

console.log('\n=== 3. planShot forceMode ===')
ok('planShot(forceMode=mirror_selfie) 真的走镜面', () => {
  const s = planShot({ scene: '今天的穿搭', forceMode: 'mirror_selfie', slot: 'noon', scope: 'x1', outfit: '浅灰T恤', hair: '马尾', imageCfg: {} })
  assert.equal(s.mode, 'mirror_selfie')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
