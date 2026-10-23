/**
 * 并发时序测试：走**真实 onEvent() 路径**验证过时回复检测。
 *
 * ## 为什么单独一个文件
 *
 * `check-qq.mjs` 里原有的过时测试是直接往 `mem.push()` 造消息 ——
 * 那**绕过了串行队列**，恰好掩盖了本次修的 bug：
 *
 *   同会话串行 → 第一条在 sleep/生成时，第二条的 `_handle` 还没跑，
 *   所以还没写进 mem → 读 mem 的检测永远看不到它们。
 *
 * 所以这里的每一条都必须**真的走 `onEvent()`**，让消息进入 Promise 队列，
 * 才能证明检测在真实时序下有效。
 *
 * 用法：node tests/check-concurrency.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeEvent } from '../src/qq/onebot.js'
import { QQBridge } from '../src/qq/bridge.js'
import { MemoryStore } from '../src/memory/short.js'
import { PersonaStore } from '../src/persona/store.js'
import { createDecisionLayer } from '../src/decision/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

/** 可放行的闸门 —— 用来把第一条消息精确卡在「生成中」。 */
function makeGate() {
  let release
  const promise = new Promise((r) => { release = r })
  return { promise, release }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 造一个 bridge，gateway 的第一次 stream 会卡在闸门上。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.groups] 白名单群
 * @param {string}   [opts.replyText] 生成的回复文本
 */
function makeBridge(opts = {}) {
  const sent = []
  const gate = makeGate()
  let streamCalls = 0
  /** 每次 stream 被调用时记录（用于断言「有没有真的去生成」） */
  const streamLog = []

  const fakeGateway = {
    providers: ['gemini'],
    catalog: [{ provider: 'gemini', id: 'g' }],
    stream: () => (async function* () {
      streamCalls++
      streamLog.push(streamCalls)
      // 只有**第一次**生成卡住，后面的立刻返回 —— 让测试可控
      if (streamCalls === 1) await gate.promise
      yield { type: 'text-delta', index: 0, text: opts.replyText ?? '好的' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }

  const persona = new PersonaStore({ home: path.join(root, '.test-home-qq'), active: 'default' })
  persona.init()
  const decision = createDecisionLayer(
    {
      provider: 'rule', threshold: 0.5, delay: { min: 0, max: 0 },
      rule: { cooldownMs: 0, mentionProbability: 1 },
    },
    { log: {} },
  )
  const memory = new MemoryStore({})
  const bridge = new QQBridge({
    cfg: {
      enabled: true,
      allow: { private: [], groups: opts.groups ?? ['999'], allowAllWhenEmpty: false },
    },
    onebot: {
      connected: true, on() { return this },
      sendGroup: async (g, t) => { sent.push({ group: String(g), text: String(t) }); return { status: 'ok', retcode: 0 } },
      sendPrivate: async (u, t) => { sent.push({ user: String(u), text: String(t) }); return { status: 'ok', retcode: 0 } },
    },
    gateway: fakeGateway, decision, memory, persona, log: {},
  })
  bridge.selfId = '10001'
  bridge.selfName = '蓝色大肥鱼'

  return { bridge, sent, gate, memory, streamLog, get streamCalls() { return streamCalls } }
}

/** 造一个规范化事件。@at=true 时会带 at 段。 */
function mkEv({ mid, text, at = false, groupId = 999, userId = 111, name = '小明', replyTo = null }) {
  const message = []
  if (replyTo) message.push({ type: 'reply', data: { id: String(replyTo) } })
  if (at) message.push({ type: 'at', data: { qq: '10001' } })
  message.push({ type: 'text', data: { text: (at || replyTo ? ' ' : '') + text } })
  const ev = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId,
    message_id: mid, time: Math.floor(Date.now() / 1000), sender: { card: name }, message,
  })
  ev.__normalized = ev
  return ev
}

/** 等到 gateway 的第一次 stream 真的被调用（= 第一条已进入生成）。 */
async function waitForStream(b, timeoutMs = 3000) {
  const t0 = Date.now()
  while (b.streamCalls === 0) {
    if (Date.now() - t0 > timeoutMs) throw new Error('等不到 stream 被调用')
    await sleep(5)
  }
}

/**
 * 等到入站记录里出现**指定条数**的消息。
 *
 * ⚠️ 不要用 `await sleep(30)` 等 —— 那是在赌「30ms 内 onEvent 一定跑完了
 *    入站登记」。机器慢 / 刚跑完别的测试时，30ms 不够，后两条还没登记，
 *    过时检测就看不到它们，测试偶发失败（实测 10 次里挂 2 次）。
 *
 *    这里改成轮询一个**确定的状态**：入站记录条数到了才继续。
 *    超时才算失败，且失败信息能直接看出是等不到。
 */
async function waitForInbound(bridge, scope, n, timeoutMs = 3000) {
  const t0 = Date.now()
  while (bridge._inboundAfter(scope, 0).length < n) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等不到入站记录达到 ${n} 条（当前 ${bridge._inboundAfter(scope, 0).length}）`)
    }
    await sleep(5)
  }
}

// ══════════════════════════════════════════════════════════════
console.log('=== 1. 生成期间连发两条（都没提我）→ 第一条应被判定过时 ===')
{
  const b = makeBridge({ replyText: '第一条的回复' })
  const p1 = b.bridge.onEvent(mkEv({ mid: 'c1', text: '第一个问题', at: true }))
  await waitForStream(b)

  // ⚠️ 关键：走真实 onEvent，不是 mem.push
  const p2 = b.bridge.onEvent(mkEv({ mid: 'c2', text: '另一个话题开始了', userId: 222, name: '小红' }))
  const p3 = b.bridge.onEvent(mkEv({ mid: 'c3', text: '真的换话题了', userId: 333, name: '阿强' }))
  // 等到两条都真的登记进入站记录（确定性等待，不是 sleep 赌时间）
  await waitForInbound(b.bridge, 'group:999', 3)

  // 此刻第一条仍在生成中。mem 里应该只有 1 条（串行队列阻塞）
  const mem = b.memory.get('group:999')
  check('生成期间 mem 只有 1 条（证明串行队列确实阻塞了后两条）', mem.recent().length === 1, String(mem.recent().length))

  // 但入站记录必须能看到 3 条
  const inbound = b.bridge._inboundAfter('group:999', 0)
  check('入站记录有 3 条（入口即写，不受阻塞）', inbound.length === 3, JSON.stringify(inbound.map((e) => e.seq)))

  // 过时检测能看到排队中的 2 条
  const sup = b.bridge._checkSuperseded({ scope: 'group:999', messageId: 'c1' }, mem)
  check('过时检测能看到排队中的 2 条', sup?.count === 2, JSON.stringify(sup))

  b.gate.release()
  await Promise.all([p1, p2, p3])

  check('第一条的回复没有被发出（过时被拦）', !b.sent.some((s) => s.text === '第一条的回复'), JSON.stringify(b.sent))
  check('superseded 计数为 1', b.bridge.stats.superseded === 1, String(b.bridge.stats.superseded))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. 生成期间有人 @ 我 → 不能错误丢弃 ===')
{
  const b = makeBridge({ replyText: '第一条的回复' })
  const p1 = b.bridge.onEvent(mkEv({ mid: 'd1', text: '第一个问题', at: true }))
  await waitForStream(b)

  // 两条新消息，但第二条 @ 我 —— 有人在等我
  const p2 = b.bridge.onEvent(mkEv({ mid: 'd2', text: '另一个话题', userId: 222, name: '小红' }))
  const p3 = b.bridge.onEvent(mkEv({ mid: 'd3', text: '等等 大肥鱼你说呢', at: true, userId: 333, name: '阿强' }))
  await waitForInbound(b.bridge, 'group:999', 3)

  const mem = b.memory.get('group:999')
  const sup = b.bridge._checkSuperseded({ scope: 'group:999', messageId: 'd1' }, mem)
  check('有人 @ 我 → 判定不过时', sup === null, JSON.stringify(sup))

  b.gate.release()
  await Promise.all([p1, p2, p3])

  check('第一条的回复正常发出', b.sent.some((s) => s.text === '第一条的回复'), JSON.stringify(b.sent))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. 生成期间有人引用我的回复 → 不能错误丢弃 ===')
{
  const b = makeBridge({ replyText: '我之前的回复' })
  // 先让机器人说一句，拿到它的 message_id
  const p0 = b.bridge.onEvent(mkEv({ mid: 'e0', text: '先问一句', at: true }))
  b.gate.release()          // 第一次生成放行
  await p0
  check('机器人已发出第一条', b.sent.length === 1, JSON.stringify(b.sent))

  // 取它发出去那条的 id（_send 从 onebot 返回里拿；这里 fake 没给 id，
  // 所以用 _rememberMyReplyIds 手动模拟 —— 只测「引用识别」这段逻辑）
  b.bridge._rememberMyReplyIds('group:999', ['my-reply-1'])

  // 造第二条：卡在生成中
  const gate2 = makeGate()
  let calls = 0
  b.bridge.gateway.stream = () => (async function* () {
    calls++
    if (calls === 1) await gate2.promise
    yield { type: 'text-delta', index: 0, text: '第二条回复' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()

  const p1 = b.bridge.onEvent(mkEv({ mid: 'e1', text: '第二个问题', at: true }))
  // 等它进生成
  const t0 = Date.now()
  while (calls === 0 && Date.now() - t0 < 3000) await sleep(5)

  const p2 = b.bridge.onEvent(mkEv({ mid: 'e2', text: '另一件事', userId: 222, name: '小红' }))
  // 引用我的回复
  const p3 = b.bridge.onEvent(mkEv({ mid: 'e3', text: '你刚才说的那个呢', userId: 333, name: '阿强', replyTo: 'my-reply-1' }))
  await waitForInbound(b.bridge, 'group:999', 4)

  const mem = b.memory.get('group:999')
  const sup = b.bridge._checkSuperseded({ scope: 'group:999', messageId: 'e1' }, mem)
  check('有人引用我的回复 → 判定不过时', sup === null, JSON.stringify(sup))

  gate2.release()
  await Promise.all([p1, p2, p3])
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. 多群隔离：A 群的消息不影响 B 群的过时判断 ===')
{
  const b = makeBridge({ groups: ['999', '888'], replyText: 'A群的回复' })
  const p1 = b.bridge.onEvent(mkEv({ mid: 'f1', text: 'A群的问题', at: true, groupId: 999 }))
  await waitForStream(b)

  // 另一个群连发两条（不该影响 A 群）
  const q2 = b.bridge.onEvent(mkEv({ mid: 'f2', text: 'B群说话', groupId: 888, userId: 222, name: '小红' }))
  const q3 = b.bridge.onEvent(mkEv({ mid: 'f3', text: 'B群又说', groupId: 888, userId: 333, name: '阿强' }))
  await waitForInbound(b.bridge, 'group:888', 2)

  const memA = b.memory.get('group:999')
  const sup = b.bridge._checkSuperseded({ scope: 'group:999', messageId: 'f1' }, memA)
  check('别的群的消息不影响本群判定', sup === null, JSON.stringify(sup))
  check('B 群的入站记录独立', b.bridge._inboundAfter('group:888', 0).length === 2, String(b.bridge._inboundAfter('group:888', 0).length))
  check('A 群的入站记录只有 1 条', b.bridge._inboundAfter('group:999', 0).length === 1)

  b.gate.release()
  await Promise.all([p1, q2, q3])
  check('A 群回复正常发出', b.sent.some((s) => s.text === 'A群的回复'), JSON.stringify(b.sent))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. 只有 1 条新消息 → 不到阈值，不误伤 ===')
{
  const b = makeBridge({ replyText: '正常回复' })
  const p1 = b.bridge.onEvent(mkEv({ mid: 'g1', text: '问题', at: true }))
  await waitForStream(b)
  const p2 = b.bridge.onEvent(mkEv({ mid: 'g2', text: '插一句', userId: 222, name: '小红' }))
  await waitForInbound(b.bridge, 'group:999', 2)

  const mem = b.memory.get('group:999')
  check('只有 1 条 → 判定不过时', b.bridge._checkSuperseded({ scope: 'group:999', messageId: 'g1' }, mem) === null)

  b.gate.release()
  await Promise.all([p1, p2])
  check('回复正常发出', b.sent.some((s) => s.text === '正常回复'), JSON.stringify(b.sent))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. 序号单调递增，且按 scope 独立 ===')
{
  const b = makeBridge({ groups: ['999', '888'] })
  const e1 = b.bridge._recordInbound({ scope: 'group:999', messageId: 's1', text: 'a' })
  const e2 = b.bridge._recordInbound({ scope: 'group:999', messageId: 's2', text: 'b' })
  const e3 = b.bridge._recordInbound({ scope: 'group:999', messageId: 's3', text: 'c' })
  check('同 scope 序号单调递增', e1 === 1 && e2 === 2 && e3 === 3, `${e1},${e2},${e3}`)

  const o1 = b.bridge._recordInbound({ scope: 'group:888', messageId: 's1', text: 'x' })
  check('不同 scope 各自从 1 开始', o1 === 1, String(o1))

  check('_inboundAfter 只返回该 scope 的', b.bridge._inboundAfter('group:999', 1).length === 2,
    String(b.bridge._inboundAfter('group:999', 1).length))
  check('_inboundAfter(0) 返回全部', b.bridge._inboundAfter('group:999', 0).length === 3)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. 重复事件去重仍然有效（不因入站登记而失效）===')
{
  const b = makeBridge({ replyText: '一次就好' })
  const ev1 = mkEv({ mid: 'h1', text: '问一句', at: true })
  const p1 = b.bridge.onEvent(ev1)
  await waitForStream(b)
  b.gate.release()
  await p1

  const before = b.sent.length
  // 同一条重推
  const ev2 = mkEv({ mid: 'h1', text: '问一句', at: true })
  await b.bridge.onEvent(ev2)

  check('重复事件不再回复', b.sent.length === before, `${before} → ${b.sent.length}`)
  check('duplicate 计数 +1', b.bridge.stats.duplicate === 1, String(b.bridge.stats.duplicate))
  check('重复事件也不进决策', b.bridge.stats.considered === 1, String(b.bridge.stats.considered))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. 冷却 defer 仍然有效（入站登记不干扰）===')
{
  const b = makeBridge({ replyText: '补回的回复' })
  // 换成冷却 60 秒的决策层
  b.bridge.decision = createDecisionLayer(
    { provider: 'rule', threshold: 0.5, delay: { min: 0, max: 0 }, rule: { cooldownMs: 60000, mentionProbability: 1 } },
    { log: {} },
  )
  const mem = b.memory.get('group:999')
  // ⚠️ 顺序很重要：先我发言，再**别人**发言。
  //    如果最后一条是 isMe，rule 会命中「最后一条是我自己发的」直接静默，
  //    根本走不到冷却分支 —— 我第一次就写错在这里。
  mem.push({ id: 'i0', sender: 'me', senderName: '我', text: '我刚说过话', at: Date.now() - 1000, isMe: true })
  mem.consecutiveTurns = 1

  // 不 @ 的普通消息 → 冷却中 → 应该 defer
  await b.bridge.onEvent(mkEv({ mid: 'i1', text: '普通闲聊', userId: 222, name: '小红' }))

  check('冷却期普通消息被 defer 而不是丢弃', b.bridge.stats.deferred >= 1, JSON.stringify(b.bridge.stats))
  check('defer 排队里有一条', b.bridge._deferred.size === 1, String(b.bridge._deferred.size))
  check('没有真正发出消息', b.sent.length === 0, JSON.stringify(b.sent))
  // 清掉 timer 避免拖住进程
  for (const v of b.bridge._deferred.values()) if (v.timer) clearTimeout(v.timer)
  b.bridge._deferred.clear()
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 9. 顺序：三条消息串行处理，回复顺序不乱 ===')
{
  const b = makeBridge({ replyText: '回复' })
  // 让每次生成都很快
  b.bridge.gateway.stream = () => (async function* () {
    yield { type: 'text-delta', index: 0, text: '回复' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()

  const ps = [
    b.bridge.onEvent(mkEv({ mid: 'j1', text: '第一条', at: true })),
    b.bridge.onEvent(mkEv({ mid: 'j2', text: '第二条', at: true })),
    b.bridge.onEvent(mkEv({ mid: 'j3', text: '第三条', at: true })),
  ]
  await Promise.all(ps)

  // 三条都该回复（都被 @，且过时检测因 @ 而不拦）
  check('三条都被处理并回复', b.sent.length === 3, String(b.sent.length))
  check('统计 replied=3', b.bridge.stats.replied === 3, String(b.bridge.stats.replied))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 10. 异常恢复：某条生成抛错，后续消息仍能处理 ===')
{
  const b = makeBridge({ replyText: 'ok' })
  let n = 0
  b.bridge.gateway.stream = () => (async function* () {
    n++
    if (n === 1) throw new Error('模拟生成失败')
    yield { type: 'text-delta', index: 0, text: '后续正常' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()

  await b.bridge.onEvent(mkEv({ mid: 'k1', text: '会失败的一条', at: true }))
  check('失败被计数', b.bridge.stats.failed >= 1, String(b.bridge.stats.failed))

  await b.bridge.onEvent(mkEv({ mid: 'k2', text: '之后的消息', at: true }))
  check('后续消息仍能正常回复（队列没卡死）', b.sent.some((s) => s.text === '后续正常'), JSON.stringify(b.sent))
}

console.log(`\n${'='.repeat(44)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
