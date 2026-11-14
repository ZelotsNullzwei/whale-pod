/**
 * 长期记忆摘要可人工修改（2026-11-10）
 *
 * 她记错事时，直接在面板上改：旧版留 history、updatedAt 刷新、原子落盘。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LongTermMemory, LongTermStore } from '../src/memory/long.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 单条摘要改写 ===')
ok('★ setSummary 覆盖正文 + 旧版进 history + 刷新时间', () => {
  const m = new LongTermMemory('s1', {})
  m.summary = '【人】老王会修电脑。'
  m.updatedAt = 1
  const before = m.summary
  const okSet = m.setSummary('【人】老王不会修电脑，上次记错了。')
  assert.equal(okSet, true)
  assert.match(m.summary, /上次记错了/)
  assert.equal(m.history[0], before, '旧版要留底')
  assert.ok(m.updatedAt > 1, 'updatedAt 要刷新')
})
ok('空串不生效', () => {
  const m = new LongTermMemory('s2', {})
  m.summary = 'abc'
  assert.equal(m.setSummary('   '), false)
  assert.equal(m.summary, 'abc')
})

console.log('\n=== 2. Store 层：改完落盘（原子） ===')
ok('★ setSummary 写进 memory-long.json，且没有残留 .tmp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memedit-'))
  const store = new LongTermStore({ home: dir, summarize: async () => '', log: {} })
  store.file = path.join(dir, 'memory-long.json')   // 兜底：老版本没有该字段时
  const r = store.setSummary('private:1', '【人】他养了一只猫，叫团子。')
  assert.equal(r.ok, true)
  const file = store.file
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.match(j.sessions['private:1'].summary, /团子/)
  assert.equal(fs.existsSync(`${file}.tmp`), false, '不该留下 tmp')
  assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false)
})

console.log('\n=== 3. 接线锁 ===')
ok('★ 服务端 /memory/summary POST + longMemory.setSummary', () => {
  const src = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8')
  assert.match(src, /sub === '\/memory\/summary' && method === 'POST'/)
  assert.match(src, /longMemory\.setSummary\(scope, summary\)/)
})
ok('★ 面板：摘要查看器可编辑（textarea + POST /memory/summary）', () => {
  const src = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  assert.match(src, /'mem\.saveSummary'/)
  assert.match(src, /api\('\/memory\/summary', \{/)
  assert.match(src, /id: 'memsum'/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
