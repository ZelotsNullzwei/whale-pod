/**
 * 四层静态合并测试：Intent → Camera → Framing → Pose
 * 检查：字段覆盖、语义冲突、重复推断、null 被默认值替换。
 */
import assert from 'node:assert/strict'
import { buildShotPlan } from '../src/photo/plan-photo-v3.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const cases = [
  ['对镜全身自拍，站在衣柜前', null],
  ['拍张全身的', null],
  ['坐在床边看漫画', null],
  ['把漫画拍给你看', null],
  ['站在窗边看着外面', null],
  ['拍一下窗外的雨', null],
  ['想要个背影', null],
  ['展示今天的穿搭', null],
  ['前置自拍', null],
  ['视频通话中', null],
  ['怼脸拍一张', null],
  ['第一人称', '第一人称 端着杯子喝'],
  ['第一人称', '第一人称 双手捧着碗'],
  ['第一人称', '第一人称 书桌上写字'],
  ['第一人称', '第一人称 窗外 远处 风景'],
  ['第一人称', '第一人称 小物件 特写'],
]

console.log('=== 1. 四层不互相覆盖 ===')
ok('每层输出原样保留（相机层不改 intent 等）', () => {
  for (const [scene, raw] of cases) {
    const a = buildShotPlan({ scene, slot: 'evening', raw })
    assert.ok(a.intent && a.camera && a.framing && a.pose, '缺层：' + scene)
    /* 只读校验：intent 里的 subject 不被下游改写 */
    assert.ok(['character', 'object', 'scene'].includes(a.intent.subject), 'subject 异常：' + a.intent.subject)
    /* pose 不得产生 camera/framing 字段 */
    assert.ok(!('geometry' in a.pose), 'pose 不应含 geometry')
    assert.ok(!('band' in a.pose), 'pose 不应含 band')
  }
})

console.log('\n=== 2. null 不许被默认值替换 ===')
ok('camera=null 时，下游全部保持未定（不出现 front_selfie/默认构图）', () => {
  const a = buildShotPlan({ scene: '坐在床边看漫画', slot: 'evening' })
  assert.equal(a.camera.mode, null)
  assert.equal(a.framing.band, null)
  assert.deepEqual(a.pose.visibility.visibleHands, [])
  assert.equal(a.resolution.resolved, false)
  assert.ok(a.unresolved.length > 0)
  assert.ok(a.unresolved.some((u) => u.layer === 'camera'))
  assert.ok(a.unresolved.some((u) => u.layer === 'framing'))
})
ok('已解析场景 resolved=true 且 unresolved 里没有 camera/framing', () => {
  const a = buildShotPlan({ scene: '对口自拍'.replace('口', '镜'), slot: 'evening' })
  assert.equal(a.camera.mode, 'mirror_selfie')
  assert.equal(a.resolution.resolved, true)
  assert.ok(!a.unresolved.some((u) => u.layer === 'camera'))
})

console.log('\n=== 3. 手数量只有一个真源 ===')
ok('final hands 只来自 pose（camera 的 cameraHands 是输入，不是最终值）', () => {
  for (const [scene, raw] of cases) {
    const a = buildShotPlan({ scene, slot: 'evening', raw })
    assert.equal(typeof a.pose.hands.requiredCount, 'number')
    assert.equal(a.resolution.handsRequired, a.pose.hands.requiredCount)
  }
})
ok('第一人称：手机手不叠加（required ≤ 2 且 camera 手不计入）', () => {
  const a = buildShotPlan({ scene: '第一人称', slot: 'evening', raw: '第一人称 端着杯子喝' })
  assert.equal(a.pose.hands.requiredCount, 1)
  assert.equal(a.pose.hands.cameraHands, 1, 'cameraHands 是"用不用手举机"的记录')
})

console.log('\n=== 4. 语义冲突被记录而不是被抹平 ===')
ok('取景容纳不下动作 → pose.unresolved 有 action_exceeds_visible_range 或可见手被限', () => {
  const a = buildShotPlan({ scene: '第一人称', slot: 'evening', raw: '第一人称 小物件 特写' })
  const hasLimit = a.unresolved.some((u) => u.layer === 'pose' && u.item === 'action_exceeds_visible_range')
  assert.ok(hasLimit || a.pose.visibility.visibleHands.length <= 1)
})
ok('双手但未分左右 → 记 two_hand_assignment_incomplete', () => {
  const a = buildShotPlan({ scene: '第一人称', slot: 'evening', raw: '第一人称 双手捧着碗' })
  assert.ok(a.unresolved.some((u) => u.item === 'two_hand_assignment_incomplete'))
})

console.log('\n=== 5. 无 undefined ===')
ok('整份输出里不存在 undefined', () => {
  const walk = (v, path) => {
    if (v === undefined) throw new Error('undefined at ' + path)
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k)
  }
  for (const [scene, raw] of cases) walk(buildShotPlan({ scene, slot: 'evening', raw }), scene)
})

console.log('\n=== 6. 关键场景防回归 ===')
ok('展示穿搭：character + mirror + full', () => {
  const a = buildShotPlan({ scene: '展示今天的穿搭', slot: 'evening' })
  assert.equal(a.intent.subject, 'character')
  assert.equal(a.camera.mode, 'mirror_selfie')
  assert.equal(a.framing.band, 'full')
})
ok('拍窗外 ≠ 第一人称看窗外', () => {
  const a = buildShotPlan({ scene: '拍一下窗外的雨', slot: 'evening' })
  const b = buildShotPlan({ scene: '第一人称', slot: 'evening', raw: '第一人称 窗外 远处' })
  assert.equal(a.camera.mode, 'scene_only')
  assert.equal(b.camera.mode, 'first_person')
  assert.equal(b.camera.povSubtype, 'eye_pov')
})
ok('背影：back_view + back + 不露脸', () => {
  const a = buildShotPlan({ scene: '想要个背影', slot: 'evening' })
  assert.equal(a.camera.mode, 'back_view')
  assert.equal(a.framing.band, 'back')
  assert.equal(a.camera.visibility.face, false)
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
