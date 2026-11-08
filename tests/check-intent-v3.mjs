/**
 * V3.0 第 2 步：结构化 intent 回归（9 条历史误判）。
 * 只测 intent 维度，不测提示词/机位几何（那些后续步骤再做）。
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

console.log('=== 9 条历史误判 ===')

ok('1 全身 ≠ 第一人称（全身是构图，不是机位）', () => {
  const i = I('拍张全身的')
  assert.equal(i.framing, 'full')
  assert.notEqual(i.camera.position, 'eye', '不能因为"全身"就判成第一人称')
})

ok('2 整理头发 ≠ 整理物品（对象是她自己）', () => {
  assert.equal(I('低头整理了一下头发').subject, 'character')
  assert.equal(I('穿着裙子侧身整理裙边').subject, 'character')
})

ok('3 看漫画按目的判', () => {
  assert.equal(I('坐在床边看漫画').subject, 'character', '看漫画本身是人物行为')
  assert.equal(I('把漫画拍给你看').subject, 'object', '要拍内容时主体才是物品')
})

ok('4 窗户作背景 ≠ 拍窗外', () => {
  assert.equal(I('站在窗边看着外面').subject, 'character')
  assert.equal(I('穿着女仆装站在房间里，窗边有绿萝').subject, 'character')
  assert.equal(I('拍一下窗外的雨').subject, 'scene', '真要拍窗外时才是场景')
})

ok('5 背影 ≠ 前置自拍', () => {
  const i = I('想要个背影')
  assert.equal(i.camera.mode, 'back_view')
  assert.notEqual(projectMode(i), 'front_selfie')
})

ok('6 穿搭 → 镜像', () => {
  assert.equal(I('展示今天的穿搭').camera.mode, 'mirror_selfie')
})

ok('7 明确要求 > 时段默认', () => {
  assert.equal(I('前置自拍', 'morning').camera.mode, 'front_selfie')
  assert.equal(I('对镜拍一张', 'noon').camera.mode, 'mirror_selfie')
  assert.deepEqual(I('第一人称拍一下', 'wake').explicitRequirements, ['first_person'])
})

ok('8 人物动作 ≠ 拍摄动作', () => {
  const i = I('书桌前把抽屉里的笔挑出来扔掉')
  assert.equal(i.activity, 'tidying')
  assert.equal(i.subject, 'object', '动作是整理，但拍的是那些东西')
})

ok('9 背景物件 ≠ 拍摄对象', () => {
  const i = I('站在房间里，身后是书桌和窗户')
  assert.equal(i.subject, 'character')
  assert.ok(i.scene.background.includes('window') || i.scene.background.includes('desk'))
})

console.log('\n=== 结构与契约 ===')
ok('intent 七个维度齐全', () => {
  const i = I('第一人称，手里端着杯子')
  for (const k of ['subject', 'activity', 'framing', 'camera', 'scene', 'explicitRequirements', 'confidence']) {
    assert.ok(k in i, '缺维度 ' + k)
  }
  assert.ok('mode' in i.camera && 'device' in i.camera && 'position' in i.camera)
})

ok('第一人称五个子型可区分', () => {
  assert.equal(projectMode(I('第一人称，手里端着杯子')), 'first_person')
  assert.equal(projectMode(I('第一人称，双手捧着碗')), 'first_person')
  assert.equal(projectMode(I('第一人称，书桌前写字')), 'first_person')
})

ok('纯场景：scene_only / 主体 scene', () => {
  const i = planIntent({ scene: '窗外的雨', sceneOnly: true })
  assert.equal(i.subject, 'scene')
  assert.equal(i.camera.mode, 'scene_only')
})

ok('projectMode 把 rear_object/scene_only 映到旧 rear_selfie', () => {
  assert.equal(projectMode({ camera: { mode: 'rear_object' } }), 'rear_selfie')
  assert.equal(projectMode({ camera: { mode: 'scene_only' } }), 'rear_selfie')
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
