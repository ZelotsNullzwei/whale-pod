/**
 * 戳一戳判定回归测试（2026-11-19）。
 *
 * ## 现场
 * 她刚说完「才九点半啊，还早着呢。」，对方立刻戳一下，她回
 * 「催什么，这不正回着吗。」—— 明显在把"戳"当成"催"。
 *
 * 根因：戳一戳会被写进上下文一条 `（Null_zwei 戳了 蓝色大鲸鱼 一下）`，
 * `isMe=false`。于是 `_recentChatState().lastFromHim` 永远是 true，
 * 明明最后一句是她说的，也被判成"他还没被接住 → 这是催"。
 *
 * 这里锁两件事：
 *   ① 判定最近对话时**忽略戳一戳记录**；
 *   ② 喂给模型的"上文"里也**不能出现戳一戳**（否则它又会接一句"戳我干嘛"）。
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const T = Date.now()
const msg = (o = {}) => ({
  text: o.text ?? '',
  at: o.at ?? T - 1000,
  isMe: o.isMe === true,
  sender: o.sender ?? (o.isMe ? '3039392113' : '2129024700'),
  senderName: o.senderName ?? (o.isMe ? '蓝色大鲸鱼' : 'Null_zwei.'),
})
const pokeNote = (at = T) => msg({ text: '（Null_zwei. 戳了 蓝色大鲸鱼 一下）', at, isMe: false })
const mkBridge = (list) => ({
  memory: { get: () => ({ recent: () => list }) },
})

console.log('=== 1. 她刚说完一句，对方再戳：不算"催" ===')
await ok('★ lastFromHim=false（戳记录不能当"他最后一句"）', () => {
  const list = [
    msg({ text: '这么晚还不睡啊', isMe: true, at: T - 5000 }),
    msg({ text: '这才几点', isMe: false, at: T - 3000 }),
    msg({ text: '才九点半啊，还早着呢。', isMe: true, at: T - 1000 }),
    pokeNote(T),
  ]
  const st = p._recentChatState.call(mkBridge(list), 'private:2129024700')
  assert.equal(st.lastFromHim, false, '最后一句是她说的，不该判成他在等回复')
  assert.equal(st.fresh, true, '10 分钟内确实聊过')
})

await ok('lastText 是她的最后一句（不是戳记录）', () => {
  const list = [msg({ text: '才九点半啊，还早着呢。', isMe: true, at: T - 1000 }), pokeNote(T)]
  const st = p._recentChatState.call(mkBridge(list), 'private:2129024700')
  assert.equal(st.lastText, '才九点半啊，还早着呢。')
})

console.log('\n=== 2. 他发完还没被接住，再戳：算"催" ===')
await ok('★ lastFromHim=true（他的消息才是最后一条真对话）', () => {
  const list = [
    msg({ text: '在吗', isMe: false, at: T - 3000 }),
    pokeNote(T),
  ]
  const st = p._recentChatState.call(mkBridge(list), 'private:2129024700')
  assert.equal(st.lastFromHim, true)
  assert.equal(st.fresh, true)
})

console.log('\n=== 3. 只有戳记录：不算聊过 ===')
await ok('★ 只有戳 → fresh=false（走"干嘛/有事？"那条路）', () => {
  const st = p._recentChatState.call(mkBridge([pokeNote(T)]), 'private:2129024700')
  assert.equal(st.fresh, false)
  assert.equal(st.lastFromHim, false)
})

console.log('\n=== 4. 喂给模型的上文里不能有"戳" ===')
await ok('★ _pokeLine 的 user 内容不含戳记录', async () => {
  let captured = null
  const fake = {
    cfg: { model: 'magpie/magpie/auto/x' },
    memory: {
      get: () => ({
        messages: [
          msg({ text: '在吗', isMe: false, at: T - 3000 }),
          pokeNote(T),
        ],
        recent: () => [],
      }),
    },
    gateway: {
      stream: (req) => {
        captured = req
        return (async function* () {
          yield { type: 'text-delta', text: '在呢' }
        })()
      },
    },
  }
  const out = await p._pokeLine.call(fake, 'private:2129024700')
  assert.equal(out, '在呢')
  const user = captured?.messages?.find((m) => m.role === 'user')?.content ?? ''
  // 只禁"戳记录"这种系统注记；提示语里出现"戳了你一下"是允许的
  assert.ok(!/[（(][^）)]*戳了[^）)]*一下[）)]/.test(user), `上文里不该出现戳记录：${user.slice(0, 120)}`)
  assert.ok(/在吗/.test(user), '该保留真实对话')
})

await ok('★ 她最后一句时，不给"结合上文"的上下文（走短反应）', async () => {
  let captured = null
  const fake = {
    cfg: { model: 'magpie/magpie/auto/x' },
    memory: {
      get: () => ({
        messages: [
          msg({ text: '才九点半啊', isMe: true, at: T - 1000 }),
          pokeNote(T),
        ],
        recent: () => [],
      }),
    },
    gateway: {
      stream: (req) => {
        captured = req
        return (async function* () {
          yield { type: 'text-delta', text: '干嘛' }
        })()
      },
    },
  }
  const out = await p._pokeLine.call(fake, 'private:2129024700')
  assert.equal(out, '干嘛')
  const sys = captured?.messages?.find((m) => m.role === 'system')?.content ?? ''
  assert.ok(!/接着话题/.test(sys), '她刚说完就不该"接着话题说"')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)