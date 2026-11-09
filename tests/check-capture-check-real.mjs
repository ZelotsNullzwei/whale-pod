/**
 * 真实图片复检（可重复执行入口）
 *
 * 用法：
 *   CAPTURE_CHECK_IMAGES=<图片目录> node tests/check-capture-check-real.mjs
 *   目录结构要求（每张：<dir>/<name>/photo.jpg + decision.json）
 *   不设环境变量时默认找 `_scratch/photo-v3/step9`（本机实验目录，不在仓库）。
 *
 * 语义：
 *   · 缺图片目录 / 缺网关 key → 打印 SKIPPED 并 exit 0（**不算通过**，也不伪造结果）
 *   · 有图片则**真实调用视觉模型**，逐张与期望比对，统计误报/漏报/uncertain
 *   · 任一张与期望不一致 → exit 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { reviewNoPhone, reviewNoBodySubject, pickReviewer } = await import(pathToFileURL(path.join(ROOT, 'src/qq/captureCheck.js')).href)

/* 期望表（人工判定，不是模型返回值） */
const CASES = [
  { name: 'front-1', expect: 'pass' },
  { name: 'front-2', expect: 'pass' },
  { name: 'front-3', expect: 'violation' },
  { name: 'mirror-1', skip: 'mirror 不参与' },
  { name: 'mirror-2', skip: 'mirror 不参与' },
  { name: 'rear-1', expect: 'violation' },
  { name: 'rear-2', expect: 'violation' },
  { name: 'rear-3', skip: '实际 mode=first_person' },
]

const DIR = process.env.CAPTURE_CHECK_IMAGES
  || path.join('C:/Users/Null_zwei/Documents/deepseek-harness/default-workspace/_scratch/photo-v3/step9')

if (!fs.existsSync(DIR)) {
  console.log(`SKIPPED：找不到图片目录 ${DIR}`)
  console.log('（真实图片验证未执行；这不是通过，只是缺素材）')
  process.exit(0)
}

let cfg = null
try {
  const home = process.env.WHALE_POD_HOME || 'C:/Users/Null_zwei/.dsh/whale-pod'
  cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
} catch { /* ignore */ }
const port = cfg?.gateway?.port ?? 18899
const key = cfg?.gateway?.key ?? null
const gateway = `http://127.0.0.1:${port}/v1`
if (!key) {
  console.log('SKIPPED：没有视觉网关 key（无法真实识别，且不允许伪造结果）')
  process.exit(0)
}

let pass = 0, fail = 0, skip = 0
const rows = []
for (const c of CASES) {
  const ip = path.join(DIR, c.name, 'photo.jpg')
  const dp = path.join(DIR, c.name, 'decision.json')
  if (!fs.existsSync(ip)) { console.log(`  --  ${c.name} 缺图片，跳过`); skip++; continue }
  const mode = fs.existsSync(dp) ? JSON.parse(fs.readFileSync(dp, 'utf8')).mode : '(unknown)'
  if (c.skip) { console.log(`  --  ${c.name} 跳过（${c.skip}）`); skip++; continue }
  const rev = pickReviewer(mode)
  if (!rev) { console.log(`  --  ${c.name} mode=${mode} 无对应 reviewer，跳过`); skip++; continue }

  const buf = fs.readFileSync(ip)
  const t0 = Date.now()
  let r
  try { r = await rev({ buf, gateway, key, timeoutMs: 30000 }) }
  catch (e) { r = { status: 'uncertain', ok: null, reviewer: '?', violation: null, why: '异常:' + String(e?.message ?? '').slice(0, 40), confidence: null } }
  const ms = Date.now() - t0
  const consistent = r.status === c.expect
  rows.push({ name: c.name, mode, status: r.status, violation: r.violation, why: r.why, confidence: r.confidence, ms, expect: c.expect, consistent })
  console.log(`  ${consistent ? 'OK' : 'XX'}  ${c.name} mode=${mode} → ${r.status}${r.violation ? '/' + r.violation : ''} (${ms}ms) 期望=${c.expect} | ${r.why}`)
  consistent ? pass++ : fail++
}

const total = rows.length
const fp = rows.filter((x) => x.expect === 'pass' && x.status === 'violation').length
const fn = rows.filter((x) => x.expect === 'violation' && x.status === 'pass').length
const unc = rows.filter((x) => x.status === 'uncertain').length
console.log(`\n参与 ${total}（分母）｜一致 ${pass}｜不一致 ${fail}｜误报 ${fp}/${total}｜漏报 ${fn}/${total}｜uncertain ${unc}/${total}｜跳过 ${skip}`)
process.exit(fail === 0 ? 0 : 1)
