/**
 * QQ 桥接测试：用假的 OneBot 事件驱动完整链路（不起真协议端）。
 * 用法：node tests/check-qq.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMessage, normalizeEvent } from '../src/qq/onebot.js'
import { QQBridge, splitMessage, SILENT } from '../src/qq/bridge.js'
import { MemoryStore } from '../src/memory/short.js'
import { LongTermStore } from '../src/memory/long.js'
import { PersonaStore } from '../src/persona/store.js'
import { createDecisionLayer } from '../src/decision/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

console.log('=== 1. CQ 码解析 ===')
{
  const r = parseMessage('[CQ:at,qq=12345] 你好啊[CQ:face,id=1]')
  check('提取 @ 的 QQ', r.mentions.includes('12345'), JSON.stringify(r.mentions))
  check('文本保留', r.text.includes('你好啊'), r.text)
  // 表情现在带 id —— QQ 内置表情 id 固定，模型能据此判断情绪
  // （早先是笼统的 [表情]，模型看不出是"得意"还是"惊讶"）
  check('表情带 id 占位', r.text.includes('[表情:1]'), r.text)
  check('isAtMe 正确', r.isAtMe('12345') === true && r.isAtMe('999') === false)
}

console.log('\n=== 2. 数组格式解析 ===')
{
  const r = parseMessage([
    { type: 'at', data: { qq: '111' } },
    { type: 'text', data: { text: ' 在吗' } },
    { type: 'image', data: { url: 'http://x/y.png' } },
  ])
  check('mentions', r.mentions.includes('111'))
  check('文本', /在吗/.test(r.text), r.text)
  check('图片', r.images.length === 1, JSON.stringify(r.images))
}

console.log('\n=== 3. 事件标准化 ===')
{
  const ev = {
    post_type: 'message', message_type: 'group', group_id: 999, user_id: 111,
    message_id: 'm1', time: 1700000000,
    sender: { card: '小明', nickname: 'xm' },
    message: [{ type: 'at', data: { qq: '222' } }, { type: 'text', data: { text: ' 你好' } }],
  }
  const n = normalizeEvent(ev)
  check('scope', n.scope === 'group:999', n.scope)
  check('昵称优先用群名片', n.senderName === '小明', n.senderName)
  check('@我判断', n.isAtMe('222') === true)
  check('时间转换', n.at === 1700000000000, String(n.at))
}

console.log('\n=== 4. 消息分句 ===')
{
  const long = '第一句话。第二句话！第三句话？'.repeat(30)
  const parts = splitMessage(long, 50)
  check('拆成多条', parts.length > 1, String(parts.length))
  check('每条都在上限内', parts.every((p) => p.length <= 50), JSON.stringify(parts.map((p) => p.length)))
  check('短消息不拆', splitMessage('你好', 100).length === 1)
}

console.log('\n=== 5. 白名单（fail-closed） ===')
{
  const mk = (cfg) => new QQBridge({
    cfg, onebot: {}, gateway: {}, decision: {}, memory: new MemoryStore(), log: {},
  })
  const closed = mk({ allow: { private: [], groups: [], allowAllWhenEmpty: false } })
  check('空白名单 → 拒绝群消息', closed.allowed({ kind: 'group', groupId: '1' }) === false)
  check('空白名单 → 拒绝私聊', closed.allowed({ kind: 'private', userId: '1' }) === false)

  const open = mk({ allow: { private: [], groups: [], allowAllWhenEmpty: true } })
  check('空白名单 + allowAll → 放行', open.allowed({ kind: 'group', groupId: '1' }) === true)

  const wl = mk({ allow: { private: ['5'], groups: ['9'], allowAllWhenEmpty: true } })
  check('白名单内群 → 放行', wl.allowed({ kind: 'group', groupId: '9' }) === true)
  check('白名单外群 → 拒绝', wl.allowed({ kind: 'group', groupId: '8' }) === false)
  check('白名单内私聊 → 放行', wl.allowed({ kind: 'private', userId: '5' }) === true)
}

console.log('\n=== 6. 端到端：消息 → 决策 → 生成 → 发送 ===')
{
  // 假 OneBot：记录发出去的消息
  const sent = []
  const fakeOnebot = {
    connected: true,
    on() { return this },
    getLoginInfo: async () => ({ data: { user_id: '10001', nickname: 'WhalePod' } }),
    sendGroup: async (g, t) => { sent.push({ g, t }); return { status: 'ok', retcode: 0 } },
    sendPrivate: async (u, t) => { sent.push({ u, t }); return { status: 'ok', retcode: 0 } },
  }

  // 假 LLM：返回固定文本，并记录被调用的 prompt
  let lastMessages = null
  const fakeGateway = {
    providers: ['gemini'],
    catalog: [],
    stream(options) {
      lastMessages = options.messages
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '在的，咋了' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }

  const home = path.join(root, '.test-home-qq')
  const memory = new MemoryStore({ short: { maxMessages: 20 } })
  const persona = new PersonaStore({ home, active: 'default' })
  persona.init()
  const decision = createDecisionLayer(
    { provider: 'rule', threshold: 0.5, delay: { min: 0, max: 0 }, rule: { cooldownMs: 0, mentionProbability: 1 } },
    { log: {} },
  )

  const bridge = new QQBridge({
    cfg: {
      enabled: true,
      allow: { private: [], groups: ['999'], allowAllWhenEmpty: false },
      reply: { segment: false, maxChars: 500 },
      model: 'free/gemini/gemini-3.8-flash-medium',
    },
    onebot: fakeOnebot,
    gateway: fakeGateway,
    decision,
    memory,
    longMemory: null,
    persona,
    log: {},
  })
  bridge.selfId = '10001'
  bridge.selfName = 'WhalePod'

  const ev = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: 999, user_id: 111,
    message_id: 'm1', time: Math.floor(Date.now() / 1000),
    sender: { card: '小明' },
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 在吗' } }],
  })
  ev.__normalized = ev

  await bridge.onEvent(ev)

  check('发出了一条消息', sent.length === 1, JSON.stringify(sent))
  check('内容正确', sent[0]?.t === '在的，咋了', JSON.stringify(sent[0]))
  check('发到了正确的群', String(sent[0]?.g) === '999')
  check('统计：收到 1', bridge.stats.received === 1)
  check('统计：回复 1', bridge.stats.replied === 1)
  check('记忆里有 2 条（用户 + 自己）', memory.get('group:999').recent().length === 2,
    String(memory.get('group:999').recent().length))
  // content 现在是 block 数组（为了支持图片），所以要展平成文本再断言
  const flat = (c) => Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : String(c ?? '')
  check('prompt 里含人格', flat(lastMessages?.[0]?.content).includes('WhalePod'))
  check('prompt 里含对话', lastMessages?.some((m) => flat(m.content).includes('在吗')),
    JSON.stringify(lastMessages?.map((m) => flat(m.content).slice(0, 40))))
}

console.log('\n=== 7. 决策为「不说」时不发消息 ===')
{
  const sent = []
  const fakeOnebot = {
    connected: true, on() { return this },
    sendGroup: async (g, t) => { sent.push(t); return { status: 'ok', retcode: 0 } },
  }
  const fakeGateway = { providers: ['gemini'], catalog: [], stream: () => (async function* () { })() }
  const memory = new MemoryStore({})
  const persona = new PersonaStore({ home: path.join(root, '.test-home-qq'), active: 'default' })
  persona.init()
  // 规则：连续发言 3 轮 → 不说
  const decision = createDecisionLayer(
    { provider: 'rule', threshold: 0.5, delay: { min: 0, max: 0 }, rule: { maxConsecutiveTurns: 1 } },
    { log: {} },
  )
  const bridge = new QQBridge({
    cfg: { enabled: true, allow: { private: [], groups: ['999'], allowAllWhenEmpty: false } },
    onebot: fakeOnebot, gateway: fakeGateway, decision, memory, persona, log: {},
  })
  bridge.selfId = '10001'
  const mem = memory.get('group:999')
  mem.consecutiveTurns = 5

  const ev = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: 999, user_id: 111,
    message_id: 'm2', time: Math.floor(Date.now() / 1000), sender: { card: '小明' },
    message: [{ type: 'text', data: { text: '哈哈' } }],
  })
  ev.__normalized = ev
  await bridge.onEvent(ev)
  check('没发消息', sent.length === 0, JSON.stringify(sent))
  check('统计：沉默 1', bridge.stats.silent === 1, String(bridge.stats.silent))
}

console.log('\n=== 8. 模型输出 [SILENT] 时不发消息 ===')
{
  const sent = []
  const fakeOnebot = {
    connected: true, on() { return this },
    sendGroup: async (g, t) => { sent.push(t); return { status: 'ok', retcode: 0 } },
  }
  const fakeGateway = {
    providers: ['gemini'], catalog: [],
    stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: SILENT }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const memory = new MemoryStore({})
  const persona = new PersonaStore({ home: path.join(root, '.test-home-qq'), active: 'default' })
  persona.init()
  const decision = createDecisionLayer(
    { provider: 'rule', threshold: 0.5, delay: { min: 0, max: 0 }, rule: { cooldownMs: 0, mentionProbability: 1 } },
    { log: {} },
  )
  const bridge = new QQBridge({
    cfg: { enabled: true, allow: { private: [], groups: ['999'], allowAllWhenEmpty: false } },
    onebot: fakeOnebot, gateway: fakeGateway, decision, memory, persona, log: {},
  })
  bridge.selfId = '10001'
  const ev = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: 999, user_id: 111,
    message_id: 'm3', time: Math.floor(Date.now() / 1000), sender: { card: '小明' },
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 说点啥' } }],
  })
  ev.__normalized = ev
  await bridge.onEvent(ev)
  check('模型说 SILENT → 不发送', sent.length === 0, JSON.stringify(sent))
  check('统计：沉默计数增加', bridge.stats.silent === 1)
}

// ── 8b. [SILENT] 混在内容里时，只剥标记、别丢整条 ─────────────
//
// ⚠️ 踩过的坑：原来是 `text.includes(SILENT)` —— 只要出现就整条丢弃。
//    而模型常这样回「[表情包][SILENT]」，于是**决定发言也被当成沉默**，
//    一个字都发不出去。症状：界面显示「发言 p=0.95」但 outcome 是
//    model-silent，replied 一直是 0。
console.log('\n=== 8b. [SILENT] 混在内容里 → 剥掉标记照常发 ===')
{
  const cases = [
    ['纯 SILENT', SILENT, 0, '整条是标记 → 不发'],
    ['表情+SILENT', '[表情包][SILENT]', 1, '剥掉标记后还有内容 → 要发'],
    ['文字+SILENT', '好了[SILENT]', 1, '同上'],
    ['SILENT+表情', '[SILENT][表情:4]', 1, '同上'],
    ['大小写变体', '好的[ silent ]', 1, '变体也要剥掉'],
    ['全角括号', '嗯[［SILENT］]', 1, '全角也认（剥完还剩「嗯」→ 发）'],
  ]
  for (const [label, out, wantSent, note] of cases) {
    const sent = []
    const fakeGateway = {
      providers: ['gemini'], catalog: [],
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: out }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }
    const persona = new PersonaStore({ home: path.join(root, '.test-home-qq'), active: 'default' })
    persona.init()
    const decision = createDecisionLayer(
      { provider: 'rule', threshold: 0.5, delay: { min: 0, max: 0 }, rule: { cooldownMs: 0, mentionProbability: 1 } },
      { log: {} },
    )
    const bridge = new QQBridge({
      cfg: { enabled: true, allow: { private: [], groups: ['999'], allowAllWhenEmpty: false } },
      onebot: {
        connected: true, on() { return this },
        sendGroup: async (g, t) => { sent.push(t); return { status: 'ok', retcode: 0 } },
      },
      gateway: fakeGateway, decision, memory: new MemoryStore({}), persona, log: {},
    })
    bridge.selfId = '10001'
    const ev = normalizeEvent({
      post_type: 'message', message_type: 'group', group_id: 999, user_id: 111,
      message_id: 'm3b', time: Math.floor(Date.now() / 1000), sender: { card: '小明' },
      message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 说点啥' } }],
    })
    ev.__normalized = ev
    await bridge.onEvent(ev)
    const ok = sent.length === wantSent
    check(`${label} → ${note}`, ok, `实际发出 ${sent.length} 条：${JSON.stringify(sent)}`)
    if (wantSent > 0) {
      check(`${label} → 发出的内容里没有 SILENT 残留`,
        !JSON.stringify(sent).match(/silent/i), JSON.stringify(sent))
    }
  }
}

console.log('\n=== 9. 白名单外的消息被丢弃 ===')
{
  const fakeOnebot = { connected: true, on() { return this }, sendGroup: async () => ({ status: 'ok' }) }
  const memory = new MemoryStore({})
  const persona = new PersonaStore({ home: path.join(root, '.test-home-qq'), active: 'default' })
  persona.init()
  const decision = createDecisionLayer({ provider: 'rule' }, { log: {} })
  const bridge = new QQBridge({
    cfg: { enabled: true, allow: { private: [], groups: ['999'], allowAllWhenEmpty: false } },
    onebot: fakeOnebot, gateway: {}, decision, memory, persona, log: {},
  })
  bridge.selfId = '10001'
  const ev = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: 888, user_id: 111,
    message_id: 'm4', time: Math.floor(Date.now() / 1000), sender: { card: '小明' },
    message: [{ type: 'text', data: { text: 'hello' } }],
  })
  ev.__normalized = ev
  await bridge.onEvent(ev)
  check('丢弃计数', bridge.stats.dropped === 1, String(bridge.stats.dropped))
  check('没有进入决策', bridge.stats.considered === 0)
}

console.log('\n=== 10. 记忆层：连续发言与冷却 ===')
{
  const memory = new MemoryStore({ short: { maxMessages: 5 } })
  const m = memory.get('group:1')
  for (let i = 0; i < 10; i++) {
    m.push({ sender: 'u', senderName: 'u', text: `消息${i}`, at: Date.now(), isMe: false })
  }
  check('短期窗口不超过上限', m.recent().length === 5, String(m.recent().length))
  check('保留的是最新的', m.recent().at(-1).text === '消息9', m.recent().at(-1).text)

  m.push({ sender: 'me', text: '我说话', at: Date.now(), isMe: true })
  check('我发言后轮数 +1', m.consecutiveTurns === 1)
  m.push({ sender: 'me', text: '又说', at: Date.now(), isMe: true })
  check('再发言轮数 +2', m.consecutiveTurns === 2)
  check('sinceMyLast 很小', m.sinceMyLast() < 100)
}

console.log('\n=== 11. 长期记忆：摘要触发 ===')
{
  const home = path.join(root, '.test-home-qq')
  let summarizeCalls = 0
  const lt = new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 3 },
    home,
    summarize: async ({ messages, previous }) => {
      summarizeCalls++
      return `（摘要）共 ${messages.length} 条；之前：${previous || '无'}`
    },
    log: {},
  })
  const ctx = { messages: [1, 2, 3, 4], scene: { kind: 'group' }, self: {} }
  const did = await lt.maybeSummarize('group:1', ctx)
  check('触发了摘要', did === true)
  check('摘要已保存', lt.get('group:1').summary.includes('摘要'))
  check('只在超阈值时触发', summarizeCalls === 1)

  // 再调一次：消息数没增加（已摘要到 4），不应再触发
  const did2 = await lt.maybeSummarize('group:1', ctx)
  check('未超过新阈值 → 不再触发', did2 === false)
}

// ── 12. 重复事件去重（平台重推同一条消息）────────────────────
//
// ⚠️ 踩过的坑：协议端重连/重试时会把同一条消息再推一遍。
//    原来只在写记忆时判重，**决策和发送照样跑第二遍** ——
//    群里看到的就是机器人把同一句话回了两次。
console.log('\n=== 12. 重复事件去重 ===')
{
  const sent = []
  const fakeGateway = {
    providers: ['gemini'], catalog: [],
    stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: '好的' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const memory = new MemoryStore({})
  const persona = new PersonaStore({ home: path.join(root, '.test-home-qq'), active: 'default' })
  persona.init()
  const decision = createDecisionLayer(
    { provider: 'rule', threshold: 0.5, delay: { min: 0, max: 0 }, rule: { cooldownMs: 0, mentionProbability: 1 } },
    { log: {} },
  )
  const bridge = new QQBridge({
    cfg: { enabled: true, allow: { private: [], groups: ['999'], allowAllWhenEmpty: false } },
    onebot: {
      connected: true, on() { return this },
      sendGroup: async (g, t) => { sent.push(t); return { status: 'ok', retcode: 0 } },
    },
    gateway: fakeGateway, decision, memory, persona, log: {},
  })
  bridge.selfId = '10001'

  const mkEv = (mid) => {
    const ev = normalizeEvent({
      post_type: 'message', message_type: 'group', group_id: 999, user_id: 111,
      message_id: mid, time: Math.floor(Date.now() / 1000), sender: { card: '小明' },
      message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 说点啥' } }],
    })
    ev.__normalized = ev
    return ev
  }

  await bridge.onEvent(mkEv('dup-1'))
  const afterFirst = sent.length
  check('第一条正常回复', afterFirst >= 1, String(afterFirst))

  // 同一个 messageId 再来一次（平台重推）
  await bridge.onEvent(mkEv('dup-1'))
  check('重推同一条 → 不再发送', sent.length === afterFirst, `第一次 ${afterFirst}，现在 ${sent.length}`)
  check('重复计数 +1', bridge.stats.duplicate === 1, String(bridge.stats.duplicate))

  // 不同 messageId 正常放行
  await bridge.onEvent(mkEv('dup-2'))
  check('新 messageId → 正常处理', sent.length > afterFirst, String(sent.length))

  // 不同群 + 相同 messageId 不该被误杀（messageId 按群各自编号）
  const ev2 = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: 777, user_id: 222,
    message_id: 'dup-1', time: Math.floor(Date.now() / 1000), sender: { card: '小红' },
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 在吗' } }],
  })
  ev2.__normalized = ev2
  bridge.cfg.allow.groups.push('777')
  const before = sent.length
  await bridge.onEvent(ev2)
  check('别的群用相同 messageId → 不被误杀', sent.length > before, String(sent.length))
}

// ── 13. 过时回复：群里聊开了、没人等我 → 放弃发送 ─────────────
//
// ⚠️ 真人遇到这种情况会先看一眼新内容再开口。原来不管，
//    延迟+生成几十秒后照发，群友看到的就是答非所问。
console.log('\n=== 13. 过时回复检测 ===')
{
  const mkBridge = () => {
    const memory = new MemoryStore({})
    const bridge = new QQBridge({
      cfg: { enabled: true, allow: { private: [], groups: ['999'], allowAllWhenEmpty: false } },
      onebot: { connected: true, on() { return this }, sendGroup: async () => ({ status: 'ok' }) },
      gateway: {}, decision: {}, memory, log: {},
    })
    bridge.selfId = '10001'
    return { bridge, memory }
  }

  // 场景 A：后面来了 2 条且没提我 → 判定过时
  {
    const { bridge, memory } = mkBridge()
    const mem = memory.get('group:999')
    mem.push({ id: 'x1', sender: 'u1', senderName: '甲', text: '问题', at: Date.now() })
    mem.push({ id: 'x2', sender: 'u2', senderName: '乙', text: '另一个话题', at: Date.now() })
    mem.push({ id: 'x3', sender: 'u3', senderName: '丙', text: '嗯嗯', at: Date.now() })
    const r = bridge._checkSuperseded({ messageId: 'x1' }, mem)
    check('后面 2 条且没提我 → 过时', r !== null, JSON.stringify(r))
    check('  报告了条数', r?.count === 2, JSON.stringify(r))
  }

  // 场景 B：新消息里有人提到我 → 不过时（还在等我）
  {
    const { bridge, memory } = mkBridge()
    const mem = memory.get('group:999')
    mem.push({ id: 'y1', sender: 'u1', senderName: '甲', text: '问题', at: Date.now() })
    mem.push({ id: 'y2', sender: 'u2', senderName: '乙', text: '插一句', at: Date.now() })
    mem.push({ id: 'y3', sender: 'u3', senderName: '丙', text: '肥鱼你说呢', at: Date.now(), mentionsMe: true })
    check('新消息里提到我 → 不过时', bridge._checkSuperseded({ messageId: 'y1' }, mem) === null)
  }

  // 场景 C：新消息引用了我的回复 → 不过时
  {
    const { bridge, memory } = mkBridge()
    const mem = memory.get('group:999')
    mem.push({ id: 'z1', sender: 'u1', senderName: '甲', text: '问题', at: Date.now() })
    mem.push({ id: 'z2', sender: 'u2', senderName: '乙', text: '补充', at: Date.now() })
    mem.push({ id: 'z3', sender: 'u3', senderName: '丙', text: '接着问', at: Date.now(), replyTo: 'z1' })
    check('新消息引用了我 → 不过时', bridge._checkSuperseded({ messageId: 'z1' }, mem) === null)
  }

  // 场景 D：只有 1 条新消息 → 不到阈值，不过时
  {
    const { bridge, memory } = mkBridge()
    const mem = memory.get('group:999')
    mem.push({ id: 'w1', sender: 'u1', senderName: '甲', text: '问题', at: Date.now() })
    mem.push({ id: 'w2', sender: 'u2', senderName: '乙', text: '一句', at: Date.now() })
    check('只多了 1 条 → 不过时（不误伤）', bridge._checkSuperseded({ messageId: 'w1' }, mem) === null)
  }

  // 场景 E：我自己后面又说了话 → 不算别人插话
  {
    const { bridge, memory } = mkBridge()
    const mem = memory.get('group:999')
    mem.push({ id: 'v1', sender: 'u1', senderName: '甲', text: '问题', at: Date.now() })
    mem.push({ id: 'v2', sender: 'me', senderName: '我', text: '我的回复', at: Date.now(), isMe: true })
    mem.push({ id: 'v3', sender: 'me', senderName: '我', text: '再说一句', at: Date.now(), isMe: true })
    check('只有我自己的后续消息 → 不过时', bridge._checkSuperseded({ messageId: 'v1' }, mem) === null)
  }
}

console.log(`\n${'='.repeat(40)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
