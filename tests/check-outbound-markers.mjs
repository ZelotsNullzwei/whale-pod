/**
 * 出站标记不许漏进群（2026-11-06）。
 *
 * ## 现场（群 704291282）
 * ```
 * 19:35:15  她（冷场补话）「催什么催，都说了这条裙子长。（对着镜子把围裙系好）
 *            [换装:白色系女仆装长款，鲸尾露在外面，白蕾丝发带]」
 * 19:35:48  群友「怎么把后台念出来了」
 * ```
 * 根因两层：
 *   ① `_deadAirSpeak()` / `_sceneContinue()` 拿 `_generate()` 原文直接 `_send()`，
 *      绕过 `_handle` 里的标记流水线；
 *   ② 发送漏斗里的 `MARKER_RE` **漏了 `换装`**（只有画图/表情/签名那几族），
 *      于是标记既没被执行、又原样出站。
 *
 * 守什么：
 * - `[换装:…]` / `[换衣服:…]` 必剥（这次的真凶）
 * - `[画图:…]` / `[场景图:…]` / `[插画:…]` 继续剥（老行为，别回退）
 * - `[戳]` `[撤回]` `[SILENT]` 这些**没冒号**的裸标记也剥
 * - 正常文字、括号里的动作、全角括号都别误伤
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { stripWaitMarkers } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const strip = (t) => stripWaitMarkers(t).text

console.log('=== 1. 线上原句 ===')
ok('★ 19:35:15 那条原文 → 标记剥干净、正文留下', () => {
  const raw = '催什么催，都说了这条裙子长。（对着镜子把围裙系好）\n\n'
    + '[换装:白色系女仆装长款，鲸尾露在外面，白蕾丝发带]\n[画图:对镜自拍全身]'
  const out = strip(raw)
  assert.ok(!out.includes('换装'), `还留着换装：${out}`)
  assert.ok(!out.includes('画图'), `还留着画图：${out}`)
  assert.ok(out.includes('这条裙子长'), '正文被误删了')
  assert.ok(out.includes('（对着镜子把围裙系好）'), '括号动作被误删了')
})

console.log('\n=== 2. 各家族都要剥 ===')
ok('换衣服（别名）', () => {
  const out = strip('穿好了 [换衣服:短款女仆装]')
  assert.ok(!out.includes('换衣服'))
  assert.equal(out, '穿好了')
})
ok('画图 / 场景图 / 插画（老行为不能回退）', () => {
  const out = strip('喏 [画图:对镜] [场景图:桌面] [插画:侧躺]')
  assert.ok(!/画图|场景图|插画/.test(out), `漏了：${out}`)
})
ok('★ 裸标记 [戳] [撤回] [SILENT]', () => {
  const out = strip('在的 [戳] 别急 [撤回] [SILENT]')
  assert.ok(!/戳|撤回|SILENT/.test(out), `漏了：${out}`)
})
ok('全角括号写成 ［换装：…］ 也要剥', () => {
  const out = strip('好啦［换装：白色长裙］')
  assert.ok(!out.includes('换装'), `漏了：${out}`)
})
ok('残缺（没有右括号）→ 从标记处截断', () => {
  const out = strip('换好了 [换装:白色女仆装')
  assert.ok(!out.includes('换装'), `漏了：${out}`)
})

console.log('\n=== 3. 不要误伤 ===')
ok('正常一句话原样', () => {
  assert.equal(strip('今天风好大，窗户都在响。'), '今天风好大，窗户都在响。')
})
ok('她聊「换装」这件事（不带标记）不受影响', () => {
  const t = '换装这种事我最快了，你别催。'
  assert.equal(strip(t), t)
})
ok('[等:5] 仍然按约定抽出来（老逻辑）', () => {
  const r = stripWaitMarkers('那我等你 [等:5]')
  // 剥完顺手收掉了行尾空格（新行为），约定分钟数必须还在
  assert.equal(r.text.trim(), '那我等你')
  assert.deepEqual(r.waits, [5])
})

console.log('\n=== 4. 源码锁：漏斗在 _send 里 ===')
ok('★ 每条出站都经过 stripWaitMarkers', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = src.indexOf('async _send(')
  assert.ok(at > 0, '找不到 _send')
  const seg = src.slice(at, at + 4000)
  assert.match(seg, /stripWaitMarkers\(/, '_send 必须过发送漏斗清洗')
})
ok('★ MARKER_RE 覆盖换装（防止有人把它删回去）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /换装\|换衣服/, 'MARKER_RE 要含 换装|换衣服')
})

console.log('\n=== 5. 表情标记必须「活着」出站（2026-11-07 修的真 bug）===')
/*
 * 现场：18:24 群里风宝发了个表情包 + 「居然有复数多」，她 decide 要回，
 * 日志却写：
 *   「bridge：剥掉标记后既没有正文也没有图，这条不发」
 * 也就是她整条只生成了一个 [表情包:震惊]，被 MARKER_RE 剥成空串 → 丢弃。
 *
 * 根因：MARKER_RE 里带着 `表情|表情包`，注释写着「为了兜旧格式」，
 * 但 `_send` 拿到的是**原始文本** —— 表情段还没被 splitFaceMarkers 转出来。
 * 于是：带冒号的表情标记（[表情:20] / [表情包:震惊]）全被吃掉，
 * 只有裸的 [表情包]（不匹配 `[:：]`）能活下来。
 *
 * 后果两条：
 *   ① 只有表情的回复被当空消息丢掉（用户看到"她明明想说却什么都不发"）；
 *   ② 正文里跟的表情也消失（她说"给你个白眼[表情包:白眼]"，白眼没发出来）。
 */
ok('★ [表情:20] 不许被剥（它要变成真的 QQ 表情）', () => {
  assert.equal(strip('[表情:20]'), '[表情:20]')
})
ok('★ [表情包:震惊] 不许被剥（它要变成收藏表情）', () => {
  assert.equal(strip('[表情包:震惊]'), '[表情包:震惊]')
})
ok('★ 正文 + 表情：正文留下、表情也留下', () => {
  assert.equal(strip('（耳朵一压）知道了[表情:20]'), '（耳朵一压）知道了[表情:20]')
})
ok('★ 裸的 [表情包] 也还在', () => {
  assert.equal(strip('[表情包]'), '[表情包]')
})
ok('★ 但 [画图:] [换装:] [等:] 照样剥（别把这条修回退）', () => {
  assert.equal(strip('[画图:对镜自拍]'), '')
  assert.equal(strip('[换装:女仆装]'), '')
  assert.equal(strip('[等:5]'), '')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
