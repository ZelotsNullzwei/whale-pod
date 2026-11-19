/** 看点过滤器（2026-11-11 用户：「这些内容都没有什么看点」） */
import assert from 'node:assert/strict'
import { hasContentPoint } from '../src/qq/qzoneText.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
console.log('=== 没看点（不该发） ===')
for (const t of ['把洗手台边的肥皂盒刷干净了', '三点多坐在窗边喝了杯温水，翻了会儿超市促销单', '把衣柜下层理了理', '早上洗了床单']) {
  ok(`✗ ${t}`, () => assert.equal(hasContentPoint(t), false))
}
console.log('\n=== 有看点（可发） ===')
for (const t of ['风把晾在阳台的袜子吹掉了一只', '超市打折，顺手多买了一袋挂面', '煮面忘了看火，糊了半锅', '第一次把米饭焖得刚好，居然没夹生']) {
  ok(`✓ ${t}`, () => assert.equal(hasContentPoint(t), true))
}
console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
