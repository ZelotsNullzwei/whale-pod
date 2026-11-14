/**
 * 实时当前穿搭/发型（2026-11-11）
 * 「衣柜也加一个实时更新当前穿搭」：换装/换发型写入当天状态，出图与说说共用。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureWearState, setWearing, setWearingHair, hairFor, wearingFor } from '../src/memory/wearing.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wear-hair-'))
const day = '2026-11-11'
const noon = new Date('2026-11-11T13:00:00+08:00')

console.log('=== 1. 换装带发型 ===')
ok('★ setWearing 记下穿搭 + 发型', () => {
  configureWearState({ home: tmp() })
  setWearing(day, { text: '浅灰家居T恤，深蓝长裤', kind: 'home', hair: '披着，有点乱' })
  assert.match(wearingFor(day, 'afternoon', noon).text, /家居T恤/)
  assert.equal(hairFor(day, 'afternoon', noon), '披着，有点乱')
})

console.log('\n=== 2. 只换发型，不丢衣服 ===')
ok('★ setWearingHair 后穿搭仍在', () => {
  configureWearState({ home: tmp() })
  setWearing(day, { text: '浅灰家居T恤，深蓝长裤', kind: 'home' })
  setWearingHair(day, '扎成马尾（刚扎的）')
  assert.equal(hairFor(day, 'afternoon', noon), '扎成马尾（刚扎的）')
  assert.match(wearingFor(day, 'afternoon', noon).text, /家居T恤/)
})
ok('换装不带 hair → 沿用已有发型', () => {
  configureWearState({ home: tmp() })
  setWearing(day, { text: 'A', hair: '马尾' })
  setWearing(day, { text: 'B' })
  assert.equal(hairFor(day, 'afternoon', noon), '马尾')
  assert.equal(wearingFor(day, 'afternoon', noon).text, 'B')
})

console.log('\n=== 3. 过期（换日 / 睡眠时段） ===')
ok('隔天失效', () => {
  configureWearState({ home: tmp() })
  setWearingHair(day, '马尾')
  assert.equal(hairFor('2026-11-12', 'afternoon', new Date('2026-11-12T13:00:00+08:00')), '')
})
ok('夜间（≥22 点）失效', () => {
  configureWearState({ home: tmp() })
  setWearingHair(day, '马尾')
  assert.equal(hairFor(day, 'evening', new Date('2026-11-11T23:00:00+08:00')), '')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
