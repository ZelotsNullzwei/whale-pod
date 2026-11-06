/**
 * 长期档案（只增不减）+ 可见性隔离（2026-11-06）。
 *
 * 用户口径：
 *   ·「以后能一直记着你说的了」 —— 摘要是覆盖式的，细节会被重写吃掉，
 *     所以要一条**只增不减**的档案
 *   ·「把一份摘要真的做成一份…会不会把 close 的亲密事说出去」
 *     —— 会。所以每条带可见性：私聊看全部，**群只看群+公共**
 *
 * 守什么：
 * - [私] 只给私聊；[群] 只给群；[公] 两边都给
 * - 解析器认三种前缀（含全角括号），剥段后摘要里不留【记】
 * - 去重：同一句不会进两次
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureFacts, addFacts, factsFor, renderFacts, clearFacts } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/memory/facts.js'
import { parseMemoryFacts, stripMemoryFacts, SUMMARY_PROMPT } from 'file:///D:/DSH%20WorkSpace/whale-pod/src/memory/long.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-facts-'))
configureFacts({ home: dir })

console.log('=== 1. 解析 ===')
ok('★ 三种前缀都认', () => {
  const items = parseMemoryFacts([
    '【记】',
    '[私] 他半夜说过想被抱着睡',
    '[群] 群里在玩卫戍协议',
    '[公] 他玩怪猎和三角洲',
    '',
    '【别的】',
  ].join('\n'))
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((x) => x.scope), ['private', 'group', 'shared'])
})
ok('全角括号也认', () => {
  const items = parseMemoryFacts('【记】\n［私］他怕黑\n')
  assert.equal(items[0]?.scope, 'private')
})
ok('没有【记】→ 空', () => {
  assert.deepEqual(parseMemoryFacts('【事】\n随便聊聊'), [])
})

console.log('\n=== 2. 剥离 ===')
ok('★ 摘要里不留【记】', () => {
  const s = stripMemoryFacts('【事】\n聊了天\n【记】\n[私] 秘密\n')
  assert.ok(!s.includes('【记】') && !s.includes('秘密'), s)
  assert.ok(s.includes('聊了天'))
})

console.log('\n=== 3. 可见性（关键：close 的东西不能进群）===')
ok('★ [私] 只有私聊看得见', () => {
  addFacts([
    { text: '他半夜说过想被抱着睡', scope: 'private' },
    { text: '群里在玩卫戍协议', scope: 'group' },
    { text: '他玩怪猎和三角洲', scope: 'shared' },
  ])
  const priv = factsFor('private:2129024700')
  const group = factsFor('group:704291282')
  assert.ok(priv.some((x) => x.text.includes('想被抱着睡')), '私聊要能看到')
  assert.ok(!group.some((x) => x.text.includes('想被抱着睡')), '群里绝不能看到')
  assert.ok(group.some((x) => x.text.includes('卫戍协议')), '群要看到群内的')
  assert.ok(group.some((x) => x.text.includes('怪猎')), '公共的两边都要有')
  assert.ok(priv.some((x) => x.text.includes('卫戍协议')), '私聊也能知道群里的（他允许）')
})
ok('★ 渲染块：群那份不含 [私] 内容', () => {
  const g = renderFacts('group:704291282')
  assert.ok(g.includes('你记得的事'))
  assert.ok(!g.includes('想被抱着睡'))
})

console.log('\n=== 4. 去重 / 异常 ===')
ok('同一句不会进两次', () => {
  const before = factsFor('private:x').length
  addFacts([{ text: '他玩怪猎和三角洲', scope: 'shared' }])
  assert.equal(factsFor('private:x').length, before)
})
ok('空档案渲染成空串', () => {
  clearFacts()
  assert.equal(renderFacts('group:1'), '')
})

console.log('\n=== 5. 提示词里教了怎么标 ===')
ok('SUMMARY_PROMPT 有【记】段和三种前缀', () => {
  assert.match(SUMMARY_PROMPT, /【记】/)
  assert.match(SUMMARY_PROMPT, /\[私\]/)
  assert.match(SUMMARY_PROMPT, /\[公\]/)
  assert.match(SUMMARY_PROMPT, /宁可只给私聊看/)
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
