/**
 * 部位特写（2026-11-07）。
 *
 * 用户：「看看脚，看看手，看看腿，看看小肚子，看看胸一类的」能生吗？
 * 查下来不能 —— 不是审核，是**构图档里没有"部位特写"这条路**：
 * 「看看脚」落不到任何一档，退回自拍/半身，**画出整个人，脚不在画面里**。
 *
 * 现在：
 * - `detectBodyPart()` 认部位（脚/手/腿/小腹/腰/锁骨/胸）
 * - `composeFraming()` 命中就直接给「局部」构图、不露脸
 * - `photo-prompt.js` 单独一段「只拍 X，脸在画外」
 * - **群里不拍**（bridge 拦掉），只在私聊给
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { detectBodyPart, composeFraming } from '../src/photo/photo-composer.js'
import { classifyDrawIntent } from '../src/qq/bridge.js'

const SRC_PROMPT = fs.readFileSync(new URL('../src/photo/photo-prompt.js', import.meta.url), 'utf8')
const SRC_BRIDGE = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 认部位 ===')
ok('★ 脚 / 手 / 腿 / 小肚子 / 锁骨 / 胸 都认得出', () => {
  assert.equal(detectBodyPart('看看脚'), '脚')
  assert.equal(detectBodyPart('让我看看手'), '手')
  assert.equal(detectBodyPart('看看腿'), '腿')
  assert.equal(detectBodyPart('看看小肚子'), '小腹')
  assert.equal(detectBodyPart('看看锁骨'), '锁骨')
  assert.equal(detectBodyPart('看看胸'), '胸部')
})
ok('★ 普通拍图请求不误判', () => {
  for (const t of ['拍一张自拍', '看看你', '全身照', '']) assert.equal(detectBodyPart(t), null, t)
})
ok('★ 「胸有成竹」不是要看胸', () => {
  assert.equal(detectBodyPart('胸有成竹'), null)
  assert.equal(detectBodyPart('心情很胸有成竹'), null)
})

console.log('\n=== 2. 构图：只框那一块、不露脸 ===')
ok('★ 命中部位 → 「局部」+ showFace=false', () => {
  const f = composeFraming({ mode: 'front_selfie', subject: '坐在床上' }, { request: '看看脚' })
  assert.equal(f.framing, '局部')
  assert.equal(f.bodyPart, '脚')
  assert.equal(f.showFace, false)
  assert.match(f.desc, /只拍「脚」/)
})
ok('★ 没命中部位 → 还是原来的构图', () => {
  const f = composeFraming({ mode: 'front_selfie', subject: '坐在床上' }, { request: '拍一张自拍' })
  assert.notEqual(f.framing, '局部')
  assert.equal(f.bodyPart, undefined)
})

console.log('\n=== 3. 提示词与禁令 ===')
ok('★ 有「部位特写」段，明确"不出现脸、不出现全身"', () => {
  assert.match(SRC_PROMPT, /【部位特写：只拍\$\{framing\.bodyPart\}】/)
  assert.match(SRC_PROMPT, /不出现脸、不出现全身/)
})
ok('★ 脚部特写不能被「这一张不拍脚」自己禁掉', () => {
  assert.match(SRC_PROMPT, /framing\.bodyPart !== '脚'/)
})

console.log('\n=== 4. 群里不拍（边界）===')
ok('★ bridge 里有"群里不拍部位特写"的闸', () => {
  const i = SRC_BRIDGE.indexOf("detectBodyPart(String(hit[1] ?? ''))")
  assert.ok(i > 0, '没有群里那道闸')
  assert.match(SRC_BRIDGE.slice(i, i + 400), /群里不拍部位特写/)
})


console.log('\n=== 5. 这些说法要算「要图」，否则根本走不到画图 ===')
ok('★ 看看脚/手/腿/小肚子/锁骨/胸 → wantsPic', () => {
  for (const t of ['看看脚', '让我看看手', '看看腿', '看看小肚子', '看看锁骨', '看看胸']) {
    assert.equal(classifyDrawIntent(t).wantsPic, true, t)
  }
})
ok('★ 看看手机/手表 不算要看手', () => {
  assert.equal(classifyDrawIntent('看看手机').wantsPic, false)
  assert.equal(classifyDrawIntent('看看手表').wantsPic, false)
})
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
