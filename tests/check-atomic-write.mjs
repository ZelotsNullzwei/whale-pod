/**
 * 状态文件原子写（2026-11-10）
 *
 * ## 问题
 * 大多数状态文件已经是「写 .tmp → rename」；但 `dayPlan.js:save()` 和
 * `person.js:_saveAff()` 是**直接写目标文件**。硬杀/断电会留下半截 JSON，
 * 下次 parse 失败 → 当天日程/好感度整体丢失。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DayPlanStore } from '../src/memory/dayPlan.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'))
const read = (p) => fs.readFileSync(p, 'utf8')

console.log('=== 1. dayPlan 保存是原子的 ===')
ok('★ save() 后：文件可解析、内容对、没有残留 .tmp', () => {
  const dir = tmpDir()
  const store = new DayPlanStore({ dir })
  store.data.plans['2026-11-10'] = { wake: '七点', morning: '热了杯豆浆' }
  store.save()
  const file = path.join(dir, 'day-plan.json')
  const j = JSON.parse(read(file))          // 能解析 = 不是半截
  assert.equal(j.plans['2026-11-10'].wake, '七点')
  assert.equal(fs.existsSync(`${file}.tmp`), false, '临时文件必须被 rename 掉')
})

ok('★ 源码锁：dayPlan 用 .tmp + renameSync（不能直写目标）', () => {
  const src = read(new URL('../src/memory/dayPlan.js', import.meta.url))
  assert.match(src, /\$\{this\.file\}\.tmp/, '缺 .tmp 写入')
  assert.match(src, /fs\.renameSync\(tmp, this\.file\)/, '缺 rename 收尾')
})

console.log('\n=== 2. person 好感度保存是原子的 ===')
ok('★ 源码锁：person 用 .tmp + renameSync', () => {
  const src = read(new URL('../src/memory/person.js', import.meta.url))
  assert.match(src, /\$\{this\.affFile\}\.tmp/, '缺 .tmp 写入')
  assert.match(src, /fs\.renameSync\(tmp, this\.affFile\)/, '缺 rename 收尾')
})

console.log('\n=== 3. 坏文件不会连带崩掉 ===')
ok('★ 目标文件已是半截 JSON 时，save() 仍能写出可解析的新文件', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'day-plan.json')
  fs.writeFileSync(file, '{"version":1,"plans":{"2026-11-1', 'utf8')   // 模拟硬杀留下的半截
  const store = new DayPlanStore({ dir })
  store.data.plans['2026-11-10'] = { wake: '七点' }
  store.save()
  assert.equal(JSON.parse(read(file)).plans['2026-11-10'].wake, '七点')
})

console.log('\n=== 4. 其它状态文件也应是原子写（2026-11-10 扫查补） ===')
ok('★ 说说状态（drafts/去重基准）', () => {
  const src = read(new URL('../src/qq/qzoneText.js', import.meta.url))
  assert.match(src, /\$\{stateFile\}\.tmp/, '缺 .tmp 写入')
  assert.match(src, /fs\.renameSync\(tmp, stateFile\)/, '缺 rename 收尾')
})
ok('★ 讨钱状态（count/usedLineIds 归零会导致重复讨钱）', () => {
  const src = read(new URL('../src/qq/beg.js', import.meta.url))
  assert.match(src, /\$\{this\.file\}\.tmp/, '缺 .tmp 写入')
  assert.match(src, /fs\.renameSync\(tmp, this\.file\)/, '缺 rename 收尾')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
