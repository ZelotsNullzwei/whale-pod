/**
 * 降级模式测试：证明 WhalePod **不依赖 DSH** 也能跑通完整链路。
 *
 * 做法：
 *   1. 起一个假的 OpenAI 兼容端点（本地 HTTP）
 *   2. 用 createFallbackLlm 接上它
 *   3. 走 router → openFirstAvailable → stream
 *   4. 验证真的收到了文本增量
 *
 * 还测边界情况：连不上、HTTP 错误、空响应、非流式 JSON 回落。
 */
import http from 'node:http'
import { createFallbackLlm, testChannel, PRESET_ENDPOINTS } from '../src/gateway/fallback.js'
import { openFirstAvailable, resolveCandidates } from '../src/gateway/router.js'

let pass = 0
let fail = 0
const check = (n, c, e = '') => {
  if (c) { pass++; console.log('  ✅ ' + n) } else { fail++; console.log('  ❌ ' + n + ' ' + e) }
}

// ── 假端点 ────────────────────────────────────────────────────
const PORT = 17311
let mode = 'stream'   // stream | json | error500 | empty | badkey

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/v1/models') {
    if (mode === 'badkey') {
      res.writeHead(401, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-2' }] }))
  }

  if (url.pathname === '/v1/chat/completions') {
    let body = ''
    for await (const c of req) body += c
    if (mode === 'error500') {
      res.writeHead(500, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: '上游炸了' } }))
    }
    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '非流式回复' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }))
    }
    if (mode === 'empty') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      return res.end('data: [DONE]\n\n')
    }
    // 默认：正常 SSE
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunks = ['你', '好', '，', '世界']
    for (const t of chunks) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4 } })}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  res.writeHead(404)
  res.end('nope')
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log('假端点已启动：http://127.0.0.1:' + PORT + '/v1\n')

const base = `http://127.0.0.1:${PORT}/v1`

// ── 1. 基本流式 ───────────────────────────────────────────────
console.log('=== 1. 流式对话（无 DSH）===')
{
  mode = 'stream'
  const llm = createFallbackLlm({
    channels: [{ id: 'mock', baseUrl: base, apiKey: 'sk-test', models: ['mock-model'], model: 'mock-model' }],
  })
  check('listProviders 返回 mock', llm.listProviders().join(',') === 'mock')

  const cands = resolveCandidates('auto', {
    freeProviders: llm.listProviders(),
    catalog: [],
    selfModels: llm.defaultModels(),
  })
  check('router 能解析出候选', cands.length === 1, JSON.stringify(cands))

  const opened = await openFirstAvailable({
    llm,
    candidates: cands,
    request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 64 },
  })
  check('建立了流', Boolean(opened.stream))

  let text = ''
  let usage = null
  let finish = null
  for await (const c of opened.stream) {
    if (c.type === 'text-delta') text += c.text
    else if (c.type === 'usage') usage = c.usage
    else if (c.type === 'finish') finish = c.reason
  }
  check('收到完整文本', text === '你好，世界', JSON.stringify(text))
  check('收到 usage', usage?.inputTokens === 8 && usage?.outputTokens === 4, JSON.stringify(usage))
  check('收到 finish', finish?.kind === 'stop', JSON.stringify(finish))
}

// ── 2. 非流式回落 ─────────────────────────────────────────────
console.log('\n=== 2. 端点忽略 stream 参数（返回完整 JSON）===')
{
  mode = 'json'
  const llm = createFallbackLlm({ channels: [{ id: 'mock', baseUrl: base, model: 'mock-model' }] })
  let text = ''
  let usage = null
  for await (const c of llm.stream({ provider: 'mock', model: 'mock-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) {
    if (c.type === 'text-delta') text += c.text
    if (c.type === 'usage') usage = c.usage
  }
  check('回落到完整 JSON 并取出文本', text === '非流式回复', JSON.stringify(text))
  check('usage 也拿到了', usage?.inputTokens === 5, JSON.stringify(usage))
}

// ── 3. HTTP 500 ───────────────────────────────────────────────
console.log('\n=== 3. 上游 500 → 应产出 error chunk（让 router 换渠道）===')
{
  mode = 'error500'
  const llm = createFallbackLlm({ channels: [{ id: 'mock', baseUrl: base, model: 'mock-model' }] })
  let err = null
  for await (const c of llm.stream({ provider: 'mock', model: 'm', messages: [] })) {
    if (c.type === 'finish' && c.reason?.kind === 'error') err = c.reason.failure.message
  }
  check('产出 error chunk', Boolean(err), '没有收到 error')
  check('错误信息含 HTTP 500', String(err).includes('500'), String(err))
  check('错误信息含上游原文', String(err).includes('上游炸了'), String(err))
}

// ── 4. 空响应 ─────────────────────────────────────────────────
console.log('\n=== 4. 一个字都不返回 → 应报错而非静默空回复 ===')
{
  mode = 'empty'
  const llm = createFallbackLlm({ channels: [{ id: 'mock', baseUrl: base, model: 'mock-model' }] })
  let err = null
  for await (const c of llm.stream({ provider: 'mock', model: 'm', messages: [] })) {
    if (c.type === 'finish' && c.reason?.kind === 'error') err = c.reason.failure.message
  }
  check('空响应被判为失败', Boolean(err), '静默通过了')
}

// ── 5. 连不上 ─────────────────────────────────────────────────
console.log('\n=== 5. 连不上的端点 → 人话错误 ===')
{
  const llm = createFallbackLlm({ channels: [{ id: 'dead', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' }] })
  let err = null
  for await (const c of llm.stream({ provider: 'dead', model: 'x', messages: [] })) {
    if (c.type === 'finish' && c.reason?.kind === 'error') err = c.reason.failure.message
  }
  check('产出错误', Boolean(err))
  check('错误是中文人话', /连接被拒绝|连接超时|失败/.test(String(err)), String(err))
}

// ── 6. 多渠道降级 ─────────────────────────────────────────────
console.log('\n=== 6. 多渠道：坏的失败后自动切到好的 ===')
{
  mode = 'stream'
  const llm = createFallbackLlm({
    channels: [
      { id: 'dead', baseUrl: 'http://127.0.0.1:1/v1', model: 'x' },
      { id: 'good', baseUrl: base, model: 'mock-model' },
    ],
  })
  const cands = resolveCandidates('auto', {
    freeProviders: llm.listProviders(),
    catalog: [],
    selfModels: llm.defaultModels(),
  })
  const opened = await openFirstAvailable({ llm, candidates: cands, request: { messages: [] } })
  let text = ''
  for await (const c of opened.stream) if (c.type === 'text-delta') text += c.text
  check('自动跳到可用渠道', text === '你好，世界', JSON.stringify(text))
  check('记录了两个尝试', opened.attempts.length === 2, JSON.stringify(opened.attempts.map((a) => a.provider + ':' + a.ok)))
}

// ── 7. testChannel 探活 ───────────────────────────────────────
console.log('\n=== 7. testChannel 探活 ===')
{
  mode = 'stream'
  const ok = await testChannel({ id: 'mock', baseUrl: base, apiKey: 'k' })
  check('正常端点探活成功', ok.ok === true, JSON.stringify(ok))
  check('解析出模型列表', (ok.models ?? []).length === 2, JSON.stringify(ok.models))

  mode = 'badkey'
  const bad = await testChannel({ id: 'mock', baseUrl: base, apiKey: 'wrong' })
  check('错误 key 探活失败', bad.ok === false, JSON.stringify(bad))
  check('给出 HTTP 状态', String(bad.detail).includes('401'), String(bad.detail))

  const dead = await testChannel({ id: 'dead', baseUrl: 'http://127.0.0.1:1/v1' }, { timeoutMs: 5000 })
  check('死端点探活失败', dead.ok === false)
}

// ── 8. 预置端点 ───────────────────────────────────────────────
console.log('\n=== 8. 预置端点表 ===')
{
  const ids = Object.keys(PRESET_ENDPOINTS)
  check('含常见国内外端点', ids.includes('openai') && ids.includes('deepseek') && ids.includes('ollama') && ids.includes('dashscope'))
  for (const [id, p] of Object.entries(PRESET_ENDPOINTS)) {
    if (!p.baseUrl) continue
    check(`${id} 有合法 baseUrl`, /^https?:\/\//.test(p.baseUrl), p.baseUrl)
  }
}

// ── 9. 消息格式转换 ───────────────────────────────────────────
console.log('\n=== 9. dsh block 数组 → OpenAI content ===')
{
  const llm = createFallbackLlm({ channels: [{ id: 'echo', baseUrl: base, model: 'm' }] })
  // 用假端点验证请求体（它不校验，但至少不该崩）
  let text = ''
  for await (const c of llm.stream({
    provider: 'echo',
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', url: 'data:image/png;base64,AAA' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '结果' }] },
    ],
  })) {
    if (c.type === 'text-delta') text += c.text
  }
  check('多角色 + 图片 + 工具消息不崩', text === '你好，世界', JSON.stringify(text))
}

server.close()
console.log('\n' + '='.repeat(44))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
