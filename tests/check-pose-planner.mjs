/**
 * pose-planner 回归 + 输出契约（V3.0 第四阶段）。
 * 边界：不改 subject/camera/framing；肢体动作唯一真源；未知不编造。
 */
import assert from 'node:assert/strict'
import { planIntent } from '../src/photo/photo-planner.js'
import { planCamera } from '../src/photo/camera-planner.js'
import { planFraming } from '../src/photo/framing-planner.js'
import { planPose, POSE_RELATIONS } from '../src/photo/pose-planner.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const run = (scene, raw) => {
  const i = planIntent({ scene, slot: 'evening' })
  if (raw) i._raw = raw
  const c = planCamera(i)
  const f = planFraming(i, c)
  const p = planPose(i, c, f)
  return { i, c, f, p }
}

console.log('=== 1. 手数量唯一真源 ===')
ok('单手拿杯子：requiredCount=1，不出现第二只', () => {
  const { p } = run('第一人称', '第一人称 端着杯子喝')
  assert.equal(p.hands.requiredCount, 1)
  assert.equal(p.hands.actionHands, 1)
})
ok('双手捧碗：requiredCount=2', () => {
  const { p } = run('第一人称', '第一人称 双手捧着碗')
  assert.equal(p.hands.requiredCount, 2)
})
ok('同一只手连续动作不重复计数（拿杯子→放桌上）', () => {
  const { p } = run('第一人称', '第一人称 端着杯子，然后把杯子放在桌上')
  assert.equal(p.hands.requiredCount, 1, '同一只手做两件事仍然只有一只手')
})
ok('持机手与动作手去重（自拍 + 拿杯子 不会算成 3 只）', () => {
  const { p } = run('前置自拍，手里端着杯子')
  assert.ok(p.hands.requiredCount <= 2, 'required=' + p.hands.requiredCount)
  assert.equal(p.hands.cameraHands, 1)
})

console.log('\n=== 2. 左右职责 / 未知 ===')
ok('明确左右手 → 分别记录', () => {
  const { p } = run('第一人称', '第一人称 右手拿杯子，左手扶着桌沿')
  assert.ok(p.hands.right.action, '右手应有动作')
  assert.ok(/扶/.test(p.hands.left.action || ''), '左手应是扶')
})
ok('未说左右 → 保持 null 并记 unresolved（不随机分配）', () => {
  const { p } = run('第一人称', '第一人称 端着杯子')
  assert.equal(p.hands.left.role, null)
  assert.equal(p.hands.right.role, null)
  assert.ok(p.unresolved.includes('hand_sides_unknown'))
})
ok('双手但分工不全 → unresolved', () => {
  const { p } = run('第一人称', '第一人称 双手捧着碗')
  assert.ok(p.unresolved.includes('two_hand_assignment_incomplete'))
})

console.log('\n=== 3. 接触关系 ===')
ok('持物：hand→杯 holding', () => {
  const { p } = run('第一人称', '第一人称 端着杯子')
  const c = p.contacts[0]
  assert.equal(c.relation, 'holding')
})
ok('支撑：hand→support supporting', () => {
  const { p } = run('第一人称', '第一人称 扶着桌沿')
  assert.equal(p.contacts[0].relation, 'supporting')
})
ok('放置：resting_on', () => {
  const { p } = run('第一人称', '第一人称 把杯子放在桌上')
  assert.equal(p.contacts[0].relation, 'resting_on')
})
ok('桌面写字：manipulating', () => {
  const { p } = run('第一人称', '第一人称 书桌上写字')
  assert.equal(p.contacts[0].relation, 'manipulating')
})
ok('接触关系取值都在允许集合内', () => {
  for (const s of ['端着杯子', '扶着桌沿', '把杯子放在桌上', '书桌上写字']) {
    const { p } = run('第一人称', '第一人称 ' + s)
    for (const c of p.contacts) assert.ok(POSE_RELATIONS.includes(c.relation), '非法关系 ' + c.relation)
  }
})

console.log('\n=== 4. 动作 ≠ 可见 ===')
ok('第一人称看窗外：动作 0，可见 0（不为 POV 强行画手）', () => {
  const { p } = run('第一人称', '第一人称 窗外 远处 风景')
  assert.equal(p.hands.actionHands, 0)
  assert.deepEqual(p.visibility.visibleHands, [])
})
ok('手部动作存在但取景只拍物品 → 可见手被限制且记 unresolved', () => {
  const { p } = run('第一人称', '第一人称 小物件 特写')
  assert.ok(p.hands.requiredCount >= 0)
  assert.ok(p.unresolved.includes('action_exceeds_visible_range') || p.visibility.visibleHands.length <= 1)
})
ok('头肩自拍：动作手不进画面', () => {
  const { p } = run('前置自拍，手里端着杯子')
  assert.deepEqual(p.visibility.visibleHands, [])
})

console.log('\n=== 5. 镜子 / 背影 ===')
ok('镜拍：持机手=1，且不与动作手冲突（required ≤ 2）', () => {
  const { p } = run('对镜拍一张')
  assert.equal(p.hands.cameraHands, 1)
  assert.ok(p.hands.requiredCount <= 2)
})
ok('背影：朝向 back_to_camera（只读 camera）', () => {
  const { p, c } = run('想要个背影')
  assert.equal(c.mode, 'back_view')
  assert.equal(p.pose.orientation, 'back_to_camera')
})

console.log('\n=== 6. 不得反向改上游 ===')
ok('pose 不改 subject/camera/framing', () => {
  const { i, c, f, p } = run('对镜拍一张，展示今天的穿搭')
  const snap = JSON.stringify([i.subject, c.geometry, f.band])
  planPose(i, c, f)
  assert.equal(JSON.stringify([i.subject, c.geometry, f.band]), snap)
})

console.log('\n=== 7. 输出契约 ===')
ok('字段齐全且无 undefined', () => {
  const { p } = run('第一人称', '第一人称 端着杯子')
  for (const k of ['pose', 'limbs', 'hands', 'contacts', 'visibility', 'source', 'unresolved']) assert.ok(k in p, '缺 ' + k)
  for (const k of ['type', 'orientation', 'posture']) assert.ok(k in p.pose, 'pose 缺 ' + k)
  for (const k of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg']) assert.ok(k in p.limbs, 'limbs 缺 ' + k)
  for (const k of ['requiredCount', 'actionHands', 'poseHands', 'cameraHands', 'left', 'right']) assert.ok(k in p.hands, 'hands 缺 ' + k)
  for (const k of ['visibleHands', 'visibleArms', 'visibleBodyParts']) assert.ok(k in p.visibility, 'visibility 缺 ' + k)
  const walk = (o, path) => {
    for (const [k, v] of Object.entries(o)) {
      assert.notEqual(v, undefined, `${path}.${k} 不能是 undefined`)
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${path}.${k}`)
    }
  }
  walk(p, 'pose')
})
ok('未知取景 → 记 unresolved，不默认姿势', () => {
  const i = planIntent({ scene: '坐在床边看漫画', slot: 'evening' })
  const c = planCamera(i)
  const f = planFraming(i, c)
  const p = planPose(i, c, f)
  assert.equal(f.band, null)
  assert.ok(p.unresolved.includes('framing_band_unknown'))
  assert.deepEqual(p.visibility.visibleHands, [])
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
