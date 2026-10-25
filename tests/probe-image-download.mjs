/**
 * 验证：QQ 图片 URL 能不能直连下载。
 * ECONNREFUSED 到底是「URL 过期」还是「网络/代理」问题。
 */
const url = process.argv[2]
if (!url) {
  console.log('用法: node test-img-fetch.mjs "<url>"')
  process.exit(1)
}

console.log('=== 代理环境变量 ===')
for (const n of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'NO_PROXY']) {
  const v = process.env[n]
  if (v) console.log(`  ${n}=${v}`)
}
console.log('  (空 = 无)')

console.log('\n=== 直连下载 ===')
try {
  const t0 = Date.now()
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  console.log(`  HTTP ${res.status}  ${Date.now() - t0}ms`)
  console.log(`  content-type: ${res.headers.get('content-type')}`)
  console.log(`  content-length: ${res.headers.get('content-length')}`)
  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer())
    console.log(`  实际字节: ${buf.length}  ${(buf.length / 1024).toFixed(0)} KB`)
    // PNG/JPEG 魔数
    const head = buf.subarray(0, 4).toString('hex')
    console.log(`  头部: ${head}  (ffd8ff=JPEG, 89504e47=PNG)`)
  }
} catch (e) {
  console.log(`  ❌ ${e.name}: ${e.message}`)
  console.log(`     cause.code: ${e.cause?.code}`)
  console.log(`     cause.message: ${e.cause?.message}`)
}
