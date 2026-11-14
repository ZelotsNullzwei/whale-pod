/**
 * 统一测试入口：跑所有 check-*.mjs。
 *
 * 用法：
 *   node tests/run.mjs            跑全部
 *   node tests/run.mjs decision   只跑名字含 decision 的
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const filter = process.argv[2] ?? ''

/*
 * 默认跳过的「真实依赖」测试（2026-11-10）。
 * 它们要**真实视觉网关 key + 本机样图**，判定由视觉模型给出，会偶发漂移
 * （实测同一份代码一次 47s 失败、单跑 5/5 通过）。放进默认回归只会制造假红。
 * 需要时手动跑：node tests/check-capture-check-real.mjs
 * ⚠️ 只跳过**依赖外部服务**的这一类，不跳过任何纯逻辑测试。
 */
const REAL_NETWORK = new Set([
  'check-capture-check-real.mjs', // 真实视觉网关 + 本机样图
  'check-search.mjs',             // 真连 DeepSeek 搜索 API（要 DEEPSEEK_API_KEY / 网络）
])

const files = fs.readdirSync(here)
  .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
  .filter((f) => !REAL_NETWORK.has(f))
  .filter((f) => !filter || f.includes(filter))
  .sort()

if (REAL_NETWORK.size && !filter) {
  console.log(`（默认跳过 ${REAL_NETWORK.size} 个真实服务测试：${[...REAL_NETWORK].join(', ')}）`)
}

if (files.length === 0) {
  console.error(`没有匹配的测试（filter="${filter}"）`)
  process.exit(1)
}

console.log(`将运行 ${files.length} 个测试文件\n${'='.repeat(60)}`)

const results = []
for (const f of files) {
  console.log(`\n▶ ${f}\n${'-'.repeat(60)}`)
  const t0 = Date.now()
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, f)], { stdio: 'inherit', env: process.env })
    child.on('exit', (c) => resolve(c ?? 1))
  })
  results.push({ file: f, code, ms: Date.now() - t0 })
}

console.log(`\n${'='.repeat(60)}`)
console.log('汇总：')
let failed = 0
for (const r of results) {
  const mark = r.code === 0 ? '✅' : '❌'
  if (r.code !== 0) failed++
  console.log(`  ${mark} ${r.file.padEnd(28)} ${(r.ms / 1000).toFixed(1)}s`)
}
console.log(`\n${results.length - failed} / ${results.length} 个测试文件通过`)
process.exit(failed === 0 ? 0 : 1)
