/**
 * 群 ↔ 私聊的**长期记忆共享**（2026-11-06）。
 *
 * 用户：「人格不一样，记忆相同没问题吧」—— 人格按会话各用各的，
 * 但记忆要一份：群里聊过的事，私聊隔天还能想起来，反之亦然。
 *
 * 原来只有两条 30 分钟的**短期**摘要（`_recentGroupDigest` / `_recentPrivateDigest`），
 * 长期摘要是各存一份 → 过一天就断片。
 *
 * 守什么：
 * - 私聊能拿到群的长期摘要，群能拿到私聊的
 * - **不拿自己那一边**（自己那份已经在正文里了）
 * - 【事实】段要剥掉（那是 people.json 的活，重复占预算）
 * - 空摘要 / 没对面会话 → 返回空串，不崩
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const fake = {
  longMemory: {
    scopes: () => ['group:704291282', 'private:2129024700'],
    get: (k) => ({
      summary: k.startsWith('group')
        ? '【人】\n123 | 某某 | 爱开玩笑\n【事】\n群里聊了 X\n【我】\n我学会了等\n【梗】\n风宝 | 某人'
        : '【人】\n2129024700 | 番茄 | 学生\n【事实】\n2129024700 | 玩怪猎\n【事】\n私下聊了 Y',
    }),
  },
}

console.log('=== 1. 私聊里能看到群里的事 ===')
ok('★ 私聊 → 带出群的长期摘要', () => {
  const s = p._crossLongDigest.call(fake, 'private:2129024700')
  assert.ok(s.includes('群里 704291282'), s)
  assert.ok(s.includes('群里聊了 X'))
  assert.ok(!s.includes('私下聊了 Y'), '不该带自己这边')
})
ok('★ 头里要写清"知道就行，别搬过去"', () => {
  const s = p._crossLongDigest.call(fake, 'private:2129024700')
  assert.match(s, /别主动把那边的事搬到这边说/)
})

console.log('\n=== 2. 群里能看到私聊的事 ===')
ok('★ 群 → 带出私聊的长期摘要，且剥掉【事实】段', () => {
  const s = p._crossLongDigest.call(fake, 'group:704291282')
  assert.ok(s.includes('私下 2129024700'), s)
  assert.ok(s.includes('私下聊了 Y'))
  assert.ok(!s.includes('【事实】'), '事实段要剥掉')
  assert.ok(!s.includes('群'), '不该带群自己的摘要')
})

console.log('\n=== 3. 异常 ===')
ok('对面没有会话 → 空串', () => {
  const only = { longMemory: { scopes: () => ['private:1'], get: () => ({ summary: 'x' }) } }
  assert.equal(p._crossLongDigest.call(only, 'private:1'), '')
})
ok('摘要是空的 → 空串', () => {
  const blank = { longMemory: { scopes: () => ['group:1', 'private:2'], get: () => ({ summary: '   ' }) } }
  assert.equal(p._crossLongDigest.call(blank, 'private:2'), '')
})
ok('没有 longMemory → 空串，不崩', () => {
  assert.equal(p._crossLongDigest.call({}, 'private:2'), '')
})

console.log('\n=== 4. 源码锁：注入点存在 ===')
ok('★ 提示词里有这一块', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /this\._crossLongDigest\(msg\.scope\)/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
