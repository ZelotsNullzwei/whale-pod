/**
 * 拍摄方案的三个实测 bug（2026-11-06，用户连续反馈两张怪图）。
 *
 * ## 事故 1：说要拍脸，发出来是一碗饭
 * ```
 * 14:54:30 画图「…她凑近手机镜头自拍，脸占满画面，
 *              浅色的窗帘和书桌在背后虚…」
 *          拍摄方案 → 第一人称记录｜局部
 *              （原 front_selfie → 修正：前摄拍不到背影 → 改成第一人称记录）
 * 结果：一碗饭 + 手 + 白裤子，脸完全没入镜
 * ```
 * 根因：`/(背影|后脑|背对|背后)/` 把「书桌在**背后**虚化」当成"要拍背影"，
 * 把"拍脸"的方案降级成第一人称（物理上拍不到自己）。
 *
 * ## 事故 2：对镜自拍，镜子里没有手机
 * 规则里写着「镜中必须能看到她举着手机」，但模型画了个悬空手机/干脆不画。
 * 根因两条：
 *   ① 「镜中能看到她举着手机」措辞太软，模型理解成"她手里有就行（画面外也算）"
 *   ② SELFIE_RULES 的「手别悬空 → 托腮/扶脸」把她的手引走了，手机没手可拿
 *
 * ## 事故 3：对镜自拍的构图描述是"沙发、桌边"（坐姿）
 * `三分之二身` 的通用 desc 是给坐着自拍写的，对镜自拍是站着的，照抄会打架。
 */
import assert from 'node:assert/strict'
import { planShot } from '../src/photo/index.js'
import { validatePhotoPlan } from '../src/photo/photo-validator.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const plan = (scene, slot = 'afternoon') => planShot({ request: scene, scene, slot })

console.log('=== 1. 「背后」是背景，不是背影 ===')
ok('★ 线上那句：背后虚化 + 要拍脸 → **不能**降级成第一人称', () => {
  const scene = '阴天下午的房间，开着灯，她凑近手机镜头自拍，脸占满画面，浅色的窗帘和书桌在背后虚'
  const r = validatePhotoPlan({ mode: 'front_selfie' }, { scene })
  assert.ok(!(r.fix.mode === 'first_person'), '不该降成第一人称')
})

ok('真的要拍背影 → 该降（这条不能丢）', () => {
  for (const scene of ['背对镜头拍一张', '转过身，只拍后脑', '背部特写', '拍后背']) {
    const r = validatePhotoPlan({ mode: 'front_selfie' }, { scene })
    assert.equal(r.fix.mode, 'first_person', `应降级：${scene}`)
  }
})

ok('「背后有窗户 / 床在背后」只是构图描述 → 不降', () => {
  for (const scene of ['自拍，背后有落地窗', '凑近镜头自拍，床在背后', '背后是白墙']) {
    const r = validatePhotoPlan({ mode: 'front_selfie' }, { scene })
    assert.ok(!(r.fix.mode === 'first_person'), `不该降：${scene}`)
  }
})

console.log('\n=== 2. 第一人称 + 要脸 → 必须拦回来 ===')
ok('★ 「脸占满画面」原来不命中，现在要命中（补全"要脸"的说法）', () => {
  for (const scene of [
    '脸占满画面', '脸占画面大半', '拍脸', '露脸', '面部妆容特写',
    '五官特写', '表情特写', '只拍脸', '脸的特写',
  ]) {
    const r = validatePhotoPlan({ mode: 'first_person' }, { scene })
    assert.equal(r.fix.mode, 'front_selfie', `应拦回前置自拍：${scene}`)
  }
})

ok('第一人称拍食物/手 → 不拦（本来就该第一人称）', () => {
  for (const scene of ['低头吃面，手里拿着木勺', '桌面上摆着一碗饭']) {
    const r = validatePhotoPlan({ mode: 'first_person' }, { scene })
    assert.ok(!(r.fix.mode === 'front_selfie'), `不该拦：${scene}`)
  }
})

console.log('\n=== 3. 对镜自拍：手机必须在镜子的倒影里 ===')
ok('★ 提示词里要有一条「手机必须在镜子倒影里」的硬规则', () => {
  const p = String(plan('对着镜子自拍，手里举着手机，穿米白针织连衣裙').prompt ?? '')
  assert.match(p, /手机必须在镜子的倒影里看得见/)
  assert.match(p, /不能只在画面里画一个悬空手机/)
})

ok('★ 「手别悬空→托腮」要带自拍例外，否则手机没手可拿', () => {
  const p = String(plan('对着镜子自拍').prompt ?? '')
  assert.match(p, /自拍类除外/, 'SELFIE_RULES 那条手部规则要有例外')
})

ok('对镜自拍的手是拿来拿手机的（显式一条）', () => {
  const p = String(plan('对着镜子自拍').prompt ?? '')
  assert.match(p, /手是拿来拿手机的，不是托腮/)
})

console.log('\n=== 4. 对镜自拍的构图不能是"坐姿" ===')
ok('★ 构图要说站姿/镜子取景，不能出现「沙发、桌边」', () => {
  const p = String(plan('对着镜子自拍，看看今天这身').prompt ?? '')
  assert.match(p, /镜子/, '构图描述要提镜子')
  assert.ok(!/坐姿常见/.test(p), '不该出现"坐姿常见"')
})

console.log('\n=== 5. 模式选择没被改坏 ===')
ok('背影 → 镜子自拍（一个人拍不到自己后脑，这是原设计）', () => {
  assert.equal(plan('转过身拍个背影').mode, 'mirror_selfie')
})

ok('怼脸 → face_closeup', () => {
  assert.equal(plan('怼脸自拍看看脸').mode, 'face_closeup')
})

ok('这身新衣服 → 镜子自拍', () => {
  assert.equal(plan('看看这身新衣服').mode, 'mirror_selfie')
})

ok('前置自拍 + 背后有窗户 → 仍是 front_selfie（不降级）', () => {
  const r = plan('自拍，背后有落地窗')
  assert.equal(r.mode, 'front_selfie')
  assert.equal(r.fixedFrom, undefined, '不该被修正过')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
