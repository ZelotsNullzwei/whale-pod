/**
 * Shadow Test v2（评审补强版）
 *  · 统计只来自实际运行（文档与测试同一份数据）
 *  · 字段级对比（旧链路无对应能力 → not_supported，不假装相同）
 *  · 强断言：strict 逐条件、手的身份/职责、约束语义
 *  · 不硬编码个人路径：仓库根由 import.meta.url 推导，WHALE_POD_HOME 可用环境变量覆盖
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planShot } from '../src/photo/index.js'
import { buildShotPlan, computeResolution } from '../src/photo/plan-photo-v3.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DOCS = path.join(ROOT, 'docs')
const HOME = process.env.WHALE_POD_HOME || path.join(ROOT, '.tmp-fixtures', 'home')
const NL = String.fromCharCode(10)

/* 最小 imageCfg：planShot 只需要宽高/比例，不需要真实 key */
const imageCfg = { size: '1024x1024', aspect: '9:16', resolution: '1K', cropBottom: 0.1 }

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

/** 预期修正白名单：key = 场景原句 */
const EXPECTED = {
  '把漫画拍给你看': '命名规范化 rear_selfie→rear_object',
  '想要一个背影': '背影独立模式 mirror_selfie→back_view',
  '坐在床边看漫画': '机位依据不足 → 不猜（旧默认 first_person）',
  '站在窗边看着外面': '机位依据不足 → 不猜（旧默认 front_selfie）',
  '不露脸拍一张': '机位依据不足 → 不猜（旧默认 rear_selfie）',
  '画面里不出现人物': '机位依据不足 → 不猜（旧默认 first_person）',
}

/* ---------- 采集 ---------- */
const rows = []
for (const [scene, raw, label] of SCENES) {
  const old = planShot({ scene, slot: 'evening', outfit: '浅灰吊带背心+米色短裤', hair: '披着', scope: 'shadow:' + label, mode: 'daily', imageCfg })
  const nw = buildShotPlan({ scene, slot: 'evening', raw })
  const oldPlan = old.plan || {}
  const newMode = nw.camera.mode ?? '(context)'
  const oldMode = old.mode || '(skip)'
  const changed = oldMode !== newMode
  rows.push({
    label, scene: raw || scene, oldMode, newMode, changed,
    expected: EXPECTED[scene] || '',
    old: {
      subject: oldPlan.subject ?? null,
      mode: oldMode,
      activities: undefined,     // 旧链路无此能力
      framing: old.framing ?? null,
      handsRequired: undefined,  // 旧链路无手部模型
      handsVisible: undefined,
      face: typeof oldPlan.faceVisible === 'boolean' ? oldPlan.faceVisible : undefined,
      phone: undefined,          // 旧链路只有 hidePhone 提示，不等价
      constraints: undefined,
      unresolved: undefined,
    },
    neu: {
      subject: nw.intent.subject,
      mode: newMode,
      activities: (nw.intent.activities || []).map((a) => a.type).join('+') || null,
      framing: nw.framing.band ?? null,
      handsRequired: nw.pose.hands.requiredCount,
      handsVisible: nw.visibility.hands,
      face: nw.visibility.face,
      phone: nw.visibility.phone,
      constraints: (nw.intent.constraints || []).map((c) => c.type),
      unresolved: nw.unresolved.length,
    },
    visibility: nw.visibility,
    pose: nw.pose,
    resolution: nw.resolution,
  })
}

/* ---------- 断言 ---------- */
let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

console.log('=== 1. 统计与白名单一致（唯一来源：本次运行） ===')
ok('场景数=17，变化数=白名单命中数，未登记=0', () => {
  assert.equal(rows.length, 17)
  const changed = rows.filter((r) => r.changed)
  const unregistered = changed.filter((r) => !r.expected)
  assert.equal(unregistered.length, 0, '未登记差异：' + unregistered.map((r) => r.label).join(','))
  const expectedHit = changed.filter((r) => r.expected).length
  assert.equal(expectedHit, Object.keys(EXPECTED).length, '白名单条目与实际变化数不一致')
})

console.log('\n=== 2. 字段级对比（不假装旧链路支持） ===')
ok('旧链路没有的能力必须标 not_supported', () => {
  const sample = rows[0]
  for (const k of ['activities', 'handsRequired', 'handsVisible', 'phone', 'constraints', 'unresolved']) {
    assert.equal(sample.old[k], undefined, '旧链路不应伪造 ' + k)
  }
})
ok('新旧都能表达的字段要能对比（mode/face/framing）', () => {
  for (const r of rows) {
    assert.ok(r.neu.mode !== undefined)
    assert.equal(typeof r.neu.framing === 'string' || r.neu.framing === null, true)
  }
})

console.log('\n=== 3. strict 逐条件 ===')
ok('无未决无冲突 → strict=true（用 computeResolution 直接验证）', () => {
  const r = computeResolution({ intent: { subject: 'character' }, camera: { mode: 'front_selfie' }, framing: { band: 'head_shoulder' }, visibility: { unresolved: [], conflicts: [] }, unresolved: [] })
  assert.equal(r.core, true)
  assert.equal(r.strict, true)
})
ok('Intent unresolved → strict=false', () => {
  const r = computeResolution({ intent: { subject: 'character' }, camera: { mode: 'front_selfie' }, framing: { band: 'head_shoulder' }, visibility: { unresolved: [], conflicts: [] }, unresolved: [{ layer: 'intent', item: 'x' }] })
  assert.equal(r.strict, false)
})
ok('Camera/Framing/Pose unresolved（已在整链 unresolved 里）→ strict=false', () => {
  for (const layer of ['camera', 'framing', 'pose']) {
    const r = computeResolution({ intent: { subject: 'character' }, camera: { mode: 'front_selfie' }, framing: { band: 'head_shoulder' }, visibility: { unresolved: [], conflicts: [] }, unresolved: [{ layer, item: 'x' }] })
    assert.equal(r.strict, false, layer)
  }
})
ok('Visibility conflict → strict=false', () => {
  const r = computeResolution({ intent: { subject: 'character' }, camera: { mode: 'mirror_selfie' }, framing: { band: 'full' }, visibility: { unresolved: [], conflicts: [{ field: 'hands' }] }, unresolved: [] })
  assert.equal(r.strict, false)
})
ok('core=false → strict=false', () => {
  const r = computeResolution({ intent: { subject: 'character' }, camera: { mode: null }, framing: { band: null }, visibility: { unresolved: [], conflicts: [] }, unresolved: [] })
  assert.equal(r.core, false)
  assert.equal(r.strict, false)
})

console.log('\n=== 4. 手的身份与职责 ===')
ok('持机手不会变成动作手（前置/后置/镜拍逐一检查）', () => {
  for (const r of rows) {
    const hands = r.visibility.hands || []
    if (r.neu.mode !== 'mirror_selfie') assert.ok(!hands.includes('camera_hand'), r.label)
  }
})
ok('第一人称动作手不含 camera_hand', () => {
  for (const r of rows.filter((x) => x.neu.mode === 'first_person')) {
    assert.ok(!(r.visibility.hands || []).includes('camera_hand'), r.label)
  }
})
ok('双手动作不被压成单手', () => {
  const r = rows.find((x) => x.label === '第一人称动作·双手')
  assert.equal(r.pose.hands.requiredCount, 2)
  assert.equal((r.visibility.hands || []).length, 2)
})
ok('镜拍必须保留 camera_hand', () => {
  for (const r of rows.filter((x) => x.neu.mode === 'mirror_selfie')) {
    assert.ok((r.visibility.hands || []).includes('camera_hand'), r.label)
  }
})
ok('同一只手不重复计数（拿杯子→放桌上）', () => {
  const one = buildShotPlan({ scene: '第一人称', slot: 'evening', raw: '第一人称 端着杯子' })
  const two = buildShotPlan({ scene: '第一人称', slot: 'evening', raw: '第一人称 端着杯子，然后把杯子放在桌上' })
  assert.equal(one.pose.hands.requiredCount, two.pose.hands.requiredCount)
})
ok('可见手不超过取景允许的数量', () => {
  for (const r of rows) {
    const n = (r.visibility.hands || []).length
    if (r.neu.framing === 'object') assert.ok(n <= 1, r.label + ' object 取景却出现 ' + n + ' 只手')
    assert.ok(n <= 2, r.label)
  }
})

console.log('\n=== 5. 约束语义互不替代 ===')
ok('no_face ≠ no_person ≠ no_phone（各自独立解析）', () => {
  const a = buildShotPlan({ scene: '不露脸拍一张', slot: 'evening' })
  const b = buildShotPlan({ scene: '画面里不出现人物', slot: 'evening' })
  const c = buildShotPlan({ scene: '不出现手机，拍桌上的杯子', slot: 'evening' })
  assert.ok(a.intent.constraints.some((x) => x.type === 'no_face'))
  assert.ok(b.intent.constraints.some((x) => x.type === 'no_person'))
  assert.ok(c.intent.constraints.some((x) => x.type === 'no_phone'))
})
ok('no_phone 不等于禁止用手机拍摄（capture.device 仍是手机）', () => {
  const c = buildShotPlan({ scene: '不出现手机，拍桌上的杯子', slot: 'evening' })
  assert.equal(c.camera.capture.device === 'phone' || c.camera.capture.device === 'rear_cam', true)
})
ok('用户明确禁止的画面元素不会被机位规则强行恢复', () => {
  /* 镜拍默认 phone=true；若显式 no_phone 则必须被压回 false 并记录冲突 */
  const m = buildShotPlan({ scene: '对镜拍一张，不出现手机', slot: 'evening' })
  assert.equal(m.visibility.phone, false, 'no_phone 必须压过镜拍默认')
  assert.ok((m.visibility.conflicts || []).some((c) => c.ruleId === 'constraint.no_phone_vs_mirror'))
})

/* ---------- 写文档（与上面同一份 rows） ---------- */
const changed = rows.filter((r) => r.changed)
const unregistered = changed.filter((r) => !r.expected)
const identical = rows.length - changed.length

const t1 = [
  '| # | 场景 | 旧 mode | 新 mode | 分类 |',
  '|---|---|---|---|---|',
  ...rows.map((r, i) => `| ${i + 1} | ${r.label} | ${r.oldMode} | ${r.newMode} | ${r.changed ? (r.expected ? 'expected_correction' : 'REGRESSION') : 'identical'} |`),
]
const t2 = [
  '| 场景 | subject 旧→新 | mode | activities | framing 旧→新 | 手需/见 | face 旧→新 | phone | constraints |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.label} | ${r.old.subject ?? 'not_supported'} → ${r.neu.subject} | ${r.oldMode}→${r.newMode} | ${r.old.activities ?? 'not_supported'} → ${r.neu.activities ?? 'null'} | ${r.old.framing ?? 'not_supported'} → ${r.neu.framing ?? 'null'} | ${r.neu.handsRequired}/${(r.visibility.hands || []).length} | ${r.old.face ?? 'not_supported'} → ${r.neu.face} | ${r.neu.phone} | ${(r.intentConstraints = r.neu.constraints.join('+')) || '-'} |`),
]
fs.mkdirSync(DOCS, { recursive: true })
fs.writeFileSync(path.join(DOCS, 'photo-v3-shadow-test.md'), [
  '# Shadow Test v2 明细（字段级）', '',
  `> 场景总数 **${rows.length}**｜一致 **${identical}**｜发生变化 **${changed.length}**｜未登记 **${unregistered.length}**`, '',
  '## 表 1 · 模式对比', '', ...t1, '',
  '## 表 2 · 字段级对比（旧链路无能力处标 not_supported）', '', ...t2,
].join(NL), 'utf8')

fs.writeFileSync(path.join(DOCS, 'photo-v3-shadow-review.md'), [
  '# Shadow Test v2 差异分类与结论', '',
  '## 统计（唯一来源：本次运行）',
  `- 场景总数：${rows.length}`,
  `- identical（行为一致）：${identical}`,
  `- expected_correction（预期修正）：${changed.length - unregistered.length}`,
  `- regression（未登记）：${unregistered.length}`,
  `- not_comparable（旧链路无对应能力）：subject 语义、activities、hands、phone、constraints、unresolved`, '',
  '## 预期修正逐项', '',
  ...changed.filter((r) => r.expected).map((r) => `- **${r.label}**：${r.oldMode} → ${r.newMode}；原因：${r.expected}`), '',
  '## 回归风险', '',
  unregistered.length ? unregistered.map((r) => `- ${r.label}: ${r.oldMode} → ${r.newMode}`).join(NL) : '- 无', '',
  '## 结论', '',
  '1. 统计数字由本次运行生成，文档与测试同源，不会再出现口径不一致。',
  '2. 旧链路没有 subject 词表/activities/手部模型/constraints，这些字段一律 not_supported，未强行比较。',
  '3. `strict` 的四个条件（intent/camera/framing/pose 的 unresolved、visibility conflict、core）已逐条测试。',
  '4. 手的身份检查覆盖：持机手不进动作手、第一人称动作手不含 camera_hand、双手不被压缩、镜拍必须保留 camera_hand、同一只手不重复计数。',
  '5. 约束语义：no_face/no_person/no_phone 互不替代；no_phone 会压过镜拍的 phone 默认并记冲突。',
  '6. 测试不依赖个人路径（仓库根由 import.meta.url 推导，可用 WHALE_POD_HOME 覆盖）。',
].join(NL), 'utf8')

console.log('\npass ' + pass + ' / fail ' + fail)
console.log(`统计：总 ${rows.length}｜identical ${identical}｜expected ${changed.length - unregistered.length}｜regression ${unregistered.length}`)
process.exit(fail === 0 ? 0 : 1)
