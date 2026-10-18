// 验证：列出 channel-pack 注册的所有 provider，并逐个查模型。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDshAppDir, findChannelPack, linkDshModules, createLlmGateway } from '../src/gateway/llm-core.js'
import { Credentials } from '../src/config/credentials.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const log = () => {}

const appDir = findDshAppDir()
const pack = findChannelPack()
linkDshModules(appDir, root)
const creds = new Credentials()
const gw = await createLlmGateway({ appDir, packFile: pack.file, credentials: creds, log })

console.log('=== 1. 已注册的 provider 路由 ===')
let providers = []
try {
  providers = gw.llm.listProviders?.() ?? []
  console.log('  数量:', providers.length)
  for (const p of providers) {
    const id = typeof p === 'string' ? p : (p.id ?? p.provider ?? JSON.stringify(p))
    console.log(`    ${id}`)
  }
} catch (e) {
  console.log('  ❌ listProviders 失败:', String(e.message).slice(0, 150))
}

console.log('\n=== 2. 逐个 provider 列模型 ===')
const all = []
for (const p of providers) {
  const id = typeof p === 'string' ? p : (p.id ?? p.provider)
  try {
    const models = await gw.llm.listModels(id)
    const n = models?.length ?? 0
    console.log(`  ${String(id).padEnd(16)} ${n} 个模型`)
    for (const m of models ?? []) all.push({ provider: id, model: m.id ?? m.model ?? m.name })
  } catch (e) {
    console.log(`  ${String(id).padEnd(16)} ❌ ${String(e.message).slice(0, 80)}`)
  }
}

console.log('\n=== 3. 全部模型（去重）===')
console.log('  总数:', all.length)
const seen = new Set()
for (const { provider, model } of all) {
  const key = `${provider}/${model}`
  if (seen.has(key)) continue
  seen.add(key)
  console.log(`    ${provider.padEnd(14)} ${model}`)
}

await gw.close()
