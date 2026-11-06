/**
 * 模型 id 归一化（2026-11-06）。
 *
 * 现场：侧栏下拉点 hy4free，写进配置的是 `magpie/magpie/magpie/workbuddy/hy4free`
 * —— 三个 magpie，网关必然 404，但日志只说"已更新"。
 * 面板拼 `<渠道>/<provider>/<模型>`，而目录 id 自带渠道前缀 → 多拼一次。
 *
 * 守什么：
 * - 三个及以上的重复首段 → 收成两个
 * - 本来就两个 / 一个 / auto → 原样
 * - 别的 provider（deepseek-official/...）不动
 */
import assert from 'node:assert/strict'
import { normalizeModelId } from '../src/qq/modelId.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 线上那个坏值 ===')
ok('★ magpie ×3 → ×2（用户实际点出来的值）', () => {
  assert.equal(
    normalizeModelId('magpie/magpie/magpie/workbuddy/hy4free'),
    'magpie/magpie/workbuddy/hy4free',
  )
})
ok('magpie ×4 → ×2', () => {
  assert.equal(
    normalizeModelId('magpie/magpie/magpie/magpie/auto/deepseek-v4.1-flash'),
    'magpie/magpie/auto/deepseek-v4.1-flash',
  )
})

console.log('\n=== 2. 正确的值不能动 ===')
ok('两段前缀 → 原样', () => {
  assert.equal(normalizeModelId('magpie/magpie/auto/deepseek-v4.1-flash'), 'magpie/magpie/auto/deepseek-v4.1-flash')
})
ok('单段前缀 → 原样（有的路径就这么存）', () => {
  assert.equal(normalizeModelId('magpie/workbuddy/hy4free'), 'magpie/workbuddy/hy4free')
})
ok('auto → 原样', () => {
  assert.equal(normalizeModelId('auto'), 'auto')
})
ok('别的 provider 不动', () => {
  assert.equal(normalizeModelId('deepseek-official/deepseek-flash'), 'deepseek-official/deepseek-flash')
})
ok('空串 / 非字符串安全', () => {
  assert.equal(normalizeModelId(''), '')
  assert.equal(normalizeModelId(undefined), '')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
