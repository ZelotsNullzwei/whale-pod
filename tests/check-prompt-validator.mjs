/**
 * Prompt Validator（v2）：PI 静态检查
 */
import assert from 'node:assert/strict'
import { validatePrompt } from '../src/photo/prompt-validator.js'
import { planShot } from '../src/photo/index.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const codes = (p, ctx) => validatePrompt(p, ctx).issues.map((x) => x.code)

console.log('=== 1. 正常 prompt ===')
ok('★ object 纯物照：无 PI 问题', () => {
  const s = planShot({ scene: '洗锅；水槽里只有锅和刷子，不要出现手、不要出现任何人', slot: 'noon', scope: 'pv1', imageCfg: {}, sceneOnly: true, subjectMode: 'object', forceMode: 'rear_selfie' })
  const r = validatePrompt(s.prompt, { subjectMode: 'object', mode: s.mode, framing: s.framing })
  assert.equal(r.ok, true, JSON.stringify(r.issues))
})
ok('★ person 自拍：无 PI 问题', () => {
  const s = planShot({ scene: '居家自拍，半身，手机在画外', slot: 'noon', scope: 'pv2', outfit: '浅灰T恤，深蓝长裤', hair: '披着', imageCfg: {}, subjectMode: 'person', forceMode: 'front_selfie' })
  const r = validatePrompt(s.prompt, { subjectMode: 'person', mode: s.mode, framing: s.framing })
  assert.equal(r.ok, true, JSON.stringify(r.issues))
})

console.log('=== 2. 越界/矛盾能抓到 ===')
ok('object 注入人物/服装/表情/手部 → PI-002/003/004/006', () => {
  const bad = '【人物身份】她是…\n今天穿着：浅灰T恤\n【表情与肢体】微笑\n【手部契约】最多 1 只手'
  const c = codes(bad, { subjectMode: 'object' })
  for (const x of ['PI_002', 'PI_003', 'PI_004', 'PI_006']) assert.ok(c.includes(x), x + ' 缺失：' + c)
})
ok('front_selfie 写"手机可以入画" → PI-007', () => {
  assert.ok(codes('手机可以入画', { subjectMode: 'person', mode: 'front_selfie' }).includes('PI_007'))
})
ok('全身+半身同时出现 → PI-011', () => {
  assert.ok(codes('全身入镜，半身入镜', { subjectMode: 'person' }).includes('PI_011'))
})
ok('残句 → PI-021', () => {
  assert.ok(codes('\n以参考图和【人物】为准。\n', { subjectMode: 'person' }).includes('PI_021'))
})
ok('object 里重复【人物】→ PI-022', () => {
  assert.ok(codes('【人物】没有人\n【人物】没人', { subjectMode: 'object' }).includes('PI_022'))
})
ok('object 里固定倍率尾巴 → PI-023', () => {
  assert.ok(codes('擦净镜头、1.5-3 倍放大', { subjectMode: 'environment' }).includes('PI_023'))
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
