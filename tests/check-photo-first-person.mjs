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

console.log('=== 第一人称约束 ===')
ok('★ 明说"这一张没有镜子"', () => {
  assert.match(p, /没有镜子/)
})
ok('★ 不许出现"手机举在她面前"的第三人称画面', () => {
  assert.match(p, /不要把手机举在她面前|看不见自己/)
})
ok('★ 禁止段点名第二个人和镜子', () => {
  assert.match(p, /第二个人/)
  assert.match(p, /镜面反射/)
})
ok('仍然保留"画面里不能出现她的脸"', () => {
  assert.match(p, /不能出现她整个人/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
