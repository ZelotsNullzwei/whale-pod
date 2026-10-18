// 关键验证：能否真的用 Gemini 渠道发一条对话？
// 这是「免费 API 网关」能不能成立的最终判据。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDshAppDir, findChannelPack, linkDshModules, createLlmGateway } from '../src/gateway/llm-core.js'
import { Credentials } from '../src/config/credentials.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const appDir = findDshAppDir()
const pack = findChannelPack()
linkDshModules(appDir, root)
const creds = new Credentials()

const gw = await createLlmGateway({ appDir, packFile: pack.file, credentials: creds, log: () => {} })

console.log('=== 1. 检查 Gemini 凭据 ===')
const gem = creds.findByPrefix('GEMINI_ACCOUNT_')
console.log('  Gemini 账号:', gem.join(', ') || '(无)')
if (gem.length) {
  const c = creds.get(gem[0])
  console.log('  字段:', Object.keys(c ?? {}).join(', '))
  console.log('  email:', c?.email ?? '(无)')
  console.log('  expiry:', c?.expiry ?? '(无)')
  const exp = c?.expiry ? Date.parse(c.expiry) - Date.now() : null
  if (exp !== null) console.log('  剩余:', Math.round(exp / 60000), '分钟', exp <= 0 ? '❌ 已过期' : '✅')
}

console.log('\n=== 2. 查 gemini provider 的模型信息 ===')
for (const model of ['gemini-3.8-flash-medium', 'gemini-3.8-flash']) {
  try {
    const info = await gw.llm.resolveModelInfo('gemini', model)
    console.log(`  ${model}: ${JSON.stringify(info)?.slice(0, 200)}`)
  } catch (e) {
    console.log(`  ${model}: ❌ ${String(e.message).slice(0, 100)}`)
  }
}

console.log('\n=== 3. 试发一条对话（走 ctx.llm.stream）===')
const candidates = [
  { provider: 'gemini', model: 'gemini-3.8-flash-medium' },
  { provider: 'gemini', model: 'gemini-3.8-flash' },
]

for (const { provider, model } of candidates) {
  console.log(`\n  --- ${provider}/${model} ---`)
  try {
    const stream = gw.llm.stream({
      provider,
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] }],
      maxTokens: 50,
    })
    let text = ''
    let chunks = 0
    for await (const chunk of stream) {
      chunks++
      if (chunk?.type === 'text' && typeof chunk.text === 'string') text += chunk.text
      else if (typeof chunk?.text === 'string') text += chunk.text
      if (chunks > 500) break
    }
    console.log(`  ✅ 收到 ${chunks} 个 chunk`)
    console.log(`  文本: "${text.slice(0, 120)}"`)
  } catch (e) {
    console.log(`  ❌ ${String(e.message).slice(0, 200)}`)
    if (e.code) console.log(`     code: ${e.code}`)
  }
}

await gw.close()
