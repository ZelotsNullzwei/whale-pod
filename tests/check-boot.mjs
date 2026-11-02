/**
 * 启动自检：跑 main()，验证所有层能装配起来。
 * 用法：node tests/check-boot.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/*
 * ★ **每次用干净的测试数据目录**（2026-11-02 修正）。
 *
 * 原来直接 `--home .test-home` 且**从不清** —— 于是那个目录里的
 * `config.json` 是**很久以前某个版本写的**，一直沿用到今天。
 *
 * 实测后果：它里面还写着 `freeProviders: [14 个]`（那是老版本的默认值，
 * 新默认早已是空）。本机又没装 channel-pack → 一个渠道都不存在 →
 * `/v1/models` 返回 0 个 → 「真实对话返回内容」这条常年红
 * （而且因为 `process.exit(0)` 的毛病，红了也传不出来）。
 *
 * 测试数据目录就该是**一次性的**：否则它测的是"上次跑完留下的状态"，
 * 而不是"这次代码的行为"。跨版本沿用会积累出这种查不明白的红。
 */
const testHome = path.join(root, '.test-home')
fs.rmSync(testHome, { recursive: true, force: true })

console.log('=== 启动 WhalePod（测试端口，不建托盘）===\n')
const r = await main([
  '--home', testHome,
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
  /*
   * ⚠️ **别硬编码渠道**（2026-11-02 修正）。
   *
   * 原来写死 `model: 'free/gemini/gemini-3.8-flash'` —— 而 gemini 是
   * **channel-pack 那条路**里的渠道。没装包的机器上它根本不存在，
   * 网关回 502「所有候选渠道都失败：gemini…未配置的渠道：gemini」。
   * 这条断言于是常年红 —— 而且因为下面那个 `process.exit(0)` 的毛病，
   * **红了也传不出来**，全量跑一直显示"通过"。
   *
   * 改成先从 /v1/models 拿一个**本机真的配了的**模型。
   */
  // /v1/models 要鉴权（只有 /health 和 / 不鉴权）—— 不带头会拿到 401，
// `body.data` 是 undefined，看起来像"本机没有模型"，其实是没认证。
  const lr = await get('http://127.0.0.1:18999/v1/models', { authorization: `Bearer ${KEY}` })
  const models = lr.body?.data ?? lr.body?.models ?? []
  const first = models[0]
  const modelId = first?.id ?? first?.model ?? (typeof first === 'string' ? first : null)
  if (!modelId) {
    check('真实对话返回内容', false, `本机没有任何可用模型（/v1/models 返回 ${models.length} 个）`)
  } else {
    const res = await fetch('http://127.0.0.1:18999/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: '只回复：OK' }],
        // 探针不该触发网关的联网增强（那会真的花钱搜）
        whale_pod_search: false,
      }),
    })
    const j = await res.json()
    const text = j?.choices?.[0]?.message?.content
    check('真实对话返回内容', res.status === 200 && typeof text === 'string' && text.length > 0,
      `model=${modelId} status=${res.status} text=${JSON.stringify(text)} err=${JSON.stringify(j?.error)?.slice(0, 120)}`)
    console.log(`     用 ${modelId} 回复: ${JSON.stringify(text)?.slice(0, 80)}`)
  }
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
  const ids = (r1.body?.providers ?? []).map((p) => p.id)
  /*
   * ⚠️ **别写死数量**（2026-11-02 修正）。
   *
   * 原来断言 `length === 3`。后来探针里多了 `jev` / `custom` 两个
   * **未启用**的提供者 → 变成 4 个，这条就一直红
   * （同样因为下面那个 process.exit(0) 的毛病，红了也传不出来）。
   *
   * 真正要守的是「**该有的那两类在**，而且 rule 可用」——
   * 那是决策链的骨干。总共几个是实现细节，多一个少一个不该让它红。
   */
  check('决策探测包含 rule 与 model', ids.includes('rule') && ids.includes('model'), JSON.stringify(ids))
  check('决策探测 provider 数量 ≥3', ids.length >= 3, JSON.stringify(ids))
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

/*
 * ⚠️ **先出成绩、先定退出码，再收尾**（2026-11-02 修正）。
 *
 * 原来是：
 *   await r.shutdown('测试结束')              ← 内部 process.exit(0)，进程到此为止
 *   console.log(`通过 ${pass} / 失败 ${fail}`)  ← 永远执行不到
 *   process.exit(fail === 0 ? 0 : 1)          ← 永远执行不到
 *
 * 于是这个文件**打印了 ❌ 却永远退出 0** —— 全量跑一直显示它"通过"，
 * 而它其实一直有失败。假绿比红更糟：红至少你知道有事。
 *
 * 两处都改了：doShutdown 现在尊重 process.exitCode（不再硬编码 0），
 * 这里则在收尾**之前**就把成绩和退出码定下来。
 */
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exitCode = fail === 0 ? 0 : 1

console.log('\n=== 收尾 ===')
await r.shutdown('测试结束')
// 到得了这里说明 shutdown 没接管退出；兜底显式退出
process.exit(process.exitCode ?? 0)
