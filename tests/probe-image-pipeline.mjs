/**
 * 用真实图片验证「下载 → 入库 → 产出 ImageBlock」整条链。
 *
 * 这是之前失败最多的环节：
 *   ✅ 下载成功
 *   ❌ admitEncodedImages is not a function  ← 刚修
 */
import fs from 'node:fs'
import { createAttachmentSupport } from '../src/gateway/attachment.js'

const APP = 'D:/DSH Desktop/resources/app'
const DSH_HOME = 'C:/Users/Null_zwei/.dsh'

console.log('=== 1. 挂载 attachment 支持 ===')
const att = await createAttachmentSupport({
  appDir: APP,
  dshHome: DSH_HOME,
  log: (lv, m) => console.log(`  [${lv}] ${m}`),
})
console.log(`  makeImageBlock: ${typeof att.makeImageBlock}`)
console.log(`  attachmentStore: ${att.attachmentStore ? '有' : '无'}`)
console.log(`  error: ${att.error ?? '(无)'}`)

if (!att.makeImageBlock) {
  console.log('\n❌ 挂载失败，后面无法继续')
  process.exit(1)
}

console.log('\n=== 2. 拉一张真实 QQ 图片 ===')
const hist = await fetch('http://127.0.0.1:3000/get_friend_msg_history', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ user_id: 2129024700, count: 10 }),
}).then((r) => r.json())

let imgUrl = null
for (const m of hist.data?.messages ?? []) {
  for (const seg of m.message ?? []) {
    if (seg.type === 'image' && seg.data?.url) imgUrl = seg.data.url
  }
}
if (!imgUrl) { console.log('  没有图片，跳过'); process.exit(1) }
console.log(`  URL: ${imgUrl.slice(0, 70)}…`)

const { fetchWithProxyFallback } = await import('../src/net.js')
const res = await fetchWithProxyFallback(imgUrl, {
  timeoutMs: 25000,
  log: (m) => console.log(`  ${m}`),
})
if (!res.ok) { console.log(`  ❌ 下载失败 HTTP ${res.status}`); process.exit(1) }

const buf = res.body ? Buffer.from(res.body) : Buffer.from(await res.arrayBuffer())
console.log(`  下载成功: ${buf.length} bytes, 头部 ${buf.subarray(0, 4).toString('hex')}`)

console.log('\n=== 3. 入库（之前在这里失败）===')
const base64 = buf.toString('base64')
const block = await att.makeImageBlock({ base64, mediaType: 'image/jpeg', name: 'test.jpg' })
if (!block) {
  console.log('  ❌ 入库失败（makeImageBlock 返回 null）')
  process.exit(1)
}
console.log('  ✅ 入库成功')
console.log(`     type: ${block.type}`)
console.log(`     attachmentId: ${block.attachment?.attachmentId ?? block.attachment?.id ?? JSON.stringify(block.attachment).slice(0, 100)}`)
console.log(`     mediaType: ${block.attachment?.mediaType}`)
console.log(`     width x height: ${block.attachment?.width} x ${block.attachment?.height}`)

console.log('\n=== 4. 完整 ImageBlock ===')
console.log('  ' + JSON.stringify(block).slice(0, 400))
