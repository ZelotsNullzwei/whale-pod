/**
 * 身体入画 → 必须喂身体参考图（2026-11-06）。
 *
 * 用户：「还是之前存在的三围不固定问题」—— 同一角色，两张图胸围/腰臀都不一样。
 *
 * 根因在 pickRefImage：只要露脸（mirror_selfie / front_selfie / video_call），
 * 一律返回**头像**，注释还写着「身材靠提示词里的尺寸段压，不靠三视图」。
 * 于是全身照每次只有一张脸当参考，82/58/85 全靠模型重新发明。
 *
 * 守什么：
 * - 全身 / 三分之二身 / 半身 → 用 bodyRefImage（三视图，脸和比例一起带过去）
 * - 面部特写 / 头肩 → 仍然用头像（身体本来就不入画）
 * - 没有身体参考图时不能崩，要退回头像
 */
import assert from 'node:assert/strict'
import { planShot } from '../src/photo/index.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const imageCfg = {
  refImage: 'FACE.png',
  faceRefImage: 'FACE3.png',
  bodyRefImage: 'BODY.png',
  size: '1024x2048',
}
const shot = (scene, cfg = imageCfg) => planShot({
  scene, slot: 'evening', outfit: '女仆装短款', request: '拍一张看看', scope: 't', imageCfg: cfg,
})

console.log('=== 1. 身体入画 → 身体参考图 ===')
ok('★ 对镜全身 → BODY（线上那张女仆装就是这个构图）', () => {
  const s = shot('对镜自拍，全身，站在镜子前')
  assert.equal(s.refImage, 'BODY.png')
})
ok('★ 半身 → BODY', () => {
  assert.equal(shot('半身，靠着沙发').refImage, 'BODY.png')
})

console.log('\n=== 2. 脸特写仍然用头像 ===')
ok('面部特写 → FACE3', () => {
  assert.equal(shot('怼脸特写，我的脸').refImage, 'FACE3.png')
})
ok('头肩特写 → 头像', () => {
  assert.equal(shot('前置自拍，头肩特写').refImage, 'FACE3.png')
})

console.log('\n=== 3. 兜底 ===')
ok('没配 bodyRefImage → 退回头像，不能崩', () => {
  const s = shot('对镜自拍，全身', { refImage: 'FACE.png', faceRefImage: 'FACE3.png', size: '1024x2048' })
  assert.ok(['FACE.png', 'FACE3.png'].includes(s.refImage), `得到 ${s.refImage}`)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
