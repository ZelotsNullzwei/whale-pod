/**
 * 自检：验证 llm-core 能否在独立进程里装载 channel-pack 并列出模型。
 * 用法：node tests/check-llm-core.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDshAppDir, findChannelPack, linkDshModules, createLlmGateway } from '../src/gateway/llm-core.js'
import { Credentials } from '../src/config/credentials.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`)

console.log('=== 1. 定位 DSH ===')
const appDir = findDshAppDir()
console.log('  appDir:', appDir ?? '❌ 未找到')
if (!appDir) process.exit(1)

console.log('\n=== 2. 定位 channel-pack ===')
const pack = findChannelPack()
console.log('  packFile:', pack?.file ?? '❌ 未找到')
console.log('  profile :', pack?.profile ?? '—')
if (!pack) process.exit(1)

console.log('\n=== 3. 链接 DSH 模块 ===')
const linked = linkDshModules(appDir, root)
for (const l of linked) console.log(`  ${l.name}: ${l.status}`)

console.log('\n=== 4. 凭据 ===')
const creds = new Credentials()
console.log('  文件:', creds.file)
console.log('  存在:', creds.load().missing ? '❌' : '✅')
console.log('  refs:', creds.listRefs().length, '个')
for (const r of creds.listRefs().slice(0, 8)) console.log(`    ${r}`)

console.log('\n=== 5. 装载 LLM 网关核心 ===')
const gw = await createLlmGateway({ appDir, packFile: pack.file, credentials: creds, log })
console.log('  ✅ 装载成功')

console.log('\n=== 6. 列模型 ===')
try {
  const models = await gw.listModels()
  console.log('  模型数:', models?.length ?? 0)
  const byProvider = {}
  for (const m of models ?? []) {
    const p = m.provider ?? m.providerId ?? '?'
    byProvider[p] = (byProvider[p] ?? 0) + 1
  }
  for (const [p, n] of Object.entries(byProvider)) console.log(`    ${p}: ${n}`)
  console.log('  样例:')
  for (const m of (models ?? []).slice(0, 12)) {
    console.log(`    ${String(m.provider ?? '?').padEnd(14)} ${m.id ?? m.model ?? '?'}`)
  }
} catch (e) {
  console.log('  ❌ listModels 失败:', String(e.message).slice(0, 200))
}

await gw.close()
console.log('\n完成。')
