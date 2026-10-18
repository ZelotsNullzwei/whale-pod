/**
 * 端到端验证「无 DSH 降级模式」：
 *
 *   1. 起一个假的 OpenAI 兼容端点
 *   2. 用干净的数据目录写一份只含自备渠道的配置
 *   3. 用 DSH_APP_DIR 指向不存在的路径 + 清空 DSH_HOME → 模拟"没有 DSH"
 *   4. 真正启动 WhalePod，打 /health 与 /v1/chat/completions
 *   5. 断言它**没有崩**且**真的回了话**
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'

const ROOT = 'D:/DSH WorkSpace/whale-pod'
const FAKE_PORT = 17411
const GW_PORT = 17412
const WB_PORT = 17413
const HOME = path.join(os.tmpdir(), 'whale-pod-nodsh-' + Date.now())

let pass = 0, fail = 0
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✅ ' + n) } else { fail++; console.log('  ❌ ' + n + ' ' + e) } }

// ── 假上游 ────────────────────────────────────────────────────
const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
  }
  if (url.pathname === '/v1/chat/completions') {
    let body = ''
    for await (const c of req) body += c
    const asked = JSON.parse(body || '{}')
    const replyModel = asked.model ?? '?'
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '降级模式收到：' + replyModel } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }
  res.writeHead(404); res.end()
})
await new Promise((r) => upstream.listen(FAKE_PORT, '127.0.0.1', r))

// ── 干净数据目录 + 只配自备渠道 ───────────────────────────────
fs.mkdirSync(HOME, { recursive: true })
const cfg = {
  version: 1,
  gateway: {
    enabled: true,
    host: '127.0.0.1',
    port: GW_PORT,
    key: 'gdn-testkey123',
    strategy: 'free-first',
    channels: [{
      id: 'fake',
      label: '假上游',
      baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`,
      model: 'fake-model',
      models: ['fake-model'],
      enabled: true,
    }],
  },
  web: { enabled: true, host: '127.0.0.1', port: WB_PORT, token: 'gdn-webtok' },
  qq: { enabled: false },
}
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(cfg, null, 2))

console.log('数据目录：' + HOME)
console.log('假上游：http://127.0.0.1:' + FAKE_PORT + '/v1\n')

// ── 启动 WhalePod（环境里故意没有 DSH）─────────────────────────
console.log('=== 启动 WhalePod（DSH_APP_DIR 指向不存在的路径）===')
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  NO_PROXY: '127.0.0.1,localhost',
  HTTP_PROXY: '', HTTPS_PROXY: '',
  DSH_APP_DIR: path.join(HOME, 'no-such-dsh'),
  DSH_HOME: path.join(HOME, 'no-such-dsh-home'),
  GUARDIAN_HOME: HOME,
  USERPROFILE: process.env.USERPROFILE,
}
delete env.HTTP_PROXY
delete env.HTTPS_PROXY

const child = spawn(process.execPath, [path.join(ROOT, 'src/index.js'), '--home', HOME, '--no-tray'], {
  env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let out = ''
child.stdout.on('data', (d) => { out += d })
child.stderr.on('data', (d) => { out += d })

// 等端口起来
let up = false
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  try {
    const r = await fetch(`http://127.0.0.1:${WB_PORT}/`, { signal: AbortSignal.timeout(2000) })
    if (r.ok) { up = true; break }
  } catch { /* retry */ }
}
check('WhalePod 在没有 DSH 的情况下起来了', up, '未监听（进程输出：' + out.slice(-400) + '）')

if (up) {
  console.log('\n=== 健康检查 ===')
  const h = await fetch(`http://127.0.0.1:${GW_PORT}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
  check('/health 返回 ok', h.ok === true || h.status === 'ok', JSON.stringify(h).slice(0, 200))
  check('报告了 provider 列表', Array.isArray(h.providers), JSON.stringify(h).slice(0, 200))

  console.log('\n=== 真的调用一次对话 ===')
  const chat = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer gdn-testkey123' },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: '在吗' }] }),
    signal: AbortSignal.timeout(30000),
  })
  check('HTTP 200', chat.status === 200, String(chat.status))
  const j = await chat.json().catch(() => null)
  const text = j?.choices?.[0]?.message?.content ?? ''
  check('拿到了回复内容', text.length > 0, JSON.stringify(j).slice(0, 300))
  check('回复来自自备渠道', text.includes('降级模式收到'), JSON.stringify(text))
  console.log('     回复：' + JSON.stringify(text))

  console.log('\n=== 启动日志检查 ===')
  check('明确警告了缺 DSH', /未找到 DSH|免费渠道不可用/.test(out), '日志里没提到')
  check('说明改用自备渠道', /自备渠道/.test(out), '日志里没提到')
}

child.kill()
await new Promise((r) => setTimeout(r, 1500))
try { child.kill('SIGKILL') } catch { /* ignore */ }
upstream.close()
fs.rmSync(HOME, { recursive: true, force: true })

console.log('\n' + '='.repeat(44))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
