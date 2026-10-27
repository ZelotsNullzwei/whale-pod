/**
 * 「找图」标记的解析与匹配测试。
 *
 * 端到端链路（真实网络，需要 DEEPSEEK_API_KEY）在下面单独跑，
 * 这里只测纯函数部分 —— 每次 CI 都联网不现实。
 */
import assert from 'node:assert/strict'
import { extractFindImageMarkers, stripFindImageMarkers } from '../src/qq/imageFindMarkers.js'
import { extractImages, scoreImage, toTerms } from '../src/gateway/imageFind.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── 标记解析 ────────────────────────────────────────────────
ok('提取 [找图:关键词]', () => {
  const m = extractFindImageMarkers('给你找了张 [找图:鲸鱼娘 女仆装]')
  assert.equal(m.length, 1)
  assert.equal(m[0].query, '鲸鱼娘 女仆装')
})

ok('兼容全角冒号', () => {
  const m = extractFindImageMarkers('来 [找图：蓝色大肥鱼]')
  assert.equal(m.length, 1)
  assert.equal(m[0].query, '蓝色大肥鱼')
})

ok('多个标记都能提取', () => {
  const m = extractFindImageMarkers('[找图:猫] 和 [找图:狗]')
  assert.equal(m.length, 2)
})

ok('空关键词不算标记', () => {
  assert.equal(extractFindImageMarkers('[找图:]').length, 0)
})

ok('剥掉标记后只剩正文', () => {
  assert.equal(stripFindImageMarkers('穿啊 [找图:女仆装] 可正经了'), '穿啊 可正经了')
})

ok('剥掉标记不留空壳', () => {
  assert.equal(stripFindImageMarkers('[找图:猫]').trim(), '')
})

ok('没有标记时原文不动', () => {
  assert.equal(stripFindImageMarkers('正常一句话'), '正常一句话')
})

// ── HTML 图片提取 ───────────────────────────────────────────
ok('提取 img 的 src 和 alt', () => {
  const html = '<img src="/a.webp" alt="蓝发鲸尾的鲸鱼娘">'
  const r = extractImages(html, 'https://x.com/page')
  assert.equal(r.length, 1)
  assert.equal(r[0].url, 'https://x.com/a.webp')
  assert.equal(r[0].alt, '蓝发鲸尾的鲸鱼娘')
})

ok('过滤 avatar/logo', () => {
  const html = '<img src="/avatar.png" alt=""><img src="/logo.png"><img src="/real.webp" alt="真图">'
  const r = extractImages(html, 'https://x.com')
  assert.equal(r.length, 1)
  assert.equal(r[0].url, 'https://x.com/real.webp')
})

ok('懒加载 data-src 优先', () => {
  const html = '<img src="/placeholder.gif" data-src="/real.webp" alt="真图">'
  const r = extractImages(html, 'https://x.com')
  assert.equal(r[0].url, 'https://x.com/real.webp')
})

ok('相对路径转绝对', () => {
  const html = '<img src="../imgs/a.jpg" alt="x">'
  const r = extractImages(html, 'https://x.com/a/b/page.html')
  assert.equal(r[0].url, 'https://x.com/a/imgs/a.jpg')
})

ok('跳过非 http 协议', () => {
  const html = '<img src="data:image/png;base64,xxx" alt="x">'
  assert.equal(extractImages(html, 'https://x.com').length, 0)
})

ok('同一个 URL 只留一次', () => {
  const html = '<img src="/a.webp" alt="1"><img src="/a.webp" alt="2">'
  assert.equal(extractImages(html, 'https://x.com').length, 1)
})

// ── 打分与关键词 ───────────────────────────────────────────
ok('toTerms 去掉动作词', () => {
  const t = toTerms('给我找一张鲸鱼娘 女仆装 的图片')
  assert.ok(t.includes('鲸鱼娘'))
  assert.ok(t.includes('女仆装'))
  assert.ok(!t.includes('给我'))
  assert.ok(!t.includes('找'))
})

ok('scoreImage：命中越多分越高', () => {
  const terms = ['鲸鱼娘', '女仆装']
  const hi = scoreImage('鲸鱼娘身穿深蓝色女仆装', terms)
  const mid = scoreImage('鲸鱼娘在睡觉', terms)
  const lo = scoreImage('一只猫', terms)
  assert.ok(hi > mid)
  assert.ok(mid > lo)
})

ok('scoreImage：空 alt 得 0', () => {
  assert.equal(scoreImage('', ['鲸鱼娘']), 0)
})

ok('scoreImage：没关键词得 0', () => {
  assert.equal(scoreImage('鲸鱼娘', []), 0)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)