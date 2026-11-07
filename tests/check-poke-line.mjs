/**
 * 被戳时说的话不要是固定两句（2026-11-07）。
 *
 * 原来从一个 6 句固定池随机，戳多了就那两句来回。
 * 现在先让模型现编一句极短的话；模型失败/超时才回退固定池。
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const mk = (chunks) => ({
  cfg: { model: 'magpie/magpie/auto/deepseek-v4.1-flash' },
  gateway: {
    stream: () => (async function* () { for (const c of chunks) yield c })(),
  },
})

console.log('=== 1. 模型能出话 ===')
await ok('★ 拼出模型给的短句', async () => {
  const t = await p._pokeLine.call(mk([{ type: 'text-delta', text: '干嘛呀' }]))
  assert.equal(t, '干嘛呀')
})
await ok('去引号/去括号', async () => {
  const t = await p._pokeLine.call(mk([{ type: 'text-delta', text: '「别戳了」' }]))
  assert.equal(t, '别戳了')
})

console.log('\n=== 2. 失败要回退 ===')
await ok('★ 上游报错 → null（调用方回退固定池）', async () => {
  const fake = {
    cfg: { model: 'x/y' },
    gateway: { stream: () => (async function* () { yield { type: 'error', message: 'boom' } })() },
  }
  assert.equal(await p._pokeLine.call(fake), null)
})
await ok('没有 gateway → null', async () => {
  assert.equal(await p._pokeLine.call({ cfg: {} }), null)
})
await ok('空文本 → null', async () => {
  assert.equal(await p._pokeLine.call(mk([{ type: 'text-delta', text: '   ' }])), null)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
