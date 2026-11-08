/**
 * framing-planner 回归（V3.0 第三阶段）。
 * 只测取景层：不改 subject/camera，camera=null → unresolved，第一人称 handheld 上物下手。
 */
import assert from 'node:assert/strict'
import { planIntent } from '../src/photo/photo-planner.js'
import { planCamera } from '../src/photo/camera-planner.js'
import { planFraming, FRAMING_BANDS } from '../src/photo/framing-planner.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const chain = (scene, raw) => {
  const i = planIntent({ scene, slot: 'evening' })
  if (raw) i._raw = raw
  const c = planCamera(i)
  const f = planFraming(i, c)
  return { i, c, f }
}

console.log('=== 1. 不改上游 ===')
ok('framing 不修改 subject / camera', () => {
  const { i, c } = chain('对镜拍一张，展示今天的穿搭')
  const beforeI = JSON.stringify(i.subject)
  const beforeC = JSON.stringify(c.geometry)
  planFraming(i, c)
  assert.equal(JSON.stringify(i.subject), beforeI)
  assert.equal(JSON.stringify(c.geometry), beforeC)
})

console.log('\n=== 2. camera=null → framing unresolved ===')
ok('机位未定时不猜取景', () => {
  const { f } = chain('坐在床边看漫画')
  assert.equal(f.band, null)
  assert.equal(f.source, 'unresolved')
  assert.ok(f.unresolved.length > 0)
  assert.equal(f.visibleRange.top, null)
})

console.log('\n=== 3. 各模式默认取景 ===')
const cases = [
  ['怼脸拍一张', 'face'],
  ['前置自拍', 'head_shoulder'],
  ['对镜拍一张', 'full'],
  ['想要个背影', 'back'],
  ['拍给你看这个', 'object'],
  ['拍一下窗外的雨', 'scene'],
  ['视频通话中', 'head_shoulder'],
]
for (const [scene, band] of cases) {
  ok(`${scene} → band=${band}`, () => {
    const { f } = chain(scene)
    assert.equal(f.band, band)
    assert.equal(f.aspect, '9:16')
    assert.ok(f.entry)
    assert.ok(f.visibleRange.top && f.visibleRange.bottom)
    assert.equal(f.composition, null, 'composition 不在本层')
  })
}

console.log('\n=== 4. intent.framing 校正取景（但不改机位） ===')
ok('前置自拍 + 全身 → band=full，机位仍是 front_selfie', () => {
  const { c, f } = chain('前置自拍，全身')
  assert.equal(c.mode, 'front_selfie')
  assert.equal(f.band, 'full')
  assert.equal(f.source, 'intent_framing')
})
ok('半身 → half', () => {
  assert.equal(chain('前置自拍，半身').f.band, 'half')
})

console.log('\n=== 5. 第一人称五子型取景 + 上物下手 ===')
ok('hand_action_pov：band=hand_object，layout 明确"上物下手"', () => {
  const { c, f } = chain('第一人称', '第一人称 端着杯子喝')
  assert.equal(c.povSubtype, 'hand_action_pov')
  assert.equal(f.band, 'hand_object')
  assert.match(f.layout, /上 2\/3/)
  assert.match(f.layout, /下 1\/3/)
})
ok('tabletop_pov：band=object，且有桌面布局说明', () => {
  const { f } = chain('第一人称', '第一人称 书桌上写字')
  assert.equal(f.band, 'object')
  assert.ok(f.layout && f.layout.includes('桌面'))
})
ok('lap_pov：band=hand_object', () => {
  assert.equal(chain('第一人称', '第一人称 腿上放着漫画').f.band, 'hand_object')
})
ok('close_object_pov：band=object', () => {
  assert.equal(chain('第一人称', '第一人称 小物件 特写').f.band, 'object')
})
ok('eye_pov：band=scene 且没有手部布局', () => {
  const { f } = chain('第一人称', '第一人称 窗外 远处 风景')
  assert.equal(f.band, 'scene')
  assert.equal(f.layout, null)
})

console.log('\n=== 6. 契约 ===')
ok('字段齐全', () => {
  const { f } = chain('前置自拍')
  for (const k of ['band', 'aspect', 'entry', 'layout', 'visibleRange', 'composition', 'source', 'unresolved']) {
    assert.ok(k in f, '缺 ' + k)
  }
  assert.ok('top' in f.visibleRange && 'bottom' in f.visibleRange)
})
ok('band 只能取已知值', () => {
  const { f } = chain('前置自拍')
  assert.ok(FRAMING_BANDS.includes(f.band), '未知 band: ' + f.band)
})
ok('未知机位 → 仍返回完整结构（不抛错）', () => {
  const f = planFraming({}, { mode: 'weird' })
  assert.equal(f.band, null)
  assert.ok(f.unresolved.some((u) => u.startsWith('unknown_camera_mode')))
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
