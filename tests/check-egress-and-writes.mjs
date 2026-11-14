/**
 * 出站路径收口与原子写（2026-11-10 扫查）
 *
 * 1) 戳一戳回话必须走 `_send`（原来直接 onebot.send*，绕过剥标记/过滤/去重/基准更新）
 * 2) 剩余状态文件补原子写
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

console.log('=== 1. 戳一戳走 _send ===')
ok('★ poke 回话不再直接调 onebot.sendGroup/Private', () => {
  const i = SRC.indexOf('戳一戳回话失败')
  assert.ok(i > 0, '找不到 poke 回话段')
  const seg = SRC.slice(Math.max(0, i - 900), i + 60)
  assert.match(seg, /await this\._send\(pokeMsg/, 'poke 回话应走 _send')
  assert.ok(!/await this\.onebot\.send(Group|Private)\((groupId|fromId), said\)/.test(seg), '还有直发')
})

ok('★ `__noSceneSymbol` 真的被 _send 尊重（戳回话不补 ♡）', () => {
  assert.match(SRC, /if \(!msg\.__noSceneSymbol\) text = this\._ensureSceneSymbol/)
})

console.log('\n=== 2. 剩余状态文件原子写 ===')
const ATOMIC = [
  ['../src/qq/bridge.js', 'interactions.json'],
  ['../src/gateway/jm.js', 'version: 1, memos'],
  ['../src/gateway/search.js', 'JSON.stringify(this.data)'],
  ['../src/persona/store.js', 'writeFileAtomic'],
]
ok('★ interactions / jm / search / persona 都有 tmp+rename', () => {
  for (const [f, marker] of ATOMIC) {
    const s = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.ok(s.includes(marker), `${f} 缺标记 ${marker}`)
    assert.match(s, /renameSync\(/, `${f} 没有 renameSync`)
  }
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
