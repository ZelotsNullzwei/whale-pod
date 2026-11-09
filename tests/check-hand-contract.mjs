/**
 * 手部契约矩阵 + Prompt 注入验证
 */
import assert from 'node:assert/strict'
import { HAND_CONTRACTS, handContractFor, requiresHandGate, handRuleLine, handDutyLine } from '../src/photo/handContract.js'
import { planShot } from '../src/photo/index.js'

let pass = 0, fail = 0
const ok = (name, fn) => { try { fn(); console.log('  OK  ' + name); pass++ } catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ } }

console.log('=== 契约矩阵 ===')
const expect = {
  first_person: [1, 'none'],
  rear_object: [1, 'hidden'],
  rear_selfie: [1, 'hidden'],
  front_selfie: [1, 'hidden'],
  mirror_selfie: [2, 'visible'],
  back_view: [0, 'hidden'],
}
for (const [mode, [max, holder]] of Object.entries(expect)) {
  ok(`${mode} → 最多 ${max} 只手 / 持机手 ${holder}`, () => {
    const c = handContractFor(mode)
    assert.ok(c, 'mode 未登记')
    assert.equal(c.maxVisibleHands, max)
    assert.equal(c.holderHand, holder)
    assert.equal(requiresHandGate(mode), true)
  })
}
ok('未登记模式（scene_only）→ null、不门禁', () => {
  assert.equal(handContractFor('scene_only'), null)
  assert.equal(requiresHandGate('scene_only'), false)
})
ok('actionRequiresBothHands 不会越权放宽（当前无模式允许）', () => {
  assert.equal(handContractFor('first_person', { actionRequiresBothHands: true }).maxVisibleHands, 1)
})
ok('handRuleLine：0 手写"不得出现"；1 手写"最多 1 只"', () => {
  assert.match(handRuleLine(handContractFor('back_view')), /不得出现手/)
  assert.match(handRuleLine(handContractFor('first_person')), /最多 1 只手/)
})

console.log('\n=== Prompt 注入（真实 planShot）')
const H = 'C:/Users/Null_zwei/.dsh/whale-pod'
import fs from 'node:fs'
const cfg = JSON.parse(fs.readFileSync(`${H}/config.json`, 'utf8')).qq.image
const dp = JSON.parse(fs.readFileSync(`${H}/day-plan.json`, 'utf8'))
const k = Object.keys(dp.plans).sort().pop()
const mkShot = (scene) => planShot({ scene, slot: 'evening', outfit: dp.plans[k].outfit, hair: dp.plans[k].hair ?? '', scope: 'hc:' + Math.random(), imageCfg: cfg })

for (const [scene, mode, max] of [
  ['第一人称 端着杯子喝水', 'first_person', 1],
  ['把漫画拍给你看', 'rear_selfie', 1],
  ['前置自拍', 'front_selfie', 1],
  ['对镜全身自拍，站在衣柜前', 'mirror_selfie', 2],
]) {
  ok(`${scene} → ${mode} 的 Prompt 恰有 1 条手部契约且含 ${max}`, () => {
    const s = mkShot(scene)
    assert.equal(s.plan.mode, mode)
    const lines = [...String(s.prompt).matchAll(/【手部契约】[^\n]*/g)].map((x) => x[0])
    assert.equal(lines.length, 1, '应恰好 1 条，实际 ' + lines.length)
    assert.ok(lines[0].includes(`最多 ${max} 只手`), lines[0])
  })
}
ok('第一人称 Prompt 不再出现旧的"最多两只手"', () => {
  assert.ok(!String(mkShot('第一人称 端着杯子喝水').prompt).includes('最多两只手'))
})

console.log('\n=== Pose Planner 手部职责 → Prompt ===')
ok('第一人称（动作手1+持机手1）→ 只写动作手，不写持机手', () => {
  const d = handDutyLine(handContractFor('first_person'), { hands: { requiredCount: 1, actionHands: 1, cameraHands: 1 } })
  assert.match(d, /动作手 1 只/)
  assert.ok(!d.includes('持机手'))
})
ok('对镜自拍 → 写明持机手（镜中可见）', () => {
  const d = handDutyLine(handContractFor('mirror_selfie'), { hands: { requiredCount: 1, actionHands: 0, cameraHands: 1 } })
  assert.match(d, /持机手 1 只（镜中可见）/)
})
ok('动作需求超上限 → 带 ⚠️ 拆分动作提示', () => {
  const d = handDutyLine(handContractFor('first_person'), { hands: { requiredCount: 3, actionHands: 3, cameraHands: 0 } })
  assert.match(d, /超过本模式上限 1/)
})
ok('真实 planShot 返回 posePlan.hands.requiredCount 为数字（4 模式）', () => {
  for (const sc of ['第一人称 端着杯子喝水', '把漫画拍给你看', '对镜全身自拍，站在衣柜前', '前置自拍']) {
    const s2 = mkShot(sc)
    assert.ok(s2.posePlan && s2.posePlan.hands, sc + ' 缺 posePlan.hands')
    assert.equal(typeof s2.posePlan.hands.requiredCount, 'number', sc + ' requiredCount 非数字')
  }
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
