/**
 * 生图提示词：胸型对称 + 款式锁死（2026-11-06）。
 *
 * 用户两条反馈：
 *   ①「生成的几张女仆装的图，胸还是一大一小的」
 *   ②「款式不统一」—— 同一套短款女仆装，三张图领口/围裙/袜子各是各的
 *
 * 根因都在提示词：
 *   · 身形段只写"有明显起伏"，**没有对称约束**；
 *   · 衣着段只是一句散文，模型每次都**重新设计一遍**款式。
 *
 * 守什么：
 * - 身形段必须有"左右对称/不要一大一小"
 * - 衣着段必须有"部件逐件对得上 + 跨图是同一件"
 * - 【禁止】里要有款式漂移和胸型不对称两条
 * - 没有 outfit 时不该硬塞这段
 */
import assert from 'node:assert/strict'
import { composePhotoPrompt } from '../src/photo/photo-prompt.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const OUTFIT = '白色蕾丝头带（拱形、一侧蓝丝带蝴蝶结），**女仆装短款**（藏青到深蓝渐变的连身裙，'
  + '裙长在膝盖以上，两层白蕾丝裙摆），白色蕾丝围裙（肩带交叉、胸前小鲸鱼刺绣），'
  + '颈饰是黑色大蝴蝶结 + 中央蓝宝石，**白色过膝长袜**（袜口一圈蕾丝花边），'
  + '**藏青玛丽珍鞋（带搭扣）**，腰后挂着一条深蓝色鲸鱼尾巴'

const plan = {
  mode: 'mirror_selfie',
  shooter: '她自己',
  device: '手机',
  camera: '镜子前，手机举在胸前',
  look: '看镜子里的手机屏幕',
  rules: [],
  needsCharacterRef: true,
  hidePhone: false,
}
const framing = { framing: '全身', desc: '全身', feet: true, cameraAngle: '平视', notes: [] }

const prompt = composePhotoPrompt({
  plan, framing, scene: '对镜自拍，站在镜子前', outfit: OUTFIT, hasRef: true,
})

console.log('=== 1. 胸型对称 ===')
ok('★ 有"左右必须对称"', () => {
  assert.match(prompt, /左右必须对称/, '身形段要写对称')
})
ok('★ 明确禁止一大一小 / 一高一低', () => {
  assert.match(prompt, /不要一大一小/)
  assert.match(prompt, /一高一低|单侧下垂/)
})
ok('举手机的动作不许把胸型带歪', () => {
  assert.match(prompt, /不许把胸型带歪/)
})

console.log('\n=== 2. 款式锁死 ===')
ok('★ 逐件对得上（领口/袖子/围裙/裙摆/袜子/鞋）', () => {
  assert.match(prompt, /每个部件\*\*必须逐件对得上\*\*/)
  assert.match(prompt, /围裙（有无肩带/, '围裙要点名')
  assert.match(prompt, /袜子（颜色\/长度\/有无蕾丝袜口）/, '袜子要点名')
})
ok('★ 跨图必须是同一件', () => {
  assert.match(prompt, /每一张照片里看起来都必须是同一件/)
})
ok('★ 【禁止】里点名款式漂移', () => {
  assert.match(prompt, /款式漂移/)
  assert.match(prompt, /胸型不对称/)
})

console.log('\n=== 3. 不该出现的时候别塞 ===')
ok('没有 outfit → 不出现款式锁', () => {
  const p2 = composePhotoPrompt({ plan, framing, scene: '拍窗外', outfit: '', hasRef: true })
  assert.ok(!/每个部件\*\*必须逐件对得上\*\*/.test(p2))
})
ok('第一人称（first_person）→ 不写"从头发到鞋跟"那套', () => {
  const p3 = composePhotoPrompt({
    plan: { ...plan, mode: 'first_person' }, framing, scene: '低头看手', outfit: OUTFIT, hasRef: true,
  })
  assert.ok(!/从头发到鞋跟/.test(p3))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
