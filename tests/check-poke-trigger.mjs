/**
 * 戳一戳**触发条件**的端到端测试（2026-11-19）。
 *
 * 现场：
 *   她「才九点半啊，还早着呢。」 → 对方戳一下 → 她「催什么，这不正回着吗。」
 *
 * 这条测试直接跑 `_onNotice` 的 poke 分支，只替换外部依赖
 * （gateway / onebot / memory），验证：
 *   · 她最后一句 + 戳  → **不走进"催"分支**
 *   · 他最后一句 + 戳  → **才走进"催"分支**
 *   · 超过 10 分钟      → 也不走进"催"分支
 *
 * 之前就是第一种被错误地判成"催"，才会蹦出「催什么」。
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
  sender: o.isMe ? '10001' : '2129024700',
  senderName: o.isMe ? '蓝色大鲸鱼' : 'Null_zwei.',
})
const pokeNote = (at = T) => msg({ text: '（Null_zwei. 戳了 蓝色大鲸鱼 一下）', at, isMe: false })

/**
 * 造一个只够跑 poke 分支的 bridge。
 * @param {Array} messages 记忆里的消息（时间正序）
 */
function mkBridge(messages) {
  const sent = []
  const counters = { speakUp: 0, pokeLine: 0 }
  return {
    sent,
    counters,
    stats: {},
    selfId: '10001',
    selfName: '蓝色大鲸鱼',
    cfg: { poke: { chance: 1 } },
    log: { info() {}, warn() {}, debug() {} },
    allowed: () => true,
    memory: {
      get: () => ({
        messages,
        recent: () => messages,
        push() {},
      }),
    },
    _memOf: () => ({ messages, recent: () => messages, push() {} }),
    _nameFromMemory: () => 'Null_zwei.',
    _typing: new Map(),
    _recordPoke() {},
    // 关键：这两条用真实实现 / 可观察的桩
    _recentChatState: p._recentChatState,
    _speakUp: async () => {
      counters.speakUp += 1
      // 模拟"接不上"——旧版会因此退回 _pokeLine，正好复现现场
      return false
    },
    _pokeLine: async () => {
      counters.pokeLine += 1
      return '干嘛'
    },
    _send: async (_m, text) => {
      sent.push(text)
      return []
    },
  }
}

/** 造一条"对方戳她"的通知。 */
const pokeEvent = () => ({
  post_type: 'notice',
  notice_type: 'notify',
  sub_type: 'poke',
  user_id: '2129024700',
  target_id: '10001',
})

console.log('=== 1. 她刚说完话 → 不该走"催" ===')
await ok('★ _speakUp 一次都不该被调用', async () => {
  const br = mkBridge([
    msg({ text: '这才几点', isMe: false, at: T - 30_000 }),
    msg({ text: '才九点半啊，还早着呢。', isMe: true, at: T - 5000 }),
    pokeNote(T),
  ])
  await p._onNotice.call(br, pokeEvent())
  assert.equal(br.counters.speakUp, 0, '她刚说完，戳不是催，不该走接话分支')
  assert.equal(br.counters.pokeLine, 1, '应该走常规的短反应')
  assert.deepEqual(br.sent, ['干嘛'])
})

console.log('\n=== 2. 他发完没被接住 → 才算"催" ===')
await ok('★ _speakUp 被调用（走催的分支）', async () => {
  const br = mkBridge([
    msg({ text: '在吗', isMe: false, at: T - 5000 }),
    pokeNote(T),
  ])
  await p._onNotice.call(br, pokeEvent())
  assert.equal(br.counters.speakUp, 1, '他的消息还没被接住，戳=催，应该尝试接话')
})

console.log('\n=== 3. 超过 10 分钟 → 不算"催" ===')
await ok('★ 老对话之后的戳：_speakUp 不调用', async () => {
  const br = mkBridge([
    msg({ text: '在吗', isMe: false, at: T - 20 * 60_000 }),
    pokeNote(T),
  ])
  await p._onNotice.call(br, pokeEvent())
  assert.equal(br.counters.speakUp, 0)
  assert.equal(br.counters.pokeLine, 1)
})

console.log('\n=== 4. 复现旧 bug：若把戳记录当"他的话" ===')
await ok('★ 旧口径（不过滤戳记录）→ lastFromHim=true，等价于会触发', () => {
  const list = [
    msg({ text: '才九点半啊，还早着呢。', isMe: true, at: T - 5000 }),
    pokeNote(T),
  ]
  // 旧实现等价于直接看最后一条
  const oldLastFromHim = !list[list.length - 1].isMe
  assert.equal(oldLastFromHim, true, '旧逻辑必然判成"他最后说的"，这就是触发条件')
  // 新实现
  const st = p._recentChatState.call({ memory: { get: () => ({ recent: () => list }) } }, 'private:2129024700')
  assert.equal(st.lastFromHim, false, '新逻辑不该判成他最后说的')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)