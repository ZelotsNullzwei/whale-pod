/**
 * LLM 网关的 HTTP 服务：对外暴露标准 OpenAI 兼容端点。
 *
 * 端点：
 *   GET  /v1/models                 列出可用模型
 *   POST /v1/chat/completions       对话补全（流式 / 非流式）
 *   GET  /health                    健康检查（无需鉴权）
 *
 * 鉴权：Authorization: Bearer <gateway.key>
 *   只绑回环地址，key 的作用是防止同机其它进程误用。
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { resolveCandidates, openFirstAvailable } from './router.js'
import { toDshRequest, toOpenAiSse, toOpenAiResponse } from './openai.js'
import { needsFreshInfo, webSearch, formatSearchContext } from './search.js'

/** 生成一个网关 key。 */
export function mintKey() {
  return `gdn-${crypto.randomBytes(24).toString('base64url')}`
}

/**
 * @param {object} opts
 * @param {object} opts.gateway    gateway 配置（host/port/key/strategy/fallback/timeoutMs）
 * @param {object} opts.llm        LLM 网关核心（来自 createLlmGateway）
 * @param {object} [opts.log]      { info, warn, error }
 * @param {()=>object} [opts.stats] 用量统计回调
 */
export function createGatewayServer(opts) {
  const { gateway, llm, log = {}, usage = null, searchKey = null } = opts
  const startedAt = Date.now()
  const counters = { requests: 0, ok: 0, failed: 0, tokensIn: 0, tokensOut: 0, byProvider: {} }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // ── CORS（本地工具可能需要） ──────────────────────────────
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

    try {
      // ── 健康检查（不鉴权） ─────────────────────────────────
      // 说明：暴露 provider 名单与目录规模是刻意的 —— 排障时第一件事就是
      // "到底有没有渠道可用"。这里不含任何密钥，且只绑回环地址。
      if (path === '/health' || path === '/') {
        const providers = llm.providers ?? []
        return json(res, 200, {
          ok: true,
          service: 'whale-pod-gateway',
          uptimeMs: Date.now() - startedAt,
          strategy: gateway.strategy,
          providers,
          providerCount: providers.length,
          catalogCount: llm.catalog?.length ?? 0,
          counters,
        })
      }

      // ── 鉴权 ───────────────────────────────────────────────
      if (!authorized(req, gateway.key)) {
        log.warn?.(`gateway: 未授权请求 ${req.method} ${path}`)
        return json(res, 401, {
          error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' },
        })
      }

      // ── 模型列表 ────────────────────────────────────────────
      if (path === '/v1/models' && req.method === 'GET') {
        return json(res, 200, await listModels(llm))
      }

      // ── 对话补全 ────────────────────────────────────────────
      if ((path === '/v1/chat/completions' || path === '/chat/completions') && req.method === 'POST') {
        return await handleChat(req, res, { gateway, llm, counters, log, usage, searchKey })
      }

      return json(res, 404, { error: { message: `Not found: ${path}`, type: 'invalid_request_error' } })
    } catch (err) {
      log.error?.(`gateway: ${String(err?.message ?? err)}`)
      if (!res.headersSent) {
        json(res, 500, { error: { message: String(err?.message ?? err), type: 'internal_error' } })
      } else {
        try { res.end() } catch { /* ignore */ }
      }
    }
  })

  return {
    server,
    counters,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(gateway.port, gateway.host, () => {
          log.info?.(`gateway: 监听 http://${gateway.host}:${gateway.port}`)
          resolve()
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** Bearer 鉴权（常量时间比较）。 */
function authorized(req, key) {
  if (!key) return true   // 没配 key 就不校验（本地场景）
  const h = req.headers.authorization ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  if (!m) return false
  const given = Buffer.from(m[1])
  const want = Buffer.from(key)
  if (given.length !== want.length) return false
  return crypto.timingSafeEqual(given, want)
}

/**
 * 发 JSON 响应。
 * @param {object} [extraHeaders] 附加响应头（如 x-whale-pod-provider）
 */
function json(res, code, body, extraHeaders) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...(extraHeaders ?? {}),
  })
  res.end(payload)
}

/** 读请求体（带上限，防止本地进程误发大包）。 */
async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error(`请求体超过上限 ${limit} 字节`)
    chunks.push(c)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) } catch (e) { throw new Error(`请求体不是合法 JSON: ${e.message}`) }
}

/** 列出模型：合并目录 + 免费渠道。 */
async function listModels(llm) {
  const data = []

  // auto 哨兵
  data.push({ id: 'auto', object: 'model', owned_by: 'whale-pod', created: 0 })

  // 免费渠道
  for (const p of llm.providers ?? []) {
    data.push({ id: `free/${p}`, object: 'model', owned_by: p, created: 0 })
  }

  // 已发现的真实模型
  const seen = new Set(data.map((d) => d.id))
  try {
    for (const p of llm.providers ?? []) {
      const models = await llm.listModels(p).catch(() => [])
      for (const m of models ?? []) {
        const id = `${p}/${m.id ?? m.model}`
        if (seen.has(id)) continue
        seen.add(id)
        data.push({ id, object: 'model', owned_by: p, created: 0 })
      }
    }
  } catch { /* 目录不可用不是错误，仍返回哨兵 */ }

  return { object: 'list', data }
}

/** 对话补全。 */
async function handleChat(req, res, ctx) {
  const { gateway, llm, counters, log, usage = null, searchKey = null } = ctx
  const body = await readBody(req)
  counters.requests++

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    counters.failed++
    return json(res, 400, { error: { message: 'messages 不能为空', type: 'invalid_request_error' } })
  }

  const wantStream = body.stream === true
  const requestedModel = String(body.model ?? 'auto')

  // ⚠️ 冷启动竞态：模型目录是启动后**异步刷新**的（要打十几个渠道的网络，
  //    几秒到十几秒）。这期间 catalog 是空的，而 auto 解析候选要查目录 ——
  //    结果是"刚启动的几秒内所有请求都 400 免费渠道为空"，用户完全看不懂。
  //
  //    所以这里如果发现目录为空，就**主动等一次刷新**（最多 15 秒）。
  //    已经就绪的话这一步是零成本的（refreshCatalog 内部有 TTL 缓存）。
  if ((llm.catalog?.length ?? 0) === 0 && typeof llm.refreshCatalog === 'function') {
    try {
      await Promise.race([
        llm.refreshCatalog(),
        new Promise((r) => setTimeout(r, 15000)),
      ])
      log.info?.(`gateway: 目录未就绪，已等待刷新（现有 ${llm.catalog?.length ?? 0} 个模型）`)
    } catch { /* 刷新失败就按现有数据继续 */ }
  }

  // 组装候选
  const candidates = resolveCandidates(requestedModel, {
    freeProviders: llm.providers ?? [],
    // 用户配置的优先顺序（没有它这段配置就完全不生效）
    freeOrder: gateway.freeProviders ?? [],
    // 被禁用的渠道不参与
    disabledProviders: gateway.disabledProviders ?? [],
    catalog: llm.catalog ?? [],
    // 自备渠道的默认模型（没有它，auto 会跳过所有非 DSH 渠道）
    selfModels: llm.defaultModels?.() ?? {},
    fallback: gateway.fallback,
  })

  if (candidates.length === 0) {
    counters.failed++
    return json(res, 400, {
      error: { message: `无法为模型 "${requestedModel}" 解析出候选渠道（免费渠道为空？）`, type: 'invalid_request_error' },
    })
  }

  const dshRequest = toDshRequest(body)

  // ── 联网增强（可选）─────────────────────────────────────────
  //
  // 外部工具（Cline / 各种客户端）问的也常是时效性问题，而它接的
  // 免费渠道模型训练数据都过时。这里和 QQ 侧用同一套触发判断：
  // **只在真的需要新信息时才搜**（一次 5~15 秒，不能每条都搜）。
  //
  // 关掉：请求体里带 `"whale_pod_search": false`。
  if (searchKey && body.whale_pod_search !== false) {
    try {
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
      const q = typeof lastUser?.content === 'string'
        ? lastUser.content
        : (Array.isArray(lastUser?.content)
          ? lastUser.content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ')
          : '')
      const hit = needsFreshInfo(q)
      if (hit.need) {
        const r = await webSearch({
          question: hit.query,
          apiKey: searchKey,
          maxUses: 3,
          timeoutMs: 20000,
          log: (m) => log.info?.(`gateway: ${m}`),
        })
        if (r.ok) {
          const ctx = formatSearchContext(r)
          // 插在**最前面**的 system 位置：作为"参考资料"，优先级高于模型记忆
          dshRequest.messages = [
            { role: 'system', content: [{ type: 'text', text: ctx }] },
            ...(dshRequest.messages ?? []),
          ]
          res.setHeader('x-whale-pod-search', String(r.sources.length))
        } else {
          log.warn?.(`gateway: 联网失败（按无联网继续）— ${r.error}`)
        }
      }
    } catch (e) {
      log.warn?.(`gateway: 联网异常（按无联网继续）— ${String(e?.message ?? e)}`)
    }
  }

  // 建立流（内部会依次尝试候选）
  let opened
  try {
    opened = await openFirstAvailable({
      llm,
      candidates,
      request: dshRequest,
      onAttempt: (a) => {
        if (a.ok) log.info?.(`gateway: 命中 ${a.provider}/${a.model}（${a.ms}ms）`)
        else log.warn?.(`gateway: 跳过 ${a.provider}/${a.model} — ${a.error}`)
      },
    })
  } catch (err) {
    counters.failed++
    return json(res, 502, {
      error: {
        message: String(err?.message ?? err),
        type: 'upstream_error',
        attempts: err?.attempts?.map((a) => ({ provider: a.provider, model: a.model, ok: a.ok, error: a.error })) ?? [],
      },
    })
  }

  const picked = opened.picked
  counters.byProvider[picked.provider] = (counters.byProvider[picked.provider] ?? 0) + 1
  log.info?.(`gateway: ${requestedModel} -> ${picked.provider}/${picked.model}${wantStream ? ' (stream)' : ''}`)

  if (wantStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-whale-pod-provider': picked.provider,
      'x-whale-pod-model': picked.model,
    })
    const t0 = Date.now()
    let outChars = 0
    let streamErr = null
    let ttftMs = null
    try {
      for await (const line of toOpenAiSse(opened.stream, { model: picked.model })) {
        // 首字延迟：第一条带内容的 SSE 事件到达的时间
        if (ttftMs === null && line.includes('"delta"') && !line.includes('"content":""')) {
          ttftMs = Date.now() - t0
        }
        res.write(line)
        outChars += line.length   // 粗估输出量（拿不到 usage 时兜底）
      }
    } catch (err) {
      streamErr = err
      // SSE 已开始，只能按 OpenAI 的约定发一个 error 事件再结束
      log.warn?.(`gateway: 流中断 — ${String(err?.message ?? err)}`)
      res.write(`data: ${JSON.stringify({ error: { message: String(err?.message ?? err), type: 'upstream_error' } })}\n\n`)
      res.write('data: [DONE]\n\n')
    } finally {
      counters.ok++
      // ⚠️ 流式分支原来**完全不记 usage** —— 于是总览页的 token 永远是 0，
      //    而大多数客户端（含 QQ bridge）走的正是这条流式路径。
      //    上游多半不回 usage，所以按输出字符数粗估（4 字符 ≈ 1 token）。
      usage?.record?.({
        provider: picked.provider,
        model: picked.model,
        source: 'gateway',
        tokensIn: 0,
        tokensOut: Math.round(outChars / 4),
        ok: !streamErr,
        ms: Date.now() - t0,
        ttftMs,
        textChars: outChars,
        error: streamErr ? String(streamErr?.message ?? streamErr) : null,
      })
      res.end()
    }
    return
  }

  // 非流式
  try {
    const t0 = Date.now()
    const payload = await toOpenAiResponse(opened.stream, { model: picked.model })
    counters.ok++
    counters.tokensIn += payload.usage.prompt_tokens
    counters.tokensOut += payload.usage.completion_tokens
    usage?.record?.({
      provider: picked.provider,
      model: picked.model,
      source: 'gateway',
      tokensIn: payload.usage.prompt_tokens,
      tokensOut: payload.usage.completion_tokens,
      ok: true,
      ms: Date.now() - t0,
      // 正文长度（推理内容在非流式里拿不到，只有 reasoning_content 字段时才算）
      textChars: String(payload.choices?.[0]?.message?.content ?? '').length,
      reasonChars: String(payload.choices?.[0]?.message?.reasoning_content ?? '').length,
    })
    // ⚠️ 这两个是**响应头**，不是 body 字段。
    //    原来写成了 `payload['x-whale-pod-provider'] = …` —— 塞进 JSON 里，
    //    客户端按头读 `x-whale-pod-provider` 永远是 null（流式分支设了头，
    //    非流式却没有，两边行为不一致）。
    payload['x-whale-pod-provider'] = picked.provider
    return json(res, 200, payload, {
      'x-whale-pod-provider': picked.provider,
      'x-whale-pod-model': picked.model,
    })
  } catch (err) {
    counters.failed++
    return json(res, 502, { error: { message: String(err?.message ?? err), type: 'upstream_error' } })
  }
}
