/**
 * 车牌识别（`src/gateway/codes.js`）。
 *
 * ## ★★★ 2026-11-03 修的坑：**只认 `JM123456`，不认链接**
 * 用户在私聊里发 `https://18comic.vip/album/1481228`，
 * 她回「**我这边打不开，链接是死的**」✗。
 *
 * 查下来：
 * ```
 * 日志  06:27:34  bridge：链接预览 ✗ 打不开 — http://18comic.vip/album/1481228
 * 原因  detectCode('…/album/1481228') → **null**
 *       → 这条消息走了「普通链接预览」那条路（成人站必然失败 ✗）
 *       → 而**能真看内页的 `jm-read` 一次都没触发过**（日志里一行都没有）
 * ```
 *
 * ⚠️ **这是"判据太窄"的典型**：功能都在、配置也开着，
 *    但**最常见的那种输入形态没被认出来** —— 于是整条链路等于不存在。
 *
 * ## 本文件锁住的
 * ① 链接形态三种写法都认（带协议 / 不带协议 / 域名换 TLD）
 * ② `JM123456` 没被破坏
 * ③ ★ **纯数字仍然不认** —— 这条是**故意的**（注释里的理由：房间号、订单号、
 *    股价、手机号后四位都会误伤）。别为了"多认一点"把它放开。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { detectCode, formatCodeContext } from '../src/gateway/codes.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('\n=== ① ★★★ 链接形态（这次修的就是它）===')

ok('★★★ `18comic.vip/album/<数字>` 要认（用户真发的那个）', () => {
  const r = detectCode('http://18comic.vip/album/1481228')
  assert.ok(r, '★ 必须认 —— 不认就走不了 jm-read')
  assert.equal(r.id, '1481228')
  assert.equal(r.kind, 'jm')
})

ok('★★ 换 TLD 也要认（域名一直在换，只认 `18comic` 这个商标名）', () => {
  for (const host of ['18comic.ink', '18comic.org', '18comic.art', '18comic.biz', '18comic.xyz']) {
    const r = detectCode(`https://${host}/album/1481228`)
    assert.ok(r, `${host} 该认`)
    assert.equal(r.id, '1481228')
  }
})

ok('★★ 没带协议也要认（群里常直接贴 `18comic.vip/album/123`）', () => {
  assert.equal(detectCode('18comic.vip/album/1481228')?.id, '1481228')
})

ok('★★ 混在句子里也要认（真人不会只发一个裸链）', () => {
  const r = detectCode('这漫画不错 https://18comic.vip/album/1481228 你看看')
  assert.equal(r?.id, '1481228', '★ 要能从整句里挑出来')
})

ok('★ 端口号 / 多余路径也别绊倒它', () => {
  assert.equal(detectCode('http://18comic.vip:8080/album/1481228')?.id, '1481228')
  assert.equal(detectCode('https://18comic.vip/zh/album/1481228')?.id, '1481228', '带语言前缀')
})

console.log('\n=== ② 老的 `JM123456` 没被破坏 ===')

ok('★★ `JM123456` / `jm 123456` 照旧认', () => {
  assert.equal(detectCode('JM1481228')?.id, '1481228')
  assert.equal(detectCode('jm1481228')?.id, '1481228')
  assert.equal(detectCode('jm 1481228')?.id, '1481228')
  assert.equal(detectCode('看看这个 JM1481228 怎么样')?.id, '1481228', '混在句子里')
})

console.log('\n=== ③ 「禁漫 N」也认了 ===')

ok('★ `禁漫 1481228` / `禁漫1481228` 认', () => {
  assert.equal(detectCode('禁漫 1481228')?.id, '1481228')
  assert.equal(detectCode('禁漫1481228')?.id, '1481228')
  assert.equal(detectCode('禁漫：1481228')?.id, '1481228')
})

console.log('\n=== ④ ★★★ 纯数字**仍然不认**（这条是故意的，别放开）===')

ok('★★★ 裸数字不认 —— 房间号/订单号/股价/手机号后四位都会误伤', () => {
  assert.equal(detectCode('1481228'), null, '★ 别为了"多认一点"把它放开')
  assert.equal(detectCode('房间号 123456'), null)
  assert.equal(detectCode('订单号 99887766'), null)
  assert.equal(detectCode('股价 12345.67'), null, '别被小数点骗了')
})

ok('★ 别的站带 /album/ 的也不认（只认 `18comic` 这个商标名）', () => {
  assert.equal(detectCode('https://example.com/album/1481228'), null)
  assert.equal(detectCode('https://somewhere.xn--fiqs8s/album/1481228'), null)
})

console.log('\n=== ⑤ 注记仍然"防编"（标题没拿到就不许说扫过）===')

ok('★★ 注记必须点名堵死"扫了眼标题"', () => {
  const note = formatCodeContext({ raw: 'JM1481228', id: '1481228', label: '禁漫（18comic）的作品编号' })
  assert.match(note, /我这次什么都没拿到/, '要说清手里是空的')
  assert.match(note, /不许说"我扫了眼标题"/, '★ 这句必须留着（被绕过一次）')
  assert.match(note, /不许猜/, '不许猜内容')
})

ok('★ 源码里仍然**不生成站点 URL**（域名会换 + 别让 link-preview 顺带去连成人站）', () => {
  const src = fs.readFileSync(new URL('../src/gateway/codes.js', import.meta.url), 'utf8')
  assert.ok(!/return\s+`https?:\/\//.test(src), '不该拼出站点的 URL 返回')
  assert.match(src, /刻意不生成站点 URL/, '理由注释要留着')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)