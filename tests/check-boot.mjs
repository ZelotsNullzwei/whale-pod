/**
 * 启动自检：跑 main()，验证所有层能装配起来。
 * 用法：node tests/check-boot.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

console.log('=== 启动 WhalePod（测试端口，不建托盘）===\n')
const r = await main([
  '--home', path.join(root, '.test-home'),
  '--port', '18999',
  '--web-port', '18998',
  '--no-tray',
])

if (r?.code) {
  console.log(`\n❌ 启动失败：${r.error?.message}`)
  process.exit(1)
}

console.log('\n=== 服务已起，开始验证 ===')

const cfg = r.store.get()
const KEY = cfg.gateway.key
const WEB = cfg.web.token

async function get(url, headers) {
  const res = await fetch(url, { headers })
  const ct = res.headers.get('content-type') ?? ''
  const body = ct.includes('json') ? await res.json() : await res.text()
  return { status: res.status, body, ct }
}

let pass = 0, fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

// 1. LLM 网关 health
{
  const r1 = await get('http://127.0.0.1:18999/health')
  check('LLM 网关 /health', r1.status === 200 && r1.body.ok === true, JSON.stringify(r1.body).slice(0, 120))
}

// 2. LLM 网关鉴权
{
  const r1 = await get('http://127.0.0.1:18999/v1/models', { authorization: 'Bearer wrong' })
  check('LLM 网关拒绝错误 key', r1.status === 401)
  const r2 = await get('http://127.0.0.1:18999/v1/models', { authorization: `Bearer ${KEY}` })
  check('LLM 网关接受正确 key', r2.status === 200)
  check('模型列表非空', (r2.body?.data?.length ?? 0) > 0, String(r2.body?.data?.length))
}

// 3. 真实对话
{
  const res = await fetch('http://127.0.0.1:18999/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'free/gemini/gemini-3.8-flash',
      messages: [{ role: 'user', content: '只回复：OK' }],
    }),
  })
  const j = await res.json()
  const text = j?.choices?.[0]?.message?.content
  check('真实对话返回内容', res.status === 200 && typeof text === 'string' && text.length > 0,
    `status=${res.status} text=${JSON.stringify(text)} err=${JSON.stringify(j?.error)?.slice(0, 120)}`)
  console.log(`     回复: ${JSON.stringify(text)?.slice(0, 80)}`)
}

// 4. Web 首页
{
  const r1 = await get('http://127.0.0.1:18998/')
  check('Web 首页可访问', r1.status === 200 && /WhalePod/.test(String(r1.body)))
  const r2 = await get('http://127.0.0.1:18998/api/status')
  check('Web API 拒绝无 token', r2.status === 401)
  const r3 = await get(`http://127.0.0.1:18998/api/status?token=${WEB}`)
  check('Web API 接受 token', r3.status === 200 && r3.body.ok === true)
  check('状态含 providers', (r3.body?.providers?.count ?? 0) > 0, String(r3.body?.providers?.count))
  check('状态含 decision', Array.isArray(r3.body?.decision?.order), JSON.stringify(r3.body?.decision))
}

// 5. 决策探测 API
{
  const r1 = await get(`http://127.0.0.1:18998/api/decision/probe?token=${WEB}`)
  check('决策探测有 3 个 provider', r1.body?.providers?.length === 3, JSON.stringify(r1.body?.providers?.map(p => p.id)))
  check('rule 可用', r1.body?.providers?.find(p => p.id === 'rule')?.ok === true)
}

// 6. 决策测试 API
{
  const res = await fetch(`http://127.0.0.1:18998/api/decision/test?token=${WEB}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '@我 在吗', mentionsMe: true, scene: { kind: 'group' }, sinceMyLastMessage: 999999 }),
  })
  const j = await res.json()
  check('决策测试返回结论', typeof j.reply === 'boolean', JSON.stringify(j).slice(0, 160))
  console.log(`     ${j.explain}`)
}

// 7. 日志 API
{
  const r1 = await get(`http://127.0.0.1:18998/api/logs?n=50&token=${WEB}`)
  check('日志有内容', (r1.body?.entries?.length ?? 0) > 0, String(r1.body?.entries?.length))
}

// 8. 配置 API
{
  const r1 = await get(`http://127.0.0.1:18998/api/config?token=${WEB}`)
  check('配置可读', r1.status === 200 && r1.body.gateway !== undefined)
  check('密钥已脱敏', String(r1.body.gateway.key).includes('…'), String(r1.body.gateway.key))
}

console.log('\n=== 收尾 ===')
await r.shutdown('测试结束')
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
