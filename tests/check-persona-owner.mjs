/**
 * 主人绑定（2026-11-10）
 *
 * 「主人」不是独立字段，就是 `activeByScope['private:<QQ>'] = 'close'`。
 * 面板上填 QQ 号即绑定；留空 = 清除。换号必须**先删旧条目**，
 * 否则旧号还留着 close（谁是主人模棱两可，说说草稿也会发到旧号）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersonaStore } from '../src/persona/store.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const mk = (activeByScope) => new PersonaStore({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'owner-')), activeByScope })

console.log('=== 1. 绑定 / 换号 / 清除 ===')
ok('★ 绑定：写入 private:<QQ> = close', () => {
  const p = mk({ group: 'default', private: 'default' })
  const next = p.setOwner('2129024700')
  assert.equal(next['private:2129024700'], 'close')
  assert.equal(next.group, 'default', '群绑定不能动')
  assert.equal(next.private, 'default', '类型兜底不能动')
  assert.equal(p.ownerQQ(), '2129024700')
})

ok('★ 换号：旧的主人条目必须被删掉（不能留着两个 close）', () => {
  const p = mk({ 'private:111': 'close', group: 'default', private: 'default' })
  const next = p.setOwner('222')
  assert.equal(next['private:222'], 'close')
  assert.equal(next['private:111'], undefined, '旧主人必须删掉')
  assert.equal(Object.values(next).filter((v) => v === 'close').length, 1, '只能有一个 close 私聊')
})

ok('★ 留空 = 清除绑定（不新增）', () => {
  const p = mk({ 'private:111': 'close', group: 'default' })
  const next = p.setOwner('')
  assert.equal(next['private:111'], undefined)
  assert.equal(p.ownerQQ(), '')
  assert.equal(next.group, 'default')
})

ok('数字以外的字符会被清掉', () => {
  const p = mk({})
  assert.deepEqual(Object.keys(p.setOwner(' 2129-0247 00 ')), ['private:2129024700'])
})

console.log('\n=== 2. 接线锁 ===')
ok('★ 服务端有 ownerQQ 入口，且用 persona.setOwner', () => {
  const src = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8')
  assert.match(src, /body\.ownerQQ !== undefined/)
  assert.match(src, /persona\.setOwner\(qq\)/)
  assert.match(src, /store\.update\(\{ persona: \{ activeByScope: next \} \}\)/)
})
ok('★ 面板有「主人 QQ」输入行（POST /persona {ownerQQ}）', () => {
  const src = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  assert.match(src, /'persona\.owner': '主人 QQ'/)
  assert.match(src, /post\('\/persona', \{ ownerQQ:/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
