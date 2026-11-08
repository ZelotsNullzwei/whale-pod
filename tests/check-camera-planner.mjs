/**
 * camera-planner 回归（v2：capture/visibility 分离 + 三类手 + back_view 注册 + 去重）。
 */
import assert from 'node:assert/strict'
import { planIntent } from '../src/photo/photo-planner.js'
import { planCamera, pickPovSubtype, listCameraModes } from '../src/photo/camera-planner.js'
import { MODES } from '../src/photo/photo-modes.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}
const cam = (scene) => planCamera(planIntent({ scene, slot: 'evening' }))
const it = (scene) => planIntent({ scene, slot: 'evening' })

console.log('=== 1. capture 与 visibility 必须分开 ===')
ok('前置自拍：holdingDevice=true 但 deviceVisible=false，且可见手为 0', () => {
  const c = cam('前置自拍')
  assert.equal(c.capture.holdingDevice, true)
  assert.equal(c.capture.deviceVisible, false)
  assert.deepEqual(c.visibility.hands, [], '拿着手机 ≠ 画面上出现拿手机的手')
  assert.equal(c.visibility.phone, false)
  assert.equal(c.hands.cameraHands, 1)
})
ok('对镜自拍：手机在镜中可见（deviceVisible=true, phone=true）', () => {
  const c = cam('对镜拍一张')
  assert.equal(c.capture.deviceVisible, true)
  assert.equal(c.visibility.phone, true)
  assert.deepEqual(c.visibility.hands, ['camera_hand'])
})
ok('视频通话：不持机（架在桌上），cameraHands=0', () => {
  const c = cam('视频通话中')
  assert.equal(c.capture.holdingDevice, false)
  assert.equal(c.hands.cameraHands, 0)
})

console.log('\n=== 2. 三类手（action/pose/camera） ===')
ok('单手拿杯子：actionHands=1，不出现两只', () => {
  const c = cam('第一人称，端着杯子')
  assert.equal(c.hands.actionHands, 1)
  assert.equal(c.visibility.hands.length, 1)
})
ok('双手捧碗：actionHands=2', () => {
  const c = cam('第一人称，双手捧着碗')
  assert.equal(c.hands.actionHands, 2)
  assert.equal(c.visibility.hands.length, 2)
})
ok('看风景 POV：没有动作 → 不强行出现手', () => {
  const c = cam('第一人称，窗外 远处')
  assert.equal(c.hands.actionHands, 0)
  assert.deepEqual(c.visibility.hands, [])
})
ok('桌面写字：有动作才有手', () => {
  const a = cam('第一人称，书桌上写字')
  const b = cam('第一人称，书桌上的杯子')
  assert.equal(a.hands.actionHands, 1)
  assert.equal(b.hands.actionHands, 0)
})

console.log('\n=== 3. back_view 正式注册 ===')
ok('photo-modes 里有 back_view，且不是 mirror/front', () => {
  assert.ok(MODES.back_view, 'back_view 未注册')
  assert.equal(MODES.back_view.id, 'back_view')
  assert.notEqual(MODES.back_view.id, 'mirror_selfie')
})
ok('back_view 几何：人物后方、不露脸', () => {
  const c = cam('想要个背影')
  assert.equal(c.mode, 'back_view')
  assert.equal(c.geometry.position, 'behind_subject')
  assert.equal(c.visibility.face, false)
})

console.log('\n=== 4. scene_only 与 eye_pov 必须分开 ===')
ok('拍窗外 → scene_only（环境摄影）', () => {
  const c = cam('拍一下窗外的雨')
  assert.equal(c.mode, 'scene_only')
})
ok('第一人称看窗外 → eye_pov（角色观察）', () => {
  const c = cam('第一人称，窗外 远处')
  assert.equal(c.mode, 'first_person')
  assert.equal(c.povSubtype, 'eye_pov')
  assert.notEqual(c.mode, 'scene_only')
})

console.log('\n=== 5. 语义修复 ===')
ok('活动去重：holding_item 不重复出现', () => {
  const i = it('手里端着杯子，拿着杯子喝')
  const types = i.activities.map((a) => a.type)
  assert.equal(new Set(types).size, types.length, '不应有重复动作：' + types.join(','))
})
ok('小物件特写 → subject=object（不是 character）', () => {
  const i = it('桌上的小物件 特写')
  assert.equal(i.subject, 'object')
})
ok('close_object_pov 不改变主体类型', () => {
  const i = it('第一人称，小物件 特写')
  const c = planCamera(i)
  assert.equal(c.povSubtype, 'close_object_pov')
  assert.equal(i.subject, 'object', 'camera 层不得改主体')
})

console.log('\n=== 6. 空值传递 / 未知模式 ===')
ok('camera=null → 全 null，且不是任何默认模式', () => {
  const c = cam('坐在床边看漫画')
  assert.equal(c.mode, null)
  assert.equal(c.capture.device, null)
  assert.equal(c.geometry.position, null)
  assert.equal(c.visibility.face, null)
  assert.equal(c.hands.cameraHands, 0)
  assert.ok(c.unresolved.includes('camera_mode'))
})
ok('未知模式 → unresolved，不假装认识', () => {
  const c = planCamera({ camera: { mode: 'weird', source: 'explicit' } })
  assert.ok(c.unresolved.some((u) => u.startsWith('unknown_mode')))
  assert.equal(c.geometry.position, null)
})

console.log('\n=== 7. 五子型几何互不相同 ===')
ok('eye/hand/tabletop/lap/close 的几何两两不同', () => {
  const mk = (raw) => { const i = it('第一人称'); i._raw = raw; return planCamera(i) }
  const set = [mk('第一人称 窗外 远处'), mk('第一人称 端着杯子'), mk('第一人称 书桌上写字'), mk('第一人称 腿上放着漫画'), mk('第一人称 小物件 特写')]
  const sig = (c) => [c.povSubtype, c.geometry.position, c.geometry.orientation, c.geometry.direction].join('|')
  assert.equal(new Set(set.map(sig)).size, 5)
})

console.log('\n=== 8. 输出契约 ===')
ok('字段齐全', () => {
  const c = cam('前置自拍')
  for (const k of ['mode', 'source', 'povSubtype', 'capture', 'geometry', 'visibility', 'hands', 'unresolved']) assert.ok(k in c, '缺 ' + k)
  for (const k of ['device', 'deviceVisible', 'holdingDevice']) assert.ok(k in c.capture)
  for (const k of ['actionHands', 'poseHands', 'cameraHands']) assert.ok(k in c.hands)
})
ok('模式清单含 back_view，POV 五个', () => {
  const l = listCameraModes()
  assert.ok(l.modes.includes('back_view'))
  assert.equal(l.povSubtypes.length, 5)
})
ok('intent 有 schemaVersion（字段冻结标记）', () => {
  assert.equal(it('前置自拍').schemaVersion, '3.0.0-intent')
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
