/**
 * 端到端：起网关 → 真实 HTTP 请求 → 验证 OpenAI 兼容响应。
 * 用法：node tests/check-gateway.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDshAppDir, findChannelPack, linkDshModules, createLlmGateway } from '../src/gateway/llm-core.js'
import { Credentials } from '../src/config/credentials.js'
import { ConfigStore } from '../src/config/store.js'
import { createGatewayServer, mintKey } from '../src/gateway/server.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const log = (lvl, msg) => console.log(`  [${lvl}] ${msg}`)

console.log('=== 1. 初始化 ===')
const store = new ConfigStore({ home: path.join(root, '.test-home') })
store.load()
const key = store.get().gateway.key || mintKey()
// ⚠️ 用独立端口（18997），**不要用生产端口 18899**。
//    否则跑测试必须先停掉用户正在看的 WhalePod，把界面搞成"拒绝连接"。
//    踩过：用户浏览器开着 127.0.0.1:18898，我为了跑测试停了服务，
//    他刷新就看到 ERR_CONNECTION_REFUSED。
const TEST_PORT = 18997
store.update({ gateway: { ...store.get().gateway, key, port: TEST_PORT } })
const cfg = store.get()
log('info', `网关端口 ${cfg.gateway.port}`)
log('info', `网关 key  ${key.slice(0, 12)}…`)

const appDir = findDshAppDir()
const pack = findChannelPack()
linkDshModules(appDir, root)
const creds = new Credentials({ mode: 'overlay' })

console.log('\n=== 2. 装载 LLM 核心 ===')
const llm = await createLlmGateway({ appDir, packFile: pack.file, credentials: creds, log })
log('info', `provider: ${llm.providers.join(', ')}`)

console.log('\n=== 3. 刷新模型目录 ===')
const catalog = await llm.refreshCatalog()
log('info', `目录 ${catalog.length} 个模型`)
for (const m of catalog.slice(0, 10)) log('info', `  ${m.provider}/${m.id}`)

console.log('\n=== 4. 起 HTTP 服务 ===')
const gw = createGatewayServer({ gateway: cfg.gateway, llm, log })
await gw.listen()

const BASE = `http://${cfg.gateway.host}:${cfg.gateway.port}`
const H = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }

async function hit(label, url, init) {
  const t0 = Date.now()
  const r = await fetch(url, init)
  const ms = Date.now() - t0
  const ct = r.headers.get('content-type') ?? ''
  let body
  if (ct.includes('text/event-stream')) {
    body = await r.text()
  } else {
    const text = await r.text()
    try { body = JSON.parse(text) } catch { body = text }
  }
  console.log(`\n--- ${label} ---`)
  console.log(`  HTTP ${r.status}  ${ms}ms  ${ct.split(';')[0]}`)
  const prov = r.headers.get('x-whale-pod-provider')
  if (prov) console.log(`  x-whale-pod-provider: ${prov}`)
  return { status: r.status, body, ms, headers: r.headers }
}

console.log('\n=== 5. 测试端点 ===')

// 5a. health（不鉴权）
{
  const r = await hit('GET /health（无鉴权）', `${BASE}/health`)
  console.log('  ok:', r.body?.ok, ' counters:', JSON.stringify(r.body?.counters))
}

// 5b. 无 key 应 401
{
  const r = await hit('GET /v1/models（错误 key → 应 401）', `${BASE}/v1/models`, {
    headers: { authorization: 'Bearer wrong-key' },
  })
  console.log('  error:', r.body?.error?.message)
}

// 5c. models
{
  const r = await hit('GET /v1/models（正确 key）', `${BASE}/v1/models`, { headers: H })
  console.log('  模型数:', r.body?.data?.length)
  console.log('  前 8 个:', (r.body?.data ?? []).slice(0, 8).map((m) => m.id).join(', '))
}

// 5d. 挑一个"当前确实可用"的渠道来测对话
//
// ⚠️ 不要写死 gemini。gemini 要连 Google，本机没开代理时必定超时，
//    而且用户会在界面上把它关掉（disabledProviders）—— 那测试就
//    必然失败，还会白等几十秒超时。改成从 /v1/models 的结果里挑
//    一个启用中的渠道。
let probeModel = 'auto'
{
  const r = await hit('GET /v1/models（挑可用渠道）', `${BASE}/v1/models`, { headers: H })
  const ids = (r.body?.data ?? []).map((m) => m.id).filter((x) => !String(x).startsWith('auto'))
  // free/<渠道> 这种条目只说明渠道注册了；真正能用的要带模型名
  const withModel = ids.filter((x) => String(x).split('/').length >= 3)
  probeModel = withModel[0] ?? ids[0] ?? 'auto'
  console.log('  用于对话测试的模型:', probeModel)
}

// 5e. 非流式对话
{
  const r = await hit(`POST /v1/chat/completions（非流式，${probeModel}）`, `${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      model: probeModel,
      messages: [{ role: 'user', content: '用中文回答：1+1 等于几？只回数字。' }],
      max_tokens: 64,
    }),
  })
  const msg = r.body?.choices?.[0]?.message
  console.log('  content:', JSON.stringify(msg?.content))
  console.log('  reasoning:', JSON.stringify(msg?.reasoning_content)?.slice(0, 100))
  console.log('  finish:', r.body?.choices?.[0]?.finish_reason)
  console.log('  usage:', JSON.stringify(r.body?.usage))
  if (r.body?.error) console.log('  ⚠️ error:', JSON.stringify(r.body.error).slice(0, 300))
}

// 5f. 流式对话
{
  const r = await hit(`POST /v1/chat/completions（流式，${probeModel}）`, `${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      model: probeModel,
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
      max_tokens: 64,
      stream: true,
    }),
  })
  const lines = String(r.body).split('\n').filter((l) => l.startsWith('data: '))
  console.log('  SSE 事件数:', lines.length)
  let text = ''
  let reasoning = ''
  for (const l of lines) {
    const d = l.slice(6).trim()
    if (d === '[DONE]') continue
    try {
      const j = JSON.parse(d)
      const delta = j.choices?.[0]?.delta
      if (delta?.content) text += delta.content
      if (delta?.reasoning_content) reasoning += delta.reasoning_content
    } catch { /* ignore */ }
  }
  console.log('  拼接文本:', JSON.stringify(text))
  console.log('  推理长度:', reasoning.length)
  console.log('  末尾 2 行:', lines.slice(-2).join(' | ').slice(0, 180))
}

// 5f. auto 路由（不给具体模型，看它自己选）
{
  const r = await hit('POST /v1/chat/completions（model=auto）', `${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: '回复：ok' }],
    }),
  })
  console.log('  选中 provider:', r.headers.get('x-whale-pod-provider'))
  console.log('  content:', JSON.stringify(r.body?.choices?.[0]?.message?.content)?.slice(0, 120))
  if (r.body?.error) console.log('  ⚠️ error:', JSON.stringify(r.body.error).slice(0, 240))
}

console.log('\n=== 6. 统计 ===')
console.log('  ', JSON.stringify(gw.counters))

console.log('\n=== 7. 收尾 ===')
await gw.close()
await llm.close()
console.log('  已关闭')
