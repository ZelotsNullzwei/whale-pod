/**
 * reference-manager 回归（P1-1b 复核修正版）
 * 每项都断言 strategy / reason / conflict；涉及版本时同时断言 checks。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveReference, sameOutfitText, parseVersion, normalizeVersion, REFERENCE_STRATEGIES } from '../src/photo/reference-manager.js'

let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}
const has = (r, name) => r.checks.some((c) => c.name === name)

const DAY = '蓝色小发夹，浅灰吊带背心 + 米色棉质家居短裤（光腿），白棉袜，木色拖鞋'
const MAID = '白色蕾丝头带，女仆装短款（藏青渐变连身裙、两层白蕾丝裙摆），白色蕾丝围裙，白棉袜，藏青玛丽珍鞋'
const HEAD = 'refs/version-a/face-front.png'
const COSTUME = 'refs/head-video-ahoge.png'
const canonA = (x = {}) => ({ match: '女仆装短款', file: 'canon/maid-short.png', outfitId: 'maid-short-v3', outfitText: MAID, version: 'A', ...x })

console.log('=== A. 版本校验不得被 NO_PERSON 绕过（本轮重点） ===')
ok('first_person + A角色 + B身体参考图 → conflict，并记 body_version_mismatch', () => {
  const r = resolveReference({
    mode: 'first_person', characterVersion: 'A',
    bodyRef: 'refs/version-b/body-3view.png', bodyRefVersion: 'B',
  })
  assert.equal(r.strategy, 'none')
  assert.equal(r.identityRef, null)
  assert.equal(r.humanPartsAllowed, true)
  assert.equal(r.conflict, true, '不能返回 conflict:false')
  assert.ok(has(r, 'body_version_mismatch'), '必须记录 body_version_mismatch')
  assert.equal(r.reason, 'no_person_with_version_conflict')
})
ok('scene_only + 跨版本 bodyRef → conflict', () => {
  const r = resolveReference({ mode: 'scene_only', characterVersion: 'B', bodyRef: 'x.png', bodyRefVersion: 'A' })
  assert.equal(r.strategy, 'none')
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'body_version_mismatch'))
})
ok('rear_object + 跨版本 bodyRef → conflict', () => {
  const r = resolveReference({ mode: 'rear_object', characterVersion: 'A', bodyRef: 'x.png', bodyRefVersion: 'B' })
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'body_version_mismatch'))
})
ok('first_person 无跨版本 → 不冲突，仅 none', () => {
  const r = resolveReference({ mode: 'first_person', characterVersion: 'A', bodyRef: 'a.png', bodyRefVersion: 'A' })
  assert.equal(r.strategy, 'none')
  assert.equal(r.conflict, false)
  assert.equal(r.reason, 'mode_has_no_person')
})

console.log('\n=== B. 非法版本值 ===')
ok('characterVersion="C" → 明确冲突，不静默当 A', () => {
  const r = resolveReference({ mode: 'front_selfie', characterVersion: 'C', outfitText: MAID, outfitId: 'maid-short-v3', canon: canonA() })
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'character_version'))
  assert.equal(r.checks.find((c) => c.name === 'character_version').ok, false)
  assert.equal(r.version.valid, false)
  assert.equal(r.version.current, null)
})
ok('parseVersion 语义：未声明/显式A/显式B/非法', () => {
  assert.deepEqual(parseVersion(''), { value: 'A', assumed: true, valid: true })
  assert.deepEqual(parseVersion('A'), { value: 'A', assumed: false, valid: true })
  assert.deepEqual(parseVersion('b'), { value: 'B', assumed: false, valid: true })
  assert.deepEqual(parseVersion('C'), { value: null, assumed: false, valid: false })
  assert.equal(normalizeVersion(''), 'A')
})

console.log('\n=== C. 服装文本比较（不再用类别词数量） ===')
ok('不同颜色/款式但都是吊带短裤 → 不同套', () => {
  assert.equal(sameOutfitText(
    '浅灰吊带背心 + 米色棉质家居短裤，白棉袜',
    '黑色细带吊带 + 牛仔短裤，黑色马丁靴',
  ), false)
})
ok('完全相同描述（仅两个主体词）→ 同套（不得无故判冲突）', () => {
  assert.equal(sameOutfitText('浅灰吊带短裤', '浅灰吊带短裤'), true)
})
ok('规范化后一致（空白/标点/星号差异）→ 同套', () => {
  assert.equal(sameOutfitText('浅灰吊带背心+米色短裤，白棉袜', '浅灰吊带背心 + 米色短裤  白棉袜'), true)
})
ok('类别相同但内容不同 → 不得判同套', () => {
  assert.equal(sameOutfitText('白色蕾丝连衣裙', '白色蕾丝女仆装短裙'), false)
})
ok('一侧过短 → 保守判不同套', () => {
  assert.equal(sameOutfitText('吊带短裤', MAID), false)
})

console.log('\n=== D. 正则不得参与比较 / ID 优先 ===')
ok('正则命中女仆装、日程灰吊带 → conflict，不用 canon', () => {
  const r = resolveReference({ mode: 'front_selfie', outfitText: DAY, outfitId: 'day-tank', canon: canonA(), faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.strategy, 'face')
  assert.equal(r.conflict, true)
  assert.match(r.reason, /outfit_conflict/)
  assert.ok(has(r, 'outfit_id'))
  assert.equal(r.checks.find((c) => c.name === 'outfit_id').ok, false)
})
ok('outfitId 相同 → canon（且不回退文本）', () => {
  const r = resolveReference({ mode: 'front_selfie', outfitText: '完全不相关的描述', outfitId: 'maid-short-v3', canon: canonA(), faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.strategy, 'canon')
  assert.equal(r.conflict, false)
  assert.equal(r.reason, 'outfit_matches_canon')
})
ok('outfitId 不同 → conflict', () => {
  const r = resolveReference({ mode: 'front_selfie', outfitText: MAID, outfitId: 'other', canon: canonA(), faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'outfit_id'))
})
ok('无 ID、文本一致 → canon', () => {
  const r = resolveReference({ mode: 'front_selfie', outfitText: MAID, canon: canonA({ outfitId: undefined }), faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.strategy, 'canon')
  assert.equal(r.conflict, false)
  assert.ok(has(r, 'outfit_text'))
})
ok('信息不完整（无 ID 无文本）→ conflict', () => {
  const r = resolveReference({ mode: 'front_selfie', outfitText: MAID, canon: canonA({ outfitId: undefined, outfitText: undefined }), faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'outfit_info_incomplete'))
})

console.log('\n=== E. canon 版本隔离 ===')
ok('canon 版本 A、当前 B → conflict 且不用 canon', () => {
  const r = resolveReference({ mode: 'front_selfie', characterVersion: 'B', outfitText: MAID, outfitId: 'maid-short-v3', canon: canonA(), faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'canon_version_mismatch'))
  assert.notEqual(r.strategy, 'canon')
  assert.match(r.reason, /version_conflict/)
})

console.log('\n=== E2. canon 版本诊断三态 ===')
ok('characterVersion=C + canon.version=A → canon_version_unchecked，且无成功项', () => {
  const r = resolveReference({ mode: 'front_selfie', characterVersion: 'C', canon: canonA(), faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'canon_version_unchecked'), '应记 canon_version_unchecked')
  assert.equal(r.checks.find((c) => c.name === 'canon_version'), undefined, '不得同时记成功')
})
ok('characterVersion=A + canon 未声明 → 记录按 A 推定，且无矛盾的成功项', () => {
  const c = canonA({ version: undefined, outfitId: 'maid-short-v3' })
  const r = resolveReference({ mode: 'front_selfie', characterVersion: 'A', outfitText: MAID, outfitId: 'maid-short-v3', canon: c, faceRef: HEAD, faceRefKind: 'head' })
  assert.ok(has(r, 'canon_version_missing'), '应记 canon_version_missing')
  assert.equal(r.checks.find((x) => x.name === 'canon_version'), undefined, '未声明时不得记成功')
  assert.equal(r.conflict, false, "A 一致，不应冲突")
  assert.equal(r.strategy, 'canon')
})
ok('canon 未声明 + 当前 B → canon_version_mismatch', () => {
  const c = canonA({ version: undefined, outfitId: 'maid-short-v3' })
  const r = resolveReference({ mode: 'front_selfie', characterVersion: 'B', outfitText: MAID, outfitId: 'maid-short-v3', canon: c, faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'canon_version_mismatch'))
})

console.log('\n=== F. 双重身份参考图 ===')
ok('faceRef 与 bodyRef 同一张 → 强制 fallback，绝不返回该图', () => {
  const same = 'refs/x.png'
  const r = resolveReference({ mode: 'front_selfie', characterVersion: 'A', faceRef: same, faceRefKind: 'head', bodyRef: same, bodyRefVersion: 'A' })
  assert.equal(r.strategy, 'fallback', '不能走 face fallback')
  assert.equal(r.refImage, null)
  assert.equal(r.identityRef, null)
  assert.equal(r.conflict, true)
  assert.equal(r.reason, 'dual_identity_reference_rejected')
  assert.ok(has(r, 'dual_identity_reference'))
})

console.log('\n=== F2. 版本诊断不得伪造 ===')
ok('characterVersion 非法 → body_version_unchecked（不记成功）', () => {
  const r = resolveReference({ mode: 'front_selfie', characterVersion: 'C', bodyRef: 'b.png', bodyRefVersion: 'A', faceRef: 'f.png', faceRefKind: 'head' })
  assert.equal(r.conflict, true)
  assert.ok(has(r, 'body_version_unchecked'))
  assert.equal(r.checks.find((c) => c.name === 'body_version'), undefined, '不得出现成功的 body_version')
})

console.log('\n=== G. first_person 语义 & faceRefKind ===')
ok('first_person：identityRef=null、humanPartsAllowed=true、reason=mode_has_no_person', () => {
  const r = resolveReference({ mode: 'first_person' })
  assert.equal(r.strategy, 'none')
  assert.equal(r.identityRef, null)
  assert.equal(r.humanPartsAllowed, true)
  assert.equal(r.reason, 'mode_has_no_person')
  assert.equal(r.conflict, false)
})
for (const [kind, expect, reasonRe] of [['costume', 'fallback', /carries_costume|no_usable/], ['unknown', 'fallback', /no_usable/], ['head', 'face', /no_canon/]]) {
  ok(`faceRefKind=${kind} → ${expect}`, () => {
    const r = resolveReference({ mode: 'front_selfie', outfitText: DAY, canon: null, faceRef: COSTUME, faceRefKind: kind })
    assert.equal(r.strategy, expect)
    assert.match(r.reason, reasonRe)
    assert.equal(r.conflict, false)
  })
}

console.log('\n=== H. 契约 ===')
ok('字段齐全、无 undefined、策略合法', () => {
  const walk = (v, p) => { if (v === undefined) throw new Error('undefined at ' + p); if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p + '.' + k) }
  const r = resolveReference({ mode: 'front_selfie', outfitText: DAY })
  for (const k of ['strategy', 'refImage', 'identityRef', 'humanPartsAllowed', 'reason', 'conflict', 'version', 'checks']) assert.ok(k in r, '缺 ' + k)
  assert.ok(REFERENCE_STRATEGIES.includes(r.strategy))
  walk(r, 'r')
})
ok('未接入正式入口（不 import photo-prompt/index/bridge）', () => {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
  assert.ok(!/from '\.\.\/src\/(photo-prompt|index)\.js'/.test(self))
})

console.log('\n=== I. 同一张 faceRef 只能当身份参考 ===')
ok('重复调用不会把 faceRef 用作 canon', () => {
  const r = resolveReference({ mode: 'front_selfie', outfitText: DAY, canon: null, faceRef: HEAD, faceRefKind: 'head' })
  assert.equal(r.strategy, 'face')
  assert.equal(r.refImage, HEAD)
})

console.log(`\npass ${pass} / fail ${fail}`)
process.exit(fail === 0 ? 0 : 1)
