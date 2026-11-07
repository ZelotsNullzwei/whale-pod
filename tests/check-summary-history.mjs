/**
 * 摘要覆盖前留底（2026-11-07）。
 *
 * 现场：昨晚 00:12–00:45 聊了 900 多条，摘要跑了 5 次；
 * 今早一次摘要就把【事】整段换成"断电重开、中午吃过饭"，昨晚那段只剩一句旁证。
 *
 * 现在两条腿：
 *   ① 旧【事】在覆盖前压成一条长期档案（带可见性：私聊的只进 [私]）
 *   ② 旧摘要整段进 history（最多 5 版），注入仍只用最新那版
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureFacts, factsFor, clearFacts } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/memory/facts.js'
import { LongTermMemory } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/memory/long.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sumhist-'))
configureFacts({ home: dir })
clearFacts()

console.log('=== 1. 旧摘要进 history ===')
ok('★ 覆盖后能翻到上一版', () => {
  const m = new LongTermMemory('private:2129024700')
  m.merge('【人】\n1 | 他 | 学生\n【事】\n昨晚聊了很久，最后说了晚安。\n【梗】\n鲸鲸 | 叫法\n')
  const first = m.summary
  m.merge('【人】\n1 | 他 | 学生\n【事】\n今天中午吃了饭。\n【梗】\n鲸鲸 | 叫法\n')
  assert.equal(m.history?.[0], first, '上一版没进 history')
  assert.notEqual(m.summary, first, 'summary 没被更新')
})

console.log('\n=== 2. 旧【事】进档案，且只给私聊 ===')
ok('★ 旧【事】被压成一条 [私]', () => {
  const priv = factsFor('private:2129024700')
  assert.ok(priv.some((x) => x.text.includes('昨晚聊了很久')), '私聊看不到旧【事】')
})
ok('★ 群看不到这条', () => {
  const grp = factsFor('group:704291282')
  assert.ok(!grp.some((x) => x.text.includes('昨晚聊了很久')), '私密内容漏进群了')
})
ok('群会话的旧【事】只给群', () => {
  const g = new LongTermMemory('group:704291282')
  g.merge('【人】\n2 | 群友 | 爱开玩笑\n【事】\n群里在聊卫戍协议，聊了一晚上。\n【梗】\n卫 | 梗\n')
  g.merge('【人】\n2 | 群友 | 爱开玩笑\n【事】\n今天聊别的。\n【梗】\n卫 | 梗\n')
  const grp = factsFor('group:704291282')
  assert.ok(grp.some((x) => x.text.includes('卫戍协议')))
})

console.log('\n=== 3. history 上限 ===')
ok('最多留 5 版', () => {
  const m = new LongTermMemory('private:x')
  for (let i = 0; i < 8; i++) m.merge(`【事】\n第 ${i} 版内容，写得长一点才不会被当成空。\n`)
  assert.ok((m.history ?? []).length <= 5)
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
