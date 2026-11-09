/**
 * 真实图片复检（可重复执行入口）
 *
 * 退出码：0=完整通过 / 1=判定不一致 / 2=INCOMPLETE（缺必测图、缺 key、缺目录、决策文件缺失或损坏、rear-3 出现未知 mode）
 *
 * rear-3 规则（**显式 mode 隔离**，不再用"有没有 reviewer"当豁免）：
 *   · mode=first_person → 跳过（设计）
 *   · mode=rear_selfie  → 必须有 photo.jpg 与 decision.json，执行 reviewNoBodySubject
 *   · 其他/未知 mode    → INCOMPLETE（不是正常跳过）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { reviewNoPhone, reviewNoBodySubject, pickReviewer } = await import(pathToFileURL(path.join(ROOT, 'src/qq/captureCheck.js')).href)

const CASES = [
  { name: 'front-1', expect: 'pass', expectedMode: 'front_selfie', required: true },
  { name: 'front-2', expect: 'pass', expectedMode: 'front_selfie', required: true },
  { name: 'front-3', expect: 'violation', expectedMode: 'front_selfie', required: true },
  { name: 'mirror-1', fixedSkip: 'mirror 不参与（设计）' },
  { name: 'mirror-2', fixedSkip: 'mirror 不参与（设计）' },
  { name: 'rear-1', expect: 'violation', expectedMode: 'rear_selfie', required: true },
  { name: 'rear-2', expect: 'violation', expectedMode: 'rear_selfie', required: true },
  { name: 'rear-3', expect: 'violation', byMode: true },   // 按实际 mode 决定
]

const DIR = process.env.CAPTURE_CHECK_IMAGES
  || path.join('C:/Users/Null_zwei/Documents/deepseek-harness/default-workspace/_scratch/photo-v3/step9')

const incomplete = []
let pass = 0, fail = 0, skip = 0
const rows = []
const markIncomplete = (why) => { incomplete.push(why); console.log(`  !!  ${why}`) }

if (!fs.existsSync(DIR)) {
  console.log(`INCOMPLETE：找不到图片目录 ${DIR}`)
  process.exit(2)
}
let cfg = null
try {
  const home = process.env.WHALE_POD_HOME || 'C:/Users/Null_zwei/.dsh/whale-pod'
  cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
} catch { /* ignore */ }
const gateway = `http://127.0.0.1:${cfg?.gateway?.port ?? 18899}/v1`
const key = cfg?.gateway?.key ?? null
if (!key) { console.log('INCOMPLETE：没有视觉网关 key（无法真实识别，且不允许伪造结果）'); process.exit(2) }

/** 读 decision.json：返回 {ok, mode} */
function readDecision(p) {
  try {
    if (!fs.existsSync(p)) return { ok: false, why: 'decision.json 缺失' }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const mode = typeof j?.mode === 'string' ? j.mode : ''
    if (!mode) return { ok: false, why: 'decision.json 缺 mode 字段' }
    return { ok: true, mode }
  } catch (e) {
    return { ok: false, why: 'decision.json 解析失败: ' + String(e?.message ?? '').slice(0, 30) }
  }
}

for (const c of CASES) {
  if (c.fixedSkip) { console.log(`  --  ${c.name} 跳过（${c.fixedSkip}）`); skip++; rows.push({ name: c.name, skipped: true, reason: c.fixedSkip }); continue }

  const ip = path.join(DIR, c.name, 'photo.jpg')
  const dp = path.join(DIR, c.name, 'decision.json')
  const dec = readDecision(dp)

  /* ---- rear-3：显式 mode 隔离 ---- */
  if (c.byMode) {
    if (!dec.ok) { markIncomplete(`${c.name} ${dec.why}`); skip++; rows.push({ name: c.name, skipped: true, reason: dec.why }); continue }
    if (dec.mode === 'first_person') {
      console.log(`  --  ${c.name} 跳过（实际 mode=first_person，设计如此）`)
      skip++; rows.push({ name: c.name, skipped: true, reason: 'mode=first_person' }); continue
    }
    if (dec.mode !== 'rear_selfie') {
      markIncomplete(`${c.name} 出现未登记 mode=${dec.mode}`)
      skip++; rows.push({ name: c.name, skipped: true, reason: 'unexpected mode=' + dec.mode }); continue
    }
    /* mode=rear_selfie → 必须有图，必须执行 reviewNoBodySubject */
    if (!fs.existsSync(ip)) { markIncomplete(`${c.name} mode=rear_selfie 但缺 photo.jpg`); skip++; rows.push({ name: c.name, skipped: true, reason: '缺图片' }); continue }
    /* fall through，用 reviewNoBodySubject */
  } else if (!dec.ok) {
    /* 其他必测项也需要 decision.json 才能确定 mode */
    markIncomplete(`${c.name} ${dec.why}`)
    skip++; rows.push({ name: c.name, skipped: true, reason: dec.why }); continue
  }

  if (!fs.existsSync(ip)) {
    if (c.required || c.byMode) markIncomplete(`${c.name} 缺 photo.jpg`)
    skip++; rows.push({ name: c.name, skipped: true, reason: '缺图片' }); continue
  }

  const mode = dec.mode
  /* ★ 先验证预期 mode 与实际一致：防止数据被改后调用了不对应的 reviewer 却仍判通过 */
  if (c.expectedMode && mode !== c.expectedMode) {
    markIncomplete(`${c.name} mode 不符：期望 ${c.expectedMode}，实际 ${mode}`)
    skip++; rows.push({ name: c.name, skipped: true, reason: `mode 不符：期望 ${c.expectedMode}，实际 ${mode}` })
    continue
  }
  const rev = pickReviewer(mode)
  if (!rev) {
    /* 走到这里说明期望表与 mode 不符（未登记组合）→ INCOMPLETE，而不是静默跳过 */
    markIncomplete(`${c.name} mode=${mode} 与期望表不符（无可执行 reviewer）`)
    skip++; rows.push({ name: c.name, skipped: true, reason: 'no reviewer for ' + mode }); continue
  }

  /* 3 次多数表决，逐次记录 */
  const buf = fs.readFileSync(ip)
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
  let r
  if (tally.pass >= 2) r = attempts.find((x) => x.status === 'pass')
  else if (tally.violation >= 2) r = attempts.find((x) => x.status === 'violation')
  else r = { status: 'uncertain', ok: null, reviewer: attempts[0].reviewer, violation: null, why: '三次未形成多数', confidence: null }

  const consistent = r.status === c.expect
  rows.push({ name: c.name, mode, status: r.status, violation: r.violation, why: r.why, confidence: r.confidence, ms, expect: c.expect, consistent, attempts: attempts.map((a) => ({ status: a.status, why: a.why, confidence: a.confidence })) })
  console.log(`  ${consistent ? 'OK' : 'XX'}  ${c.name} mode=${mode} → ${r.status}${r.violation ? '/' + r.violation : ''} (${ms}ms) 期望=${c.expect} | ${r.why}`)
  console.log(`       三次: ${attempts.map((a) => a.status).join('/')}`)
  if (consistent) pass++; else fail++
}

const judged = rows.filter((x) => !x.skipped)
const total = judged.length
const fp = judged.filter((x) => x.expect === 'pass' && x.status === 'violation').length
const fn = judged.filter((x) => x.expect === 'violation' && x.status === 'pass').length
const unc = judged.filter((x) => x.status === 'uncertain').length

console.log(`\n参与 ${total}（分母）｜一致 ${pass}｜不一致 ${fail}｜误报 ${fp}/${total}｜漏报 ${fn}/${total}｜uncertain ${unc}/${total}｜跳过 ${skip}`)
if (incomplete.length) { console.log(`INCOMPLETE：${incomplete.join('、')}`); process.exit(2) }
if (fail > 0) { console.log('FAILED：存在与期望不一致的结果'); process.exit(1) }
console.log('PASS：全部必测图片已执行且结果与期望一致')
process.exit(0)
