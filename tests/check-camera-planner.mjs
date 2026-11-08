/**
 * camera-planner 回归（V3.0 第二阶段，14 项要求）。
 */
import assert from 'node:assert/strict'
import { planIntent } from '../src/photo/photo-planner.js'
import { planCamera, pickPovSubtype, listCameraModes } from '../src/photo/camera-planner.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}
const cam = (scene) => planCamera(planIntent({ scene, slot: 'evening' }))
const it = (scene) => planIntent({ scene, slot: 'evening' })

console.log('=== 1-3 解耦（camera 不反向影响主体/目的） ===')
ok('1 相同 subject、不同 camera', () => {
  const a = cam('前置自拍')
  const b = cam('对镜拍一张，展示今天的穿搭')
  assert.equal(it('前置自拍').subject, it('对镜拍一张，展示今天的穿搭').subject)
  assert.notEqual(a.mode, b.mode)
})
ok('2 相同 camera、不同 subject', () => {
  const a = cam('第一人称，手里端着杯子')     // object
  const b = cam('第一人称，看着窗外的雨')      // scene 主体但机位同为 first_person
  assert.equal(a.mode, b.mode)
  assert.notEqual(it('第一人称，手里端着杯子').subject, it('第一人称，看着窗外的雨').subject)
})
ok('3 相同活动、不同目的（看漫画 vs 拍漫画）', () => {
  const a = cam('坐在床边看漫画')
  const b = cam('把漫画拍给你看')
  assert.equal(it('坐在床边看漫画').activities.some((x) => x.type === 'reading'), true)
  assert.notEqual(a.mode, b.mode, '目的不同 → 机位应不同')
})

console.log('\n=== 4-5 null 语义 / 明确优先 ===')
ok('4 camera=null 时不生成自拍', () => {
  const c = cam('坐在床边看漫画')
  assert.equal(c.mode, null)
  assert.equal(c.source, 'unresolved')
  assert.ok(c.unresolved.includes('camera_mode'))
  assert.deepEqual(c.visibility.hands, [])
})
ok('5 明确机位优先于推断机位', () => {
  const i = it('拍给你看这个，但是用前置自拍')
  assert.equal(i.camera.source, 'explicit')
  assert.equal(planCamera(i).mode, 'front_selfie')
})

console.log('\n=== 6 五种 POV 几何必须不同 ===')
ok('6 eye/hand/tabletop/lap/close 的几何互不相同', () => {
  const mk = (raw) => {
    const i = it('第一人称')
    i._raw = raw
    return planCamera(i)
  }
  const set = {
    eye_pov: mk('第一人称 窗外 远处 风景'),
    hand_action_pov: mk('第一人称 端着杯子喝'),
    tabletop_pov: mk('第一人称 书桌上写字'),
    lap_pov: mk('第一人称 腿上放着漫画'),
    close_object_pov: mk('第一人称 小物件 特写 近一点'),
  }
  const sig = (c) => [c.povSubtype, c.geometry.position, c.geometry.orientation, c.geometry.direction].join('|')
  const sigs = Object.values(set).map(sig)
  assert.equal(new Set(sigs).size, 5, '五种子型几何必须各不相同，实际：' + sigs.join(' / '))
})
ok('6b 子型判定符合预期', () => {
  const f = (raw) => pickPovSubtype({ activities: [], _raw: raw })
  assert.equal(f('第一人称 窗外 远处'), 'eye_pov')
  assert.equal(f('第一人称 书桌上写字'), 'tabletop_pov')
  assert.equal(f('第一人称 腿上放着漫画'), 'lap_pov')
  assert.equal(f('第一人称 小物件 特写'), 'close_object_pov')
  assert.equal(f('第一人称 端着杯子'), 'hand_action_pov')
})

console.log('\n=== 7-10 POV 手/手机约束 ===')
ok('7 POV 不出现无理由的额外手臂', () => {
  const c = cam('第一人称，端着杯子')
  assert.ok(c.visibility.arms.length <= 1, '单手动作不应出现两条手臂')
  assert.deepEqual(c.visibility.hands, ['action_hand'])
})
ok('8 单手动作不能生成双手操作', () => {
  const c = cam('第一人称，端着杯子')
  assert.notEqual(c.visibility.hands.length, 2)
})
ok('9 双手动作必须有明确依据', () => {
  const one = cam('第一人称，端着杯子')
  const two = cam('第一人称，双手捧着碗')
  assert.equal(two.visibility.hands.length, 2, '明确"双手"时才两只')
  assert.equal(one.visibility.hands.length, 1)
})
ok('10 手机不进入第一人称画面', () => {
  for (const s of ['第一人称，端着杯子', '第一人称，书桌上写字']) {
    assert.equal(cam(s).visibility.phone, false)
  }
})

console.log('\n=== 11-14 其他模式一致性 ===')
ok('11 镜面自拍：镜子/手机/人物反射关系一致（手机必须在镜中可见）', () => {
  const c = cam('对镜拍一张')
  assert.equal(c.mode, 'mirror_selfie')
  assert.equal(c.visibility.phone, true, '镜拍必须能看到手机')
  assert.equal(c.visibility.face, true)
  assert.equal(c.geometry.position, 'in_front_of_mirror')
})
ok('12 back_view ≠ mirror_selfie', () => {
  const c = cam('想要个背影')
  assert.equal(c.mode, 'back_view')
  assert.notEqual(c.mode, 'mirror_selfie')
  assert.equal(c.visibility.face, false)
})
ok('13 scene_only 不出现人物主体', () => {
  const c = planCamera(planIntent({ scene: '窗外的雨', sceneOnly: true }))
  assert.equal(c.mode, 'scene_only')
  assert.equal(c.visibility.face, false)
  assert.deepEqual(c.visibility.bodyParts, [])
})
ok('14 video_call 不错误投影成 scene_only', () => {
  const c = cam('视频通话中')
  assert.equal(c.mode, 'video_call')
  assert.equal(c.visibility.face, true)
})

console.log('\n=== 契约 ===')
ok('输出字段齐全（mode/source/device/geometry/visibility/unresolved）', () => {
  const c = cam('前置自拍')
  for (const k of ['mode', 'source', 'device', 'geometry', 'visibility', 'unresolved']) assert.ok(k in c, '缺 ' + k)
  for (const k of ['position', 'height', 'orientation', 'distance', 'direction']) assert.ok(k in c.geometry)
  for (const k of ['face', 'hands', 'arms', 'phone', 'bodyParts']) assert.ok(k in c.visibility)
})
ok('未知模式不假装认识 → unresolved', () => {
  const c = planCamera({ camera: { mode: 'weird_mode', source: 'explicit' } })
  assert.equal(c.mode, 'weird_mode')
  assert.ok(c.unresolved.some((u) => u.startsWith('unknown_mode')))
  assert.equal(c.geometry.position, null)
})
ok('模式清单：7 种几何 + 5 个 POV 子型', () => {
  const l = listCameraModes()
  assert.equal(l.povSubtypes.length, 5)
  assert.ok(l.modes.includes('first_person'))
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
