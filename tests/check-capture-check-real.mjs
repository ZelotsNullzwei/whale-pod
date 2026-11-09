/**
 * 真实图片复检（可重复执行入口）
 *
 * 用法：
 *   CAPTURE_CHECK_IMAGES=<图片目录> node tests/check-capture-check-real.mjs
 *   目录结构：<dir>/<name>/photo.jpg + decision.json
 *   默认目录：_scratch/photo-v3/step9（本机实验目录，不在仓库）
 *
 * 退出码：
 *   0  全部通过且**完整**（必测图片都在、无缺失）
 *   1  有判定与期望不一致
 *   2  INCOMPLETE：缺必测图片 / 缺网关 key / 缺图片目录（**绝不报 PASS**）
 *
 * 规则：
 *   · 真实调用视觉模型，不用 mock
 *   · mirror-1/2 固定跳过（按设计不审）
 *   · rear-3 **按实际 decision.json.mode 判断**：first_person 才跳过；
 *     若变成 rear_selfie 则必须执行 reviewer（验证 mode 隔离而非固定名单）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { reviewNoPhone, reviewNoBodySubject, pickReviewer } = await import(pathToFileURL(path.join(ROOT, 'src/qq/captureCheck.js')).href)

/* 期望表：required=必须存在并参与；fixedSkip=固定跳过 */
const CASES = [
  { name: 'front-1', expect: 'pass', required: true },
  { name: 'front-2', expect: 'pass', required: true },
  { name: 'front-3', expect: 'violation', required: true },
  { name: 'mirror-1', fixedSkip: 'mirror 不参与（设计）' },
  { name: 'mirror-2', fixedSkip: 'mirror 不参与（设计）' },
  { name: 'rear-1', expect: 'violation', required: true },
  { name: 'rear-2', expect: 'violation', required: true },
  /* rear-3 不写死：按实际 mode 决定 */
  { name: 'rear-3', expect: 'violation', byMode: true },
]

const DIR = process.env.CAPTURE_CHECK_IMAGES
  || path.join('C:/Users/Null_zwei/Documents/deepseek-harness/default-workspace/_scratch/photo-v3/step9')

const incomplete = []
let pass = 0, fail = 0, skip = 0
const rows = []

if (!fs.existsSync(DIR)) {
  console.log(`INCOMPLETE：找不到图片目录 ${DIR}`)
  console.log('（真实图片验证未执行；这不是通过，只是缺素材）')
  process.exit(2)
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
  console.log('INCOMPLETE：没有视觉网关 key（无法真实识别，且不允许伪造结果）')
  process.exit(2)
}

for (const c of CASES) {
  const ip = path.join(DIR, c.name, 'photo.jpg')
  const dp = path.join(DIR, c.name, 'decision.json')

  if (c.fixedSkip) { console.log(`  --  ${c.name} 跳过（${c.fixedSkip}）`); skip++; rows.push({ name: c.name, skipped: true, reason: c.fixedSkip }); continue }

  if (!fs.existsSync(ip)) {
    console.log(`  !!  ${c.name} 缺图片`)
    if (c.required) incomplete.push(c.name + '(缺图片)')
    skip++
    rows.push({ name: c.name, skipped: true, reason: '缺图片' })
    continue
  }

  const mode = fs.existsSync(dp) ? JSON.parse(fs.readFileSync(dp, 'utf8')).mode : '(unknown)'

  /* 按实际 mode 判断是否应该跳过 */
  if (c.byMode) {
    const rev = pickReviewer(mode)
    if (!rev) {
      console.log(`  --  ${c.name} 跳过（实际 mode=${mode}，无对应 reviewer）`)
      skip++
      rows.push({ name: c.name, skipped: true, reason: 'mode=' + mode })
      continue
    }
  }

  const rev = pickReviewer(mode)
  if (!rev) {
    console.log(`  !!  ${c.name} mode=${mode} 无可执行 reviewer（期望表与 mode 不符）`)
    if (c.required) incomplete.push(c.name + '(mode 无可执行 reviewer)')
    skip++
    rows.push({ name: c.name, skipped: true, reason: 'no reviewer for ' + mode })
    continue
  }

  const buf = fs.readFileSync(ip)
  /*
   * 单次视觉判定存在抖动（实测同一张图会偶发把"手臂边缘"看成手机）。
   * 这里跑 3 次取**多数**为结论，但把每次结果都打印/记录，不隐藏抖动。
   */
  const attempts = []
  const t0 = Date.now()
  for (let k = 0; k < 3; k++) {
    let rk
    try { rk = await rev({ buf, gateway, key, timeoutMs: 30000 }) }
    catch (e) { rk = { status: 'uncertain', ok: null, reviewer: '?', violation: null, why: '异常:' + String(e?.message ?? '').slice(0, 40), confidence: null } }
    attempts.push(rk)
  }
  const ms = Date.now() - t0
  const tally = { pass: 0, violation: 0, uncertain: 0 }
  for (const a of attempts) tally[a.status]++
  let final = attempts[attempts.length - 1]
  if (tally.pass >= 2) final = attempts.find((x) => x.status === 'pass')
  else if (tally.violation >= 2) final = attempts.find((x) => x.status === 'violation')
  else final = { status: 'uncertain', ok: null, reviewer: attempts[0].reviewer, violation: null, why: '三次未形成多数', confidence: null }
  const r = final
  const consistent = r.status === c.expect
  rows.push({ name: c.name, mode, status: r.status, violation: r.violation, why: r.why, confidence: r.confidence, ms, expect: c.expect, consistent, attempts: attempts.map((a) => ({ status: a.status, why: a.why, confidence: a.confidence })) })
  console.log(`  ${consistent ? 'OK' : 'XX'}  ${c.name} mode=${mode} → ${r.status}${r.violation ? '/' + r.violation : ''} (${ms}ms) 期望=${c.expect} | ${r.why}`)
  console.log(`       三次: ${attempts.map((a) => a.status).join('/')}${tally.pass < 2 && tally.violation < 2 ? ' (无多数→uncertain)' : ''}`)
  if (consistent) pass++; else fail++
}

const judged = rows.filter((x) => !x.skipped)
const total = judged.length
const fp = judged.filter((x) => x.expect === 'pass' && x.status === 'violation').length
const fn = judged.filter((x) => x.expect === 'violation' && x.status === 'pass').length
const unc = judged.filter((x) => x.status === 'uncertain').length

console.log(`\n参与 ${total}（分母）｜一致 ${pass}｜不一致 ${fail}｜误报 ${fp}/${total}｜漏报 ${fn}/${total}｜uncertain ${unc}/${total}｜跳过 ${skip}`)
if (incomplete.length) {
  console.log(`INCOMPLETE：缺少必测项 → ${incomplete.join('、')}`)
  process.exit(2)
}
if (fail > 0) { console.log('FAILED：存在与期望不一致的结果'); process.exit(1) }
console.log('PASS：全部必测图片已执行且结果与期望一致')
process.exit(0)
