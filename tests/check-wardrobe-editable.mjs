/**
 * 衣柜可编辑（2026-11-06）。
 *
 * ## 用户原话
 * 「衣柜要能改吧，毕竟现在这个只是我们的预设，不代表别人喜欢」
 *
 * ## 设计（跟 persona 的 roles/*.md 同一套机制）
 * 数据目录 `<home>/wardrobe.json`：
 * ```json
 * { "home": ["…"], "outing": ["…"], "sleepwear": ["…"], "signature": ["…"], "hairstyle": ["…"] }
 * ```
 * - **某类存在且非空 → 整类用文件里的**（不是追加：追加的话用户删掉的
 *   那套下次启动又回来了，删不掉等于不能改）
 * - 缺省 / 空数组 → 回落到内置预设（老用户无痛）
 * - **按 mtime 热加载**：改完下一轮生效，不用重启
 *
 * 守什么：
 * ① 覆盖只影响点名的那一类（写别的类不能把已有覆盖抹掉）
 * ② 空数组 = 恢复预设（不是"这一类不能穿"）
 * ③ 文件写坏了 → **继续用预设**，并把错误暴露出来（不能因为一个
 *    JSON 语法错就让衣柜整个空掉）
 * ④ add 去重、remove 支持包含匹配（用户只说半句也能删）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-wardrobe-'))

/**
 * 每个用例都要**重新 import** —— 模块里 `WARDROBE_HOME` 是模块级状态，
 * 用 import() 加 query 拿一份干净实例，避免用例互相污染。
 */
let seq = 0
async function freshStore(home) {
  const W = await import(`../src/memory/wardrobe.js?t=${Date.now()}-${seq++}`)
  W.configureWardrobe({ home })
  return W
}

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 没有文件 → 全用预设（老用户无痛）===')
await ok('没 wardrobe.json 时，生效池 = 内置预设', async () => {
  const dir = tmp()
  const W = await freshStore(dir)
  const pools = W.effectivePools()
  assert.equal(pools.home.length, W.HOME_OUTFITS.length)
  assert.deepEqual(pools.home, W.HOME_OUTFITS)
  assert.deepEqual(W.wardrobeOverrides(), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n=== 2. 整类覆盖 ===')
await ok('★ 写了 home → 家居服整类换成文件里的（不是追加）', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'wardrobe.json'), JSON.stringify({
    home: ['我的第一套：白T + 短裤', '我的第二套：系带连衣裙'],
  }))
  const W = await freshStore(dir)
  const pools = W.effectivePools()
  assert.deepEqual(pools.home, ['我的第一套：白T + 短裤', '我的第二套：系带连衣裙'])
  assert.equal(pools.home.length, 2, '不能把预设也拼进来')
  // 别的类不受影响
  assert.deepEqual(pools.outing, W.OUTING_OUTFITS)
  assert.deepEqual(W.wardrobeOverrides(), ['home'])
  fs.rmSync(dir, { recursive: true, force: true })
})

await ok('取当天那套时用的是覆盖后的池子', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'wardrobe.json'), JSON.stringify({ home: ['唯一一套'] }))
  const W = await freshStore(dir)
  assert.equal(W.outfitForDay('2026-11-06'), '唯一一套')
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n=== 3. 增 / 删 / 恢复 ===')
await ok('addOutfit 追加一套并落盘', async () => {
  const dir = tmp()
  const W = await freshStore(dir)
  const r = W.addOutfit('home', '新加的家居服：灰色卫衣 + 短裤')
  assert.equal(r.ok, true)
  assert.equal(r.added, true)
  // 重新读一份（模拟下一轮）
  const W2 = await freshStore(dir)
  assert.ok(W2.effectivePools().home.includes('新加的家居服：灰色卫衣 + 短裤'))
  assert.equal(W2.effectivePools().home.length, W.HOME_OUTFITS.length + 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

await ok('addOutfit 重复添加不加第二遍', async () => {
  const dir = tmp()
  const W = await freshStore(dir)
  const t = '同一套'
  W.addOutfit('sleepwear', t)
  const r = W.addOutfit('sleepwear', t)
  assert.equal(r.added, false)
  const W2 = await freshStore(dir)
  assert.equal(W2.effectivePools().sleepwear.filter((x) => x === t).length, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

await ok('★ removeOutfit 按包含匹配删（用户只说半句）', async () => {
  const dir = tmp()
  const W = await freshStore(dir)
  const first = W.HOME_OUTFITS[0]
  const r = W.removeOutfit('home', first.slice(0, 6)) // 只说前 6 个字
  assert.equal(r.ok, true)
  const W2 = await freshStore(dir)
  assert.ok(!W2.effectivePools().home.includes(first), '那一套要没了')
  fs.rmSync(dir, { recursive: true, force: true })
})

await ok('reset（空数组）= 回到内置预设', async () => {
  const dir = tmp()
  const W = await freshStore(dir)
  W.addOutfit('outing', '临时加的外出服')
  assert.deepEqual((await freshStore(dir)).wardrobeOverrides(), ['outing'])
  W.saveWardrobe({ outing: [] })
  const W3 = await freshStore(dir)
  assert.deepEqual(W3.wardrobeOverrides(), [])
  assert.deepEqual(W3.effectivePools().outing, W.OUTING_OUTFITS)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n=== 4. 只改一类不影响别的 ===')
await ok('先改 home，再改 outing → 两类的覆盖都在', async () => {
  const dir = tmp()
  const W = await freshStore(dir)
  W.saveWardrobe({ home: ['只此一套家居'] })
  W.saveWardrobe({ outing: ['只此一套外出'] })
  const W2 = await freshStore(dir)
  const pools = W2.effectivePools()
  assert.deepEqual(pools.home, ['只此一套家居'])
  assert.deepEqual(pools.outing, ['只此一套外外'.replace('外外', '外出')])
  assert.deepEqual(W2.wardrobeOverrides().sort(), ['home', 'outing'])
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n=== 5. 坏文件不能把衣柜搞空 ===')
await ok('★ JSON 写坏了 → 继续用预设，并暴露错误', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'wardrobe.json'), '{ 这不是 JSON')
  const W = await freshStore(dir)
  const pools = W.effectivePools()
  assert.deepEqual(pools.home, W.HOME_OUTFITS, '要回落到预设')
  assert.ok(W.wardrobeError(), '要能报出错误')
  fs.rmSync(dir, { recursive: true, force: true })
})

await ok('某类写成空数组 → 该类回落预设（不是"没衣服穿"）', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'wardrobe.json'), JSON.stringify({ home: [] }))
  const W = await freshStore(dir)
  assert.deepEqual(W.effectivePools().home, W.HOME_OUTFITS)
  fs.rmSync(dir, { recursive: true, force: true })
})

await ok('某类写成非数组（手滑）→ 忽略，回落预设', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'wardrobe.json'), JSON.stringify({ home: '一套' }))
  const W = await freshStore(dir)
  assert.deepEqual(W.effectivePools().home, W.HOME_OUTFITS)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
