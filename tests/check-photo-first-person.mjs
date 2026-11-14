/**
 * 第一人称不许混进"镜子/别人举着手机"（2026-11-07 实测事故）。
 *
 * 现场那张图：她坐在床边、整张是第三人称，画面左边还有**别人的手臂举着手机**，
 * 而且是**镜面反射**。第一人称的提示词只写了"镜头就是她的眼睛、看不到自己"，
 * 没写"没有镜子、没有第二个人"。
 */
import assert from 'node:assert/strict'
import { composePhotoPrompt } from '../src/photo/photo-prompt.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const plan = {
  mode: 'first_person', shooter: '她自己', device: '手机', camera: '眼睛位置',
  look: '看手里的东西', rules: [], needsCharacterRef: false, hidePhone: true,
}
const framing = { framing: '局部', desc: '局部', feet: false, cameraAngle: '俯视', notes: [] }
const p = composePhotoPrompt({ plan, framing, scene: '她坐在床边低头看手机', hasRef: false })

console.log('=== 第一人称约束（精简可见提示词）===')
ok('★ 明说"没有镜子"、没有第二个人', () => {
  assert.match(p, /没有镜子/)
  assert.match(p, /没有第二个人/)
})
ok('★ 不出现她的脸/身体/头发', () => {
  assert.match(p, /不出现她的脸、身体和头发/)
})
ok('★ 画面主体是眼前物品和台面', () => {
  assert.match(p, /只拍她眼前能看到的物品和台面/)
})
ok('★ 画面最多一只手', () => {
  assert.match(p, /最多一只手/)
})
ok('★ 不再堆空间/位置模板', () => {
  assert.doesNotMatch(p, /画面下方\/中央/)
  assert.doesNotMatch(p, /自然落在画面下半部/)
  assert.match(p, /场景与动作/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
