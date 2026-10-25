/**
 * 大样本测 maxTokens 对 verdict 准确度的影响。
 *
 * 之前只测了 3 个用例，不足以判断。这次 10 个，覆盖各种场景。
 */
import { buildSystemPrompt, buildContext, parseVerdict } from '../src/decision/model.js'
import { createFallbackLlm } from '../src/gateway/fallback.js'

const llm = createFallbackLlm({
  channels: [{
    id: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'dsh-local',
    model: 'magpie/auto/deepseek-v4.1-flash', models: ['magpie/auto/deepseek-v4.1-flash'],
  }],
  log: () => {},
})

const G = (groupName = '神秘黄豆群') => ({ kind: 'group', groupName })
const P = { kind: 'private' }
const self = { qq: '9', nickname: '蓝色大肥鱼' }
const m = (name, text, o = {}) => ({
  sender: o.isMe ? '9' : '1', senderName: name, text,
  isMe: !!o.isMe, mentionsMe: !!o.mentionsMe, at: o.at ?? 1,
})

// [名称, 场景, 消息, 期望]
const CASES = [
  ['私聊·问几张图', P, [
    m('你', '[图片][图片]'),
    m('蓝色大肥鱼', '哼，本鱼才不评', { isMe: true }),
    m('你', '那我问你上面一共几张图'),
  ], 'reply'],
  ['私聊·在吗', P, [m('你', '在吗')], 'reply'],
  ['私聊·说没事了', P, [
    m('蓝色大肥鱼', '有事就说吧', { isMe: true }),
    m('你', '没事了'),
  ], 'reply'],
  ['私聊·纯图片', P, [m('你', '[图片]')], 'reply'],
  ['群·别人互聊显卡', G(), [
    m('A', '你显卡驱动更新了吗'),
    m('B', '更了，三角洲还是卡'),
  ], 'wait|stop'],
  ['群·技术争论', G(), [
    m('A', '这个应该用链表'),
    m('B', '数组更快，缓存友好'),
  ], 'wait|stop'],
  ['群·点名问它', G(), [m('A', '蓝色大肥鱼你说呢')], 'reply'],
  ['群·@它', G(), [m('A', '@9 在不在', { mentionsMe: true })], 'reply'],
  ['群·接它的话', G(), [
    m('蓝色大肥鱼', '这青蛙真抽象', { isMe: true }),
    m('A', '你才抽象'),
  ], 'reply'],
  ['群·冷场', G(), [m('A', '有人吗')], 'reply|wait'],
]

const MAXTOKENS = [32, 64, 128]

for (const mt of MAXTOKENS) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`  maxTokens = ${mt}`)
  console.log('='.repeat(60))

  let ok = 0
  let bad = 0
  for (const [name, scene, msgs, expect] of CASES) {
    const input = {
      messages: msgs, self, scene,
      sinceMyLastMessage: 20000, consecutiveTurns: 1,
    }
    const chunks = []
    try {
      for await (const c of llm.stream({
        provider: 'magpie', model: 'magpie/auto/deepseek-v4.1-flash',
        messages: [
          { role: 'system', content: buildSystemPrompt(input) },
          { role: 'user', content: buildContext(input) },
        ],
        maxTokens: mt, temperature: 0,
        signal: AbortSignal.timeout(40000),
      })) {
        if (c?.type === 'text-delta') chunks.push(c.text)
      }
    } catch (e) {
      console.log(`  ❌ ${name.padEnd(20)} 调用失败: ${e.message}`)
      bad++
      continue
    }

    const raw = chunks.join('').trim()
    const v = parseVerdict(raw)
    const expectList = expect.split('|')
    const pass = v !== null && expectList.includes(v)
    if (pass) ok++
    else if (v === null) bad++

    const mark = pass ? '✅' : (v === null ? '⚠️ ' : '❌')
    console.log(`  ${mark} ${name.padEnd(20)} → ${JSON.stringify(raw).padEnd(14)} 解析=${String(v).padEnd(6)} 期望=${expect}`)
  }
  console.log(`  ── 正确 ${ok}/${CASES.length}，解析失败 ${bad}`)
}
