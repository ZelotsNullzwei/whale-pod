/**
 * V3.0 文档 ↔ 代码 一致性（防止 docs/photo-v3-modes.md 写成"想象版"）。
 * 只校验**现有 6 个模式**的不变量；新增模式（half_selfie/rear_object/scene_only/back_view）
 * 在实现后再加进这里。
 */
import assert from 'node:assert/strict'
import { MODES } from '../src/photo/photo-modes.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const need = ['face_closeup', 'front_selfie', 'rear_selfie', 'mirror_selfie', 'video_call', 'first_person']
const text = (m) => (m.rules || []).join('\n')

console.log('=== 结构 ===')
ok('6 个已实现模式都在', () => {
  for (const k of need) assert.ok(MODES[k], '缺模式 ' + k)
})
ok('每个模式字段齐全', () => {
  for (const k of need) {
    const m = MODES[k]
    for (const f of ['id', 'label', 'shooter', 'device', 'camera', 'framing', 'rules']) {
      assert.ok(m[f] !== undefined && m[f] !== '', `${k} 缺字段 ${f}`)
    }
    assert.ok(Array.isArray(m.framing) && m.framing.length > 0, `${k}.framing 应为非空数组`)
  }
})

console.log('\n=== 规则不变量（与文档一致） ===')
ok('mirror_selfie：规则里必须提"镜中要有手机"', () => {
  const t = text(MODES.mirror_selfie)
  assert.match(t, /手机/)
  assert.match(t, /镜/)
})
ok('first_person：规则里必须限制"不出现脸/人"', () => {
  const t = text(MODES.first_person)
  assert.ok(/不出现|不能出现/.test(t) && /脸|人/.test(t), 'first_person 规则缺少"不出现脸/人"')
})
ok('rear_selfie：规则里必须限制"不出现人物"', () => {
  const t = text(MODES.rear_selfie)
  assert.match(t, /人/)
})
ok('front_selfie / face_closeup：规则里必须提到手机本体不入画', () => {
  assert.match(text(MODES.front_selfie) + text(MODES.face_closeup), /手机/)
})
ok('所有模式 framing 都是字符串数组', () => {
  for (const k of need) for (const f of MODES[k].framing) assert.equal(typeof f, 'string')
})

console.log('\n=== 未实现模式（明确记录，避免误以为已支持） ===')
ok('half_selfie / rear_object / scene_only / back_view 目前未定义', () => {
  const notYet = ['half_selfie', 'rear_object', 'scene_only', 'back_view'].filter((k) => MODES[k])
  assert.deepEqual(notYet, [], '这些还没实现，出现说明有人提前改了 photo-modes：' + notYet.join(','))
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
