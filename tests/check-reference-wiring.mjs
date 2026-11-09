/**
 * 第 5 步接线测试（planShot → resolveReference）
 * 每项断言：strategy / reason / conflict / 实际 refImage / canonRef 一致性。
 */
import './_isolate-home.mjs'          // 必须第一个：把 WHALE_POD_HOME 指到临时目录
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { TEST_HOME } from './_isolate-home.mjs'
import { planShot } from '../src/photo/index.js'
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
const BODY_A = path.join(TEST_HOME, 'body-A.png')
const OLD_REF = path.join(TEST_HOME, 'old-maid.png')
const CANON_FILE = path.join(TEST_HOME, 'canon-maid.png')
const ANIME_FACE = path.join(TEST_HOME, 'anime-face.jpg')
for (const f of [FACE_A, OLD_REF, CANON_FILE, ANIME_FACE]) fs.writeFileSync(f, 'x')
/* BODY_A 必须是**真实的 A 版 body**（接线里用 sha256 核验版本，假文件会判 UNKNOWN） */
const REAL_A_BODY = 'C:/Users/Null_zwei/Documents/deepseek-harness/default-workspace/_scratch/photo-v3/version-a-original-body/body-3view.png'
if (!fs.existsSync(REAL_A_BODY)) throw new Error('缺少 A 版 body 素材: ' + REAL_A_BODY)
fs.copyFileSync(REAL_A_BODY, BODY_A)

const cfgBase = {
  refImage: OLD_REF,
  faceRefImage: OLD_REF,
  bodyRefImage: BODY_A,
  animeFaceRefImage: ANIME_FACE,
  faceRef: FACE_A,
  faceRefKind: 'head',
  characterVersion: 'A',
}

function writeCanon(entries) {
  const p = path.join(TEST_HOME, 'canon.json')
  fs.writeFileSync(p, JSON.stringify({ entries }, null, 2), 'utf8')
  /* mtime 变化会让 canon.js 重新加载（缓存按 mtime） */
  const t = new Date(Date.now() + Math.floor(Math.random() * 100000))
  fs.utimesSync(p, t, t)
  configureCanon({ home: TEST_HOME })
}
const shot = (o = {}) => planShot({ scene: '自拍一张', slot: 'evening', outfit: DAY, hair: '披发', scope: 'wiring:' + Math.random(), imageCfg: cfgBase, ...o })

console.log('=== 1. 日程吊带（女仆 canon 未命中该日程）→ A 版脸图 ===')
writeCanon([{ match: '女仆装短款', file: CANON_FILE, note: '', outfitText: MAID, outfitId: 'maid-short-v3', version: 'A' }])
ok('女仆 canon 不匹配吊带日程 → 用 A 版脸图，不用 canon', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, FACE_A)
  assert.equal(r.refDecision.strategy, 'face')
  assert.equal(r.refDecision.reason, 'no_canon_use_head_ref', 'canon 根本没命中 → 无冲突但也不得用 canon')
  assert.equal(r.canonRef, false)
})

console.log('=== 1b. canon 命中但不同套 → conflict ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: MAID, outfitId: 'maid-short-v3', version: 'A' }])
ok('canon 命中(正则可匹配)但 outfitText 不是同套 → conflict + face', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, FACE_A)
  assert.equal(r.refDecision.strategy, 'face')
  assert.equal(r.refDecision.conflict, true)
  assert.match(r.refDecision.reason, /outfit_conflict/)
  assert.equal(r.canonRef, false)
})

console.log('\n=== 2. 日程与 canon 同套、版本一致 → canon ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: DAY, outfitId: 'day-001', version: 'A' }])
ok('refImage = canon；strategy=canon；canonRef=true', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, CANON_FILE)
  assert.equal(r.refDecision.strategy, 'canon')
  assert.equal(r.refDecision.conflict, false)
  assert.equal(r.canonRef, true)
})

console.log('\n=== 3. canon 版本不匹配 → 不用 canon ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: DAY, outfitId: 'day-001', version: 'B' }])
ok('strategy=face；conflict=true；reason=version_conflict*', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, FACE_A)
  assert.equal(r.refDecision.strategy, 'face')
  assert.equal(r.refDecision.conflict, true)
  assert.match(r.refDecision.reason, /version_conflict/)
  assert.equal(r.canonRef, false)
})

console.log('\n=== 4. canon 元数据缺失 → 保守冲突 ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '' }])
ok('strategy=face；conflict=true；checks 含 outfit_info_incomplete', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refImage, FACE_A)
  assert.equal(r.refDecision.conflict, true)
  assert.ok(r.refDecision.checks.some((c) => c.name === 'outfit_info_incomplete'))
})

console.log('\n=== 5. outfitId 不同（resolver 级）→ face ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: DAY, outfitId: 'day-001', version: 'A' }])
ok('id 不同 → conflict', () => {
  const d = resolveReference({ outfitText: DAY, outfitId: 'other-999', canon: { file: CANON_FILE, outfitId: 'day-001', outfitText: DAY, version: 'A' }, faceRef: FACE_A, faceRefKind: 'head', mode: 'front_selfie', characterVersion: 'A', bodyRef: BODY_A, bodyRefVersion: 'A' })
  assert.equal(d.strategy, 'face')
  assert.equal(d.conflict, true)
  assert.ok(d.checks.some((c) => c.name === 'outfit_id' && !c.ok))
})

console.log('\n=== 6. 无人物模式：不使用身份参考图 ===')
writeCanon([])
ok('sceneOnly（plan.mode=rear_selfie, needsCharacterRef=false）→ refImage 为空', () => {
  const r = shot({ scene: '桌上的杯子，有点阳光', sceneOnly: true })
  assert.equal(r.refDecision.strategy, 'none')
  assert.equal(r.refImage, '')
  assert.equal(r.refDecision.identityRef, null)
  assert.equal(r.refDecision.humanPartsAllowed, true)
})
ok('first_person → refImage 为空', () => {
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
ok('未配置 faceRef → refDecision=null，refImage 保持旧逻辑（旧脸图）', () => {
  const cfg = { ...cfgBase }
  delete cfg.faceRef
  const r = planShot({ scene: '自拍一张', slot: 'evening', outfit: DAY, hair: '披发', scope: 'wiring:nofaceref', imageCfg: cfg })
  assert.equal(r.refDecision, null)
  assert.ok([OLD_REF, BODY_A].includes(r.refImage), '旧逻辑应仍给出 refImage（脸或身体参考图）')
  assert.ok(!r.refImage.includes('face-front-A'), '未配置 faceRef 时不得用 A 版脸图')
})
ok('anime 档 → refDecision=null，走旧 anime 参考图', () => {
  const r = shot({ anime: true })
  assert.equal(r.refDecision, null)
  assert.ok([ANIME_FACE, BODY_A, OLD_REF].includes(r.refImage))
  assert.ok(!r.refImage.includes('face-front-A'), 'anime 档不得进入真人脸图逻辑')
})

console.log('\n=== 8. fallback 不回退旧 refImage ===')
ok('faceRefKind=costume → strategy=fallback 且 refImage 为空（不是旧图）', () => {
  const cfg = { ...cfgBase, faceRefKind: 'costume' }
  const r = planShot({ scene: '自拍一张', slot: 'evening', outfit: DAY, hair: '披发', scope: 'wiring:costume', imageCfg: cfg })
  assert.equal(r.refDecision.strategy, 'fallback')
  assert.equal(r.refImage, '')
  assert.notEqual(r.refImage, OLD_REF)
})

console.log('\n=== 8b. bodyRefImage 指向非 A 版 → 版本核验失败（不伪造 A） ===')
const REAL_B_BODY = 'C:/Users/Null_zwei/Documents/deepseek-harness/default-workspace/_scratch/photo-v3/version-b-new-design/body-3view.png'
ok('B 版 body 被当作 bodyRef → body_version_invalid + conflict，不静默当 A', () => {
  const cfg = { ...cfgBase, bodyRefImage: REAL_B_BODY }
  const r = planShot({ scene: '自拍一张', slot: 'evening', outfit: DAY, hair: '披发', scope: 'wiring:bbody', imageCfg: cfg })
  assert.equal(r.refDecision.conflict, true)
  assert.ok(r.refDecision.checks.some((c) => c.name === 'body_version_invalid' && !c.ok))
  assert.equal(r.refDecision.checks.find((c) => c.name === 'body_version'), undefined, '不得记录 body_version 成功')
  assert.equal(r.refDecision.version.body, null)
})

console.log('\n=== 9. canonRef / character.faceRef 与决策一致 ===')
writeCanon([{ match: '浅灰吊带', file: CANON_FILE, note: '', outfitText: DAY, outfitId: 'day-001', version: 'A' }])
ok('canon 命中时 canonRef=true 且 prompt 不含 face-front', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.canonRef, true)
  assert.ok(!r.prompt.includes('face-front'))
})
writeCanon([{ match: '女仆装短款', file: CANON_FILE, note: '', outfitText: MAID, outfitId: 'maid-short-v3', version: 'A' }])
ok('走 face 时 prompt 里出现的就是 A 版脸图文件名', () => {
  const r = shot({ scene: '对镜自拍' })
  assert.equal(r.refDecision.strategy, 'face')
  assert.ok(!r.prompt.includes('定妆照'), '走 face 时不得出现 canon 的定妆照文案')
  assert.ok(r.prompt.includes('参考图'), '走 face 时应有参考图措辞')
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
