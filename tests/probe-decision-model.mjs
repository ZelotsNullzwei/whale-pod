/**
 * 用**运行中实例的最新配置**验证 model 判断。
 * 直接读 config.json，确保和进程用的一致。
 */
import fs from 'node:fs'
import { ModelDecisionProvider } from '../src/decision/model.js'
import { createFallbackLlm } from '../src/gateway/fallback.js'

const cfg = JSON.parse(fs.readFileSync('C:/Users/Null_zwei/.dsh/whale-pod/config.json', 'utf8'))
console.log('=== 进程实际配置 ===')
console.log('  provider      :', cfg.decision.provider)
console.log('  model         :', cfg.decision.model.model)
console.log('  maxTokens     :', cfg.decision.model.maxTokens)
console.log('  timeoutMs     :', cfg.decision.model.timeoutMs)

const llm = createFallbackLlm({
  channels: [{
    id: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'dsh-local',
    model: 'magpie/auto/deepseek-v4.1-flash', models: ['magpie/auto/deepseek-v4.1-flash'],
  }],
  log: () => {},
})

const p = new ModelDecisionProvider(
  { providerId: 'magpie', ...cfg.decision.model },
  { llm, log: { warn: (m) => console.log('  [warn] ' + m) } },
)

const priv = (text, o = {}) => ({
  messages: [{ sender: '1', senderName: 'Null_zwei.', text, isMe: false, mentionsMe: false, at: 1 }],
  self: { qq: '3039392113', nickname: '蓝色大肥鱼' },
  scene: { kind: 'private', userId: '2129024700' },
  sinceMyLastMessage: o.since ?? 30000,
  consecutiveTurns: o.turns ?? 0,
})

const cases = [
  ['私聊：把你思考发出来',  priv('把你思考发出来我看看呢')],
  ['私聊：表情包',         priv('[表情包]')],
  ['私聊：你的思考模式开源了', priv('你的思考模式都开源了哎')],
  ['私聊：连续追问',        priv('真的吗', { since: 3000, turns: 2 })],
]

for (const [name, input] of cases) {
  const t0 = Date.now()
  try {
    const d = await p.decide(input)
    console.log(`\n  【${name}】`)
    console.log(`    ${d.reply ? '发言' : '沉默'}  verdict=${d.raw?.verdict}  (${Date.now() - t0}ms)  「${(d.raw?.text ?? '').slice(0, 20)}」`)
  } catch (e) {
    console.log(`\n  【${name}】❌ ${e.message}`)
  }
}
console.log('\n  统计:', JSON.stringify(p.stats))
