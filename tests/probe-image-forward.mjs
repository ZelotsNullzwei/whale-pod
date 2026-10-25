/**
 * 验证：ImageBlock 带 dataUrl 后，转发层能不能正确拼出 image_url。
 *
 * 这是「图发了但模型看不见」的最后一环。
 */
import fs from 'node:fs'
import { createAttachmentSupport } from '../src/gateway/attachment.js'

const APP = 'D:/DSH Desktop/resources/app'

console.log('=== 1. 造一个 ImageBlock ===')
const att = await createAttachmentSupport({
  appDir: APP,
  dshHome: 'C:/Users/Null_zwei/.dsh',
  log: (lv, m) => console.log(`  [${lv}] ${m}`),
})

const IMG = 'C:/Users/Null_zwei/.dsh/attachments/v1/objects/ce/ced2e62a1b1cc8e7b48265f2a6fe35564e197f1099b8fcad9c94187846f798e1'
const buf = fs.readFileSync(IMG)
const block = await att.makeImageBlock({
  base64: buf.toString('base64'),
  mediaType: 'image/jpeg',
  name: 'qq-image',
})

console.log(`  type: ${block?.type}`)
console.log(`  有 attachment: ${block?.attachment ? '是' : '否'}`)
console.log(`  有 dataUrl:    ${block?.dataUrl ? `是（${block.dataUrl.length} 字符）` : '❌ 否'}`)
console.log(`  dataUrl 前缀:  ${block?.dataUrl?.slice(0, 40)}…`)

console.log('\n=== 2. 走转发层，看拼出来的 content ===')
// 直接 import 内部函数做验证
const mod = await import('../src/gateway/fallback.js')

// blocksToOpenAiContent 没导出，用 llm.stream 抓请求体更真实
// 这里用一个小技巧：构造 llm 并拦截 fetch
const originalFetch = globalThis.fetch
let captured = null
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('chat/completions')) {
    captured = JSON.parse(opts.body)
    // 返回一个最小的 SSE 流
    return new Response(
      'data: {"choices":[{"delta":{"content":"看到了"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  return originalFetch(url, opts)
}

try {
  const llm = mod.createFallbackLlm({
    channels: [{
      id: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'dsh-local',
      model: 'magpie/auto/deepseek-v4.1-flash', models: ['magpie/auto/deepseek-v4.1-flash'],
    }],
    log: () => {},
  })

  for await (const _ of llm.stream({
    provider: 'magpie',
    model: 'magpie/auto/deepseek-v4.1-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        block,   // ← ImageBlock
      ],
    }],
    maxTokens: 50,
  })) { /* 只要请求体 */ }
} catch (e) {
  console.log(`  (流式读取异常，不影响验证请求体): ${e.message}`)
}

globalThis.fetch = originalFetch

console.log('\n=== 3. 实际发出的请求体（关键）===')
if (!captured) {
  console.log('  ❌ 没抓到请求')
} else {
  const content = captured.messages?.[0]?.content
  console.log(`  content 类型: ${Array.isArray(content) ? '数组（多模态 ✅）' : typeof content}`)
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'text') {
        console.log(`    [text] "${part.text}"`)
      } else if (part.type === 'image_url') {
        const u = part.image_url?.url ?? ''
        const isData = u.startsWith('data:image/')
        const isUndefined = u === 'undefined' || u === ''
        console.log(`    [image_url] ${isData ? `✅ data URL（${u.length} 字符）` : isUndefined ? '❌ "undefined" —— 就是这个 bug' : u.slice(0, 60)}`)
        console.log(`                前缀: ${u.slice(0, 50)}`)
      }
    }
  } else {
    console.log(`  ❌ content 是字符串（图丢了）: ${String(content).slice(0, 100)}`)
  }
}
