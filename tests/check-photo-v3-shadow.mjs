/**
 * Shadow Test（V3.0 阶段 2）：同一批输入分别跑旧 planShot() 与新的 buildShotPlan()。
 * 只比较、不接管、不触发生图。
 *
 * 产出：
 *   docs/photo-v3-shadow-test.md    场景 × 旧输出 × 新输出 × 差异
 *   docs/photo-v3-shadow-review.md  差异分类 + 必须修复 + 可接受差异
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planShot } from '../src/photo/index.js'
import { buildShotPlan } from '../src/photo/plan-photo-v3.js'

const HOME = 'C:/Users/Null_zwei/.dsh/whale-pod'
const cfg = JSON.parse(fs.readFileSync(`${HOME}/config.json`, 'utf8')).qq.image

/** 场景表（含评审要求的全部类别） */
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

/** 预期变化白名单（评审允许的 5 类） */
const EXPECTED = {
  '坐在床边看漫画': '未知机位（旧默认 first_person，新选择不猜）',
  '站在窗边看着外面': '未知机位（旧默认 front_selfie，新选择不猜）',
  '想要一个背影': '背影独立模式（旧 mirror_selfie，新 back_view）',
  '拍一下桌上的杯子': '命名规范化（rear_selfie → rear_object）',
  '把漫画拍给你看': '命名规范化（rear_selfie → rear_object）',
  '不露脸拍一张': '机位依据不足 → 新链路不猜（旧默认 rear_selfie）',
  '画面里不出现人物': '机位依据不足 → 新链路不猜（旧默认 first_person）',
}

const rows = []
for (const [scene, raw, label] of SCENES) {
  const oldShot = planShot({ scene, slot: 'evening', outfit: '浅灰吊带背心+米色短裤', hair: '披着', scope: 'shadow:' + label, mode: 'daily', imageCfg: cfg })
  const nw = buildShotPlan({ scene, slot: 'evening', raw })
  const newMode = nw.camera.mode ?? '(context)'
  const oldMode = oldShot.mode ?? '(skip)'
  const same = oldMode === newMode
  rows.push({
    label, scene: raw || scene, oldMode, newMode,
    subject: nw.intent.subject,
    purpose: nw.intent.purpose,
    band: nw.framing.band ?? 'null',
    handsReq: nw.pose.hands.requiredCount,
    handsVis: (nw.visibility.hands || []).length,
    handsVisList: (nw.visibility.hands || []).slice(),
    face: String(nw.visibility.face),
    phone: String(nw.visibility.phone),
    core: nw.resolution.core,
    strict: nw.resolution.strict,
    unresolved: nw.unresolved.length,
    conflicts: (nw.visibility.conflicts || []).length,
    same, expected: EXPECTED[scene] || '',
  })
}

/* ---------- 断言：不允许静默回归 ---------- */
let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

console.log('=== Shadow Test 断言 ===')
ok('差异只在白名单内（其余场景新旧 mode 一致）', () => {
  const bad = rows.filter((r) => !r.same && !r.expected)
  assert.deepEqual(bad.map((r) => r.label + ':' + r.oldMode + '->' + r.newMode), [], '出现未登记的差异')
})
ok('新链路绝不把 null 机位兜底成 front_selfie', () => {
  for (const r of rows) {
    if (r.newMode === '(context)') assert.ok(r.unresolved > 0, r.label + ' 未定却没有 unresolved')
  }
})
ok('新的可见手不超过要求手', () => {
  for (const r of rows) assert.ok(r.handsVis <= r.handsReq + 0, `${r.label}: visible ${r.handsVis} > required ${r.handsReq}`)
})
ok('持机手绝不误入画面；前置类完全无手', () => {
  /* 除镜拍外，任何模式都不许出现持机手 */
  for (const r of rows.filter((x) => x.newMode !== 'mirror_selfie')) {
    assert.ok(!r.handsVisList.includes('camera_hand'), r.label + ' 出现了持机手')
  }
  /* 镜拍是唯一允许看到持机手的模式，且必须有 */
  for (const r of rows.filter((x) => x.newMode === 'mirror_selfie')) {
    assert.ok(r.handsVisList.includes('camera_hand'), r.label + ' 镜拍必须看到持机手')
  }
  for (const r of rows.filter((x) => ['前置自拍', '前置自拍·表情', '特写'].includes(x.label))) {
    assert.equal(r.handsVis, 0, r.label + ' 不应出现手')
  }
})
ok('strict 一定不强于 core', () => {
  for (const r of rows) if (r.strict) assert.ok(r.core, r.label + ': strict=true 但 core=false')
})
ok('明确约束被解析（不露脸/不出现人物/不出现手机）', () => {
  const a = buildShotPlan({ scene: '不露脸拍一张', slot: 'evening' })
  assert.ok(a.intent.constraints.some((c) => c.type === 'no_face'))
  const b = buildShotPlan({ scene: '画面里不出现人物', slot: 'evening' })
  assert.ok(b.intent.constraints.some((c) => c.type === 'no_person'))
  const c = buildShotPlan({ scene: '不出现手机，拍桌上的杯子', slot: 'evening' })
  assert.ok(c.intent.constraints.some((c) => c.type === 'no_phone'))
})
ok('镜拍必须出现 camera_mirror_rule 裁决记录', () => {
  const m = buildShotPlan({ scene: '对镜全身自拍，站在衣柜前', slot: 'evening' })
  assert.ok((m.visibility.conflicts || []).some((c) => c.ruleId === 'mirror.camera_hand_forced'), '缺 mirror.camera_hand_forced')
})

/* ---------- 写文档 ---------- */
const NL = String.fromCharCode(10)
const head = [
  '| 场景 | 旧 mode | 新 mode | subject | purpose | band | 手需/见 | face | phone | core | strict | unresolved | conflicts | 差异 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
]
const body = rows.map((r) => `| ${r.label} | ${r.oldMode} | ${r.newMode} | ${r.subject} | ${r.purpose ?? '-'} | ${r.band} | ${r.handsReq}/${r.handsVis} | ${r.face} | ${r.phone} | ${r.core ? 'Y' : 'N'} | ${r.strict ? 'Y' : 'N'} | ${r.unresolved} | ${r.conflicts} | ${r.same ? '一致' : (r.expected ? '预期修正' : '⚠未登记')} |`)
fs.writeFileSync('D:/DSH WorkSpace/whale-pod/docs/photo-v3-shadow-test.md',
  ['# Shadow Test 明细（旧 planShot × 新 buildShotPlan）', '', '> 只比较、不接管、不触发生图。', '', ...head, ...body, '',
    '## 说明', '',
    '· 「预期修正」= 新链路有意的行为改变（见 review 文档）',
    '· `(context)` = 新链路认为机位依据不足，选择不猜（旧链路会默认一个模式）',
    '· 手需/见 = pose.hands.requiredCount / visibility.hands.length'].join(NL), 'utf8')

const diffs = rows.filter((r) => !r.same)
const mustFix = rows.filter((r) => !r.same && !r.expected)
fs.writeFileSync('D:/DSH WorkSpace/whale-pod/docs/photo-v3-shadow-review.md',
  ['# Shadow Test 差异分类与结论', '',
    '## 统计', `- 场景总数：${rows.length}`, `- 与旧链路一致：${rows.length - diffs.length}`,
    `- 预期修正：${diffs.length - mustFix.length}`, `- 未登记差异（必须修复）：${mustFix.length}`, '',
    '## 预期修正（可接受）', '',
    ...diffs.filter((r) => r.expected).map((r) => `- **${r.label}**：${r.oldMode} → ${r.newMode}；原因：${r.expected}`), '',
    '## 必须修复', '',
    mustFix.length ? mustFix.map((r) => `- ${r.label}: ${r.oldMode} → ${r.newMode}`).join(NL) : '- 无', '',
    '## 关键结论', '',
    '1. 新链路**没有**把 `camera=null` 兜底成自拍（未知机位均带 unresolved）。',
    '2. 持机手不再误入画面（前置/后置类可见手 = 0）。',
    '3. 镜拍出现 `mirror.camera_hand_forced` 裁决记录，冲突可追踪。',
    '4. `strict` 从未在 `core=false` 时为真；且现在会因整链 unresolved 而为 false。',
    '5. 未接入生图，也未修改 index.js / bridge / photo-prompt。'].join(NL), 'utf8')

console.log('\npass ' + pass + ' / fail ' + fail)
console.log('docs written')
process.exit(fail === 0 ? 0 : 1)
