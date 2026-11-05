#!/usr/bin/env node
/**
 * 导出生成图缓存。
 *
 *   node scripts/export-images.mjs                     → 复制到 ./export-images/
 *   node scripts/export-images.mjs D:/某目录            → 指定目录
 *   node scripts/export-images.mjs D:/某目录 --days 7   → 只要最近 7 天的
 *   node scripts/export-images.mjs D:/某目录 --scope private:2129024700
 *
 * 会把图（.png）连同 index.json 一起复制过去，index.json 里有提示词和时间。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = process.env.WHALE_POD_HOME
  ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'whale-pod')
const SRC = path.join(HOME, 'generated')

const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : dflt
}

const outDir = positional[0] ?? path.join(process.cwd(), 'export-images')
const days = Number(flag('days', 0)) || 0
const scope = flag('scope', '')

if (!fs.existsSync(SRC)) {
  console.error(`没有缓存目录：${SRC}`)
  process.exit(1)
}
let index = { items: {} }
try {
  index = JSON.parse(fs.readFileSync(path.join(SRC, 'index.json'), 'utf8'))
} catch {
  console.error('index.json 读不出来（可能还没生成过图）')
  process.exit(1)
}

const cutoff = days > 0 ? Date.now() - days * 24 * 3600 * 1000 : 0
const items = Object.values(index.items ?? {})
  .filter((v) => (cutoff ? Number(v.at ?? 0) >= cutoff : true))
  .filter((v) => (scope ? String(v.scope ?? '') === scope : true))
  .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))

if (!items.length) {
  console.log('没有符合条件的图。')
  process.exit(0)
}

fs.mkdirSync(outDir, { recursive: true })
let copied = 0
const kept = {}
for (const it of items) {
  const from = path.join(SRC, `${it.key}.png`)
  if (!fs.existsSync(from)) continue
  const day = new Date(Number(it.at ?? 0)).toISOString().slice(0, 10)
  const to = path.join(outDir, `${day}-${it.key}.png`)
  fs.copyFileSync(from, to)
  kept[it.key] = it
  copied++
}
fs.writeFileSync(
  path.join(outDir, 'index.json'),
  JSON.stringify({ exportedAt: Date.now(), source: SRC, items: kept }, null, 2),
)
console.log(`导出 ${copied} 张 → ${outDir}`)
console.log('（index.json 里有每张的提示词和时间）')