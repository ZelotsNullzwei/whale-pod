/**
 * 复现：为什么模型回答「哼」「五张」而不是 reply/wait/stop。
 */
import fs from 'node:fs'
import { buildSystemPrompt, buildContext } from '../src/decision/model.js'
import { createFallbackLlm } from '../src/gateway/fallback.js'

const llm = createFallbackLlm({
  channels: [{
    id: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'dsh-local',
    model: 'magpie/auto/deepseek-v4.1-flash', models: ['magpie/auto/deepseek-v4.1-flash'],
  }],
  log: () => {},
})

// 用真实对话复现：用户在问「上面一共几张图」
const input = {
  messages: [
    { sender: '1', senderName: 'Null_zwei.', text: '[图片][图片][图片][图片][图片]', isMe: false, mentionsMe: false, at: 1 },
    { sender: '9', senderName: '蓝色大肥鱼', text: '哼，本鱼才不评', isMe: true, mentionsMe: false, at: 2 },
    { sender: '1', senderName: 'Null_zwei.', text: '那我问你上面一共几张图', isMe: false, mentionsMe: false, at: 3 },
  ],
  self: { qq: '3039392113', nickname: '蓝色大肥鱼' },
  scene: { kind: 'private', userId: '1' },
  sinceMyLastMessage: 20000,
  consecutiveTurns: 1,
}

const system = buildSystemPrompt(input)
const user = buildContext(input)

console.log('=== system prompt（私聊版）===')
console.log(system.split('\n').map((l) => `  ${l}`).join('\n'))

console.log('\n=== user 消息 ===')
console.log(user.split('\n').map((l) => `  ${l}`).join('\n'))

console.log('\n=== 实际调用（maxTokens 512）===')
const chunks = []
for await (const c of llm.stream({
  provider: 'magpie',
  model: 'magpie/auto/deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ],
  maxTokens: 512,
  temperature: 0,
  signal: AbortSignal.timeout(30000),
})) {
  if (c?.type === 'text-delta') chunks.push(c.text)
  else if (c?.type === 'error') console.log(`  [error] ${c.message}`)
}
console.log(`  输出: ${JSON.stringify(chunks.join(''))}`)

console.log('\n=== 对照：maxTokens 16 ===')
const chunks2 = []
for await (const c of llm.stream({
  provider: 'magpie',
  model: 'magpie/auto/deepseek-v4.1-flash',
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ],
  maxTokens: 64,
  temperature: 0,
  signal: AbortSignal.timeout(30000),
})) {
  if (c?.type === 'text-delta') chunks2.push(c.text)
}
console.log(`  输出: ${JSON.stringify(chunks2.join(''))}`)
