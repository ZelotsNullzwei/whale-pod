/**
 * 验证私聊强制回复。
 *
 * 关键点：
 *   1) 私聊提示词里**不该出现 wait / stop**
 *   2) 模型即使吐 wait/stop，decide() 也要返回 reply
 *   3) 群聊保持三选一不变
 */
import { buildSystemPrompt, parseVerdict } from '../src/decision/model.js'

const priv = (text) => ({
  messages: [{ sender: '1', senderName: '你', text, isMe: false, mentionsMe: false, at: 1 }],
  self: { qq: '9', nickname: '蓝色大肥鱼' },
  scene: { kind: 'private', userId: '1' },
  sinceMyLastMessage: 5000,
  consecutiveTurns: 0,
})

const grp = (text) => ({
  messages: [{ sender: '1', senderName: 'A', text, isMe: false, mentionsMe: false, at: 1 }],
  self: { qq: '9', nickname: '蓝色大肥鱼' },
  scene: { kind: 'group', groupName: '神秘黄豆群' },
  sinceMyLastMessage: 300000,
  consecutiveTurns: 0,
})

console.log('=== 1. 私聊提示词 ===')
const pPrompt = buildSystemPrompt(priv('在吗'))
console.log(`  长度: ${pPrompt.length}`)
console.log(`  含 "wait": ${pPrompt.includes('wait') ? '❌ 有（不该有）' : '✅ 无'}`)
console.log(`  含 "stop": ${pPrompt.includes('stop') ? '❌ 有（不该有）' : '✅ 无'}`)
console.log(`  含 "reply": ${pPrompt.includes('reply') ? '✅ 有' : '❌ 无'}`)
console.log('\n  全文:')
console.log(pPrompt.split('\n').map((l) => `    ${l}`).join('\n'))

console.log('\n=== 2. 群聊提示词（应保留三选一）===')
const gPrompt = buildSystemPrompt(grp('真不预编译着色器'))
console.log(`  含 "wait": ${gPrompt.includes('wait') ? '✅ 有' : '❌ 无'}`)
console.log(`  含 "stop": ${gPrompt.includes('stop') ? '✅ 有' : '❌ 无'}`)
console.log(`  长度: ${gPrompt.length}`)

console.log('\n=== 3. 解析器仍正常 ===')
for (const s of ['reply', 'wait', 'stop']) {
  console.log(`  "${s}" -> ${parseVerdict(s)}`)
}
