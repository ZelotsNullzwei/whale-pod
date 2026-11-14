/** 动作池规范（2026-11-12 GPT 交接） */
import assert from 'node:assert/strict'
import { ACTIONS, matchAction, needsActionDetail, actionForScene } from '../src/photo/action-pool.js'

let pass = 0, fail = 0
const ok = (name, fn) => { try { fn(); console.log('  ✅ ' + name); pass++ } catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fail++ } }

const byId = Object.fromEntries(ACTIONS.map((a) => [a.id, a]))
const ids = ['stretch','cream','cotton','lipstick','brow','brush','blow','comb','water','comic','diary']

console.log('=== 动作目录 ===')
ok('11 个动作齐全', () => { for (const id of ids) assert.ok(byId[id], '缺 ' + id) })
ok('每条 scene ≤ 40 字', () => { for (const a of ACTIONS) assert.ok(a.scene.length <= 40, `${a.id} 长度 ${a.scene.length}`) })
ok('镜面动作 = mirror_selfie（不再写手数，交给模型）', () => {
  for (const id of ['cream','cotton','lipstick','brow','brush','blow','comb']) {
    assert.equal(byId[id].mode, 'mirror_selfie', id)
    assert.equal(byId[id].hands, undefined, `${id} 不应再写 hands`)
    assert.ok(!/另一只手|拿.*手|双手/.test(byId[id].scene), `${id} 不应描述手：${byId[id].scene}`)
  }
})
ok('喝水 = front_selfie；漫画/日记 = first_person（不写手数）', () => {
  assert.equal(byId.water.mode, 'front_selfie')
  for (const id of ['comic','diary']) assert.equal(byId[id].mode, 'first_person')
})

console.log('\n=== 伸懒腰交给模型 ===')
ok('伸懒腰不写手臂角度/轨迹', () => {
  const s = byId.stretch.scene
  assert.ok(!/手臂|双臂|举起|后仰|向两侧|伸直/.test(s), s)
})

console.log('\n=== 匹配与触发 ===')
ok('护肤 → cotton；口红 → lipstick；刷牙 → brush', () => {
  assert.equal(matchAction('晚上在镜子前护肤').id, 'cotton')
  assert.equal(matchAction('涂个口红').id, 'lipstick')
  assert.equal(matchAction('去刷牙').id, 'brush')
})
ok('模糊动作会触发补全；喝水/漫画/写日记不自动改写', () => {
  assert.equal(needsActionDetail('晚上护肤'), true)
  assert.equal(needsActionDetail('喝口水'), false)
  assert.equal(needsActionDetail('看漫画'), false)
})
ok('actionForScene 返回模式（不再带手数）', () => {
  const a = actionForScene('在化妆镜前涂口红')
  assert.equal(a.mode, 'mirror_selfie'); assert.equal(a.hands, undefined)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
