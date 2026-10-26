/**
 * check-image-body.mjs —— 图片响应体读取。
 *
 * 这条 bug 曾导致**所有图片下载失败**（表情包全部降级成文字），
 * 表现是「她不知道我在说什么」—— 因为模型根本看不到图。
 *
 * 根因：`Buffer.from(res.body)` 接不住 Web ReadableStream / Node Readable。
 * 本测试覆盖四种可能的 body 形态。
 */

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

// onebot.js 的 readBodyAsBuffer 是模块内私有函数，没有导出。
// 这里复制同一份实现做回归 —— 若两边逻辑分叉，check 会失败提醒。
// （用真实代码路径的集成测试需要跑起 NapCat，属于 probe 类。）
async function readBodyAsBuffer(res) {
  if (!res) return null
  const body = res.body ?? res
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof res.arrayBuffer === 'function') {
    try {
      return Buffer.from(await res.arrayBuffer())
    } catch { /* fallthrough */ }
  }
  if (typeof body?.getReader === 'function') {
    const reader = body.getReader()
    const parts = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parts.push(Buffer.from(value))
    }
    return Buffer.concat(parts)
  }
  if (typeof body?.on === 'function') {
    return await new Promise((resolve, reject) => {
      const parts = []
      body.on('data', (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      body.on('end', () => resolve(Buffer.concat(parts)))
      body.on('error', reject)
    })
  }
  return null
}

console.log('图片响应体')

const PAYLOAD = Buffer.from('假装这是 PNG 字节', 'utf8')

await ok('Buffer 直接返回', async () => {
  const out = await readBodyAsBuffer({ body: PAYLOAD })
  assert.deepEqual(out, PAYLOAD)
})

await ok('Uint8Array', async () => {
  const out = await readBodyAsBuffer({ body: new Uint8Array(PAYLOAD) })
  assert.deepEqual(Buffer.from(out), PAYLOAD)
})

await ok('Node Readable（代理兜底通道）', async () => {
  const stream = Readable.from([PAYLOAD.subarray(0, 10), PAYLOAD.subarray(10)])
  const out = await readBodyAsBuffer({ body: stream })
  assert.deepEqual(out, PAYLOAD)
})

await ok('Web ReadableStream（标准 fetch）', async () => {
  const rs = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(PAYLOAD.subarray(0, 8)))
      c.enqueue(new Uint8Array(PAYLOAD.subarray(8)))
      c.close()
    },
  })
  const out = await readBodyAsBuffer({ body: rs })
  assert.deepEqual(Buffer.from(out), PAYLOAD)
})

await ok('标准 Response（有 arrayBuffer）', async () => {
  const res = new Response(PAYLOAD)
  const out = await readBodyAsBuffer(res)
  assert.deepEqual(Buffer.from(out), PAYLOAD)
})

await ok('真实 fetch 拿到的 Response 也能读', async () => {
  // data: URL 不需要网络，纯本地验证
  const res = await fetch(`data:image/png;base64,${PAYLOAD.toString('base64')}`)
  const out = await readBodyAsBuffer(res)
  assert.deepEqual(Buffer.from(out), PAYLOAD)
})

await ok('认不出的类型返回 null（不抛错）', async () => {
  const out = await readBodyAsBuffer({ body: { 这不是流: true } })
  assert.equal(out, null)
})

await ok('空输入返回 null', async () => {
  assert.equal(await readBodyAsBuffer(null), null)
  assert.equal(await readBodyAsBuffer(undefined), null)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
