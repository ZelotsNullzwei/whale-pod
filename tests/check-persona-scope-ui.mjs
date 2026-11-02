/**
 * 界面显示的角色 == 实际生效的角色（2026-11-01）。
 *
 * ## 为什么要有这条测试
 * 设置页那个「范围 + 当前人格」选择器，显示的是**所选范围下真正生效的角色**。
 * 它的算法写在 `plugin/client.js` 的 `PersonaPicker` 里（浏览器半身，拿不到 Node 里跑），
 * 服务端的算法在 `PersonaStore#pickActive` —— **两处必须完全一致**。
 *
 * 不一致的后果（实测被用户抓到）：
 *   选了「私聊 close」→ 服务端写对了 → 但界面显示的还是全局的 default
 *   → 下拉跳回去 → 用户以为"选中了没变化"。
 *
 * 所以这里把**浏览器那套公式**照抄一份，跟**服务端真身**逐一对比。
 * ⚠️ 以后改任一边，这条会红 —— 那就是提醒你两边一起改。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersonaStore } from '../src/persona/store.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 照抄 plugin/client.js 里 `PersonaPicker` 的 effective 算法（只改了这一处变量名）。 */
function uiEffective(p, scope) {
  const byScope = p.activeByScope ?? {}
  const sc = String(scope ?? '')          // 跟服务端 pickActive 的归一化对齐
  const kind = sc.includes(':') ? sc.slice(0, sc.indexOf(':')) : sc
  return (sc ? (byScope[sc] ?? byScope[kind]) : undefined) ?? p.active ?? ''
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-ui-'))
const dir = path.join(home, 'persona', 'roles')
fs.mkdirSync(dir, { recursive: true })
for (const n of ['default', 'close', 'plain']) fs.writeFileSync(path.join(dir, `${n}.md`), `# ${n}`, 'utf8')

const CASES = [
  { active: 'default', activeByScope: {} },
  { active: 'default', activeByScope: { group: 'default', private: 'close' } },
  { active: 'plain', activeByScope: { private: 'close' } },
  { active: 'default', activeByScope: { 'private:2129024700': 'plain', private: 'close' } },
  { active: 'close', activeByScope: { group: 'plain' } },
]
const SCOPES = ['', 'group', 'private', 'group:704291282', 'private:2129024700', 'private:999', undefined]

ok('界面公式 == 服务端 pickActive（全矩阵）', () => {
  for (const c of CASES) {
    const store = new PersonaStore({ home, active: c.active, activeByScope: c.activeByScope, log: {} })
    for (const scope of SCOPES) {
      const ui = uiEffective(c, scope)
      const srv = store.pickActive(scope)
      assert.equal(ui, srv,
        `不一致！active=${c.active} byScope=${JSON.stringify(c.activeByScope)} scope=${String(scope)}`
        + ` → 界面 ${ui} / 服务端 ${srv}`)
    }
  }
})

ok('复现当初那个 bug：私聊选了 close，界面不该再显示全局的 default', () => {
  const p = { active: 'default', activeByScope: { private: 'close' } }
  assert.equal(uiEffective(p, 'private'), 'close')
  assert.equal(uiEffective(p, 'private:2129024700'), 'close')
  assert.equal(uiEffective(p, 'group'), 'default', '群里还是全局那个')
  assert.equal(uiEffective(p, ''), 'default', '选「全局」时显示全局值，这是对的')
})

ok('精确 scope 压过类型（界面也要）', () => {
  const p = { active: 'default', activeByScope: { private: 'close', 'private:1': 'plain' } }
  assert.equal(uiEffective(p, 'private:1'), 'plain')
  assert.equal(uiEffective(p, 'private:2'), 'close')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 临时目录 */ }
process.exit(fail > 0 ? 1 : 0)