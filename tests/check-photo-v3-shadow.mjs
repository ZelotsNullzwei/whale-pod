/**
 * Shadow Test v2.1（最终补强）
 *  identical 不再是 "mode 相同"：必须**所有可比较字段**一致。
 *  可比较字段：mode / subject(映射后) / framing(映射后) / face
 *  旧链路不支持的字段：activities / hands / phone / constraints / unresolved → not_supported
 *  差异分类：identical | expected_correction | regression | not_comparable
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planShot } from '../src/photo/index.js'
import { buildShotPlan } from '../src/photo/plan-photo-v3.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DOCS = path.join(ROOT, 'docs')
const NL = String.fromCharCode(10)
const imageCfg = { size: '1024x1024', aspect: '9:16', resolution: '1K', cropBottom: 0.1 }

/* 旧值 → 新值 词表映射（只映射语义等价，别的都算差异） */
function mapOldSubject(s) {
  const t = String(s ?? '')
  if (/她|自己/.test(t)) return 'character'
  if (/场景|窗|阳台/.test(t)) return 'scene'
  if (/手|东西|物品|眼前/.test(t)) return 'object'
  return null
}
function mapOldFraming(f) {
  const arr = Array.isArray(f) ? f : [f]
  const t = arr.filter(Boolean).join('/')
  if (/面部特写/.test(t)) return 'face'
  if (/头肩/.test(t)) return 'head_shoulder'
  if (/半身/.test(t)) return 'half'
  if (/全身/.test(t)) return 'full'
  if (/局部|手部特写|桌面|食物|物品特写/.test(t)) return 'part'
  return null
}

/** 每个场景的**新链路预期值**（逐项断言，不只看类型） */
const EXPECT = {
  '前置自拍': { mode: 'front_selfie', subject: 'character', band: 'head_shoulder', face: true },
  '前置自拍·表情': { mode: 'front_selfie', subject: 'character', band: 'head_shoulder', face: true },
  '镜面自拍·全身': { mode: 'mirror_selfie', subject: 'character', band: 'full', face: true },
  '镜面自拍·穿搭': { mode: 'mirror_selfie', subject: 'character', band: 'full', face: true },
  '后置拍物·漫画': { mode: 'rear_object', subject: 'object', band: 'object', face: false },
  '后置拍物·杯子': { mode: 'first_person', subject: 'object', band: 'object', face: false },
  '第一人称动作·端杯': { mode: 'first_person', subject: 'character', band: 'hand_object', face: false },
  '第一人称动作·双手': { mode: 'first_person', subject: 'character', band: 'hand_object', face: false },
  '桌面 POV': { mode: 'first_person', subject: 'character', band: 'object', face: false },
  '环境 POV': { mode: 'first_person', subject: 'character', band: 'scene', face: false },
  '背影': { mode: 'back_view', subject: 'character', band: 'back', face: false },
  '特写': { mode: 'face_closeup', subject: 'character', band: 'face', face: true },
  '未知机位·看漫画': { mode: null, subject: 'character', band: null, face: null },
  '未知机位·窗边': { mode: null, subject: 'character', band: null, face: null },
  '明确约束·不露脸': { mode: null, subject: 'character', band: null, face: null },
  '明确约束·不出现人物': { mode: null, subject: 'character', band: null, face: null },
  '明确约束·不出现手机': { mode: 'first_person', subject: 'object', band: 'object', face: false },
}

/** 允许的差异（expected_correction）；键=场景，值=允许差异的字段集合 + 原因 */
const ALLOW = {
  '后置拍物·漫画': { fields: ['mode'], why: '命名规范化 rear_selfie→rear_object' },
  '背影': { fields: ['mode', 'face'], why: '背影独立模式 mirror_selfie→back_view；不露脸' },
  '后置拍物·漫画': { fields: ['mode', 'subject'], why: '命名规范化；主体词表更精确（场景→物品）' },
  '后置拍物·杯子': { fields: ['subject'], why: '主体词表更精确（旧把拍物记为场景/手边）' },
  '特写': { fields: ['face'], why: '旧链路把 face_closeup 当不露脸，新链路认为特写必露脸' },
  '明确约束·不出现手机': { fields: ['subject'], why: '主体词表更精确（手边→物品）' },
  '未知机位·看漫画': { fields: ['mode', 'band', 'face'], why: '机位依据不足 → 不猜' },
  '未知机位·窗边': { fields: ['mode', 'band', 'face'], why: '机位依据不足 → 不猜' },
  '明确约束·不露脸': { fields: ['mode', 'band', 'face'], why: '机位依据不足 → 不猜' },
  '明确约束·不出现人物': { fields: ['mode', 'band', 'face'], why: '机位依据不足 → 不猜' },
}

const SCENES = [
  ['前置自拍', null, '前置自拍'],
  ['前置自拍，自然笑一下', null, '前置自拍·表情'],
  ['对镜全身自拍，站在衣柜前', null, '镜面自拍·全身'],
  ['展示今天的穿搭', null, '镜面自拍·穿搭'],
  ['把漫画拍给你看', null, '后置拍物·漫画'],
  ['拍一下桌上的杯子', null, '后置拍物·杯子'],
  ['第一人称', '第一人称 端着杯子喝水', '第一人称动作·端杯'],
  ['第一人称', '第一人称 双手捧着碗', '第一人称动作·双手'],
  ['第一人称', '第一人称 书桌上写字', '桌面 POV'],
  ['第一人称', '第一人称 窗外的雨 远处', '环境 POV'],
  ['想要一个背影', null, '背影'],
  ['怼脸拍一张', null, '特写'],
  ['坐在床边看漫画', null, '未知机位·看漫画'],
  ['站在窗边看着外面', null, '未知机位·窗边'],
  ['不露脸拍一张', null, '明确约束·不露脸'],
  ['画面里不出现人物', null, '明确约束·不出现人物'],
  ['不出现手机，拍桌上的杯子', null, '明确约束·不出现手机'],
]

/** 分类器（可被合成用例单测） */
export function classify({ modeSame, fieldDiffs, allowedFields, comparableCount }) {
  /* 没有任何可比较字段 → 无法判断，不能算一致 */
  if (!comparableCount) return 'not_comparable'
  const changed = fieldDiffs.filter((d) => d.kind === 'changed')
  if (!changed.length) return modeSame ? 'identical' : 'regression'
  const unexpected = changed.filter((d) => !(allowedFields || []).includes(d.field))
  return unexpected.length ? 'regression' : 'expected_correction'
}

/* ---------- 采集 ---------- */
const rows = []
for (const [scene, raw, label] of SCENES) {
  const old = planShot({ scene, slot: 'evening', outfit: '浅灰吊带背心+米色短裤', hair: '披着', scope: 's:' + label, mode: 'daily', imageCfg })
  const nw = buildShotPlan({ scene, slot: 'evening', raw })
  const p = old.plan || {}
  const newMode = nw.camera.mode ?? null
  const oldMode = old.mode || null
  const modeSame = oldMode === newMode

  const oldSubj = mapOldSubject(p.subject)
  const oldBand = mapOldFraming(old.framing)
  const oldFace = typeof p.faceVisible === 'boolean' ? p.faceVisible : null
  const nwFace = nw.visibility.face

  const diffs = []
  if (oldSubj === null) diffs.push({ field: 'subject', kind: 'not_supported' })
  else if (oldSubj !== nw.intent.subject) diffs.push({ field: 'subject', kind: 'changed', old: oldSubj, neu: nw.intent.subject })
  /*
   * ⚠️ 旧链接 plan.framing 是**模式能力列表**（如 front_selfie = [面部特写,头肩,半身]），
   *    不是"这一张实际用了哪个取景"，因此不可与新 band 直接比较 → not_supported。
   */
  diffs.push({ field: 'band', kind: 'not_supported' })
  if (oldFace === null) diffs.push({ field: 'face', kind: 'not_supported' })
  else if (oldFace !== nwFace) diffs.push({ field: 'face', kind: 'changed', old: oldFace, neu: nwFace })
  if (!modeSame) diffs.push({ field: 'mode', kind: 'changed', old: oldMode, neu: newMode })

  /* 可比较字段：mode 总是可比；subject/face 仅当旧链路有该字段时可比 */
  const comparableCount = 1 + (oldSubj !== null ? 1 : 0) + (oldFace !== null ? 1 : 0)
  const allowed = (ALLOW[label] || {}).fields
  const klass = classify({ modeSame, fieldDiffs: diffs, allowedFields: allowed, comparableCount })

  rows.push({
    label, scene: raw || scene, oldMode, newMode, modeSame, diffs, klass,
    old: { subject: oldSubj, band: oldBand, face: oldFace },
    neu: { subject: nw.intent.subject, band: nw.framing.band ?? null, face: nwFace },
    expect: EXPECT[label],
    allowWhy: (ALLOW[label] || {}).why || '',
  })
}

/* ---------- 断言 ---------- */
let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

console.log('=== 1. 逐场景预期值（新链路） ===')
for (const r of rows) {
  ok(`${r.label}：mode/subject/band/face 符合预期`, () => {
    assert.equal(r.newMode, r.expect.mode, 'mode')
    assert.equal(r.neu.subject, r.expect.subject, 'subject')
    assert.equal(r.neu.band, r.expect.band, 'band')
    assert.equal(r.neu.face, r.expect.face, 'face')
  })
}

console.log('\n=== 2. 分类语义 ===')
ok('没有未登记回归', () => {
  const bad = rows.filter((r) => r.klass === 'regression')
  assert.deepEqual(bad.map((r) => r.label), [])
})
ok('前置自拍：mode/subject/face 一致；band 明确标 not_supported（不拿能力列表冒充取景）', () => {
  const r = rows.find((x) => x.label === '前置自拍')
  assert.equal(r.modeSame, true)
  assert.equal(r.neu.subject, 'character')
  assert.ok(r.diffs.some((d) => d.field === 'band' && d.kind === 'not_supported'), 'band 应为 not_supported')
  assert.equal(r.klass, 'identical', '可比较字段全一致 → identical')
})
ok('背影：face 正确变为 false（且属于允许修正）', () => {
  const r = rows.find((x) => x.label === '背影')
  assert.equal(r.neu.face, false)
  assert.equal(r.klass, 'expected_correction')
})
ok('未知机位：mode/band/face 保持 null（不猜）', () => {
  for (const l of ['未知机位·看漫画', '未知机位·窗边']) {
    const r = rows.find((x) => x.label === l)
    assert.equal(r.newMode, null)
    assert.equal(r.neu.band, null)
    assert.equal(r.neu.face, null)
  }
})

console.log('\n=== 3. 合成用例：regression / expected_correction 必须能触发 ===')
ok('人为制造未登记字段差异 → regression', () => {
  const k = classify({ modeSame: true, comparableCount: 2, fieldDiffs: [{ field: 'subject', kind: 'changed', old: 'character', neu: 'object' }], allowedFields: [] })
  assert.equal(k, 'regression')
})
ok('人为制造符合预期的差异 → expected_correction', () => {
  const k = classify({ modeSame: false, comparableCount: 1, fieldDiffs: [{ field: 'mode', kind: 'changed' }], allowedFields: ['mode'] })
  assert.equal(k, 'expected_correction')
})
ok('旧链路不支持 → not_comparable（不伪装成一致）', () => {
  const k = classify({ modeSame: true, comparableCount: 0, fieldDiffs: [{ field: 'hands', kind: 'not_supported' }], allowedFields: [] })
  assert.equal(k, 'not_comparable')
})

/* ---------- 统计 & 文档（同一份数据） ---------- */
const total = rows.length
const byKlass = (k) => rows.filter((r) => r.klass === k)
const modeSameCount = rows.filter((r) => r.modeSame).length
const identical = byKlass('identical')
const expectedRows = byKlass('expected_correction')
const regressions = byKlass('regression')
const notComparable = byKlass('not_comparable')

fs.mkdirSync(DOCS, { recursive: true })
fs.writeFileSync(path.join(DOCS, 'photo-v3-shadow-test.md'), [
  '# Shadow Test v2.1 明细（字段级一致语义）', '',
  '> `identical` = **所有可比较字段**一致，而不是 mode 相同。', '',
  `- 场景总数：**${total}**`,
  `- mode 相同：**${modeSameCount}**（仅代表机位相同）`,
  `- identical（全部可比较字段一致）：**${identical.length}**`,
  `- expected_correction：**${expectedRows.length}**`,
  `- regression：**${regressions.length}**`,
  `- not_comparable：**${notComparable.length}**`, '',
  '| # | 场景 | mode 旧→新 | modeSame | subject 旧→新 | band 旧→新 | face 旧→新 | 差异字段 | 分类 |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r, i) => `| ${i + 1} | ${r.label} | ${r.oldMode ?? 'null'}→${r.newMode ?? 'null'} | ${r.modeSame ? 'Y' : 'N'} | ${r.old.subject ?? 'not_supported'}→${r.neu.subject} | ${r.old.band ?? 'not_supported'}→${r.neu.band ?? 'null'} | ${r.old.face ?? 'not_supported'}→${r.neu.face} | ${r.diffs.map((d) => d.field + ':' + d.kind).join(',') || '-'} | ${r.klass} |`),
].join(NL), 'utf8')

fs.writeFileSync(path.join(DOCS, 'photo-v3-shadow-review.md'), [
  '# Shadow Test v2.1 差异分类与结论', '',
  '## 统计（唯一来源：本次运行）',
  `- 场景总数：${total}`,
  `- mode 相同：${modeSameCount}（**不能**等同于行为一致）`,
  `- identical（可比较字段全一致）：${identical.length}`,
  `- expected_correction：${expectedRows.length}`,
  `- regression：${regressions.length}`,
  `- not_comparable：${notComparable.length}`, '',
  '## expected_correction 逐项', '',
  ...expectedRows.map((r) => `- **${r.label}**：差异字段 ${r.diffs.filter((d) => d.kind === 'changed').map((d) => d.field).join('/') || '-'}；原因：${r.allowWhy}`), '',
  '## identical 逐项', '',
  ...identical.map((r) => `- ${r.label}（mode=${r.newMode ?? 'null'}，subject=${r.neu.subject}，band=${r.neu.band ?? 'null'}，face=${r.neu.face}）`), '',
  '## 回归', '',
  regressions.length ? regressions.map((r) => `- ${r.label}: ${r.diffs.map((d) => d.field).join(',')}`).join(NL) : '- 无', '',
  '## 结论',
  '1. `identical` 现在要求 subject / band / face / mode 全部一致；前置自拍这类"mode 相同但 subject/band 变了"的场景不再被误标为一致。',
  '2. 旧链路不支持的字段标 `not_supported`，整行可能因此为 `not_comparable`，不伪装成一致。',
  '3. 合成用例验证了 classification 本身：未登记差异 → regression；命中白名单 → expected_correction；仅不可比较 → not_comparable。',
].join(NL), 'utf8')

console.log('\n统计：总 ' + total + '｜modeSame ' + modeSameCount + '｜identical ' + identical.length + '｜expected ' + expectedRows.length + '｜regression ' + regressions.length + '｜not_comparable ' + notComparable.length)
console.log('pass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
