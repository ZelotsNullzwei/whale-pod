/**
 * 衣服优先级（2026-11-08 用户：「优先级那个真的没问题吗，你验证了没」）。
 *
 * 定的顺序：**她嘴里说的 > 临时换的 > 标志性那套 > 外出服 > 日程**
 * 并且：她说的必须能映射到衣柜里某一套，**不许出现衣柜以外的衣服**。
 *
 * 这个测试守三件事：
 * ① `extractSaidOutfit` 抽得准（正例 / 边界 / 指代不抽）
 * ② `matchOutfit` 只在衣柜里找（衣柜外的组合 → 空）
 * ③ 源码里那段**确实排在 worn / outage 之前**（顺序锁，防以后挪位置）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractSaidOutfit, matchOutfit } from '../src/memory/wardrobe.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 抽她说自己穿什么 ===')
ok('★ 「穿着浅灰吊带背心和米色家居短裤」→ 抽出那段', () => {
  const r = extractSaidOutfit('对镜自拍，穿着浅灰吊带背心和米色家居短裤，站在小单间里')
  assert.equal(r, '浅灰吊带背心和米色家居短裤')
})
ok('★ 「换上白衬衫了」→ 去掉尾部助词', () => {
  assert.equal(extractSaidOutfit('换上白衬衫了'), '白衬衫')
})
ok('★ 「这身怎么样」→ 不抽（不是描述）', () => {
  assert.equal(extractSaidOutfit('这身怎么样'), '')
})
ok('★ 「身上是昨天那件」→ 不抽（指代）', () => {
  assert.equal(extractSaidOutfit('身上是昨天那件'), '')
})
ok('★ 没提衣服 → 空', () => {
  assert.equal(extractSaidOutfit('看看你的手'), '')
})

console.log('\n=== 2. 只在衣柜里找 ===')
ok('★ 衣柜里有的（吊带+短裤）→ 命中', () => {
  const m = matchOutfit('浅灰吊带背心和米色家居短裤')
  assert.ok(m, '应该命中')
  assert.match(m, /吊带/)
})
ok('★ 衣柜里没有的（白衬衫配牛仔裤）→ 空', () => {
  assert.equal(matchOutfit('白衬衫配牛仔裤'), '')
})
ok('★ 只提鞋袜（白棉袜和木色拖鞋）→ 空（不算换装）', () => {
  assert.equal(matchOutfit('白棉袜和木色拖鞋'), '')
})
ok('★ 指代词（昨天那件）→ 空', () => {
  assert.equal(matchOutfit('昨天那件'), '')
})

console.log('\n=== 3. 顺序锁（源码） ===')
ok('★ 她的说法排在 worn / signature / outingNow 之前', () => {
  const src = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
  const iSaid = src.indexOf('const saidRaw = extractSaidOutfit(msg.text)')
  const iWorn = src.indexOf('const worn = wearingFor(dayKey(), currentSlot().id)')
  const iSig = src.indexOf('const wantsSignature =')
  const iOuting = src.indexOf('if (outingNow) return String(outingOutfitForDay')
  assert.ok(iSaid > 0, '没找到她说的那段')
  assert.ok(iWorn > iSaid, `她说的(${iSaid}) 必须在 worn(${iWorn}) 之前`)
  assert.ok(iSig > iSaid, `她说的 必须在 signature(${iSig}) 之前`)
  assert.ok(iOuting > iSaid, `她说的 必须在 outingNow(${iOuting}) 之前`)
})
ok('★ 映射不到时不会 return（要回落，不能把衣服变成空）', () => {
  const src = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
  const i = src.indexOf('不在衣柜里')
  assert.ok(i > 0, '没找到回落分支')
  const seg = src.slice(i, i + 120)
  assert.ok(!/return\s+['"]{2}/.test(seg), '回落分支不该 return 空字符串')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
