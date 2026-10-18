/**
 * OpenAI 协议 ↔ dsh-llm 协议的转换。
 *
 * 这是「通用性」的核心：对外只认标准 OpenAI 格式，
 * 内部转换成 dsh-llm 的调用形状，再把 chunk 流转回 OpenAI 的 SSE。
 *
 * 覆盖范围：
 *   - messages: system / user / assistant / tool
 *   - content: 字符串 或 [{type:'text'|'image_url', ...}]
 *   - 工具调用（tools / tool_calls）—— 透传，不做语义改写
 *   - stream: true → SSE；false → 聚合成完整响应
 */

/**
 * OpenAI messages → dsh-llm messages。
 *
 * dsh-llm 的 content 是 block 数组：[{type:'text',text}, {type:'image',...}]
 */
export function toDshMessages(messages = []) {
  const out = []
  for (const m of messages) {
    const role = m.role === 'developer' ? 'system' : m.role
    if (role === 'tool') {
      out.push({
        role: 'tool',
        toolCallId: m.tool_call_id,
        content: [{ type: 'text', text: stringify(m.content) }],
      })
      continue
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      out.push({
        role: 'assistant',
        content: contentBlocks(m.content),
        toolCalls: m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments,
        })),
      })
      continue
    }
    out.push({ role, content: contentBlocks(m.content) })
  }
  return out
}

/** 把 OpenAI 的 content 转成 block 数组。 */
function contentBlocks(content) {
  if (content == null) return []
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }]
  }
  if (!Array.isArray(content)) return [{ type: 'text', text: stringify(content) }]

  const blocks = []
  for (const part of content) {
    if (typeof part === 'string') { blocks.push({ type: 'text', text: part }); continue }
    if (part?.type === 'text') { blocks.push({ type: 'text', text: String(part.text ?? '') }); continue }
    if (part?.type === 'image_url') {
      const url = part.image_url?.url ?? part.image_url
      blocks.push({ type: 'image', url: String(url ?? '') })
      continue
    }
    // 未知块：尽量转文本，不丢信息
    blocks.push({ type: 'text', text: stringify(part) })
  }
  return blocks
}

function stringify(v) {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

/**
 * OpenAI 请求 → dsh-llm 的 stream options。
 *
 * ## maxTokens 的语义（实测得出，反直觉但重要）
 *
 * **0 / 负数 / 不传 = 不限制**，交给上游用自己的上限。
 *
 * 实测同一道题（群聊短回复）三种写法：
 *
 *   maxTokens=4096    68s   推理 8469 字   正文  0 字   finish=max-tokens
 *   maxTokens=100000  32s   推理 4019 字   正文 24 字   finish=stop
 *   不传              34s   推理 3997 字   正文 24 字   finish=stop
 *
 * 给"中等"上限反而**最糟**：推理没有天然终点，模型会把预算一路顶到极限，
 * 正文一个 token 都不剩（表现为「HTTP 200 但内容为空」）。不限制时它推理完
 * 自然收口，又快又有正文。
 *
 * 只有客户端显式给了正整数才当上限，并保留 512 下限（太小的值必然被
 * 推理吃光，等于没回答）。
 */

export function toDshRequest(body = {}) {
  const req = {
    messages: toDshMessages(body.messages),
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    req.tools = body.tools.map((t) => ({
      name: t.function?.name ?? t.name,
      description: t.function?.description ?? t.description,
      parameters: t.function?.parameters ?? t.parameters,
    }))
  }
  const raw = body.max_tokens ?? body.max_completion_tokens
  // 只有"显式正整数"才当上限；0 / 负数 / 不传一律**不限制**
  //（不传这个字段，交给上游用自己的上限）。
  //
  // ⚠️ 这里原来兜底成 DEFAULT_MAX_TOKENS=4096，那正是踩过的坑：
  //    实测同一道题 maxTokens=4096 → 推理 8469 字 / 正文 0 字 / 68 秒；
  //    不限制 → 推理 3997 字 / 正文 24 字 / 34 秒。
  //    推理没有天然终点，给个中等上限它会一路顶到极限，正文全没了。
  if (typeof raw === 'number' && raw > 0) req.maxTokens = Math.max(raw, 512)
  if (typeof body.temperature === 'number') req.temperature = body.temperature
  if (typeof body.top_p === 'number') req.topP = body.top_p
  if (typeof body.stop === 'string' || Array.isArray(body.stop)) req.stop = body.stop
  if (typeof body.reasoning_effort === 'string') req.reasoningEffort = body.reasoning_effort
  return req
}

/**
 * dsh-llm chunk 流 → OpenAI SSE 事件流。
 *
 * dsh-llm 的 chunk 类型（实测）：
 *   { type:'block-start', index, blockType }
 *   { type:'text-delta', index, text }        （推测）
 *   { type:'reasoning-delta', index, text }
 *   { type:'block-end', index, block }
 *   { type:'usage', usage:{...} }
 *   { type:'finish', reason:{kind} }
 *   { type:'tool-call', ... }                 （推测）
 */
export async function* toOpenAiSse(chunks, opts = {}) {
  const id = opts.id ?? `chatcmpl-${Date.now().toString(36)}`
  const model = opts.model ?? 'auto'
  const created = Math.floor(Date.now() / 1000)
  let index = 0
  let finishReason = 'stop'
  let usage = null

  const emit = (delta, finish = null) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finish,
    }],
  })

  // 首块：role
  yield sse(emit({ role: 'assistant', content: '' }))

  for await (const chunk of chunks) {
    const t = chunk?.type
    if (t === 'text-delta' || t === 'text') {
      const text = chunk.text ?? chunk.delta ?? ''
      if (text) yield sse(emit({ content: text }))
      continue
    }
    if (t === 'reasoning-delta' || t === 'reasoning') {
      // OpenAI 没有标准 reasoning 字段；用 reasoning_content 兼容 DeepSeek 风格
      const text = chunk.text ?? ''
      if (text) yield sse(emit({ reasoning_content: text }))
      continue
    }
    if (t === 'tool-call' || t === 'tool-call-delta') {
      const tc = chunk.toolCall ?? chunk.tool_call ?? chunk
      yield sse(emit({
        tool_calls: [{
          index,
          id: tc.id ?? `call_${index}`,
          type: 'function',
          function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
        }],
      }))
      index++
      finishReason = 'tool_calls'
      continue
    }
    if (t === 'usage') { usage = chunk.usage; continue }
    if (t === 'block-end') {
      // 有些实现把最终文本放在 block 里
      const b = chunk.block
      if (b?.type === 'text' && !chunk.__seenText) {
        // 避免与 text-delta 重复：仅当整个流没发过文本时才用
        // （dsh-llm 通常两个都给，这里靠 __seenText 标记去重）
      }
      continue
    }
    if (t === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error') {
        const msg = chunk.reason?.failure?.message ?? 'model error'
        yield sse({ error: { message: msg, type: 'upstream_error' } })
        yield 'data: [DONE]\n\n'
        return
      }
      if (kind === 'tool-calls') finishReason = 'tool_calls'
      else if (kind === 'max-tokens') finishReason = 'length'
      else if (kind === 'stop') finishReason = 'stop'
      continue
    }
    // 其它块类型忽略（block-start 等）
  }

  yield sse(emit({}, finishReason))
  if (opts.includeUsage && usage) {
    yield sse({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })
  }
  yield 'data: [DONE]\n\n'
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

/**
 * 把 chunk 流聚合成一个完整的非流式响应（stream:false 时用）。
 */
export async function toOpenAiResponse(chunks, opts = {}) {
  const id = opts.id ?? `chatcmpl-${Date.now().toString(36)}`
  const model = opts.model ?? 'auto'
  let text = ''
  let reasoning = ''
  const toolCalls = []
  let finishReason = 'stop'
  let usage = null

  for await (const chunk of chunks) {
    const t = chunk?.type
    if (t === 'text-delta' || t === 'text') text += chunk.text ?? chunk.delta ?? ''
    else if (t === 'reasoning-delta' || t === 'reasoning') reasoning += chunk.text ?? ''
    else if (t === 'tool-call' || t === 'tool-call-delta') {
      const tc = chunk.toolCall ?? chunk.tool_call ?? chunk
      toolCalls.push({
        id: tc.id ?? `call_${toolCalls.length}`,
        type: 'function',
        function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
      })
      finishReason = 'tool_calls'
    } else if (t === 'usage') usage = chunk.usage
    else if (t === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error') {
        const msg = chunk.reason?.failure?.message ?? 'model error'
        const e = new Error(msg)
        e.upstream = true
        throw e
      }
      if (kind === 'tool-calls') finishReason = 'tool_calls'
      else if (kind === 'max-tokens') finishReason = 'length'
      else if (kind === 'stop') finishReason = 'stop'
    }
  }

  const message = { role: 'assistant', content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length) message.tool_calls = toolCalls

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage
      ? {
        prompt_tokens: usage.inputTokens ?? 0,
        completion_tokens: usage.outputTokens ?? 0,
        total_tokens: usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)),
      }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}
