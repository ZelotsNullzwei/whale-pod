/**
 * 人物档案「从没落盘」的回归测试（2026-10-29 修）。
 *
 * ## 症状
 * 线上 `~/.dsh/whale-pod/people.json` **不存在**，连 `.tmp` 残留都没有 ——
 * 而 `PeopleStore` 代码完整、接线完整（`index.js:566` 构造 → `:754` 传入 →
 * `bridge.js:562` 接住）、`save()` 手工调用也正常。
 *
 * ## 根因
 * `onEvent()` 里 `msg` 是 `ev.__normalized`（`bridge.js:1237`），而
 * `normalizeEvent()` 返回的字段是 **`userId`，没有 `sender`**
 * （`onebot.js:1180-1198`）。
 *
 * 于是这一行永远不成立：
 * ```js
 * if (!msg.isMe && msg.sender) this.people?.touch(msg.sender, msg.senderName)
 * //                        ^^^^^^^^^^ undefined → 整个 touch 从未执行
 * ```
 * `touch()` 不跑 → `_dirty` 永远是 false → `flush()` 什么都不写 →
 * **重启后人物档案全丢**（进程内 `toPrompt()` 还是好的，所以不易察觉）。
 *
 * ## 这个测试怎么跑
 * 复刻 `check-qq.mjs` 的假 OneBot 套路：`normalizeEvent()` → 挂
 * `__normalized` → `bridge.onEvent()`，走的是**真实入口**，不 mock 业务逻辑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQBridge } from '../src/qq/bridge.js'
import { MemoryStore } from '../src/memory/short.js'
import { PeopleStore } from '../src/memory/person.js'
import { normalizeEvent } from '../src/qq/onebot.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

function mkBridge(home) {
  const people = new PeopleStore({ home })
  const bridge = new QQBridge({
    cfg: { allow: { private: [], groups: [], allowAllWhenEmpty: true } },
    onebot: {
      connected: true,
      on() { return this },
      getLoginInfo: async () => ({ data: { user_id: '10000', nickname: 'Bot' } }),
      sendGroup: async () => ({ status: 'ok', retcode: 0 }),
      sendPrivate: async () => ({ status: 'ok', retcode: 0 }),
    },
    gateway: {},
    // 决策直接判沉默 —— 这条测试只关心「人物档案有没有被记」，不需要走生成
    decision: { shouldReply: async () => ({ reply: false, reason: '测试：不发言' }) },
    memory: new MemoryStore(),
    people,
    log: {},
  })
  bridge.selfName = 'Bot'
  return { bridge, people }
}

/** 造一条真实形状的群消息事件（走 normalizeEvent，不手搓 __normalized）。 */
function groupEvent({ groupId = '999', userId = '111', card = '小明', text = '在吗', id = 'm1' } = {}) {
  const ev = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: Number(groupId),
    user_id: Number(userId),
    message_id: id,
    time: Math.floor(Date.now() / 1000),
    sender: { card },
    message: [{ type: 'text', data: { text } }],
  })
  ev.__normalized = ev
  return ev
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-people-'))
}

// ── ① 契约：normalizeEvent 不提供 sender（这是 bug 的成因）──────────
await ok('normalizeEvent 的字段里有 userId、没有 sender', () => {
  const n = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: 1, user_id: 222,
    message_id: 'x', time: 1, sender: { card: '甲' },
    message: [{ type: 'text', data: { text: 'hi' } }],
  })
  assert.equal(n.userId, '222', 'user 事件里 userId 必须有值')
  assert.equal('sender' in n, false, 'normalizeEvent 不应有 sender 字段 —— 这正是 bug 的成因')
})

// ── ② 核心回归：群消息进来，人物档案要被记下 ────────────────────────
await ok('群消息进来 → 人物档案里出现这个人（按 QQ 号）', async () => {
  const home = tmpHome()
  const { bridge, people } = mkBridge(home)
  await bridge.onEvent(groupEvent({ userId: '111', card: '小明' }))
  assert.equal(people.people.size, 1, `应当记下 1 个人，实际 ${people.people.size} 个`)
  assert.ok(people.people.has('u:111'), `应以 u:111 为 key，实际 keys=${[...people.people.keys()]}`)
})

await ok('两个人 → 两条档案，不串', async () => {
  const home = tmpHome()
  const { bridge, people } = mkBridge(home)
  await bridge.onEvent(groupEvent({ userId: '111', card: '小明', id: 'a' }))
  await bridge.onEvent(groupEvent({ userId: '222', card: '小红', id: 'b' }))
  assert.equal(people.people.size, 2)
  assert.ok(people.people.has('u:111') && people.people.has('u:222'))
})

await ok('私聊消息也要记（私聊带 userId）', async () => {
  const home = tmpHome()
  const { bridge, people } = mkBridge(home)
  const ev = normalizeEvent({
    post_type: 'message', message_type: 'private', user_id: 333,
    message_id: 'p1', time: Math.floor(Date.now() / 1000),
    sender: { nickname: '私聊甲' },
    message: [{ type: 'text', data: { text: '在吗' } }],
  })
  ev.__normalized = ev
  await bridge.onEvent(ev)
  assert.ok(people.people.has('u:333'), `私聊也要记，实际 keys=${[...people.people.keys()]}`)
})

// ── ③ 落盘：flush 之后磁盘上必须有 people.json ─────────────────────
await ok('flush() 之后 people.json 真的存在且内容正确', async () => {
  const home = tmpHome()
  const { bridge, people } = mkBridge(home)
  await bridge.onEvent(groupEvent({ userId: '111', card: '小明' }))
  people.flush()
  const file = path.join(home, 'people.json')
  assert.ok(fs.existsSync(file), 'people.json 应被写出 —— 「从没落盘」正是线上症状')
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(j.people?.['u:111'], `文件里应有 u:111，实际 keys=${Object.keys(j.people ?? {})}`)
})

await ok('新进程能读回上一个人物档案（重启不丢）', async () => {
  const home = tmpHome()
  const a = mkBridge(home)
  await a.bridge.onEvent(groupEvent({ userId: '111', card: '小明' }))
  a.people.save()
  // 模拟重启：同一目录重新构造
  const b = new PeopleStore({ home })
  assert.ok(b.people.has('u:111'), '重启后应能读回 u:111')
})

// ── ④ 源码锁：不许再用 msg.sender ──────────────────────────────────
await ok('源码锁：onEvent 里的 people.touch 必须用 userId 兜底', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'qq', 'bridge.js'), 'utf8')
  const lines = src.split('\n').map((l) => l.trim())
  const idx = lines.findIndex((l) => l.includes('this.people?.touch('))
  assert.ok(idx >= 0, '应能找到 people.touch 调用')
  const line = lines[idx]
  assert.match(line, /msg\.userId/, `必须传 msg.userId（normalizeEvent 只给这个），实际：${line}`)
  assert.ok(!/touch\(msg\.sender\b/.test(line), `不能再直接传 msg.sender（undefined），实际：${line}`)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)