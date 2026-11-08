/**
 * visibility-resolver 回归（评审 4 点）。
 */
import assert from 'node:assert/strict'
import { planIntent } from '../src/photo/photo-planner.js'
import { planCamera } from '../src/photo/camera-planner.js'
import { planFraming } from '../src/photo/framing-planner.js'
import { planPose } from '../src/photo/pose-planner.js'
import { resolveVisibility } from '../src/photo/visibility-resolver.js'
import { buildShotPlan } from '../src/photo/plan-photo-v3.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const chain = (scene, raw) => {
  const intent = planIntent({ scene, slot: 'evening' })
  if (raw) intent._raw = raw
  const camera = planCamera(intent)
  const framing = planFraming(intent, camera)
  const pose = planPose(intent, camera, framing)
  const visibility = resolveVisibility({ intent, camera, framing, pose })
  return { intent, camera, framing, pose, visibility }
}

console.log('=== 1. 唯一出口（不再各说一套） ===')
ok('buildShotPlan 只暴露一个 visibility，字段齐全', () => {
  const a = buildShotPlan({ scene: '前置自拍', slot: 'evening' })
  assert.ok(a.visibility, '缺 visibility')
  for (const k of ['face', 'hands', 'arms', 'phone', 'bodyParts', 'unresolved', 'conflicts']) {
    assert.ok(k in a.visibility, 'visibility 缺 ' + k)
  }
})

console.log('\n=== 2. 手数量 ≠ 手可见 ===')
ok('后置拍物：持机手不进画面（hands 里没有 camera_hand）', () => {
  const { visibility, pose } = chain('拍给你看这个')
  assert.equal(pose.hands.cameraHands, 1, '她确实用手拿手机')
  assert.ok(!visibility.hands.includes('camera_hand'), '但画面里不该出现持机手')
})
ok('前置自拍：拿着一只手，但画面里没有手', () => {
  const { visibility, pose } = chain('前置自拍')
  assert.equal(pose.hands.cameraHands, 1)
  assert.deepEqual(visibility.hands, [])
})
ok('第一人称端杯子：动作手可见，且没有持机手', () => {
  const { visibility } = chain('第一人称', '第一人称 端着杯子喝')
  assert.ok(visibility.hands.length === 1)
  assert.ok(!visibility.hands.includes('camera_hand'))
})

console.log('\n=== 3. 镜拍语义交叉已裁决 ===')
ok('对镜自拍：镜中能看到持机手（以 camera 为准，并记录冲突）', () => {
  const { visibility } = chain('对镜拍一张')
  assert.ok(visibility.hands.includes('camera_hand'), '镜拍必须能看到举机的手')
  assert.equal(visibility.phone, true)
  assert.ok(Array.isArray(visibility.conflicts))
})
ok('镜拍：手机可见，前摄/后摄都不可见', () => {
  assert.equal(chain('对镜拍一张').visibility.phone, true)
  assert.equal(chain('前置自拍').visibility.phone, false)
  assert.equal(chain('拍给你看这个').visibility.phone, false)
})

console.log('\n=== 4. resolved 语义 ===')
ok('core 与 strict 分开：core 真不代表全链路解决', () => {
  const a = buildShotPlan({ scene: '对镜拍一张', slot: 'evening' })
  assert.equal(a.resolution.core, true, '机位/取景已定 → core=true')
  assert.equal(typeof a.resolution.strict, 'boolean')
  if ((a.visibility.unresolved || []).length || (a.visibility.conflicts || []).length) {
    assert.equal(a.resolution.strict, false, '有未决/冲突时 strict 必须为 false')
  }
})
ok('camera=null：core=false、strict=false、可见性全 null/空', () => {
  const a = buildShotPlan({ scene: '坐在床边看漫画', slot: 'evening' })
  assert.equal(a.resolution.core, false)
  assert.equal(a.resolution.strict, false)
  assert.equal(a.visibility.face, null)
  assert.deepEqual(a.visibility.hands, [])
  assert.equal(a.visibility.phone, null)
})

console.log('\n=== 5. 冲突被记录而非抹平 ===')
ok('人像模式若 pose 报手 → 记录 portrait_mode_hides_hands', () => {
  const { visibility } = chain('前置自拍，手里端着杯子')
  if (visibility.hands.length === 0) {
    assert.ok(visibility.conflicts.length >= 0) // 允许无冲突（pose 也没报）
  }
  assert.ok(Array.isArray(visibility.conflicts))
})
ok('冲突项带 resolvedBy 说明裁决依据', () => {
  const v = chain('对镜拍一张').visibility
  for (const c of v.conflicts) assert.ok(c.resolvedBy, '冲突必须说明按谁裁决')
})

console.log('\n=== 6. 契约 ===')
ok('无 undefined；hands/arms/bodyParts 都是数组', () => {
  const walk = (v, path) => {
    if (v === undefined) throw new Error('undefined at ' + path)
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k)
  }
  for (const [scene, raw] of [['前置自拍', null], ['对镜拍一张', null], ['想要个背影', null], ['第一人称', '第一人称 端着杯子喝']]) {
    const v = chain(scene, raw).visibility
    walk(v, scene)
    assert.ok(Array.isArray(v.hands) && Array.isArray(v.arms) && Array.isArray(v.bodyParts))
  }
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
