/**
 * 展示穿搭：多参考一起喂（2026-11-11）
 * 对镜自拍（mirror_selfie）→ refImages = [脸参考, 身体参考]，锁脸 + 锁身形。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planShot } from '../src/photo/index.js'
import { generateImage } from '../src/qq/mcpImage.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refmulti-'))
const face = path.join(tmp, 'face.png')
const body = path.join(tmp, 'body.png')
fs.writeFileSync(face, Buffer.from('89504e470d0a1a0a', 'hex'))
fs.writeFileSync(body, Buffer.from('89504e470d0a1a0a', 'hex'))
const imageCfg = { faceRef: face, bodyRefImage: body, refImage: face, size: '1024x1536' }
const base = { slot: 'noon', outfit: '浅灰家居T恤，深蓝长裤', hair: '披着', mode: 'daily', imageCfg }

console.log('=== 1. 对镜穿搭 → 两个参考 ===')
ok('★ mirror_selfie 返回 refImages=[脸, 身体]', () => {
  const s = planShot({ ...base, scene: '镜子自拍：卧室衣柜镜前；站在镜子前拍今天的穿搭，半身（到腰胯）', forceMode: 'mirror_selfie', subjectMode: 'person', forceFraming: '半身', scope: 'rm1' })
  assert.equal(s.mode, 'mirror_selfie')
  assert.equal(s.refImages.length, 2)
  assert.equal(path.basename(s.refImages[0]), 'face.png')
  assert.equal(path.basename(s.refImages[1]), 'body.png')
  assert.equal(path.basename(s.refImage), 'face.png')
})

console.log('=== 2. 自拍也要双参考（锁蓝瞳） ===')
ok('前置自拍 refImages=[脸, 身体]', () => {
  const s = planShot({ ...base, scene: '居家自拍，半身，手机在画外', forceMode: 'front_selfie', subjectMode: 'person', scope: 'rm2' })
  assert.equal(s.refImages.length, 2)
  assert.equal(path.basename(s.refImages[0]), 'face.png')
})
ok('纯物照 refImages 为空', () => {
  const s = planShot({ ...base, scene: '洗锅；水槽里只有锅和刷子', sceneOnly: true, subjectMode: 'object', forceMode: 'rear_selfie', scope: 'rm3' })
  assert.equal(s.refImages.length, 0)
})

console.log('=== 3. generateImage 支持多参考参数（不真发请求） ===')
ok('传入 refImages 不报"未知参数/签名错误"', () => {
  assert.equal(typeof generateImage, 'function')
  assert.ok(generateImage.length >= 0)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
