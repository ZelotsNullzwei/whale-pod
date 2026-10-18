/**
 * 验证「引用我 = 在跟我说话」。
 *
 * 实测踩过：群里有人**直接引用机器人刚说的话**回「那还不是决策层叫你发的」，
 * 明显是在跟它对话，但 reply 段原来被丢掉了，于是这条被当普通闲聊掷骰子
 * → 一半概率沉默。用户看到的就是"明明在跟它说话，它却不理"。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = 'D:/DSH WorkSpace/whale-pod'
const imp = (p) => import(pathToFileURL(path.join(root, p)).href)

let pass = 0, fail = 0
const check = (n, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + n) }
  else { fail++; console.log('  ❌ ' + n + ' ' + extra) }
}

const { parseMessage, normalizeEvent } = await imp('src/qq/onebot.js')
const { QQBridge } = await imp('src/qq/bridge.js')
const { MemoryStore } = await imp('src/memory/short.js')

console.log('=== 1. parseMessage 能取出被引用的消息 id ===')
{
  // 数组形式
  const a = parseMessage([
    { type: 'reply', data: { id: '123456' } },
    { type: 'text', data: { text: ' 那还不是决策层叫你发的' } },
  ])
  check('数组形式取出 replyTo', a.replyTo === '123456', JSON.stringify(a))
  check('引用本身不进正文', a.text === '那还不是决策层叫你发的', JSON.stringify(a.text))

  // CQ 码形式
  const b = parseMessage('[CQ:reply,id=999]你好')
  check('CQ 码形式取出 replyTo', b.replyTo === '999', JSON.stringify(b))
  check('CQ 码引用不进正文', b.text === '你好', JSON.stringify(b.text))

  // 没有引用
  const c = parseMessage([{ type: 'text', data: { text: '随便说说' } }])
  check('没引用 → replyTo 为空串', c.replyTo === '', JSON.stringify(c))
}

console.log('\n=== 2. normalizeEvent 把 replyTo 透传出来 ===')
{
  const ev = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: 1, user_id: 2,
    message_id: 'm1', time: Math.floor(Date.now() / 1000),
    sender: { card: '甲' },
    message: [
      { type: 'reply', data: { id: 'bot-msg-1' } },
      { type: 'text', data: { text: '在吗' } },
    ],
  })
  check('透传 replyTo', ev.replyTo === 'bot-msg-1', JSON.stringify(ev.replyTo))
}

console.log('\n=== 3. 端到端：引用我的消息 → 按"被叫"处理（不再掷骰子）===')
{
  const mk = (opts = {}) => {
    const mem = new MemoryStore({})
    const scope = 'group:1'
    const m = mem.get(scope)
    // 先塞一条"我说的话"，模拟机器人之前的发言
    m.push({
      id: 'bot-msg-1', sender: '9', senderName: 'Bot', text: '测出来啥了，一堆图是吧',
      at: Date.now() - 5000, isMe: true, mentionsMe: false, images: [],
    })
    m.myLastAt = Date.now() - 1000        // 1 秒前刚说过话（**在冷却期内**）

    const sent = []
    const br0 = new QQBridge({
      cfg: { allow: { private: [], groups: ['1'], allowAllWhenEmpty: false }, model: 'auto', reply: {} },
      onebot: {
        connected: true, on() { return this },
        sendGroup: async (g, t) => { sent.push(t); return { status: 'ok', retcode: 0, data: { message_id: 'sent-1' } } },
        sendPrivate: async (u, t) => { sent.push(t); return { status: 'ok', retcode: 0, data: { message_id: 'sent-1' } } },
        call: async () => ({ data: {} }),
        fetchImage: async () => null,
      },
      gateway: {
        providers: ['fake'],
        catalog: [{ provider: 'fake', id: 'm1', inputModalities: ['text'] }],
        defaultModels: () => ({ fake: 'm1' }),
        makeImageBlock: async () => null,
        refreshCatalog: async () => [{ provider: 'fake', id: 'm1' }],
        // ⚠️ openFirstAvailable 走的是 `llm.stream({provider, model, ...})`，
        //    所以 stub 必须叫 stream（不是 open）。之前 stub 错名字导致
        //    "没有可用的 LLM 渠道"（实测踩过）。
        stream: () => (async function* () {
          yield { type: 'text-delta', text: '因为我在测表情呀' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      },
      decision: {
        // 记录决策输入，看 mentionsMe 有没有被置上
        shouldReply: async (input) => {
          opts.seen = input
          // 用真实规则层来判断
          const { RuleDecisionProvider } = await import(
            pathToFileURL(path.join(root, 'src/decision/rule.js')).href)
          const d = new RuleDecisionProvider(
            { cooldownMs: 2000, maxConsecutiveTurns: 99, mentionProbability: 1, idleChatterProbability: 0.5, delayMin: 0, delayMax: 0 },
            {},
          )
          return d.decide(input)
        },
      },
      memory: mem,
      persona: { buildSystemPrompt: () => 'SYS' },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    })
    return { br: (() => {
      // ⚠️ 必须设 selfId —— 否则 `this.selfId ? msg.isAtMe(...) : false`
      //    恒为 false，"被 @ 了"这条分支永远进不去（实测踩过这个坑，
      //    当时误以为功能坏了，其实是测试没配 selfId）。
      br0.selfId = '1000000001'
      br0.selfName = 'WhalePod'
      return br0
    })(), sent, mem }
  }

  const msg = (replyTo) => ({
    scope: 'group:1', kind: 'group', groupId: '1', userId: '2', senderName: '番茄',
    text: '那还不是决策层叫你发的', images: [], at: Date.now(),
    messageId: 'm-' + Math.random(), replyTo, isAtMe: () => false,
  })

  // ① 引用我的消息 → 必然回复（即使在冷却期内）
  {
    const { br, sent, mem } = mk()
    await br._handle(msg('bot-msg-1'))
    check('引用我的话 → 仍然回复（冷却不拦）', sent.length === 1, `发出 ${sent.length} 条`)
    // ⚠️ 注意：回复成功后，机器人自己的回复也被 push 进记忆了，
    //    所以 recent(1) 是**我的回复**。要判断被处理的那条，
    //    得往后找（这里取倒数第二条）。
    const arr = mem.get('group:1').recent(5)
    const judged = arr.filter((x) => !x.isMe).at(-1)
    check('被判断的那条 mentionsMe 为真', judged?.mentionsMe === true, JSON.stringify(judged))
  }

  // ② 引用**别人的**消息 → 不算被叫（走正常掷骰子/冷却）
  {
    const { br, sent, mem } = mk()
    await br._handle(msg('someone-else-msg'))
    const judged = mem.get('group:1').recent(5).filter((x) => !x.isMe).at(-1)
    check('引用别人的消息 → 不算被叫', judged?.mentionsMe !== true, JSON.stringify(judged))
    check('引用别人的消息 → 冷却期内沉默', sent.length === 0, `发出 ${sent.length} 条`)
  }

  // ③ 完全没有引用 → 同理不算被叫
  {
    const { br, mem } = mk()
    await br._handle(msg(''))
    const judged = mem.get('group:1').recent(5).filter((x) => !x.isMe).at(-1)
    check('没有引用 → 不算被叫', judged?.mentionsMe !== true, JSON.stringify(judged))
  }

  // ④ 回复后自己的消息带上了 id（供别人引用时匹配）
  //
  // ⚠️ 这里必须**绕开冷却**：mk() 预置了"1 秒前说过话"，
  //    而冷却阈值是 2 秒 —— 普通消息会被拦下，也就不会有回复、
  //    自然没有 id 可记。用 @ 我 的消息（走 mention 分支，不受冷却限制）。
  {
    const { br, mem } = mk()
    const ev = {
      scope: 'group:1', kind: 'group', groupId: '1', userId: '2', senderName: '番茄',
      text: '在吗', images: [], at: Date.now(), messageId: 'm-x', replyTo: '', isAtMe: () => true,
    }
    await br._handle(ev)
    const mine = mem.get('group:1').recent(5).filter((x) => x.isMe)
    check('我的回复记下了 message_id', mine.some((x) => x.id === 'sent-1'),
      JSON.stringify(mine.map((x) => ({ id: x.id, text: x.text }))))
  }
}

console.log('\n' + '='.repeat(46))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
