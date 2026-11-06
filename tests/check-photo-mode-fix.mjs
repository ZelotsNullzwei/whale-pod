/**
 * 「要身形」必须改判镜子自拍（2026-11-07）。
 *
 * 现场：她说「对着手机前置镜头的自拍」，他要「全身看看这一身」，
 * 结果出了"别人举着手机拍她 + 镜子边"的怪图 —— 因为前摄只有一臂距离，
 * 拍不到全身/三分之二身。
 *
 * 现在：前置自拍 + 要看身形 → 校验层直接改判 mirror_selfie，
 * 构图回到"站镜子前、全身"，手机也在镜子里，物理上说得通。
 *
 * 守什么：
 * - 「全身/这一身/身形」→ mirror_selfie + 全身
 * - 只想拍脸 → 仍是 front_selfie（不要被顺手改掉）
 * - 不涉及身形的普通自拍 → 不变
 */
import assert from 'node:assert/strict'
import { planShot } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/photo/index.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const cfg = { refImage: 'F', bodyRefImage: 'B', size: '1024x2048' }
const shot = (req) => planShot({
  scene: '对着手机前置镜头的自拍，穿着白色无袖连身睡裙',
  slot: 'night',
  outfit: '白色无袖连身睡裙',
  request: req,
  scope: 'm' + req + Date.now(),
  imageCfg: cfg,
})

console.log('=== 要身形 → 镜子自拍 ===')
ok('★ 「全身看看这一身」→ mirror_selfie + 全身', () => {
  const s = shot('拍一张全身看看这一身')
  assert.equal(s.mode, 'mirror_selfie')
  assert.equal(s.framingInfo?.framing, '全身')
  assert.match(String(s.fixReason ?? ''), /改成镜子自拍/)
})
ok('★ 「想看身材」也算', () => {
  const s = shot('让我看看你的身材')
  assert.equal(s.mode, 'mirror_selfie')
})

console.log('\n=== 不该改的别改 ===')
ok('「就拍脸」→ 仍是前置自拍', () => {
  const s = shot('就拍脸')
  assert.equal(s.mode, 'front_selfie')
  assert.equal(s.framingInfo?.framing, '头肩')
})
ok('普通自拍（没提身形）→ 仍是前置自拍', () => {
  const s = shot('拍一张给我看看')
  assert.equal(s.mode, 'front_selfie')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
