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

const files = fs.readdirSync(here)
  .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
  .filter((f) => !filter || f.includes(filter))
  .sort()

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
