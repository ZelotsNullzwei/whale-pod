/**
 * 摄影系统 V3 · 第二层【构图扩展】+ 第三层【风格模式】（2026-11-07）。
 *
 * 三条硬性约束（用户 / GPT 交接）：
 *   ① 不整体替换，只允许增量追加（第一层完全不碰）
 *   ② 摄影描述第一人称；人物/服装仍读原数据库
 *   ③ 实现方式只用 parts.push(...) 追加 + 一个默认值参数
 *
 * 本文件只守"追加进去的东西对不对、旧调用有没有被影响"。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { composePhotoPrompt } from '../src/photo/photo-prompt.js'
import { composeFraming } from '../src/photo/photo-composer.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const SRC = fs.readFileSync(new URL('../src/photo/photo-prompt.js', import.meta.url), 'utf8')

function mk(req, mode) {
  const framing = composeFraming({ mode: 'front_selfie', subject: '坐在床边' }, { request: req })
  const o = {
    plan: { shooter: '她', device: '手机', camera: '举在胸口', look: '看镜头', rules: [] },
    framing, scene: '卧室', outfit: '白T', hair: '蓝发', weather: '晚上', mood: '',
    hasRef: false, anime: false, character: {}, expression: null,
  }
  if (mode !== undefined) o.mode = mode
  return composePhotoPrompt(o)
}

console.log('=== 1. 第二层：构图扩展 ===')
ok('★ 五个字段都在', () => {
  const p = mk('看看脚', 'daily')
  for (const k of ['拍摄部位：', '是否露脸：', '镜头距离：', '镜头角度：', '裁切范围：']) {
    assert.ok(p.includes(k), `缺 ${k}`)
  }
})
ok('★ 还写清了「进入画面 / 不进入画面」', () => {
  const p = mk('看看脚', 'daily')
  assert.match(p, /进入画面：/)
  assert.match(p, /不进入画面：/)
})
ok('★ 局部照：部位=脚、不露脸、距离很近', () => {
  const p = mk('看看脚', 'daily')
  assert.match(p, /拍摄部位：脚/)
  assert.match(p, /是否露脸：\*\*不露脸\*\*/)
  assert.match(p, /镜头距离：很近/)
  assert.match(p, /不进入画面：脸/)
})
ok('★ 普通照：部位不指定、可以露脸、一臂距离', () => {
  const p = mk('拍一张自拍', 'daily')
  assert.match(p, /拍摄部位：不指定/)
  assert.match(p, /是否露脸：可以露脸/)
  assert.match(p, /镜头距离：一臂距离/)
})
ok('★ 透视写明"不需要第三方视角"', () => {
  assert.match(mk('拍一张自拍', 'daily'), /不允许出现第三方视角或远距离机位/)
})

console.log('\n=== 2. 第三层：风格模式 ===')
ok('★ daily 出 DAILY 段，且说清三样（服装/表情/光线）', () => {
  const p = mk('拍一张自拍', 'daily')
  assert.match(p, /【风格模式：DAILY/)
  assert.match(p, /服装氛围：/)
  assert.match(p, /表情：/)
  assert.match(p, /光线：/)
  assert.match(p, /不要把默认表情设成冷脸/)
})
ok('★ close 出 CLOSE 段，且写明不生成露骨内容', () => {
  const p = mk('拍一张自拍', 'close')
  assert.match(p, /【风格模式：CLOSE/)
  assert.match(p, /不生成露骨裸露或明确性行为/)
  assert.match(p, /床头灯/)
})
ok('★ 旧调用不传 mode → 等价于 daily（行为不破）', () => {
  const p = mk('拍一张自拍', undefined)
  assert.match(p, /【风格模式：DAILY/)
  assert.ok(!p.includes('【风格模式：CLOSE'))
})

console.log('\n=== 3. 只追加，不改第一层 ===')
ok('★ 两个新段都在【输出】之前（输出仍是最后一段）', () => {
  const p = mk('拍一张自拍', 'daily')
  const iOut = p.lastIndexOf('【输出】')
  assert.ok(p.indexOf('【构图扩展】') < iOut, '构图扩展跑到输出后面了')
  assert.ok(p.indexOf('【风格模式') < iOut, '风格模式跑到输出后面了')
})
ok('★ mode 是带默认值的参数（旧接口兼容）', () => {
  assert.match(SRC, /mode = 'daily'/, 'mode 参数没有默认值')
})
ok('★ 第一层文件没被改（photo-planner / photo-modes 里没有 v3 痕迹）', () => {
  for (const f of ['photo-planner.js', 'photo-modes.js', 'photo-validator.js']) {
    const s = fs.readFileSync(new URL(`../src/photo/${f}`, import.meta.url), 'utf8')
    assert.ok(!/构图扩展|风格模式：CLOSE|V3/.test(s), `${f} 被这次改动污染了`)
  }
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
