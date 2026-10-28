/**
 * 「找图」标记的解析与匹配测试。
 *
 * 端到端链路（真实网络，需要 DEEPSEEK_API_KEY）在下面单独跑，
 * 这里只测纯函数部分 —— 每次 CI 都联网不现实。
 */
import assert from 'node:assert/strict'
import { extractFindImageMarkers, stripFindImageMarkers } from '../src/qq/imageFindMarkers.js'
import { extractImages, scoreImage, toTerms, queryBigrams, isRelevant } from '../src/gateway/imageFind.js'
import { findImageKey, isDuplicateFindImage } from '../src/qq/imageFindMarkers.js'

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

// ── 相关性判据（2026-10-28 用户报「找到东西不相关」）─────────
//
// 真实翻车现场：
//   找图「明日方舟终末地 祀 立绘」→ news.17173.com 提取到 57 张
//   → alt 全空、全部并列 0 分 → 排序退化成文档顺序
//   → 选中广告横幅 /novar/20261022/YgJRcFbufreCxad.jpg 发进群

ok('toTerms 保留单字内容词（人名「祀」）', () => {
  const t = toTerms('明日方舟终末地 祀 立绘')
  assert.ok(t.includes('祀'), `「祀」被丢了：${JSON.stringify(t)}`)
  assert.ok(t.includes('立绘'))
  assert.ok(t.includes('明日方舟终末地'))
})

ok('toTerms 仍然不保留单字虚词/量词', () => {
  const t = toTerms('找 的 个 一 张 这 那')
  assert.ok(!t.includes('的'))
  assert.ok(!t.includes('个'))
  assert.ok(!t.includes('这'))
})

ok('queryBigrams 切出相邻双字词组', () => {
  const g = queryBigrams(['明日方舟终末地'])
  assert.ok(g.includes('明日'))
  assert.ok(g.includes('方舟'))
  assert.ok(g.includes('末地'))
  assert.ok(!g.includes('明日方'), '只取相邻两字')
})

ok('isRelevant：命中「祀」单字 → 相关', () => {
  const terms = toTerms('明日方舟终末地 祀 立绘')
  const o = { url: 'https://220.bobopic.com/small/150938421.jpg' }
  assert.equal(isRelevant('尺寸2814x4462 女孩和祀 2K图片', terms, o), true)
})

ok('isRelevant：17173 广告横幅（alt 空、URL 随机）→ 无关', () => {
  const terms = toTerms('明日方舟终末地 祀 立绘')
  const o = { url: 'https://i.17173cdn.com/gdthue/YWxqaGBf/novar/20261022/YgJRcFbufreCxad.jpg!a-3-32' }
  assert.equal(isRelevant('', terms, o), false, '这张就是当时发错的那张')
})

ok('isRelevant：长描述里只偶然含一个「明」→ 无关（不能只看单字）', () => {
  const terms = toTerms('明日方舟终末地 祀 立绘')
  const alt = '这是一段很长的说明文字用来测试长描述加成会不会让无关图也混过去'.repeat(3)
  assert.equal(isRelevant(alt, terms, { url: 'https://x.com/a.jpg' }), false)
})

ok('isRelevant：只写到游戏名（双字命中）→ 相关', () => {
  const terms = toTerms('明日方舟终末地 祀 立绘')
  assert.equal(isRelevant('明日方舟 官方壁纸', terms, { url: 'https://x.com/w.jpg' }), true)
})

ok('isRelevant：导航装饰图 → 无关', () => {
  const terms = toTerms('明日方舟终末地 祀 立绘')
  assert.equal(isRelevant('首页 上一页 下一页', terms, { url: 'https://x.com/nav.png' }), false)
})

ok('isRelevant：没有关键词 → 无关（不乱发）', () => {
  assert.equal(isRelevant('随便什么图', [], { url: 'https://x.com/a.jpg' }), false)
})

ok('isRelevant：URL 里含关键词也算命中', () => {
  const terms = toTerms('鲸鱼娘 女仆装 图片')
  assert.equal(isRelevant('', terms, { url: 'https://x.com/whale/鲸鱼娘-maid.jpg' }), true)
})

ok('scoreImage：无关图的长描述加成不足以构成「相关」', () => {
  const terms = toTerms('明日方舟终末地 祀 立绘')
  const longUnrelated = '说明文字'.repeat(200)
  const o = { url: 'https://x.com/a.jpg' }
  const s = scoreImage(longUnrelated, terms, o)
  assert.equal(isRelevant(longUnrelated, terms, o), false, '再有加成也不算相关')
  assert.ok(s <= 0.2, `加成不该盖过相关性判断，实际 ${s}`)
})

// ── 找图判重（2026-10-28 用户报「一直找图」）─────────────────
//
// 实测同一关键词反复搜了 5 次：
//   15:07:52「明日方舟 终末地 祀 立绘」
//   15:08:36「明日方舟终末地 祀 立绘」      ← 只差一个空格
//   15:18:59「明日方舟终末地 祀 角色立绘」
//   17:06:06「明日方舟终末地 祀 立绘」
//   17:07:32「明日方舟终末地 祀 角色立绘」
// 17:07:50 它自己说「图没出去，刚重搜了一张」。

const TF = 1_793_000_000_000

ok('findImageKey 把空格差异归一成同一个键', () => {
  assert.equal(findImageKey('明日方舟 终末地 祀 立绘'), findImageKey('明日方舟终末地 祀 立绘'))
  assert.equal(findImageKey('  明日方舟终末地  祀  立绘 '), findImageKey('明日方舟终末地祀立绘'))
})

ok('findImageKey 大小写不敏感', () => {
  assert.equal(findImageKey('Whale Maid'), findImageKey('whale maid'))
})

ok('判重：同一会话 1 分钟前找过 → 判重', () => {
  const key = findImageKey('明日方舟终末地 祀 立绘')
  const hist = [{ key, scope: 'group:1', at: TF - 60_000 }]
  assert.equal(isDuplicateFindImage(hist, { key, scope: 'group:1', now: TF }), true)
})

ok('判重：换了写法但同键，也算重', () => {
  const hist = [{ key: findImageKey('明日方舟 终末地 祀 立绘'), scope: 'group:1', at: TF - 60_000 }]
  const key2 = findImageKey('明日方舟终末地 祀 立绘')
  assert.equal(isDuplicateFindImage(hist, { key: key2, scope: 'group:1', now: TF }), true)
})

ok('判重：按会话分开 —— 别的群找同样的图不算重', () => {
  const key = findImageKey('小猫')
  const hist = [{ key, scope: 'group:1', at: TF - 60_000 }]
  assert.equal(isDuplicateFindImage(hist, { key, scope: 'group:2', now: TF }), false)
})

ok('判重：超过 10 分钟窗口 → 允许再找', () => {
  const key = findImageKey('小猫')
  const hist = [{ key, scope: 'group:1', at: TF - 20 * 60_000 }]
  assert.equal(isDuplicateFindImage(hist, { key, scope: 'group:1', now: TF }), false)
})

ok('判重：空历史 → 不判重', () => {
  assert.equal(isDuplicateFindImage([], { key: 'x', scope: 'group:1', now: TF }), false)
  assert.equal(isDuplicateFindImage(null, { key: 'x', scope: 'group:1', now: TF }), false)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)