/**
 * V3.0 第 2 步（复核后 v2）：结构化 intent 回归。
 * 覆盖：9 条误判 + 复核指出的 3 处 subject 修正 + 三组解耦 + 结构契约。
 * 注意：这里只测 intent，不测机位几何/提示词（后续步骤）。
 */
import assert from 'node:assert/strict'
import { planIntent, projectMode } from '../src/photo/photo-planner.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}
const I = (scene, slot = 'evening') => planIntent({ scene, slot })

console.log('=== A. 9 条历史误判 ===')
ok('1 全身 ≠ 第一人称', () => {
  const i = I('拍张全身的')
  assert.equal(i.framing.type, 'full')
  assert.notEqual(i.camera.mode, 'first_person')
})
ok('2 整理头发 ≠ 整理物品', () => {
  assert.equal(I('低头整理了一下头发').subject, 'character')
  assert.equal(I('穿着裙子侧身整理裙边').subject, 'character')
})
ok('3 看漫画按目的判', () => {
  assert.equal(I('坐在床边看漫画').subject, 'character')
  assert.equal(I('把漫画拍给你看').subject, 'object')
})
ok('4 窗户作背景 ≠ 拍窗外', () => {
  assert.equal(I('站在窗边看着外面').subject, 'character')
  assert.equal(I('拍一下窗外的雨').subject, 'scene')
})
ok('5 背影 ≠ 前置自拍', () => {
  assert.equal(I('想要个背影').camera.mode, 'back_view')
})
ok('6 穿搭 → 镜像', () => {
  const i = I('展示今天的穿搭')
  assert.equal(i.camera.mode, 'mirror_selfie')
  assert.equal(i.framing.type, 'full')
})
ok('7 明确要求 > 时段默认', () => {
  assert.equal(I('前置自拍', 'morning').camera.mode, 'front_selfie')
  assert.equal(I('对镜拍一张', 'noon').camera.mode, 'mirror_selfie')
  assert.equal(I('前置自拍').camera.source, 'explicit')
})
ok('8 人物动作 ≠ 拍摄动作', () => {
  const i = I('书桌前把抽屉里的笔挑出来扔掉')
  assert.ok(i.activities.some((a) => a.type === 'tidying'))
  assert.equal(i.subject, 'object')
})
ok('9 背景物件 ≠ 拍摄对象', () => {
  const i = I('站在房间里，身后是书桌和窗户')
  assert.equal(i.subject, 'character')
  assert.ok(i.scene.background.includes('window') || i.scene.background.includes('desk'))
})

console.log('\n=== B. 复核指出的 3 处 subject ===')
ok('展示今天的穿搭 → subject=character（不是 scene）', () => {
  assert.equal(I('展示今天的穿搭').subject, 'character')
})
ok('视频通话中 → subject=character（不是 scene）', () => {
  const i = I('视频通话中')
  assert.equal(i.subject, 'character')
  assert.equal(i.camera.mode, 'video_call')
})
ok('怼脸拍一张 → subject=character（特写是构图不是主体）', () => {
  const i = I('怼脸拍一张')
  assert.equal(i.subject, 'character')
  assert.equal(i.framing.type, 'face')
})

console.log('\n=== C. 无明确机位时不许默认 selfie ===')
ok('坐在床边看漫画 → camera 未定（交给上下文），不硬判 front_selfie', () => {
  const i = I('坐在床边看漫画')
  assert.equal(i.camera.mode, null)
  assert.equal(i.camera.source, 'context')
  assert.ok(i.diagnostics.unresolved.includes('camera'))
})

console.log('\n=== D. 三组解耦 ===')
ok('D1 相同动作、不同目的：看漫画 vs 拍漫画', () => {
  const a = I('坐在床边看漫画')
  const b = I('把漫画拍给你看')
  assert.ok(a.activities.some((x) => x.type === 'reading'))
  assert.ok(Array.isArray(b.activities))
  assert.notEqual(a.subject, b.subject, '同样是"看/拍漫画"，主体应不同')
  assert.equal(a.subject, 'character')
  assert.equal(b.subject, 'object')
})
ok('D2 相同主体、不同机位：穿搭 vs 前置 vs 第一人称', () => {
  assert.equal(I('展示今天的穿搭').camera.mode, 'mirror_selfie')
  assert.equal(I('前置自拍').camera.mode, 'front_selfie')
  assert.equal(I('第一人称，手里端着杯子').camera.mode, 'first_person')
})
ok('D3 相同机位、不同构图：头肩 vs 全身', () => {
  const a = I('前置自拍，头肩')
  const b = I('前置自拍，全身')
  assert.equal(a.camera.mode, b.camera.mode, '机位应相同')
  assert.notEqual(a.framing.type, b.framing.type, '构图应不同')
})

console.log('\n=== E. 结构契约 ===')
ok('十个维度齐全（含新增 intent/composition/constraints/diagnostics）', () => {
  const i = I('第一人称，手里端着杯子')
  for (const k of ['subject', 'intent', 'activities', 'framing', 'composition', 'camera', 'scene', 'explicitRequirements', 'constraints', 'diagnostics']) {
    assert.ok(k in i, '缺维度 ' + k)
  }
  assert.ok('purpose' in i.intent && 'source' in i.intent)
  assert.ok('mode' in i.camera && 'device' in i.camera && 'position' in i.camera && 'source' in i.camera)
})
ok('未知值允许 null（不为了填满而猜）', () => {
  const i = I('坐在床边看漫画')
  assert.equal(i.camera.mode, null)
  assert.equal(i.composition, null)
  assert.equal(i.confidence, null)
})
ok('activities 支持多个动作（有序）', () => {
  const i = I('边看漫画边吃面')
  assert.ok(i.activities.length >= 2, '应识别出两个动作')
  const orders = i.activities.map((a) => a.order)
  assert.deepEqual(orders, orders.slice().sort((x, y) => x - y))
})
ok('explicitRequirements 是结构化对象（带 source/spans）', () => {
  const r = I('对镜拍一张').explicitRequirements[0]
  assert.ok(r)
  assert.equal(r.type, 'camera')
  assert.equal(r.mode, 'mirror_selfie')
  assert.equal(r.source, 'explicit')
  assert.ok(Array.isArray(r.spans) && r.spans[0].text)
})
ok('constraints 按模式生成', () => {
  const has = (arr, t) => arr.some((c) => typeof c === 'object' && c.type === t)
  assert.ok(has(I('第一人称，手里端着杯子').constraints, 'no_face'))
  assert.ok(has(I('第一人称，手里端着杯子').constraints, 'no_phone'))
  assert.ok(has(I('前置自拍').constraints, 'no_phone'))
  assert.ok(has(I('拍给你看这个').constraints, 'no_person'))
})
ok('confidence 已移除，改为 diagnostics', () => {
  const i = I('第一人称，手里端着杯子')
  assert.equal(i.confidence, null)
  assert.ok(Array.isArray(i.diagnostics.matchedRules))
  assert.ok(Array.isArray(i.diagnostics.conflicts))
  assert.ok(Array.isArray(i.diagnostics.unresolved))
})

console.log('\n=== F. projectMode 过渡层 ===')
ok('rear_object/scene_only → 旧 rear_selfie；null → null（不再兜底 selfie）', () => {
  assert.equal(projectMode({ camera: { mode: 'rear_object' } }), 'rear_selfie')
  assert.equal(projectMode({ camera: { mode: 'scene_only' } }), 'rear_selfie')
  assert.equal(projectMode({ camera: { mode: null } }), null)
  assert.equal(projectMode({ camera: { mode: 'weird' } }), null)
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
