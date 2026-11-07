/**
 * 撤回 + 讨钱记账（2026-11-07）。
 *
 * ## ① 「他会看见已撤回的消息」
 *
 * 消息先到、后被撤回 —— 到的时候已经进短期记忆了，甚至排进了合并窗口。
 * 如果不主动清，她照样看得见那句话、还会对着它回。
 *
 * ## ② 「貌似不知道自己去讨钱了」
 *
 * 讨钱是直接 `onebot.sendGroup`，不走正常回复那条路（那条会把"我说的话"
 * push 进记忆）。于是他对她说「你刚才讨什么钱」，她一脸茫然。
 *
 * ## ③ 「讨钱3次按照好感度前三依次吧，老是@同一个人会觉得烦」
 *
 * 一天 3 次按好感度第 1/2/3 名依次 @，不再随机挑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQBridge } from '../src/qq/bridge.js'
import { ConversationMemory } from '../src/memory/short.js'
import { BegState, InteractionTracker } from '../src/qq/beg.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-recall-'))
const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

console.log('=== 1. 短期记忆要能删一条 ===')
await ok('★ removeById 删掉指定那条，其余不动', () => {
  const m = new ConversationMemory({ maxMessages: 10 })
  m.push({ id: '111', sender: '1', text: '要撤回的' })
  m.push({ id: '222', sender: '2', text: '留着的' })
  assert.equal(m.removeById('111'), true)
  assert.deepEqual(m.recent().map((x) => x.id), ['222'])
})
await ok('★ 删不存在的返回 false', () => {
  const m = new ConversationMemory({ maxMessages: 10 })
  m.push({ id: '222', sender: '2', text: 'x' })
  assert.equal(m.removeById('999'), false)
})
await ok('★ totalPushed 不跟着减（摘要计数不能被撤回打乱）', () => {
  const m = new ConversationMemory({ maxMessages: 10 })
  m.push({ id: '111', sender: '1', text: 'a' })
  m.push({ id: '222', sender: '2', text: 'b' })
  m.removeById('111')
  assert.equal(m.totalPushed, 2)
})

console.log('\n=== 2. 撤回要把记忆和合并窗口都清掉 ===')
await ok('★ 记忆里删掉 + 合并窗口里去掉', () => {
  const removed = []
  const timer = setTimeout(() => {}, 5000)
  const b = Object.assign(Object.create(p), {
    memory: { get: () => ({ removeById: (id) => { removed.push(id); return id === '111' } }) },
    _pending: new Map([
      ['group:1::u1', { scope: 'group:1', msgs: [{ messageId: '111' }, { messageId: '222' }] }],
    ]),
    _pendingTimers: new Map([['group:1::u1', timer]]),
  })
  const r = p._dropRecalled.call(b, 'group:1', '111')
  assert.equal(r.mem, true)
  assert.equal(r.pending, 1)
  assert.deepEqual(b._pending.get('group:1::u1').msgs.map((m) => m.messageId), ['222'])
  clearTimeout(timer)
})
await ok('★ 合并窗口里被撤空了 → 整个丢掉、定时器取消', () => {
  const timer = setTimeout(() => {}, 5000)
  const b = Object.assign(Object.create(p), {
    memory: { get: () => ({ removeById: () => false }) },
    _pending: new Map([['k', { scope: 'group:1', msgs: [{ messageId: '111' }] }]]),
    _pendingTimers: new Map([['k', timer]]),
  })
  p._dropRecalled.call(b, 'group:1', '111')
  assert.equal(b._pending.has('k'), false)
  assert.equal(b._pendingTimers.has('k'), false)
  clearTimeout(timer)
})
await ok('★ 别的会话不受影响', () => {
  const b = Object.assign(Object.create(p), {
    memory: { get: () => ({ removeById: () => false }) },
    _pending: new Map([['g2', { scope: 'group:2', msgs: [{ messageId: '111' }] }]]),
    _pendingTimers: new Map(),
  })
  const r = p._dropRecalled.call(b, 'group:1', '111')
  assert.equal(r.pending, 0)
  assert.equal(b._pending.get('g2').msgs.length, 1)
})
await ok('★ 源码锁：撤回通知必须在「只处理 poke」那条 return 之前', () => {
  const iRecall = SRC.indexOf("nt === 'group_recall' || nt === 'friend_recall'")
  const iPoke = SRC.indexOf("if (nt !== 'notify' || st !== 'poke') return")
  assert.ok(iRecall > 0, '没有处理撤回的分支')
  assert.ok(iRecall < iPoke, '撤回分支排在 poke 的 return 后面 —— 永远走不到')
})

console.log('\n=== 3. 讨钱：前三名依次 @ + 写进记忆 ===')
function mkBeg(count) {
  const dir = tmp()
  const sent = []
  const pushed = []
  const b = Object.assign(Object.create(p), {
    cfg: { home: dir, search: { lowBalanceCny: 2 }, beg: { enabled: true } },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    selfId: '3039392113',
    selfName: '蓝色大肥鱼',
    onebot: {
      sendGroup: async (gid, payload) => { sent.push({ gid, payload }); return { message_id: 'm' + sent.length } },
    },
    _interactions: new InteractionTracker({}),
    _begState: new BegState({ file: path.join(dir, 'beg.json') }),
    people: { affinityOf: (id) => ({ 1001: 140, 1002: 70, 1003: 50 }[String(id)] ?? 50) },
    memory: {
      get: () => ({
        recent: () => ([
          { isMe: false, sender: '1001', senderName: 'A' },
          { isMe: false, sender: '1002', senderName: 'B' },
          { isMe: false, sender: '1003', senderName: 'C' },
        ]),
        push: (m) => pushed.push(m),
      }),
    },
  })
  b._begState.count = count
  return { b, sent, pushed }
}

for (const [count, expect, who] of [[0, '1001', '第一名'], [1, '1002', '第二名'], [2, '1003', '第三名']]) {
  await ok(`★ 今天第 ${count + 1} 次 → @${who}（${expect}）`, async () => {
    const { b, sent, pushed } = mkBeg(count)
    const r = await p._maybeBeg.call(b, { kind: 'group', groupId: '1', scope: 'group:1' }, 1.0)
    assert.equal(r, true, '没讨成')
    const at = sent[0].payload.find((x) => x.type === 'at')
    assert.equal(String(at.data.qq), expect, `@ 错了人：${at.data.qq}`)
    assert.equal(pushed.length, 1, '没写进记忆')
    assert.equal(pushed[0].isMe, true)
    assert.ok(String(pushed[0].text).includes('A') || String(pushed[0].text).includes('B') || String(pushed[0].text).includes('C'))
  })
}

await ok('★ 候选只有 2 个人时，第 3 次回到第 1 名（取模）', async () => {
  const dir = tmp()
  const sent = []
  const b = Object.assign(Object.create(p), {
    cfg: { home: dir, search: { lowBalanceCny: 2 }, beg: { enabled: true } },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    selfId: '3039392113',
    selfName: '蓝色大肥鱼',
    onebot: { sendGroup: async (gid, payload) => { sent.push({ payload }); return { message_id: 'm' } } },
    _interactions: new InteractionTracker({}),
    _begState: new BegState({ file: path.join(dir, 'beg.json') }),
    people: { affinityOf: (id) => ({ 1001: 140, 1002: 70 }[String(id)] ?? 50) },
    memory: {
      get: () => ({
        recent: () => ([
          { isMe: false, sender: '1001', senderName: 'A' },
          { isMe: false, sender: '1002', senderName: 'B' },
        ]),
        push: () => {},
      }),
    },
  })
  b._begState.count = 2
  await p._maybeBeg.call(b, { kind: 'group', groupId: '1', scope: 'group:1' }, 1.0)
  const at = sent[0].payload.find((x) => x.type === 'at')
  assert.equal(String(at.data.qq), '1001')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
