/**
 * 转发图 → 单独调识图模型 → 变成文字（2026-11-06）。
 *
 * ## 要修的 bug
 * 线上日志：
 * ```
 * 04:01:59  转发图 1 块进上下文（视觉模型能看到）
 * 04:02:00  本条带 1 张图发给 deepseek-v4.1-flash-sg（若模型不支持视觉，图等于没传）
 * 04:02:02  [我]「八十七条全是图，本鱼这边一张都没显出来」
 * ```
 * 图**确实进了上下文**，但主模型是纯文本的 → 看不见 →
 * 她只能编（先说「看到是看到了」，8 秒后又说「一张都没显出来」）。
 *
 * ## 改法（用户：「用看 b 站视频的路径」）
 * 照 B 站那条路：**画面先转成文字，主模型只吃文字**。
 * Magpie 的 `settings.json` 里早就配了 `"vision": "auto/deepseek-v4.1-flash"`，
 * 但 `readMagpieSettings().vision` **只被读、从来没被用** —— 现在接上。
 *
 * ## 守什么
 * ① 有描述 → 拼进正文（主模型读文字）
 * ② 没描述 → 图块留着（万一主模型能看图），但**不假装看过**
 * ③ 视觉调用失败 → 当没看，正文保持原文，绝不编
 * ④ 输出过长（>400 字）→ 判定为 reasoning 漏出，丢弃
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stitchForwardImages } from '../src/qq/forward-images.js'
import { readMagpieSettings } from '../src/qq/mcpImage.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const mkFetch = () => async () => ({ dataUrl: PNG })
const mkBlock = () => async (o) => ({ type: 'image', name: o.name })

console.log('=== 1. describe 被调用，结果进 description ===')
await ok('★ 有识图回调 → description 有内容（主模型就能读文字了）', async () => {
  const r = await stitchForwardImages({
    refs: ['a', 'b'],
    fetchImage: mkFetch(),
    makeImageBlock: mkBlock(),
    describe: async () => '图里有两只猫，一只橘色一只白。',
    log: {},
  })
  assert.equal(r.description, '图里有两只猫，一只橘色一只白。')
  assert.equal(r.used, 2)
})

await ok('describe 返回空 → 没有 description（不假装看过）', async () => {
  const r = await stitchForwardImages({
    refs: ['a'],
    fetchImage: mkFetch(),
    makeImageBlock: mkBlock(),
    describe: async () => '',
    log: {},
  })
  assert.equal(r.description, undefined)
  assert.ok(r.blocks.length >= 1, '图块还是要留着')
})

await ok('describe 抛错 → 当没看，不抛（图是加分项）', async () => {
  const r = await stitchForwardImages({
    refs: ['a', 'b'],
    fetchImage: mkFetch(),
    makeImageBlock: mkBlock(),
    describe: async () => { throw new Error('视觉渠道挂了') },
    log: {},
  })
  assert.equal(r.description, undefined)
  assert.ok(r.used > 0, '下载和拼图不受影响')
})

await ok('没给 describe → 老行为不变（只给块）', async () => {
  const r = await stitchForwardImages({
    refs: ['a'],
    fetchImage: mkFetch(),
    makeImageBlock: mkBlock(),
    log: {},
  })
  assert.equal(r.description, undefined)
  assert.ok(r.blocks.length >= 1)
})

console.log('\n=== 2. Magpie 的 vision 配置真的读得到 ===')
await ok('readMagpieSettings 返回 vision（这就是那个"只读不用"的字段）', () => {
  const s = readMagpieSettings()
  assert.equal(typeof s.vision, 'string')
  assert.equal(typeof s.imageGen, 'string')
  // 这台机器上确实配了；没配也不该抛
  console.log(`     当前：vision="${s.vision}" imageGen="${s.imageGen}"`)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)