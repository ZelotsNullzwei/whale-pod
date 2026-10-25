/**
 * 实测：magpie 的模型到底能不能看图。
 *
 * 直接发一个 OpenAI 多模态请求，图片用 data URL。
 * 如果模型真能看图，必须能说出「战斗机」/「飞机」这类词。
 */
import fs from 'node:fs'

// 用你发的 F-14 那张图（1080x1620）
const IMG = process.argv[2] || 'C:/Users/Null_zwei/.dsh/attachments/v1/objects/ce/ced2e62a1b1cc8e7b48265f2a6fe35564e197f1099b8fcad9c94187846f798e1'

if (!fs.existsSync(IMG)) {
  console.log(`❌ 图片不存在: ${IMG}`)
  process.exit(1)
}
const buf = fs.readFileSync(IMG)
const b64 = buf.toString('base64')
console.log(`图片: ${IMG.split(/[\\/]/).pop()}  ${(buf.length / 1024).toFixed(0)} KB`)
console.log(`base64 长度: ${b64.length}`)

const models = [
  'auto/deepseek-v4.1-flash',
  'trae-global/gpt-6-astra',
  'trae-global/deepseek-v4.1-flash',
]

for (const model of models) {
  console.log(`\n=== ${model} ===`)
  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里是什么？一句话回答，说具体物体。' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
      ],
    }],
    max_tokens: 200,
    stream: false,
  }
  try {
    const t0 = Date.now()
    const r = await fetch('http://127.0.0.1:3425/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer dsh-local' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    })
    const text = await r.text()
    console.log(`  HTTP ${r.status}  ${Date.now() - t0}ms`)
    if (r.ok) {
      try {
        const j = JSON.parse(text)
        const c = j.choices?.[0]?.message?.content ?? ''
        console.log(`  回答: ${String(c).slice(0, 200)}`)
      } catch {
        console.log(`  ${text.slice(0, 300)}`)
      }
    } else {
      console.log(`  ${text.slice(0, 300)}`)
    }
  } catch (e) {
    console.log(`  ❌ ${e.message}`)
  }
}
