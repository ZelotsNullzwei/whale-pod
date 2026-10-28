/**
 * `buildOutgoingSegments` 回归测试（2026-10-28）。
 *
 * ## 修的是什么
 *
 * 群里让人「去找张图回来」，模型只输出 `[找图:...]` 标记、**没有正文**。
 * 标记剥掉后 text 为空 → segments 为空 → 原来的
 * `if (cover?.url && segments.length > 0)` 把**已经下好的图一起丢掉**，
 * 结果一个字一张图都没发（用户原话：「这都没回」）。
 */
import assert from 'node:assert/strict'
import { buildOutgoingSegments } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const cover = { url: 'base64://AAAA' }

// ── 核心：只有图也要发 ──────────────────────────────────────
ok('空正文 + 有图 → 仍然产出 1 个 image 段（核心修复）', () => {
  const segs = buildOutgoingSegments('', cover)
  assert.equal(segs.length, 1, '不能因为没文字就把图丢掉')
  assert.equal(segs[0].kind, 'image')
  assert.equal(segs[0].url, cover.url)
})

ok('纯空白正文 + 有图 → 仍然发图', () => {
  const segs = buildOutgoingSegments('   \n  ', cover)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, 'image')
})

// ── 正常组合 ────────────────────────────────────────────────
ok('有正文 + 有图 → text 在前、image 在后', () => {
  const segs = buildOutgoingSegments('这是图', cover)
  assert.equal(segs.length, 2)
  assert.equal(segs[0].kind, 'text')
  assert.equal(segs[0].text, '这是图')
  assert.equal(segs[1].kind, 'image')
})

ok('有正文 + 无图 → 只有 text', () => {
  const segs = buildOutgoingSegments('只有文字', null)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, 'text')
})

ok('空正文 + 无图 → 空数组（确实没什么可发）', () => {
  assert.equal(buildOutgoingSegments('', null).length, 0)
})

// ── 表情段 ─────────────────────────────────────────────────
ok('正文里的 [表情包] 单独成段', () => {
  const segs = buildOutgoingSegments('哈[表情包]哈', null)
  const kinds = segs.map((s) => s.kind)
  assert.ok(kinds.includes('mface') || kinds.includes('face'), `实际：${kinds.join(',')}`)
})

// ── 分段开关 ───────────────────────────────────────────────
ok('segment:true 时长正文被拆多段', () => {
  const long = '第一句话。第二句话。第三句话。第四句话。'.repeat(3)
  const segs = buildOutgoingSegments(long, null, { segment: true, maxChars: 20 })
  assert.ok(segs.length > 1, `应该被拆开，实际 ${segs.length} 段`)
})

ok('segment:false（默认）时正文不拆', () => {
  const long = '第一句话。第二句话。第三句话。第四句话。'.repeat(3)
  const segs = buildOutgoingSegments(long, null)
  assert.equal(segs.length, 1)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
