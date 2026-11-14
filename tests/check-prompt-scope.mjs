/**
 * 提示词作用域（2026-11-11 v2）
 * object / environment 不得注入：人物身份、当日服装、发型、表情、姿势、DAILY/CLOSE、手部契约、构图扩展。
 */
import assert from 'node:assert/strict'
import { planShot } from '../src/photo/index.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const base = { slot: 'noon', scope: 'scope-test-' + Math.random(), outfit: '浅灰短袖家居T恤，深蓝棉布长裤，木色拖鞋', hair: '披着，头发有点乱', mode: 'daily', imageCfg: {} }
const P = (o) => String(planShot({ ...base, ...o })?.prompt ?? '')

console.log('=== object（后置拍物） ===')
ok('★ 只写物品/地点，不注入人物/服装/表情/手部', () => {
  const p = P({ scene: '洗锅；后置拍物，正面平拍：小厨房水槽，锅里泡着水，旁边刷子洗洁精；不要出现手、不要出现任何人', sceneOnly: true, subjectMode: 'object', forceMode: 'rear_selfie' })
  assert.match(p, /生活物品照片/); assert.match(p, /没有人和手/); assert.match(p, /拍摄对象/)
  for (const bad of ['【人物身份】', '今天穿着', '【表情与肢体】', '【构图扩展】', '【手部契约】', '【风格模式']) {
    assert.ok(!p.includes(bad), `不应出现 ${bad}`)
  }
})

console.log('\n=== environment（天气/环境） ===')
ok('★ 只写环境/地点，不注入人物/衣服/手', () => {
  const p = P({ scene: '窗外的天气：客厅窗户，外面有点风', weather: '多云，二十度，有点风', sceneOnly: true, subjectMode: 'environment', forceMode: 'rear_selfie' })
  assert.match(p, /生活物品照片/); assert.match(p, /拍摄对象/)
  for (const bad of ['【人物身份】', '今天穿着', '【表情与肢体】', '【手部契约】', '【构图扩展】']) {
    assert.ok(!p.includes(bad), `不应出现 ${bad}`)
  }
})

console.log('\n=== person（自拍）照旧 ===')
ok('★ 自拍仍有人物/今天穿着，但没有重复手部契约（精简提示词）', () => {
  const p = P({ scene: '居家自拍：卧室；前置镜头，半身，手机在画外', subjectMode: 'person', forceMode: 'front_selfie' })
  assert.match(p, /今天穿着/); assert.match(p, /一只手举着手机/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
