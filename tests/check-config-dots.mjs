/**
 * 配置**点号路径**的回归测试（2026-10-30）。
 *
 * ## 挖出来的一个老 bug
 * `store.update(patch)` 原来只是 `deepMerge(this.value, patch)`，
 * 而 `deepMerge` 按**字面 key** 合并、不认点号。于是面板提交
 * `{'memory.dir': 'D:/mem'}` 时，配置里多出一个**顶层键字面叫 "memory.dir"**，
 * 真正的 `memory.dir` 一动不动：
 *
 * ```
 * 结果 {"memory":{"dir":""}, "memory.dir":"D:/mem"}
 *      → memory.dir 还是 ""      ❌
 * ```
 *
 * 实测受影响：
 * · 面板「**记忆目录**」—— 从 0.3.x 起就没生效过
 *   （留空 = 跟数据目录，看起来"能用"，所以一直没人发现）
 * · 面板「**记忆上限** 存多少 / 每轮带多少」—— 0.3.5 新加的，同样只存了假键
 *
 * 用户的原话：「上下文现在改不了」「不会自动保存」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deepMerge, expandDots, ConfigStore } from '../src/config/store.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── ① expandDots 本身 ────────────────────────────────────
ok('三层点号 → 嵌套', () => {
  assert.deepEqual(
    expandDots({ 'memory.long.maxChars': 4000 }),
    { memory: { long: { maxChars: 4000 } } },
  )
})

ok('两层点号 → 嵌套（面板「记忆目录」用的就是这种）', () => {
  assert.deepEqual(expandDots({ 'memory.dir': 'D:/mem' }), { memory: { dir: 'D:/mem' } })
})

ok('没有点号 → 原样（嵌套对象也逐层处理）', () => {
  assert.deepEqual(
    expandDots({ memory: { long: { injectChars: 500 } } }),
    { memory: { long: { injectChars: 500 } } },
  )
})

ok('混合写法：嵌套 + 点号 能合到一起', () => {
  const out = expandDots({ memory: { dir: 'A' }, 'memory.long.maxChars': 1 })
  assert.deepEqual(out, { memory: { dir: 'A', long: { maxChars: 1 } } })
})

ok('同层冲突：后者覆盖前者', () => {
  const out = expandDots({ 'memory.dir': 'B', memory: { dir: 'C' } })
  assert.equal(out.memory.dir, 'C', '按出现顺序，后面的覆盖')
})

ok('数组和标量不被展开', () => {
  assert.deepEqual(expandDots({ groups: ['a', 'b'] }), { groups: ['a', 'b'] })
  assert.equal(expandDots(null), null)
  assert.equal(expandDots(5), 5)
})

ok('deepMerge 本身仍然不认点号（保持原语义）', () => {
  const r = deepMerge({ memory: { dir: '' } }, { 'memory.dir': 'X' })
  assert.equal(r.memory.dir, '', 'deepMerge 不该被改语义')
  assert.equal(r['memory.dir'], 'X', '它会留下字面量键 —— 这正是要在 update 前展开的原因')
})

// ── ② 端到端：ConfigStore.update ─────────────────────────
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'))

ok('⚠️ update 三层点号 → 真的写进 memory.long，且不留字面量键', () => {
  const home = tmpHome()
  const s = new ConfigStore({ home })
  s.update({ 'memory.long.injectChars': 4000 })
  const v = s.get()
  assert.equal(v.memory.long.injectChars, 4000, '真正的字段要变')
  assert.ok(!('memory.long.injectChars' in v), '不该留下字面量顶层键')
})

ok('⚠️ update 两层点号（记忆目录）→ 真的生效（存量 bug 修复）', () => {
  const home = tmpHome()
  const s = new ConfigStore({ home })
  s.update({ 'memory.dir': 'D:/memory' })
  assert.equal(s.get().memory.dir, 'D:/memory')
  assert.ok(!('memory.dir' in s.get()), '不该留字面量键')
})

ok('落盘后重新载入，值仍在（不是只改了内存）', () => {
  const home = tmpHome()
  const a = new ConfigStore({ home })
  a.update({ 'memory.long.maxChars': 20000 })
  const b = new ConfigStore({ home })
  b.load()
  assert.equal(b.get().memory.long.maxChars, 20000)
  assert.ok(!('memory.long.maxChars' in b.get()), '文件里也不该有假键')
})

ok('点号写法不会破坏同路径其它字段', () => {
  const home = tmpHome()
  const s = new ConfigStore({ home })
  const before = JSON.stringify(s.get().memory.short)
  s.update({ 'memory.long.maxChars': 9000 })
  assert.equal(JSON.stringify(s.get().memory.short), before, 'memory.short 不该被动')
  assert.equal(s.get().memory.long.enabled, true, 'memory.long 的其它字段也还在')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)