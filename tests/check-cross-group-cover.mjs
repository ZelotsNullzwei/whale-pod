/**
 * `[发群]` 要不要带图（2026-11-06）。
 *
 * ## 现场
 * ```
 * 20:18:03  私聊出图（女仆装自拍），已发给他
 * 20:19:47  他「去群发吧，给风宝他们看看」
 * 20:19:50  发群「试好了，本鲸这身新衣服，风宝你们看看行不行」→ 704291282
 *           ↑ 群里只有一句话，没有图
 * ```
 * 根因：`const cover = drawnImage ?? null` —— 只看**本轮**有没有画。
 * 而"转发刚才那张"这一轮她根本没画。
 *
 * 守什么：
 * - 本轮画了就带本轮那张（老行为）
 * - 本轮没画、但 10 分钟内发过、同一个会话、这句话在说图 → 带上次那张
 * - 超时 / 跨会话 / 没提图 → 不带（不硬塞旧图）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pickCrossGroupCover } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const NOW = 1_793_967_600_000
const last = { scope: 'private:2129024700', url: 'base64://AAA', at: NOW - 60_000 }

console.log('=== 1. 转发场景（线上那条）===')
ok('★ 本轮没画 + 「这身新衣服…看看」 + 1 分钟前发过 → 带图', () => {
  const r = pickCrossGroupCover({
    drawnImage: null,
    lastSentImage: last,
    scope: 'private:2129024700',
    text: '试好了，本鲸这身新衣服，风宝你们看看行不行',
    now: NOW,
  })
  assert.equal(r?.url, 'base64://AAA')
})

console.log('\n=== 2. 不该带的时候不带 ===')
ok('超 10 分钟 → 不带', () => {
  const r = pickCrossGroupCover({
    drawnImage: null,
    lastSentImage: { ...last, at: NOW - 11 * 60_000 },
    scope: 'private:2129024700',
    text: '给你看看这张',
    now: NOW,
  })
  assert.equal(r, null)
})
ok('跨会话 → 不带（别把别的聊天里的图发到群里）', () => {
  const r = pickCrossGroupCover({
    drawnImage: null,
    lastSentImage: last,
    scope: 'private:999999',
    text: '给你们看这张图',
    now: NOW,
  })
  assert.equal(r, null)
})
ok('这句话没提图/看 → 不带（「今天好累」不该配图）', () => {
  const r = pickCrossGroupCover({
    drawnImage: null,
    lastSentImage: last,
    scope: 'private:2129024700',
    text: '今天好累，先去睡了',
    now: NOW,
  })
  assert.equal(r, null)
})
ok('从来没发过图 → 不带', () => {
  const r = pickCrossGroupCover({
    drawnImage: null, lastSentImage: null, scope: 'private:2129024700', text: '看这张', now: NOW,
  })
  assert.equal(r, null)
})

console.log('\n=== 3. 本轮画了图 → 用本轮的 ===')
ok('drawnImage 优先于上次那张', () => {
  const r = pickCrossGroupCover({
    drawnImage: { url: 'base64://NEW' },
    lastSentImage: last,
    scope: 'private:2129024700',
    text: '随便说点什么',
    now: NOW,
  })
  assert.equal(r?.url, 'base64://NEW')
})

console.log('\n=== 4. 源码锁 ===')
ok('★ _send 发成功一张图就记 _lastSentImage', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /this\._lastSentImage = \{ scope:/, '要记 scope + url + at')
})
ok('★ 发群用的是 pickCrossGroupCover，不是裸 drawnImage', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /const cover = pickCrossGroupCover\(\{/)
  assert.ok(!/const cover = drawnImage \?\? null/.test(src), '别退回只认本轮')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
