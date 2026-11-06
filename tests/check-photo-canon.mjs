/**
 * 定妆照 canon（2026-11-06 A 方案）。
 *
 * 用户选定 v3 当短款女仆的定妆照。之后画这套走图生图：
 * 参考图 = 定妆照，只对齐「款式 + 体型 + 尾巴数量」，不参考姿势背景。
 *
 * 守什么：
 * - canon.json 按正则匹配衣柜原文，命中且文件存在才生效
 * - 命中时 planShot 的 refImage 换成定妆照，且 prompt 里有「定妆照」段
 * - 没命中的衣服（日常穿搭）行为不变
 * - 文件不存在 / JSON 坏了 → 不生效、不崩
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureCanon, canonFor } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/photo/canon.js'
import { planShot } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/photo/index.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-canon-'))
const img = path.join(dir, 'canon.png')
fs.writeFileSync(img, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'))   // 假 PNG 头即可（只检查存在）
fs.writeFileSync(path.join(dir, 'canon.json'), JSON.stringify({
  entries: [{ match: '女仆装短款', file: img, note: 'test' }],
}))
configureCanon({ home: dir })

const MAID = '白色蕾丝头带，**女仆装短款**（藏青渐变连身裙），白色蕾丝围裙，白色过膝长袜，藏青玛丽珍鞋，一条鲸鱼尾巴'
const HOME_OUTFIT = '米白棉质衬衫，浅蓝家居长裤，白棉袜，木色拖鞋'
const imageCfg = { refImage: 'FACE.png', faceRefImage: 'FACE3.png', bodyRefImage: 'BODY.png', size: '1024x2048' }
let n = 0
// ⚠️ 每次换一个 scope：否则 planShot 的「同一场景重复」闸会跳过，prompt 是空的
const shot = (outfit) => planShot({ scene: '对镜自拍，全身', slot: 'evening', outfit, request: '拍一张', scope: 't' + (++n), imageCfg })

console.log('=== 1. 匹配 ===')
ok('★ 命中「女仆装短款」→ 返回定妆照', () => {
  const c = canonFor(MAID)
  assert.equal(c?.file, img)
})
ok('日常穿搭不命中', () => {
  assert.equal(canonFor(HOME_OUTFIT), null)
})

console.log('\n=== 2. 生图链路 ===')
ok('★ 女仆装 → refImage 换成定妆照，且标记 canonRef', () => {
  const s = shot(MAID)
  assert.equal(s.refImage, img)
  assert.equal(s.canonRef, true)
})
ok('★ prompt 里有「参考图是这套衣服的定妆照」段', () => {
  const s = shot(MAID)
  assert.match(s.prompt, /参考图是这套衣服的定妆照/)
  assert.match(s.prompt, /尾巴只有一条/)
})
ok('★ 日常穿搭 → 仍走 body/face 参考图，不出现定妆照段', () => {
  const s = shot(HOME_OUTFIT)
  assert.notEqual(s.refImage, img)
  assert.ok(!/定妆照/.test(s.prompt), '不该出现定妆照段')
})

console.log('\n=== 3. 异常 ===')
ok('canon.json 坏掉 → 不生效、不崩', () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-canon2-'))
  fs.writeFileSync(path.join(d2, 'canon.json'), '{ 这不是 json')
  configureCanon({ home: d2 })
  assert.equal(canonFor(MAID), null)
  configureCanon({ home: dir })
})
ok('配了但文件不在了 → 不生效', () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-canon3-'))
  fs.writeFileSync(path.join(d3, 'canon.json'), JSON.stringify({ entries: [{ match: '女仆', file: path.join(d3, 'nope.png') }] }))
  configureCanon({ home: d3 })
  assert.equal(canonFor(MAID), null)
  configureCanon({ home: dir })
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
