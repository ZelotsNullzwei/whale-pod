/**
 * reference-manager 回归（P1-1b 第 1~3 步）
 * 覆盖评审列出的 14 个场景；每项都断言 strategy / reason / conflict（不只看 strategy）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveReference, sameOutfitText, normalizeVersion, REFERENCE_STRATEGIES } from '../src/photo/reference-manager.js'

let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

const DAY = '蓝色小发夹，浅灰吊带背心 + 米色棉质家居短裤（光腿），白棉袜，木色拖鞋'
const MAID = '白色蕾丝头带，女仆装短款（藏青渐变连身裙、两层白蕾丝裙摆），白色蕾丝围裙，白棉袜，藏青玛丽珍鞋'
const HEAD = 'refs/version-a/face-front.png'
const COSTUME = 'refs/head-video-ahoge.png'

const canonA = (extra = {}) => ({
  match: '女仆装短款',
  file: 'canon/maid-short.png',
  outfitId: 'maid-short-v3',
  outfitText: MAID,
  version: 'A',
  ...extra,
})

console.log('=== 1. 正则命中 ≠ 同套（核心修正） ===')
ok('正则 match 命中女仆装、日程是灰吊带 → conflict，且不使用 canon', () => {
  const r = resolveReference({
    outfitText: DAY, outfitId: 'day-tank-shorts',
    canon: canonA(), faceRef: HEAD, faceRefKind: 'head', mode: 'front_selfie',
  })
  assert.equal(r.strategy, 'face')
  assert.equal(r.conflict, true)
  assert.match(r.reason, /outfit_conflict/)
  assert.notEqual(r.refImage, 'canon/maid-short.png')
})
ok('sameOutfitText 不因 "白色/蕾丝" 就判同套', () => {
  assert.equal(sameOutfitText('白色蕾丝连衣裙', '白色蕾丝女仆装短裙'), false)
})

console.log('\n=== 2. outfitId 语义 ===')
ok('outfitId 相同 → canon', () => {
  const r = resolveReference({ outfitText: MAID, outfitId: 'maid-short-v3', canon: canonA(), faceRef: HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  assert.equal(r.strategy, 'canon')
  assert.equal(r.conflict, false)
  assert.equal(r.reason, 'outfit_matches_canon')
})
ok('outfitId 不同 → conflict', () => {
  const r = resolveReference({ outfitText: MAID, outfitId: 'other-id', canon: canonA(), faceRef: HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  assert.equal(r.conflict, true)
  assert.match(r.reason, /outfit_conflict/)
})

console.log('\n=== 3. outfitText 次级比较 ===')
ok('无 ID、完整描述一致 → canon', () => {
  const c = canonA({ outfitId: undefined })
  const r = resolveReference({ outfitText: MAID, canon: c, faceRef: HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  assert.equal(r.strategy, 'canon')
  assert.equal(r.conflict, false)
})
ok('描述不完整（canon 无 outfitText 且无 ID）→ conflict', () => {
  const c = canonA({ outfitId: undefined, outfitText: undefined })
  const r = resolveReference({ outfitText: MAID, canon: c, faceRef: HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  assert.equal(r.conflict, true)
  assert.equal(r.strategy, 'face')
})

console.log('\n=== 4. 版本隔离 ===')
ok('canon 版本 A、当前 B → conflict（version）', () => {
  const r = resolveReference({ outfitText: MAID, outfitId: 'maid-short-v3', canon: canonA(), faceRef: HEAD, faceRefKind: 'head', mode: 'front_selfie', characterVersion: 'B' })
  assert.equal(r.conflict, true)
  assert.match(r.reason, /version_conflict/)
  assert.notEqual(r.strategy, 'canon')
})
ok('当前版本未声明 → 默认 A', () => {
  const r = resolveReference({ outfitText: MAID, outfitId: 'maid-short-v3', canon: canonA(), faceRef: HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  assert.equal(r.version.current, 'A')
  assert.equal(r.version.assumed, true)
  assert.equal(r.strategy, 'canon')
})
ok('B 版未显式指定 → 不会进入 B（normalizeVersion 归一）', () => {
  assert.equal(normalizeVersion(undefined), 'A')
  assert.equal(normalizeVersion(''), 'A')
  assert.equal(normalizeVersion('b'), 'B')
  const r = resolveReference({ outfitText: MAID, outfitId: 'maid-short-v3', canon: canonA(), faceRef: HEAD, faceRefKind: 'head', mode: 'front_selfie' })
  assert.equal(r.version.current, 'A', '未声明时必须按 A')
})
ok('A/B 身体参考图交叉使用 → 拒绝', () => {
  const r = resolveReference({
    outfitText: MAID, outfitId: 'maid-short-v3', canon: canonA(), faceRef: HEAD, faceRefKind: 'head',
    mode: 'front_selfie', characterVersion: 'A',
    bodyRef: 'refs/version-b/body-3view.png', bodyRefVersion: 'B',
  })
  assert.equal(r.conflict, true)
  assert.ok(r.checks.some((c) => c.name === 'body_version_mismatch' && !c.ok))
  assert.notEqual(r.strategy, 'canon')
})

console.log('\n=== 5. first_person 语义（none ≠ 禁止人体局部） ===')
ok('first_person → identityRef=null 且 humanPartsAllowed=true', () => {
  const r = resolveReference({ outfitText: DAY, canon: null, faceRef: COSTUME, faceRefKind: 'costume', mode: 'first_person' })
  assert.equal(r.strategy, 'none')
  assert.equal(r.identityRef, null)
  assert.equal(r.humanPartsAllowed, true)
  assert.equal(r.reason, 'mode_has_no_person')
  assert.equal(r.conflict, false)
})
ok('scene_only / rear_object 同样只禁身份参考图', () => {
  for (const mode of ['scene_only', 'rear_object']) {
    const r = resolveReference({ mode })
    assert.equal(r.strategy, 'none')
    assert.equal(r.humanPartsAllowed, true)
  }
})

console.log('\n=== 6. faceRefKind 判定 ===')
for (const [kind, expect] of [['costume', 'fallback'], ['unknown', 'fallback'], ['head', 'face']]) {
  ok(`faceRefKind=${kind} → ${expect}`, () => {
    const r = resolveReference({ outfitText: DAY, canon: null, faceRef: COSTUME, faceRefKind: kind, mode: 'front_selfie' })
    assert.equal(r.strategy, expect)
  })
}

console.log('\n=== 7. 契约 ===')
ok('字段齐全且策略合法', () => {
  const r = resolveReference({ outfitText: DAY, mode: 'front_selfie' })
  for (const k of ['strategy', 'refImage', 'identityRef', 'humanPartsAllowed', 'reason', 'conflict', 'version', 'checks']) assert.ok(k in r, '缺 ' + k)
  assert.ok(REFERENCE_STRATEGIES.includes(r.strategy))
  assert.ok('current' in r.version && 'canon' in r.version && 'body' in r.version && 'assumed' in r.version)
})
ok('无 undefined', () => {
  const walk = (v, p) => { if (v === undefined) throw new Error('undefined at ' + p); if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p + '.' + k) }
  walk(resolveReference({ outfitText: DAY, mode: 'front_selfie' }), 'r')
})
ok('未接入正式入口（不 import photo-prompt/index/bridge）', () => {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.ok(!/from '\.\.\/src\/(photo-prompt|index)\.js'/.test(self))
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
