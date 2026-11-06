/**
 * 面板「生图风格：照片 / 插画」必须真的生效（2026-11-06）。
 *
 * 现场：侧栏那个「照片｜插画」按钮点了没反应 —— 因为
 * `qq.actions.drawStyle` 在 bridge 里**从来没被读过**：
 * 只有 `[插画:…]` 标记才会走插画档（`anime = Boolean(hitIll)`）。
 * 于是配置里写的是 anime，画出来还是照片。
 *
 * 守什么：
 * - bridge 的两个生图入口都要把 `drawStyle === 'anime'` 算进 anime
 * - anime 档真的会换参考图 + 换画风段（这条测 planShot）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planShot } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/photo/index.js'
import { configureCanon } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/photo/canon.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 源码锁：两个入口都读了 drawStyle ===')
ok('★ 主图和附加图都算 drawStyle', () => {
  const src = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
  const hits = src.match(/drawStyle \?\? ''\) === 'anime'/g) ?? []
  assert.equal(hits.length, 2, `应该两个入口都有，实际 ${hits.length}`)
})
ok('★ 不再只认 [插画:] 标记', () => {
  const src = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
  assert.ok(!/anime: Boolean\(hitIll\),/.test(src), '原来的单标记写法要改掉')
})

console.log('\n=== 2. 行为：anime 档真的换参考图和画风 ===')
// 先把定妆照关掉，否则女仆装会被 canon 接管，测不到参考图选择
configureCanon({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'wp-nocanon2-')) })

const cfg = {
  refImage: 'FACE.png',
  faceRefImage: 'FACE3.png',
  bodyRefImage: 'BODY.png',
  animeBodyRefImage: 'ANIME-BODY.jpg',
  animeFaceRefImage: 'ANIME-FACE.jpg',
  size: '1024x2048',
}
const shot = (anime) => planShot({
  scene: '对镜自拍，全身',
  slot: 'evening',
  outfit: '女仆装短款',
  request: '拍一张',
  scope: 'anime-test-' + String(anime),
  anime,
  imageCfg: cfg,
})

ok('★ anime=false → 用写实参考图 + 写实画风', () => {
  const s = shot(false)
  assert.equal(s.refImage, 'BODY.png')
  assert.match(s.prompt, /真实生活摄影/)
})
ok('★ anime=true → 用插画参考图 + 日系画风', () => {
  const s = shot(true)
  assert.equal(s.refImage, 'ANIME-BODY.jpg')
  assert.match(s.prompt, /日系二次元插画/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
