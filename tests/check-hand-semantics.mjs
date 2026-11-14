/**
 * 手部契约（v10）：单一真源 analyzeHands → planHands 状态机
 *
 * 覆盖：动作/摆拍分流、unknown、switch 后重算 capacity、切换后仍冲突（合成输入）、
 *      降级显式化、pending、back_view 占位、禁 ?? 0。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { analyzeHands, planHands, capability, framingCapacity, degradeToSingleHand } from '../src/photo/hand-intent.js'
import { planShot } from '../src/photo/index.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const hp = (src) => analyzeHands(src)
const capOf = (m) => capability(m).maxVisibleHands
const fcap = (m, name) => framingCapacity(name)

console.log('=== A. analyzeHands 优先级 / 分流 ===')
ok('端杯喝水 = 单手', () => { const h = hp('端着杯子喝水'); assert.equal(h.certainty, 'known'); assert.equal(h.actionHands, 1); assert.equal(h.poseHands, 0) })
ok('端碗 = 单手（端≠双手）', () => { const h = hp('一碗汤粉端在手里'); assert.equal(h.actionHands, 1) })
ok('双手端碗 = 2', () => { assert.equal(hp('双手端碗').actionHands, 2) })
ok('捧碗 = 2', () => { assert.equal(hp('捧着一碗面').actionHands, 2) })
ok('抱纸箱 = 2', () => { assert.equal(hp('抱着一个纸箱').actionHands, 2) })
ok('提袋/拿瓶 = 1', () => { assert.equal(hp('提着一个袋子').actionHands, 1); assert.equal(hp('手里拿着一瓶饮料').actionHands, 1) })
ok('抱枕头 = unknown（null，不是 0/1）', () => { const h = hp('抱着枕头靠在床头'); assert.equal(h.certainty, 'unknown'); assert.equal(h.actionHands, null); assert.equal(h.poseHands, null) })
ok('不用双手+单手端杯 = 1', () => { const h = hp('不用双手，单手端着杯子'); assert.equal(h.certainty, 'known'); assert.equal(h.actionHands, 1) })
ok('只有否定、无单手词 = unknown', () => { assert.equal(hp('不用双手，端杯就行').certainty, 'unknown') })
ok('双手比心 = poseHands 2（不是 actionHands）', () => { const h = hp('双手比心'); assert.equal(h.actionHands, 0); assert.equal(h.poseHands, 2) })
ok('单手比心 = poseHands 1', () => { const h = hp('单手比心'); assert.equal(h.poseHands, 1); assert.equal(h.actionHands, 0) })

console.log('\n=== B. 状态机（真实契约） ===')
const dec = (scene, mode) => planHands({ hp: hp(scene), mode, framingName: '半身', capOf, framingCapOf: fcap, placeholderOf: (m) => capability(m).placeholder })
ok('端杯：first_person ok，need=1', () => { const d = dec('端着杯子喝水', 'first_person'); assert.equal(d.status, 'ok'); assert.equal(d.requestedNeed, 1); assert.equal(d.finalVisibleHands, 1) })
ok('双手捧碗：first_person → 自拍+物体（front_selfie），动作降为单手', () => { const d = dec('双手捧碗', 'first_person'); assert.equal(d.status, 'degraded_action'); assert.equal(d.mode, 'front_selfie'); assert.equal(d.switchedFrom, 'first_person'); assert.equal(d.effective.actionHands, 1); assert.equal(d.actionSatisfied, 'degraded') })
ok('对镜双手比心：mirror → 降为单手比心（镜中 1 持机手 + 1 动作手）', () => {
  const d = dec('对镜自拍，双手比心', 'mirror_selfie')
  assert.equal(d.status, 'degraded_action'); assert.equal(d.mode, 'mirror_selfie')
  assert.equal(d.actionSatisfied, 'degraded'); assert.equal(d.effective.poseHands, 1)
})
ok('抱枕头：unknown → 按 planner 第一人称拍摄，但未验证', () => { const d = dec('抱着枕头靠在床头', 'first_person'); assert.equal(d.status, 'unknown_fail_open'); assert.equal(d.canGenerate, true); assert.equal(d.finalVisibleHands, null); assert.equal(d.planVerified, false) })
ok('video_call cap=null：pending_product，默认不生成', () => { const d = dec('双手比心', 'video_call'); assert.equal(d.status, 'pending_product'); assert.notEqual(d.canGenerate, true) })
ok('video_call allowPending=true：可临时生成但仍未验证', () => { const d = planHands({ hp: hp('双手比心'), mode: 'video_call', framingName: '半身', capOf, framingCapOf: fcap, allowPending: true }); assert.equal(d.canGenerate, true); assert.equal(d.planVerified, false) })
ok('back_view 占位：skipped_pending', () => { const d = dec('背影，抱着箱子', 'back_view'); assert.equal(d.status, 'skipped_pending'); assert.equal(d.actionSatisfied, 'n/a') })

console.log('\n=== C. 合成输入：自拍容量放不下 / 降级后仍超 ===')
ok('自拍容量只容 1、stub 降级仍返 2 手 → skipped_conflict', () => {
  const d = planHands({
    hp: { certainty: 'known', actionHands: 2, poseHands: 0, verb: '抱纸箱' },
    mode: 'first_person', framingName: '半身', capOf, framingCapOf: fcap,
    degradeImpl: () => ({ actionHands: 2, poseHands: 0, assignment: {}, dropped: [] }),
  })
  assert.equal(d.status, 'skipped_conflict'); assert.equal(d.switchedFrom, 'first_person')
})
ok('自拍容量 1、默认降级到 1 手 → degraded_action', () => {
  const d = planHands({ hp: { certainty: 'known', actionHands: 2, poseHands: 0, verb: '双手拿' }, mode: 'first_person', framingName: '半身', capOf, framingCapOf: fcap })
  assert.equal(d.status, 'degraded_action'); assert.equal(d.mode, 'front_selfie'); assert.equal(d.effective.actionHands, 1); assert.equal(d.effectiveNeed, 1)
})
ok('degradeToSingleHand 返回具体 assignment（A 口径：双手一律降单手）', () => {
  const e = degradeToSingleHand({ certainty: 'known', actionHands: 0, poseHands: 2, verb: '双手比心' })
  assert.equal(e.poseHands, 1); assert.equal(e.assignment.right.role, 'action'); assert.equal(e.assignment.left.role, 'rest')
  const b = degradeToSingleHand({ certainty: 'known', actionHands: 2, poseHands: 0, verb: '抱纸箱' })
  assert.equal(b.actionHands, 1)
  assert.ok(!/双手/.test(b.assignment.right.action), 'assignment 里不能还写双手')
})

console.log('\n=== D. planShot 接线 ===')
ok('端杯喝水 → first_person / ok / 不计为验证失败', () => {
  const s = planShot({ scene: '端着杯子喝水', slot: 'evening', scope: 'hs1', outfit: '吊带', hair: '马尾', mode: 'daily', imageCfg: {} })
  assert.equal(s.mode, 'first_person'); assert.equal(s.handStatus, 'ok'); assert.equal(s.planVerified, true)
})
ok('★ 双手捧碗 → 退回单手（不跳过、不再出现双手）', () => {
  const s = planShot({ scene: '双手捧碗', slot: 'evening', scope: 'hs2', outfit: '吊带', hair: '马尾', mode: 'daily', imageCfg: {} })
  assert.equal(s.skip, false, `不该跳过：${s.skipReason ?? ''}`)
  assert.equal(s.handStatus, 'degraded_action')
  assert.ok(s.prompt && s.prompt.length > 0, '应正常拼出提示词')
  assert.ok(!/双手捧碗|双手端着/.test(s.prompt), '提示词里不能还写场景的双手动作')
})
ok('抱枕头 → 第一人称 POV（主体=怀里抱枕+一只手），未验证', () => {
  const s = planShot({ scene: '抱着枕头靠在床头', slot: 'evening', scope: 'hs3', outfit: '吊带', hair: '马尾', mode: 'daily', imageCfg: {} })
  assert.equal(s.skip, false); assert.equal(s.mode, 'first_person'); assert.equal(s.handStatus, 'unknown_fail_open'); assert.equal(s.planVerified, false)
  assert.match(s.prompt, /怀里抱着/, '场景要改写成"怀里抱着…"的 POV 写法')
})

console.log('\n=== E. 禁 ?? 0 ===')
ok('hand-intent 里手数字段没有 ?? 0', () => {
  const src = fs.readFileSync(new URL('../src/photo/hand-intent.js', import.meta.url), 'utf8')
  assert.ok(!/needVisibleHands\s*\?\?\s*0/.test(src))
  assert.ok(!/finalVisibleHands\s*\?\?\s*0/.test(src))
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
