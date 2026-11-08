/**
 * camera-planner 输出契约测试（评审要求：完整输出契约 + 空值传递）。
 * 对**每一个** mode / POV 子型逐一校验结构，而不是抽样。
 */
import assert from 'node:assert/strict'
import { planIntent } from '../src/photo/photo-planner.js'
import { planCamera, listCameraModes } from '../src/photo/camera-planner.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const TOP = ['mode', 'source', 'povSubtype', 'capture', 'geometry', 'visibility', 'hands', 'unresolved']
const CAP = ['device', 'deviceVisible', 'holdingDevice']
const GEO = ['position', 'height', 'orientation', 'distance', 'direction']
const VIS = ['face', 'hands', 'arms', 'phone', 'bodyParts']
const HND = ['actionHands', 'poseHands', 'cameraHands']

function checkShape(c, label) {
  for (const k of TOP) assert.ok(k in c, `${label} 缺顶层字段 ${k}`)
  for (const k of CAP) assert.ok(k in c.capture, `${label}.capture 缺 ${k}`)
  for (const k of GEO) assert.ok(k in c.geometry, `${label}.geometry 缺 ${k}`)
  for (const k of VIS) assert.ok(k in c.visibility, `${label}.visibility 缺 ${k}`)
  for (const k of HND) assert.ok(k in c.hands, `${label}.hands 缺 ${k}`)
  assert.ok(Array.isArray(c.visibility.hands), `${label}.visibility.hands 应为数组`)
  assert.ok(Array.isArray(c.visibility.arms), `${label}.visibility.arms 应为数组`)
  assert.ok(Array.isArray(c.visibility.bodyParts), `${label}.visibility.bodyParts 应为数组`)
  assert.ok(Array.isArray(c.unresolved), `${label}.unresolved 应为数组`)
  /* 不允许 undefined：未知必须是 null */
  for (const k of GEO) assert.notEqual(c.geometry[k], undefined, `${label}.geometry.${k} 不能是 undefined（未知用 null）`)
  for (const k of CAP) assert.notEqual(c.capture[k], undefined, `${label}.capture.${k} 不能是 undefined`)
  for (const k of HND) assert.equal(typeof c.hands[k], 'number', `${label}.hands.${k} 必须是数字`)
}

console.log('=== 每个已知模式的契约 ===')
const scenes = {
  face_closeup: '怼脸拍一张',
  front_selfie: '前置自拍',
  half_selfie: '前置自拍，半身',
  mirror_selfie: '对镜拍一张',
  back_view: '想要个背影',
  video_call: '视频通话中',
  rear_object: '拍给你看这个',
  scene_only: '拍一下窗外的雨',
}
for (const [mode, scene] of Object.entries(scenes)) {
  ok(`${mode}：结构完整且 unresolved 为空`, () => {
    const c = planCamera(planIntent({ scene, slot: 'evening' }))
    checkShape(c, mode)
    assert.deepEqual(c.unresolved, [], `${mode} 不该有 unresolved`)
  })
}

console.log('\n=== 每个 POV 子型的契约 ===')
const povs = {
  eye_pov: '第一人称 窗外 远处 风景',
  hand_action_pov: '第一人称 端着杯子喝',
  tabletop_pov: '第一人称 书桌上写字',
  lap_pov: '第一人称 腿上放着漫画',
  close_object_pov: '第一人称 小物件 特写',
}
for (const [sub, raw] of Object.entries(povs)) {
  ok(`${sub}：结构完整、手机不可见、无脸`, () => {
    const i = planIntent({ scene: '第一人称', slot: 'evening' })
    i._raw = raw
    const c = planCamera(i)
    checkShape(c, sub)
    assert.equal(c.povSubtype, sub)
    assert.equal(c.visibility.phone, false, 'POV 里手机不许入画')
    assert.equal(c.visibility.face, false, 'POV 里不出现脸')
    assert.equal(c.mode, 'first_person')
  })
}

console.log('\n=== 空值传递 ===')
ok('camera=null：所有"未知"必须是 null，不能是 undefined 或默认值', () => {
  const c = planCamera(planIntent({ scene: '坐在床边看漫画', slot: 'evening' }))
  checkShape(c, 'unresolved')
  assert.equal(c.mode, null)
  assert.equal(c.capture.device, null)
  assert.equal(c.capture.deviceVisible, null)
  for (const k of GEO) assert.equal(c.geometry[k], null, `geometry.${k} 应为 null`)
  assert.equal(c.visibility.face, null)
  assert.equal(c.visibility.phone, null)
  assert.ok(c.unresolved.length > 0)
})
ok('未知模式：结构仍然完整（不抛错、不伪造几何）', () => {
  const c = planCamera({ camera: { mode: 'not_a_mode', source: 'explicit' } })
  checkShape(c, 'unknown')
  assert.ok(c.unresolved.some((u) => u.startsWith('unknown_mode')))
})

console.log('\n=== 清单一致性 ===')
ok('listCameraModes 覆盖 7 模式 + first_person + 5 POV', () => {
  const l = listCameraModes()
  for (const m of ['face_closeup', 'front_selfie', 'mirror_selfie', 'back_view', 'rear_object', 'scene_only', 'video_call', 'first_person']) {
    assert.ok(l.modes.includes(m), '缺模式 ' + m)
  }
  assert.equal(l.povSubtypes.length, 5)
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
