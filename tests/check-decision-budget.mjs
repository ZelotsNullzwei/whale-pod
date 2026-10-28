/**
 * 决策层「预算够不够 + 空正文能不能被发现」的回归测试（2026-10-28）。
 *
 * 用户症状：「看新的日志，这为什么回沉默」
 *
 * 日志实证：
 * ```
 * 21:47:31  decision/model：解析不出 verdict（原始=""），重试 1/1
 * 21:47:32  decision/model：解析不出 verdict（原始=""），重试 2/1
 * 21:47:32  decision: model 失败 — 模型返回无法解析：""
 * 21:47:32  决策 → 沉默 (p=0.06, 来源=rule, 群聊中无 @，本次保持沉默)
 * ```
 * 当天「解析不出 verdict」出现 **551 次**。
 *
 * ## 两个问题
 *
 * ① **`maxTokens` 太小** —— 判断用的是推理模型，草稿能写到 2200 字，
 *    而 64 token 只装得下 64~100 个汉字，正文一个字都没剩下。
 *    实测（真实决策提示词、上下文 15 条）：
 *      64   → 4 次里空 3 次
 *      256  → 4 次里空 1 次
 *      1024 → 6 次全对
 *
 * ② **`fallback.js` 把这个「空」静默放过去了** ——
 *    收到 `finish_reason` 就 `return`，跳过了下面的 `if (!sawAny)` 兜底。
 *    于是调用方只看到「无法解析」，既不知道上游只给了推理、
 *    也没机会换渠道重试。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULTS } from '../src/config/store.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const repo = path.resolve(import.meta.dirname, '..')
/** 只看代码行，丢掉落单的注释行。 */
function codeLines(rel) {
  return fs.readFileSync(path.join(repo, rel), 'utf8')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('*/'))
}

// ── ① 预算 ────────────────────────────────────────────────
ok('config 默认的 decision.model.maxTokens 至少 512', () => {
  const mt = DEFAULTS.decision?.model?.maxTokens
  assert.equal(typeof mt, 'number', '要有这个默认值')
  assert.ok(mt >= 512, `实测 64 在长上下文下 4 次空 3 次；至少要 512，实际 ${mt}`)
})

ok('model.js 的兜底默认值也不能低于 512', () => {
  const lines = codeLines('src/decision/model.js')
  const line = lines.find((l) => l.includes('maxTokens: Number(this.cfg.maxTokens'))
  assert.ok(line, '应能找到 maxTokens 那一行')
  const m = line.match(/\?\?\s*(\d+)/)
  assert.ok(m, `应写成 cfg.maxTokens ?? <默认值>，实际：${line}`)
  assert.ok(Number(m[1]) >= 512, `兜底默认值太小：${m[1]}`)
})

// ── ② 空正文必须被发现 ──────────────────────────────────────
ok('fallback.js：finish 之前先判「有没有正文」', () => {
  const src = fs.readFileSync(path.join(repo, 'src', 'gateway', 'fallback.js'), 'utf8')
  const lines = src.split('\n').map((l) => l.trim())
  const iFin = lines.findIndex((l) => l.includes('const fin = j.choices?.[0]?.finish_reason'))
  assert.ok(iFin >= 0, '应能找到 finish_reason 判断')
  const block = lines.slice(iFin, iFin + 24).join('\n')
  assert.ok(/if \(!sawAny\)/.test(block), 'finish 分支里必须先检查 sawAny（否则空正文被静默放过）')
  assert.ok(/errorChunk\(/.test(block), '应为空正文产出 error chunk，而不是静默 finish')
})

ok('fallback.js：原有的「流自然结束」兜底还在', () => {
  const src = fs.readFileSync(path.join(repo, 'src', 'gateway', 'fallback.js'), 'utf8')
  assert.match(src, /上游没有返回任何内容/, '这段兜底不该被删')
})

ok('出错信息要能指向真正原因（推理吃光预算）', () => {
  const src = fs.readFileSync(path.join(repo, 'src', 'gateway', 'fallback.js'), 'utf8')
  assert.match(src, /推理内容可能吃光了 maxTokens/, '错误文案要说明可能原因')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)