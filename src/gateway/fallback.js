/**
 * 降级 LLM 后端：不用 DSH 也能跑。
 *
 * ## 为什么需要它
 *
 * WhalePod 的默认渠道来自宿主已装的 `channel-pack`，而那是 **DSH 插件** ——
 * 没装 DSH 就没有那 14 个免费渠道。这个模块提供**自备渠道**的退路：
 *
 *   ┌─ 有 DSH ─→ channel-pack（14 个免费渠道，省钱）＋ 可叠加自备渠道
 *   └─ 无 DSH ─→ 只用自备渠道（OpenAI 兼容 / Ollama / 任意自定义端点）
 *
 * ## 契约：必须长得像 ctx.llm
 *
 * WhalePod 的其余部分（router / openai 转换 / gateway）只依赖 `ctx.llm`
 * 的一个方法：
 *
 *     llm.stream({ provider, model, messages, maxTokens, ... })
 *       → AsyncIterable<Chunk>
 *
 * 而 Chunk 的形状由 `openai.js` 的 `toOpenAiSse` 决定（已核对源码）：
 *
 *     { type:'text-delta', text }              正文增量
 *     { type:'reasoning-delta', text }         推理增量（可选）
 *     { type:'tool-call', toolCall:{...} }     工具调用（可选）
 *     { type:'usage', usage:{...} }            用量（可选）
 *     { type:'block', block:{type:'text',...} } 整块（可选）
 *     { type:'finish', reason:{ kind:'error', failure:{message} } }  错误
 *
 * 所以这里只要产出同形状的 chunk，整条链路（网关 / QQ 桥接 / 决策层）
 * 都能无缝复用 —— **不需要改任何调用方**。这是关键的解耦点。
 *
 * ## 支持的后端类型
 *
 *   openai   任何 OpenAI 兼容端点（OpenAI / DeepSeek / 硅基流动 / 中转 …）
 *   ollama   本地 Ollama（/v1 兼容，无需 key）
 *   custom   自定义，行为同 openai（列出是为了 UI 区分）
 */

/** 预置的常见端点（UI 里可直接选）。 */
export const PRESET_ENDPOINTS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    needsKey: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    needsKey: true,
    models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },
  moonshot: {
    label: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    needsKey: true,
    models: ['moonshot-v1-8k', 'moonshot-v1-32k'],
  },
  zhipu: {
    label: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    needsKey: true,
    models: ['glm-4-flash', 'glm-4-plus'],
  },
  dashscope: {
    label: '阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    needsKey: true,
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
  },
  ollama: {
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    models: ['qwen2.5:7b', 'llama3.2', 'gemma2'],
  },
  custom: {
    label: '自定义端点',
    baseUrl: '',
    needsKey: false,
    models: [],
  },
}

/**
 * 一个自备渠道的配置形状。
 * @typedef {object} FallbackChannel
 * @property {string}  id          唯一 id（用作 provider 名）
 * @property {string}  [label]     显示名
 * @property {string}  [preset]    预置类型（openai/deepseek/ollama/…）
 * @property {string}  baseUrl     OpenAI 兼容根地址（含 /v1）
 * @property {string}  [apiKey]
 * @property {string[]} [models]   已知模型（供目录与 auto 用）
 * @property {string}  [model]     默认模型
 * @property {number}  [timeoutMs]
 * @property {object}  [headers]   额外请求头
 * @property {boolean} [enabled]
 */

/**
 * 把若干自备渠道包成一个 `ctx.llm` 兼容对象。
 *
 * @param {object} opts
 * @param {FallbackChannel[]} opts.channels
 * @param {(level:string,msg:string)=>void} [opts.log]
 * @returns {{stream:Function, listProviders:Function, listModels:Function, __fallback:true}}
 */
export function createFallbackLlm(opts = {}) {
  const channels = (opts.channels ?? []).filter((c) => c && c.enabled !== false && c.baseUrl)
  const log = opts.log ?? (() => {})

  /** 按 id 建索引，同时把 id 当 provider 名暴露出去。 */
  const byId = new Map()
  for (const c of channels) byId.set(c.id, c)

  return {
    __fallback: true,

    /**
     * 已配置的 provider 名列表。
     *
     * ⚠️ 两个名字都要有：
     *   - `providers`  —— 调用方（gateway/server、qq/bridge）读的是这个属性
     *   - `listProviders()` —— router 的契约方法
     * 只提供后者会导致 `llm.providers` 为 undefined，
     * 于是候选列表为空 → "无法解析出候选渠道"。踩过一次。
     */
    get providers() {
      return [...byId.keys()]
    },

    listProviders() {
      return [...byId.keys()]
    },

    /**
     * provider → 默认模型。
     *
     * router 的 auto 模式要按这个决定"每个渠道先试哪个模型"。
     * 没有它，自备渠道会被当成"不知道模型名"而跳过。
     */
    defaultModels() {
      const out = {}
      for (const c of byId.values()) {
        const m = c.model || c.models?.[0]
        if (m) out[c.id] = m
      }
      return out
    },

    /** 列模型（router 的目录匹配用）。 */
    listModels({ provider } = {}) {
      const out = []
      const targets = provider ? [byId.get(provider)].filter(Boolean) : [...byId.values()]
      for (const c of targets) {
        const models = c.models?.length ? c.models : (c.model ? [c.model] : [])
        for (const m of models) out.push({ provider: c.id, id: m, model: m })
      }
      return out
    },

    /**
     * 流式对话 —— 产出 dsh-llm 形状的 chunk。
     *
     * 做成 async generator 是刻意的：`openFirstAvailable()` 会用
     * `takeFirst()` 手动取首块来判断"这个候选能不能用"，
     * 所以必须是**真正的异步迭代器**（而不是一次性返回数组）。
     *
     * @param {object} o
     * @param {string} o.provider
     * @param {string} o.model
     * @param {Array}  o.messages      dsh 形状（content 是 block 数组）
     * @param {number} [o.maxTokens]
     * @param {number} [o.temperature]
     * @param {Array}  [o.tools]
     * @param {AbortSignal} [o.signal]
     */
    async *stream(o = {}) {
      const ch = byId.get(o.provider)
      if (!ch) {
        yield errorChunk(`未配置的渠道：${o.provider}`)
        return
      }

      let res
      try {
        res = await fetch(joinUrl(ch.baseUrl, '/chat/completions'), {
          method: 'POST',
          headers: buildHeaders(ch),
          signal: o.signal,
          body: JSON.stringify(buildBody(ch, o)),
        })
      } catch (e) {
        // 网络层失败：交给 router 试下一个候选
        yield errorChunk(`连接失败（${ch.baseUrl}）：${describeFetchError(e)}`)
        return
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        yield errorChunk(`HTTP ${res.status}：${extractErr(text)}`)
        return
      }

      const ctype = res.headers.get('content-type') ?? ''
      // 有些端点忽略 stream 参数，直接返回完整 JSON —— 兜住这种情况
      if (ctype.includes('application/json')) {
        try {
          const j = await res.json()
          const text = j?.choices?.[0]?.message?.content ?? ''
          if (text) yield { type: 'text-delta', text }
          if (j?.usage) {
            yield {
              type: 'usage',
              usage: {
                inputTokens: j.usage.prompt_tokens,
                outputTokens: j.usage.completion_tokens,
              },
            }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        } catch (e) {
          yield errorChunk(`解析响应失败：${String(e?.message ?? e)}`)
        }
        return
      }

      if (!res.body) {
        yield errorChunk('响应没有 body')
        return
      }

      // ── 解析 SSE ─────────────────────────────────────────────
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let sawAny = false

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })

          // SSE 以空行分隔事件；兼容 \n\n 与 \r\n\r\n
          for (;;) {
            const idx = findEventEnd(buf)
            if (!idx) break                    // 没有完整事件了，等下一批数据
            const raw = buf.slice(0, idx.at)
            buf = buf.slice(idx.at + idx.len)
            const payload = parseSseData(raw)
            if (payload === null) continue
            if (payload === '[DONE]') break

            let j
            try { j = JSON.parse(payload) } catch { continue }

            // 错误对象混在流里（部分中转会这么干）
            if (j.error) {
              yield errorChunk(extractErr(JSON.stringify(j.error)))
              return
            }

            const delta = j.choices?.[0]?.delta ?? {}
            // 推理模型（DeepSeek-R1 / QwQ 等）用 reasoning_content
            const reasoning = delta.reasoning_content ?? delta.reasoning
            if (reasoning) yield { type: 'reasoning-delta', text: String(reasoning) }

            if (delta.content) {
              sawAny = true
              yield { type: 'text-delta', text: String(delta.content) }
            }

            // 工具调用（透传成 dsh 的 tool-call）
            if (delta.tool_calls?.length) {
              for (const tc of delta.tool_calls) {
                yield {
                  type: 'tool-call',
                  toolCall: {
                    id: tc.id,
                    name: tc.function?.name,
                    arguments: tc.function?.arguments,
                  },
                }
              }
            }

            if (j.usage) {
              yield {
                type: 'usage',
                usage: {
                  inputTokens: j.usage.prompt_tokens,
                  outputTokens: j.usage.completion_tokens,
                },
              }
            }

            const fin = j.choices?.[0]?.finish_reason
            if (fin) {
              yield { type: 'finish', reason: { kind: fin === 'length' ? 'length' : 'stop' } }
              return
            }
          }
        }
        // 流自然结束但没收到 finish_reason
        if (!sawAny) {
          // 一个字都没出：报错让 router 换渠道，而不是静默空回复
          yield errorChunk('上游没有返回任何内容（可能被内容策略拦截或额度耗尽）')
          return
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } catch (e) {
        if (e?.name === 'AbortError') return
        yield errorChunk(`流读取失败：${String(e?.message ?? e)}`)
      } finally {
        try { reader.releaseLock() } catch { /* ignore */ }
      }
    },
  }
}

// ── 请求构造 ──────────────────────────────────────────────────

function buildHeaders(ch) {
  const h = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(ch.headers ?? {}),
  }
  if (ch.apiKey) h.authorization = `Bearer ${ch.apiKey}`
  return h
}

function buildBody(ch, o) {
  const model = o.model || ch.model || ch.models?.[0]
  const body = {
    model,
    messages: toOpenAiMessages(o.messages ?? []),
    stream: true,
    // 让支持该参数的中转也回 usage
    stream_options: { include_usage: true },
  }
  if (o.maxTokens) body.max_tokens = o.maxTokens
  if (typeof o.temperature === 'number') body.temperature = o.temperature
  if (o.topP !== undefined) body.top_p = o.topP
  if (Array.isArray(o.tools) && o.tools.length > 0) {
    body.tools = o.tools
    body.tool_choice = o.toolChoice ?? 'auto'
  }
  return body
}

/** dsh 的 block 数组 → OpenAI 的 content（支持文本与图片）。 */
function toOpenAiMessages(messages) {
  const out = []
  for (const m of messages) {
    const role = m.role === 'system' || m.role === 'user' || m.role === 'assistant' || m.role === 'tool'
      ? m.role
      : 'user'

    if (role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId ?? m.tool_call_id,
        content: blocksToText(m.content),
      })
      continue
    }

    const msg = { role, content: blocksToOpenAiContent(m.content) }
    if (m.toolCalls?.length) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments ?? '' },
      }))
    }
    out.push(msg)
  }
  return out
}

function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('')
}

/** block 数组 → OpenAI 的 content（字符串或 parts 数组）。 */
function blocksToOpenAiContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length === 0) return ''
  const parts = []
  let allText = true
  for (const b of content) {
    if (b?.type === 'text') {
      parts.push({ type: 'text', text: String(b.text ?? '') })
    } else if (b?.type === 'image' || b?.type === 'image_url') {
      allText = false
      const url = b.url ?? b.image_url?.url ?? b.data
      parts.push({ type: 'image_url', image_url: { url: String(url ?? '') } })
    }
  }
  // 全是文本就退回字符串（兼容性最好，很多端点不认 parts 数组）
  if (allText) return parts.map((p) => p.text).join('')
  return parts
}

// ── SSE 辅助 ──────────────────────────────────────────────────

/**
 * 找事件分隔（\n\n 或 \r\n\r\n）。
 * @returns {{at:number,len:number}|null} null 表示还没有完整事件
 */
function findEventEnd(buf) {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a < 0 && b < 0) return null
  if (a >= 0 && (b < 0 || a < b)) return { at: a, len: 2 }
  return { at: b, len: 4 }
}

/** 从一段 SSE 原文里取 data 行拼接（多行 data 要连起来）。 */
function parseSseData(raw) {
  const lines = raw.split(/\r?\n/)
  const datas = []
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    datas.push(line.slice(5).replace(/^ /, ''))
  }
  if (datas.length === 0) return null
  return datas.join('\n')
}

function errorChunk(message) {
  return { type: 'finish', reason: { kind: 'error', failure: { message } } }
}

function joinUrl(base, suffix) {
  const b = String(base).replace(/\/+$/, '')
  return b + suffix
}

/** 把 fetch 的报错说得人话（用户要能据此排查）。 */
function describeFetchError(e) {
  const code = e?.cause?.code ?? e?.code
  const msg = String(e?.message ?? e)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败，检查 baseUrl 与网络'
  if (code === 'ECONNREFUSED') return '连接被拒绝（服务没起，或端口不对）'
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时（需要代理？）'
  if (code === 'CERT_HAS_EXPIRED' || /certificate/i.test(msg)) return 'TLS 证书错误'
  if (e?.cause?.message) return `${msg}（${e.cause.message}）`
  return msg
}

/** 从错误响应体里挖出人能看懂的信息。 */
function extractErr(text) {
  const s = String(text ?? '').slice(0, 500)
  try {
    const j = JSON.parse(s)
    return j?.error?.message ?? j?.message ?? j?.error ?? s
  } catch {
    return s || '(空响应)'
  }
}

/**
 * 探测一个渠道是否可用（供 Web UI 的「测试连接」按钮）。
 *
 * 只做一次极小的请求，成功即认为可用；失败返回具体原因。
 *
 * @param {FallbackChannel} ch
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, detail:string, ms?:number, models?:string[]}>}
 */
export async function testChannel(ch, opts = {}) {
  if (!ch?.baseUrl) return { ok: false, detail: '未填 baseUrl' }
  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000)
  try {
    // 优先 /models（便宜、不耗 token）
    const r = await fetch(joinUrl(ch.baseUrl, '/models'), {
      headers: buildHeaders(ch),
      signal: ctl.signal,
    })
    const ms = Date.now() - t0
    if (r.ok) {
      const j = await r.json().catch(() => null)
      const models = (j?.data ?? []).map((m) => m.id).filter(Boolean).slice(0, 200)
      return { ok: true, detail: `连接正常（${models.length} 个模型）`, ms, models }
    }
    // /models 不被支持时退回一次最小对话
    if (r.status === 404 || r.status === 405) {
      const r2 = await fetch(joinUrl(ch.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: buildHeaders(ch),
        signal: ctl.signal,
        body: JSON.stringify({
          model: ch.model || ch.models?.[0] || 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        }),
      })
      const ms2 = Date.now() - t0
      if (r2.ok) return { ok: true, detail: '连接正常（无 /models，已用对话验证）', ms: ms2 }
      const t = await r2.text().catch(() => '')
      return { ok: false, detail: `HTTP ${r2.status}：${extractErr(t)}`, ms: ms2 }
    }
    const t = await r.text().catch(() => '')
    return { ok: false, detail: `HTTP ${r.status}：${extractErr(t)}`, ms }
  } catch (e) {
    return { ok: false, detail: describeFetchError(e), ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}
