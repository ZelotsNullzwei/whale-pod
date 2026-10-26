/**
 * 短期记忆落盘测试。
 *
 * 覆盖 2026-10-26 修的 bug：短期记忆原来是纯内存的，重启即清零，
 * 导致「它刚说要去吃饭，重启后就不认账」这种断片。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore, makeMessage, ConversationMemory } from '../src/memory/short.js'

let pass = 0
let fail = 0
const dir = path.join(os.tmpdir(), 'wp-short-test-' + Date.now())
fs.mkdirSync(dir, { recursive: true })
const log = { info: () => {}, warn: () => {} }

async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

await ok('makeMessage 保留 provider/model（assistant 必需）', () => {
  const m = makeMessage({ sender: '0', text: 'x', isMe: true, provider: 'magpie', model: 'flash' })
  assert.equal(m.provider, 'magpie')
  assert.equal(m.model, 'flash')
})

await ok('写入后能落盘并重启恢复', () => {
  const a = new MemoryStore({ maxMessages: 30, dir, log })
  a.load()
  const mem = a.get('private:1')
  mem.push({ sender: '0', senderName: '鱼', text: '我去吃饭了', isMe: true, at: Date.now() - 60000, provider: 'p', model: 'm' })
  mem.push({ sender: '9', senderName: '人', text: '吃', isMe: false, at: Date.now() - 5000 })
  a.save()

  const b = new MemoryStore({ maxMessages: 30, dir, log })
  b.load()
  const got = b.get('private:1').recent()
  assert.equal(got.length, 2, '应恢复 2 条')
  assert.ok(got.some((m) => m.isMe && m.text === '我去吃饭了'), 'isMe 那条要在')
  assert.ok(got.some((m) => m.provider === 'p'), 'provider 要保住')
})

await ok('过老的消息载入时丢弃', () => {
  const d2 = path.join(dir, 'old')
  fs.mkdirSync(d2, { recursive: true })
  const a = new MemoryStore({ maxMessages: 30, maxAgeMs: 60_000, dir: d2, log })
  a.load()
  a.get('g:1').push({ sender: '9', text: '很久以前', isMe: false, at: Date.now() - 10 * 3600_000 })
  a.save()
  const b = new MemoryStore({ maxMessages: 30, maxAgeMs: 60_000, dir: d2, log })
  b.load()
  assert.equal(b.get('g:1').messages.length, 0, '超过 maxAgeMs 的应丢掉')
})

await ok('clear 也要落盘（否则重启又回来）', () => {
  const d3 = path.join(dir, 'clr')
  fs.mkdirSync(d3, { recursive: true })
  const a = new MemoryStore({ maxMessages: 30, dir: d3, log })
  a.load()
  a.get('g:2').push({ sender: '9', text: 'hi', isMe: false })
  a.save()
  a.clear('g:2')
  const b = new MemoryStore({ maxMessages: 30, dir: d3, log })
  b.load()
  assert.equal(b.get('g:2').messages.length, 0)
})

await ok('push 会触发 onChange（宿主据此落盘）', () => {
  const store = new MemoryStore({ maxMessages: 30, dir, log })
  store.load()
  let called = 0
  const m = store.get('g:3')
  m.onChange = () => called++
  m.push({ sender: '9', text: 'x', isMe: false })
  assert.equal(called, 1, 'push 后要通知一次')
})

await ok('没有 dir 时纯内存、不报错', () => {
  const s = new MemoryStore({ maxMessages: 30, dir: '', log })
  s.load()
  s.get('g:4').push({ sender: '9', text: 'x', isMe: false })
  s.save()   // 不该抛
  assert.equal(s.file, null)
})

await ok('totalPushed 跨重启保留（长期摘要基准）', () => {
  const d4 = path.join(dir, 'tp')
  fs.mkdirSync(d4, { recursive: true })
  const a = new MemoryStore({ maxMessages: 30, dir: d4, log })
  a.load()
  const m = a.get('g:5')
  for (let i = 0; i < 5; i++) m.push({ sender: '9', text: 'x' + i, isMe: false })
  a.save()
  const b = new MemoryStore({ maxMessages: 30, dir: d4, log })
  b.load()
  assert.equal(b.get('g:5').totalPushed, 5, '累计计数要保住')
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)