/**
 * 第 5 步接线测试（planShot → resolveReference）
 *
 * ⚠️ 完全可移植：只用 os.tmpdir 下的临时文件，不碰任何本机绝对路径 / `_scratch`。
 * 每项断言：strategy / reason / conflict / 实际 refImage / canonRef 一致性。
 */
import './_isolate-home.mjs'          // 必须第一个：把 WHALE_POD_HOME 指到临时目录
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { TEST_HOME } from './_isolate-home.mjs'
import { planShot, bodyRefVersionOf } from '../src/photo/index.js'
import { resolveReference } from '../src/photo/reference-manager.js'
import { configureCanon } from '../src/photo/canon.js'

let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const DAY = '浅灰吊带背心 + 米色棉质家居短裤，白棉袜'
const MAID = '白色蕾丝头带，女仆装短款（藏青渐变连身裙、两层白蕾丝裙摆），白色棉袜，藏青玛丽珍鞋'

const FACE_A = path.join(TEST_HOME, 'face-front-A.png')
const OLD_REF = path.join(TEST_HOME, 'old-maid.png')
const CANON_FILE = path.join(TEST_HOME, 'canon-maid.png')
const ANIME_FACE = path.join(TEST_HOME, 'anime-face.jpg')
const OTHER_BODY = path.join(TEST_HOME, 'body-other.png')

for (const f of [FACE_A, OLD_REF, CANON_FILE, ANIME_FACE]) fs.writeFileSync(f, 'x')
/* 非 A 版 body：内容随机 → 完整 SHA256 必然不等于 A 基准 */
fs.writeFileSync(OTHER_BODY, 'not-the-a-body-' + Math.random())

const cfgBase = {
  refImage: OLD_REF,
  faceRefImage: OLD_REF,
  animeFaceRefImage: ANIME_FACE,
  faceRef: FACE_A,
  faceRefKind: 'head',
  characterVersion: 'A',
}

function writeCanon(entries) {
  const p = path.join(TEST_HOME, 'canon.json')
  fs.writeFileSync(p, JSON.stringify({ entries }, null, 2), 'utf8')
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000))
  fs.utimesSync(p, t, t)
  configureCanon({ home: TEST_HOME })
}
const shot = (o = {}) => planShot({ scene: '自拍一张', slot: 'evening', outfit: DAY, hair: '披发', scope: 'wiring:' + Math.random(), imageCfg: cfgBase, ...o })

console.log('=== 1. canon 未命中日程 → A 版脸图 ===')
writeCanon([{ match: '女仆装短款', file: CANON_FILE, note: '', outfitText: MAID, outfitId: 'maid-short-v3', version: 'A' }])
ok('女仆 canon 不匹配吊带日程 → face，不用 canon', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, FACE_A)
  assert.equal(r.refDecision.strategy, 'face')
  assert.equal(r.refDecision.reason, 'no_canon_use_head_ref')
  assert.equal(r.canonRef, false)
})

console.log('\n=== 1b. canon 命中但不同套 → conflict ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: MAID, outfitId: 'maid-short-v3', version: 'A' }])
ok('正则命中但 outfitText 不同套 → conflict + face', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, FACE_A)
  assert.equal(r.refDecision.conflict, true)
  assert.match(r.refDecision.reason, /outfit_conflict/)
  assert.equal(r.canonRef, false)
})

console.log('\n=== 2. 同套 + 版本一致 → canon ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: DAY, outfitId: 'day-001', version: 'A' }])
ok('canon；canonRef=true', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, CANON_FILE)
  assert.equal(r.refDecision.strategy, 'canon')
  assert.equal(r.refDecision.conflict, false)
  assert.equal(r.canonRef, true)
})

console.log('\n=== 3. canon 版本不匹配 → 不用 canon ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: DAY, outfitId: 'day-001', version: 'B' }])
ok('version_conflict → face', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, FACE_A)
  assert.match(r.refDecision.reason, /version_conflict/)
  assert.equal(r.canonRef, false)
})

console.log('\n=== 4. canon 元数据缺失 → 保守冲突 ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '' }])
ok('outfit_info_incomplete → face + conflict', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, FACE_A)
  assert.equal(r.refDecision.conflict, true)
  assert.ok(r.refDecision.checks.some((c) => c.name === 'outfit_info_incomplete'))
})

console.log('\n=== 5. outfitId 不同（resolver 级）→ face ===')
ok('outfit_id 不等 → conflict', () => {
  const d = resolveReference({ outfitText: DAY, outfitId: 'other-999', canon: { file: CANON_FILE, outfitId: 'day-001', outfitText: DAY, version: 'A' }, faceRef: FACE_A, faceRefKind: 'head', mode: 'front_selfie', characterVersion: 'A' })
  assert.equal(d.strategy, 'face')
  assert.equal(d.conflict, true)
  assert.ok(d.checks.some((c) => c.name === 'outfit_id' && !c.ok))
})

console.log('\n=== 6. 无人物模式 ===')
writeCanon([])
ok('sceneOnly（plan.mode=rear_selfie, needsCharacterRef=false）→ refImage 空', () => {
  const r = shot({ scene: '桌上的杯子，有点阳光', sceneOnly: true })
  assert.equal(r.refDecision.strategy, 'none')
  assert.equal(r.refImage, '')
  assert.equal(r.refDecision.identityRef, null)
})
ok('first_person → refImage 空', () => {
  const r = shot({ scene: '第一人称 端着杯子喝水' })
  assert.equal(r.refDecision.strategy, 'none')
  assert.equal(r.refImage, '')
})
ok('rear_object（resolver 级）→ none', () => {
  const d = resolveReference({ mode: 'rear_object', faceRef: FACE_A, faceRefKind: 'head', characterVersion: 'A' })
  assert.equal(d.strategy, 'none')
  assert.equal(d.refImage, null)
})

console.log('\n=== 7. 开关与旧行为 ===')
ok('未配置 faceRef → refDecision=null，旧逻辑给参考图', () => {
  const cfg = { ...cfgBase }
  delete cfg.faceRef
  const r = planShot({ scene: '自拍一张', slot: 'evening', outfit: DAY, hair: '披发', scope: 'wiring:nofaceref', imageCfg: cfg })
  assert.equal(r.refDecision, null)
  assert.ok(r.refImage.length > 0)
  assert.ok(!r.refImage.includes('face-front-A'))
})
ok('anime 档 → refDecision=null，不进真人脸图逻辑', () => {
  const r = shot({ anime: true })
  assert.equal(r.refDecision, null)
  assert.ok(!r.refImage.includes('face-front-A'))
})

console.log('\n=== 8. fallback 不回退旧 refImage ===')
ok('faceRefKind=costume → fallback 且 refImage 空', () => {
  const cfg = { ...cfgBase, faceRefKind: 'costume' }
  const r = planShot({ scene: '自拍一张', slot: 'evening', outfit: DAY, hair: '披发', scope: 'wiring:costume', imageCfg: cfg })
  assert.equal(r.refDecision.strategy, 'fallback')
  assert.equal(r.refImage, '')
})

console.log('\n=== 8b. bodyRefVersion 不能被配置绕过（本轮重点） ===')
ok('bodyRefVersionOf：空路径→空；非 A 文件→UNKNOWN', () => {
  assert.equal(bodyRefVersionOf(''), '')
  assert.equal(bodyRefVersionOf(OTHER_BODY), 'UNKNOWN')
})
ok('非 A 的 bodyRefImage + 显式 bodyRefVersion="A" → 仍判 body_version_invalid', () => {
  const cfg = { ...cfgBase, bodyRefImage: OTHER_BODY, bodyRefVersion: 'A' }
  const r = planShot({ scene: '自拍一张', slot: 'evening', outfit: DAY, hair: '披发', scope: 'wiring:bypass', imageCfg: cfg })
  assert.equal(r.refDecision.conflict, true)
  assert.ok(r.refDecision.checks.some((c) => c.name === 'body_version_invalid' && !c.ok), '必须判非法')
  assert.equal(r.refDecision.checks.find((c) => c.name === 'body_version'), undefined, '不得记成功')
  assert.equal(r.refDecision.version.body, null)
})

console.log('\n=== 9. canonRef / prompt 与决策一致 ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: DAY, outfitId: 'day-001', version: 'A' }])
ok('canon 时 canonRef=true 且 prompt 无 face-front', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.canonRef, true)
  assert.ok(!r.prompt.includes('face-front'))
})
writeCanon([{ match: '女仆装短款', file: CANON_FILE, note: '', outfitText: MAID, outfitId: 'maid-short-v3', version: 'A' }])
ok('face 时 prompt 无定妆照文案、有参考图措辞', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refDecision.strategy, 'face')
  assert.ok(!r.prompt.includes('定妆照'))
  assert.ok(r.prompt.includes('参考图'))
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
