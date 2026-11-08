/**
 * 明日方舟外号 → 正式名（2026-11-08）。
 *
 * 数据：萌娘百科《明日方舟/梗》的三张表（干员外号/敌方外号/组织别称），
 * 存成 `<home>/arknights-alias.json`。
 *
 * 目的：认得出「肥鸭」「图图姐」在说谁，好接话。**不解释、不科普。**
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge } from '../src/qq/bridge.js'

const HOME = 'C:/Users/Null_zwei/.dsh/whale-pod'
const p = QQBridge.prototype
const fake = { cfg: { home: HOME } }
let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 数据文件 ===')
ok('★ 外号表存在且条数够', () => {
  const j = JSON.parse(fs.readFileSync(`${HOME}/arknights-alias.json`, 'utf8'))
  const n = Object.keys(j).filter((k) => !k.startsWith('_')).length
  assert.ok(n >= 100, `只有 ${n} 条`)
  assert.equal(j['图图姐'], '塑心', '图图姐 应该是塑心')
  assert.equal(j['肥鸭'], '菲亚梅塔', '肥鸭 应该是菲亚梅塔')
})

console.log('\n=== 2. 命中 ===')
ok('★ 肥鸭 → 菲亚梅塔', () => {
  const r = p._arknightsAliasHint.call(fake, '肥鸭那套怎么打')
  assert.match(r, /肥鸭.*菲亚梅塔/)
})
ok('★ 图图姐 → 塑心', () => {
  const r = p._arknightsAliasHint.call(fake, '图图姐又加强了')
  assert.match(r, /图图姐.*塑心/)
})
ok('★ 有方舟语境时，数字外号也认', () => {
  const r = p._arknightsAliasHint.call(fake, '明日方舟新卡池 42 出了吗')
  assert.match(r, /42.*史尔特尔/)
})

console.log('\n=== 3. 别乱认 ===')
ok('★ 没有方舟语境的纯数字不当外号', () => {
  assert.equal(p._arknightsAliasHint.call(fake, '42是不是很强'), '')
})
ok('★ 日常句子不注入', () => {
  assert.equal(p._arknightsAliasHint.call(fake, '今天下午好热啊'), '')
})
ok('★ 一次最多 3 个', () => {
  const many = '肥鸭 图图姐 蒂蒂 鸡翅 龟龟 火凛'
  const r = p._arknightsAliasHint.call(fake, many)
  assert.equal((r.match(/^- /gm) ?? []).length, 3)
})
ok('★ 明确要求"别科普、别报出处"', () => {
  const r = p._arknightsAliasHint.call(fake, '肥鸭')
  assert.match(r, /别科普/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
