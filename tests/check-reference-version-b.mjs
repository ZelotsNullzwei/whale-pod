/**
 * B 版身体参考图的版本识别与选用（2026-11-10）
 *
 * ## 事故
 * 用户给了 B 版**无头饰素体**三视图，`characterVersion=B`、`faceRefKind=head`，
 * 但 `bodyRefVersionOf` 只认 A 版的 SHA256 → B 图被判 `body_version_invalid: UNKNOWN`
 * → resolver 只能退回脸图（`strategy=face, reason=version_conflict_use_head_ref`）。
 *
 * ## 现在要求
 * 1. B 身体图有**显式、可验证**的版本识别（按文件内容 SHA256，不读配置、不看文件名）
 * 2. 未知文件仍 **fail closed**（UNKNOWN → 不选身体图）
 * 3. 身体可见的模式（自拍/对镜/视频通话）且 A/B 版本一致时 → 选身体图
 * 4. 第一人称/局部 → 不选任何身份参考图
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planShot, bodyRefVersionOf, B_BODY_SHA256 } from '../src/photo/index.js'
import { resolveReference } from '../src/photo/reference-manager.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const BODY_B = path.join(import.meta.dirname, 'fixtures', 'body-ref-b.png')
const FACE_B = path.join(import.meta.dirname, 'fixtures', 'face-ref-b.png')
const DAY = '雾霾蓝细吊带 + 深灰棉质家居短裤，光脚，木色拖鞋'

/** 造一个"未知"身体图：内容不同 → 哈希不同 */
const OTHER = (() => {
  const f = path.join(os.tmpdir(), `body-unknown-${Date.now()}.png`)
  fs.writeFileSync(f, 'totally-not-the-b-body-' + Math.random())
  return f
})()

const imageCfg = (over = {}) => ({
  faceRef: FACE_B,
  faceRefKind: 'head',
  characterVersion: 'B',
  bodyRefImage: BODY_B,
  refImage: FACE_B,
  ...over,
})

const shot = (scene, over = {}) =>
  planShot({ scene, slot: 'evening', outfit: DAY, hair: '披发', scope: `t:${Math.random()}`, imageCfg: imageCfg(over) })

console.log('=== 1. 版本识别 ===')
ok('★ B 版身体图 → "B"（按内容 SHA256）', () => {
  assert.equal(bodyRefVersionOf(BODY_B), 'B')
})
ok('★ 常量与文件一致（防止有人改图不改常量）', () => {
  assert.equal(typeof B_BODY_SHA256, 'string')
  assert.match(B_BODY_SHA256, /^[0-9a-f]{64}$/)
})
ok('★ 未知文件 → "UNKNOWN"（fail closed）', () => {
  assert.equal(bodyRefVersionOf(OTHER), 'UNKNOWN')
})
ok('空路径 → ""', () => {
  assert.equal(bodyRefVersionOf(''), '')
})

console.log('\n=== 2. B 版能用身体图 ===')
ok('★ 自拍（front_selfie）→ strategy=body，且真的用身体图', () => {
  const r = shot('对着镜头自拍一张')
  assert.equal(r.refDecision.strategy, 'body', `实际 ${r.refDecision.strategy}`)
  assert.equal(r.refImage, BODY_B, 'refImage 必须是 B 身体图')
  assert.ok(r.refDecision.checks.some((c) => c.name === 'body_version' && c.ok), '必须有 body_version 通过项')
})
ok('★ 对镜（mirror_selfie）→ 也用身体图', () => {
  const r = shot('对镜看看今天这身')
  assert.equal(r.refDecision.strategy, 'body')
  assert.equal(r.refImage, BODY_B)
})
ok('★ 后置拍物（rear_selfie）→ 不用人物身体参考', () => {
  const r = shot('拍一张窗外的雪')
  assert.equal(r.mode, 'rear_selfie')
  assert.equal(r.refDecision.strategy, 'none', `实际 ${r.refDecision.strategy}`)
  assert.equal(r.refImage, '')
})

console.log('\n=== 3. 未知身体图仍拒绝 ===')
ok('★ 未知身体图 → 不会选身体图，并记 body_version_invalid', () => {
  const r = shot('对着镜头自拍一张', { bodyRefImage: OTHER })
  assert.notEqual(r.refDecision.strategy, 'body', '不能选未知版本的身体图')
  assert.ok(
    r.refDecision.checks.some((c) => c.name === 'body_version_invalid' && !c.ok),
    '必须记 body_version_invalid',
  )
})

console.log('\n=== 4. 第一人称不选身份参考图 ===')
ok('★ 第一人称 → strategy=none（局部构图不需要身体基准）', () => {
  const r = shot('（第一人称）洗碗，手上都是泡沫')
  assert.equal(r.mode, 'first_person')
  assert.equal(r.refDecision.strategy, 'none', `实际 ${r.refDecision.strategy}`)
  assert.equal(r.refImage, '')
})

console.log('\n=== 5. 源码锁 ===')
ok('★ 版本识别只认内容 SHA256（不读配置字段/文件名）', () => {
  const src = fs.readFileSync(new URL('../src/photo/index.js', import.meta.url), 'utf8')
  assert.match(src, /B_BODY_SHA256/)
  assert.match(src, /h === B_BODY_SHA256/)
  assert.ok(!/bodyRefVersion\s*=\s*['"]B['"]/.test(src), '不能拿配置字段直接当版本')
})

console.log('\n=== 6. 构图决定喂头像还是全身（2026-11-10 修）===')
const refBase = {
  outfitText: DAY, faceRef: FACE_B, faceRefKind: 'head', mode: 'front_selfie',
  characterVersion: 'B', bodyRef: BODY_B, bodyRefVersion: 'B',
}
ok('★ 头肩 / 面部特写 → 用头像（喂全身图会把脸和耳鳍糊掉）', () => {
  for (const f of ['头肩', '面部特写']) {
    const r = resolveReference({ ...refBase, framing: f })
    assert.equal(r.strategy, 'face', `${f} 应走 face，实际 ${r.strategy}`)
    assert.equal(r.refImage, FACE_B, `${f} 应回头像`)
  }
})
ok('★ 半身 / 三分之二身 / 全身 → 用身体图', () => {
  for (const f of ['半身', '三分之二身', '全身']) {
    const r = resolveReference({ ...refBase, framing: f })
    assert.equal(r.strategy, 'body', `${f} 应走 body，实际 ${r.strategy}`)
    assert.equal(r.refImage, BODY_B)
  }
})
ok('★ index.js 真的把 framing 传给 resolver（否则上面那条判断永不生效）', () => {
  const src = fs.readFileSync(new URL('../src/photo/index.js', import.meta.url), 'utf8')
  assert.match(src, /framing: String\(framing\?\.framing/, 'resolveReference 调用里没传 framing')
})

ok('★ 未知构图要显式记录 fallback 原因（未来新增构图不至于静默落回头像）', () => {
  for (const f of ['某某新构图', '']) {
    const r = resolveReference({ ...refBase, framing: f })
    assert.equal(r.strategy, 'face', `${f || '(空)'} 应按预期退回头像`)
    const hit = r.checks.find((c) => c.name === 'body_framing_unknown_fallback')
    assert.ok(hit && hit.ok === false, `${f || '(空)'} 必须记 body_framing_unknown_fallback`)
  }
  /* 已知的"只该用头像"构图属于正常退化，不该报未知 */
  for (const f of ['头肩', '面部特写']) {
    const r = resolveReference({ ...refBase, framing: f })
    assert.ok(!r.checks.some((c) => c.name === 'body_framing_unknown_fallback'), `${f} 不该报未知构图`)
  }
})

console.log('\n=== 7. checks 真的进日志了（评审：原先只在返回对象里）===')
ok('★ bridge 会把 refDecision 的异常项写进日志', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /参考图决策有 \$\{serious\.length\} 项异常/, '缺 warn 日志')
  assert.match(src, /参考图决策 \$\{rd\.strategy\}/, '缺 info 日志')
})

console.log('\n=== 8. 背影模式现状（评审提出，待产品确认）===')
ok('rear_object / rear_selfie → strategy=none（目前完全不给参考图，不是"回落到头像"）', () => {
  for (const mode of ['rear_object', 'rear_selfie']) {
    const r = resolveReference({ ...refBase, mode, framing: '全身' })
    assert.equal(r.strategy, 'none', `${mode} 实际 ${r.strategy}`)
    assert.ok(!r.refImage, `${mode} 不该给参考图（实际 ${JSON.stringify(r.refImage)}）`)
  }
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
