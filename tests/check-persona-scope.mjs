/**
 * 人格按会话生效（2026-11-01）。
 *
 * ## 为什么要这个
 * 用户要的是「**群里还是那只鱼鱼，私聊另一版**」——
 * 原来 `persona.active` 是**全局**的，切一下群里也跟着变。
 *
 * ## 查找顺序（这条锁住）
 *   **精确 scope → 类型（group/private）→ 全局 active**
 *
 * ## 两个刻意的宽松（也要锁住）
 *   · 表里写了但**文件不存在** → 跳过继续找（别让一个手滑的名字把会话变没人格）
 *   · 都没有 → 回落全局 active（永远有个能用的）
 *
 * ## 还要守住
 *   · `setActive(name, scope)` **不能**动到全局 `active`（群里不该被私聊的切换影响）
 *   · 不传 scope 时行为跟以前**完全一样**（老调用点不受影响）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersonaStore } from '../src/persona/store.js'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-scope-'))
const dir = path.join(home, 'persona', 'roles')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'default.md'), '# 群里那只\n\n群里的话少说两句。', 'utf8')
fs.writeFileSync(path.join(dir, 'close.md'), '# 亲近版\n\n这一版会先动。', 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const mk = () => new PersonaStore({
  home,
  active: 'default',
  activeByScope: { private: 'close', 'group:704291282': 'close' },
  log: {},
})

ok('私聊 → 用按类型指定的那个', () => {
  assert.equal(mk().pickActive('private:2129024700'), 'close')
})

ok('群里 → 没指定 group 就回落全局 active', () => {
  assert.equal(mk().pickActive('group:999999'), 'default')
})

ok('精确 scope 压过类型', () => {
  const p = mk()
  assert.equal(p.pickActive('group:704291282'), 'close', '这个群被单独指定了')
  assert.equal(p.pickActive('group:111111'), 'default', '别的群还是全局')
})

ok('文件不存在 → 跳过，回落全局（别让手滑的名字把会话变没人格）', () => {
  const p = new PersonaStore({
    home, active: 'default', activeByScope: { private: 'typo-name' }, log: {},
  })
  assert.equal(p.pickActive('private:1'), 'default')
})

ok('setActive(name, scope) 不动全局', () => {
  const p = mk()
  p.setActive('default', 'private:2129024700')
  assert.equal(p.active, 'default', '全局没被改')
  assert.equal(p.pickActive('private:2129024700'), 'default')
  assert.equal(p.pickActive('private:999'), 'close', '同类型其它会话仍走类型规则')
})

ok('setActive(name) 不带 scope → 还是改全局（老行为）', () => {
  const p = mk()
  p.setActive('close')
  assert.equal(p.active, 'close')
  assert.equal(p.pickActive('group:1'), 'close')
})

ok('不传 scope → 跟以前一样用全局', () => {
  const p = mk()
  assert.equal(p.pickActive(undefined), 'default')
  assert.equal(p.pickActive(''), 'default')
})

ok('buildSystemPrompt 真的按 scope 取内容', () => {
  const p = mk()
  const g = p.buildSystemPrompt({ scope: 'group:999999' })
  const c = p.buildSystemPrompt({ scope: 'private:2129024700' })
  assert.match(g, /群里那只/, '群里该拿到 default 的正文')
  assert.doesNotMatch(g, /这一版会先动/)
  assert.match(c, /这一版会先动/, '私聊该拿到 close 的正文')
  assert.doesNotMatch(c, /群里那只/)
})

ok('不传 scope 时 buildSystemPrompt 也是全局那个', () => {
  const p = mk()
  assert.match(p.buildSystemPrompt({}), /群里那只/)
})

ok('clearScopes 之后，全局才真的生效（这就是那个"全局点了没反应"的 bug）', () => {
  /*
   * ⚠️ 这条是用户实测抓到的：`pickActive` 顺序是「精确 → 类型 → 全局」，
   *    所以**只要 activeByScope 里有条目，全局值永远轮不到** ——
   *    面板上选「全局（群和私聊都跟着变）」看着毫无变化。
   *    修法就是选「全局」时先把覆盖清掉。
   */
  const p = mk()
  assert.equal(p.pickActive('private:1'), 'close', '清之前：私聊被按会话的覆盖挡着')
  p.clearScopes()
  assert.equal(p.pickActive('private:1'), 'default', '清之后：回落到全局')
  assert.equal(p.pickActive('group:1'), 'default')
  assert.deepEqual(p.activeByScope, {}, '覆盖表被清空')
})

ok('stats() 把 activeByScope 暴露出来（面板要看）', () => {
  const s = mk().stats()
  assert.equal(s.active, 'default')
  assert.equal(s.activeByScope.private, 'close')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 临时目录，删不掉就算了 */ }
process.exit(fail > 0 ? 1 : 0)