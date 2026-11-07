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
import { partBandOf, buildPartRef, resolveBand, selfSafeBandOf, PART_REF_ALGO_VERSION, FACE_SAFETY_MARGIN } from '../src/photo/partRef.js'

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
  assert.match(SRC_PROMPT, /【局部构图：这一张只拍/)
  assert.ok(SRC_PROMPT.includes('**画面里只有**'), '缺正向清单')
  assert.match(SRC_PROMPT, /这一张全部不适用/)
})
ok('★ 脚部特写不能被「这一张不拍脚」自己禁掉', () => {
  assert.match(SRC_PROMPT, /framing\.bodyPart !== '脚'/)
})

console.log('\n=== 4. 群里：先撩几轮再给（用户：「群聊可以，但得先拉扯或者挑逗」「甚至可以多几次」）===')
ok('★ bridge 里有「先拉扯」的计数闸', () => {
  const i = SRC_BRIDGE.indexOf("detectBodyPart(String(hit[1] ?? ''))")
  assert.ok(i > 0, '没有群里那道闸')
  const seg = SRC_BRIDGE.slice(i, i + 900)
  assert.match(seg, /bodyPartTeaseTimes/, '没有可配的「撩几次」')
  assert.match(seg, /只拉扯，不画/, '没有对应的日志')
})
ok('★ 默认撩 2 次（第 3 次才给）', () => {
  const i = SRC_BRIDGE.indexOf('const teaseTimes = Number(')
  assert.ok(i > 0, '找不到 teaseTimes')
  assert.match(SRC_BRIDGE.slice(i, i + 90), /\?\? 2/, '默认值不是 2')
})
ok('★ 只拉扯那一轮有兜底句（别变成空消息）', () => {
  assert.match(SRC_BRIDGE, /msg\.__teaseOnly && !text\.trim\(\)/)
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

console.log('\\n=== 6. 三处出口修正（2026-11-07 20:0x 私聊现场）===')
ok('★ 文本里明确要图 → 不被「看图」抢走', () => {
  const i = SRC_BRIDGE.indexOf('const wantsPicText = classifyDrawIntent')
  assert.ok(i > 0, '没有这个前置判断')
  assert.match(SRC_BRIDGE.slice(i, i + 120), /if \(!wantsPicText && this\._shouldLookAtImage/)
})
ok('★ 她刚撩过部位 → 下一句提部位就算确认', () => {
  assert.match(SRC_BRIDGE, /const bodyPartFresh = \(\(\) => \{/)
  assert.match(SRC_BRIDGE, /bodyPartFresh && detectBodyPart/)
})
ok('★ 图有了但正文空 → 兜一句（且不许用今日计划）', () => {
  const i = SRC_BRIDGE.indexOf('if (coverForSend && !String(text')
  assert.ok(i > 0, '没有空正文兜底')
  const seg = SRC_BRIDGE.slice(i, i + 400)
  assert.match(seg, /喏。/, '兜底句不在')
  assert.ok(!/dayPlan/.test(seg), '又拿今日计划拼兜底句了')
})


console.log('\\n=== 7. 部位特写靠裁切，不靠提示词（2026-11-07 实测结论）===')
ok('★ mcpImage 有 cropRegion（结果确定，不跟模型较劲）', () => {
  const b = fs.readFileSync(new URL('../src/qq/mcpImage.js', import.meta.url), 'utf8')
  assert.match(b, /export async function cropRegion/)
  assert.match(b, /b - t >= 0\.15/, '要挡住非法区间，别裁成一条线')
})
ok('★ bridge 生成后按部位裁（腿/脚/小腹/腰/锁骨/胸部/肩颈）', () => {
  const b = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(b, /const bpCrop = \(\(\) => \{/)
  for (const k of ['腿', '脚', '小腹', '腰', '锁骨', '胸部', '肩颈']) {
    assert.ok(b.includes(`${k}: [`), `裁切表里缺「${k}」`)
  }
  assert.match(b, /cropRegion\(buf, bpCrop\[0\], bpCrop\[1\]/, '没真正调用裁切')
})
ok('★ 手不裁（位置不定，裁了容易切半只手）', () => {
  const b = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const i = b.indexOf('const TABLE = {')
  const seg = b.slice(i, b.indexOf('}', i))
  assert.ok(!seg.includes('手: ['), '手部不该进裁切表')
})
ok('★ framingInfo 要把 bodyPart 带出来（否则裁切永远不触发）', () => {
  const f = fs.readFileSync(new URL('../src/photo/index.js', import.meta.url), 'utf8')
  assert.match(f, /framingInfo: framing/)
})


console.log('\\n=== 8. 部位参考图（参考图就是构图基准，2026-11-07 实测）===')
ok('★ 腿/脚/腰/小腹/锁骨/胸部 都有裁切区间，手没有', () => {
  for (const p of ['腿', '脚', '腰', '小腹', '锁骨', '胸部']) assert.ok(partBandOf(p), p)
  assert.equal(partBandOf('手'), null, '手不该有区间（位置不固定，会裁到脸）')
})
ok('★ 靠上的部位（锁骨/胸部）起点必须低于下巴线', () => {
  assert.ok(partBandOf('锁骨')[0] >= 0.4, '锁骨起点太低会裁到脸')
  assert.ok(partBandOf('胸部')[0] >= 0.4, '胸部起点太低会裁到脸')
})
ok('★ bridge：部位特写换参考图 + 失败时做诊断性重试（不再归因单个词）', () => {
  const b = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(b, /buildPartRef\x28/, '没接部位参考图')
  assert.match(b, /部位特写生成失败/, '没有失败诊断日志')
  assert.match(b, /疑似参考图触发过滤/, '没有换参考图重试')
})


console.log('\\n=== 9. C 方案：脸下边界决定裁切起点（2026-11-07）===')
ok('★ 有脸位置 → 起点 = max(默认, 脸底 + 安全边距)', () => {
  const r = resolveBand('腿', { face_found: true, face_bottom_y: 0.45, confidence: 0.9 })
  assert.ok(r, " 应该能裁")
  assert.equal(r.band[0], Number((0.45 + FACE_SAFETY_MARGIN).toFixed(5)))
})
ok('★ 脸已经占住这个部位 → 直接不出参考图（不许把脸裁进去）', () => {
  const r = resolveBand('锁骨', { face_found: true, face_bottom_y: 0.49, confidence: 0.9 })
  assert.equal(r, null, "锁骨被脸占住时必须停止")
})
ok('★ 检测不到脸 → 腿/脚/腰/小腹 走保守区间；锁骨/胸部 停止', () => {
  const noFace = { face_found: false, face_bottom_y: null, confidence: 0 }
  for (const p of ['腿', '脚', '腰', '小腹']) {
    const r = resolveBand(p, noFace)
    assert.ok(r, `${p} 应有保守区间`)
    assert.deepEqual(r.band, selfSafeBandOf(p))
  }
  for (const p of ['锁骨', '胸部']) assert.equal(resolveBand(p, noFace), null, `${p} 必须停止`)
})
ok('★ 低置信度/越界坐标 视为没检测到', () => {
  assert.deepEqual(resolveBand('腿', { face_found: true, face_bottom_y: 0.3, confidence: 0.2 }).band, selfSafeBandOf('腿'))
  assert.deepEqual(resolveBand('腿', { face_found: true, face_bottom_y: 1.4, confidence: 0.9 }).band, selfSafeBandOf('腿'))
})
ok('★ 缓存键含：部位 + 源图哈希 + 区间 + 算法版本', () => {
  const b = fs.readFileSync(new URL('../src/photo/partRef.js', import.meta.url), 'utf8')
  assert.match(b, /hashOfFile\x28src\x29/)
  assert.match(b, /PART_REF_ALGO_VERSION/)
  assert.ok(PART_REF_ALGO_VERSION >= 2)
})
ok('★ 视觉模型只输出三个字段（不参与部位分类）', () => {
  const f = fs.readFileSync(new URL('../src/photo/faceBand.js', import.meta.url), 'utf8')
  assert.match(f, /face_found/)
  assert.match(f, /face_bottom_y/)
  assert.match(f, /confidence/)
  assert.ok(!f.includes("from './photo-composer"), '脸检测不该依赖部位分类模块')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
