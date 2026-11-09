/**
 * reference-manager 回归（P1-1）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveReference, sameOutfit, REFERENCE_STRATEGIES } from '../src/photo/reference-manager.js'

let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const DAY = '蓝色小发夹，浅灰吊带背心 + 米色棉质家居短裤（光腿），白棉袜，木色拖鞋'
const MAID = '白色蕾丝头带，女仆装短款（藏青渐变连身裙、三层白蕾丝裙摆），白棉袜，玛丽珍鞋'
const FACE_HEAD = 'refs/face-head-only.png'
const FACE_COSTUME = 'refs/head-video-ahoge.png'

console.log('=== 1. 同一套 / 不同套 判定 ===')
ok('吊带短裤 vs 女仆装 → 不同套', () => {
  assert.equal(sameOutfit(DAY, MAID), false)
})
ok('同一描述微调（加前缀）→ 同套', () => {
  assert.equal(sameOutfit(DAY, '浅灰吊带背心 + 米色家居短裤'), true)
})

console.log('\n=== 2. 核心规则 ===')
ok('规则1：第一人称/后置拍物/纯场景 → 不用人物参考图', () => {
  for (const mode of ['first_person', 'rear_object', 'scene_only']) {
    const r = resolveReference({ outfitText: DAY, canon: null, faceRef: FACE_HEAD, faceRefKind: 'head', mode })
    assert.equal(r.strategy, 'none')
    assert.equal(r.refImage, null)
  }
})
ok('规则2：日程服装与 canon 一致 → 用 canon', () => {
  const canon = { match: '女仆装短款', label: MAID, file: 'canon/maid-short.png' }
  const r = resolveReference({ outfitText: MAID, canon, faceRef: FACE_HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  assert.equal(r.strategy, 'canon')
  assert.equal(r.refImage, 'canon/maid-short.png')
  assert.equal(r.conflict, false)
})
ok('规则3：canon 与日程不一致 → 绝不用 canon，改用只锁脸的图', () => {
  const canon = { match: '女仆装短款', label: MAID, file: 'canon/maid-short.png' }
  const r = resolveReference({ outfitText: DAY, canon, faceRef: FACE_HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  assert.equal(r.strategy, 'face')
  assert.equal(r.refImage, FACE_HEAD)
  assert.equal(r.conflict, true, '不一致必须标记 conflict')
})
ok('规则4：没有只锁脸的图（或参考图自带服装）→ 不用参考图，走兜底', () => {
  const r1 = resolveReference({ outfitText: DAY, canon: null, faceRef: '', faceRefKind: 'unknown', mode: 'front_selfie' })
  assert.equal(r1.strategy, 'fallback')
  assert.equal(r1.refImage, null)
  const r2 = resolveReference({ outfitText: DAY, canon: null, faceRef: FACE_COSTUME, faceRefKind: 'costume', mode: 'front_selfie' })
  assert.equal(r2.strategy, 'fallback')
  assert.equal(r2.refImage, null)
  assert.equal(r2.reason, 'face_ref_carries_costume')
})

console.log('\n=== 3. 现实场景（当前配置的真实情况） ===')
ok('当前脸参考图是 costume 型 → 日程吊带时不应使用它', () => {
  const canon = { match: '女仆装短款', label: MAID, file: 'canon/maid-short.png' }
  const r = resolveReference({ outfitText: DAY, canon: null, faceRef: FACE_COSTUME, faceRefKind: 'costume', mode: 'front_selfie' })
  assert.equal(r.refImage, null, 'costume 参考图必须被拒（否则女仆装/棕瞳会串进来）')
})
ok('镜拍且日程与 canon 一致 → canon；不一致 → 冲突标记', () => {
  const canonMiss = { match: '女仆装短款', label: MAID, file: 'canon/maid-short.png' }
  assert.equal(resolveReference({ outfitText: MAID, canon: canonMiss, faceRef: FACE_HEAD, faceRefKind: 'head', mode: 'mirror_selfie' }).strategy, 'canon')
  const r = resolveReference({ outfitText: DAY, canon: canonMiss, faceRef: FACE_HEAD, faceRefKind: 'head', mode: 'mirror_selfie' })
  assert.equal(r.strategy, 'face')
  assert.equal(r.conflict, true)
})

console.log('\n=== 4. 契约 ===')
ok('策略取值合法', () => {
  const r = resolveReference({ outfitText: DAY, canon: null, faceRef: FACE_HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  for (const k of ['strategy', 'refImage', 'reason', 'conflict']) assert.ok(k in r)
  assert.ok(REFERENCE_STRATEGIES.includes(r.strategy))
})
ok('无 undefined', () => {
  const walk = (v, p) => { if (v === undefined) throw new Error('undefined at ' + p); if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p + '.' + k) }
  walk(resolveReference({ outfitText: DAY, canon: null, faceRef: '', faceRefKind: 'unknown', mode: 'front_selfie' }), 'r')
})
ok('未接入正式入口：本模块不 import photo-prompt / bridge / index', () => {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.ok(!/from '\.\/(photo-prompt|index)\.js'/.test(self))
  assert.ok(!/from '\.\.\/qq\/bridge\.js'/.test(self))
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
