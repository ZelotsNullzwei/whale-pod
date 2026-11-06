/**
 * 换衣服必须真落地（2026-11-06）。
 *
 * ## 现场（私聊）
 * ```
 * 16:14:50 他「不是说换短女仆吗」
 * 16:15:42 她「换好了，看吧。」        ← wearing.json 还是空的 {}
 * 16:23:53 他「这不是完全没变吗」
 * 16:24:13 她「（一僵）……我光嘴上说，手没动。」
 * ```
 * 根因：换衣服原来**只是画标志性套装时的副作用**，她不画图就永远落不了地。
 *
 * ## 修法
 * ① 独立标记 `[换装:描述]`（别名 `[换衣服:…]`）—— 不画图也生效
 * ② 谎报闸加 `wear`：说「换好了/换上了」但没有 `did.wear` → 重写一次
 *
 * 守什么：
 * - 「还没换」「这就换」「等会换」不算谎报（她明确说了还没做）
 * - 真换了（[换装:] 或画了标志性那套）不拦
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQBridge, classifyDrawIntent } from '../src/qq/bridge.js'
import { setWearing, wearingFor, clearWearing } from '../src/memory/wearing.js'

const p = QQBridge.prototype
const claim = (text, did, ctx = '') => p._falseClaim.call({}, text, did, ctx)

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 谎报闸：说了"换好了"但没换 ===')
ok('★ 线上原句「换好了，看吧。」→ 抓到', () => {
  assert.ok(claim('换好了，看吧。', {}))
})

ok('真换了（did.wear）→ 不拦', () => {
  assert.equal(claim('换好了，看吧。', { wear: true }), null)
})

ok('「还没换」「这就换」「等会换」不算谎报', () => {
  for (const t of ['还没换呢，等我一下', '这就换，别催', '等会儿换', '我不换']) {
    assert.equal(claim(t, {}), null, `不该抓：${t}`)
  }
})

ok('「换上了」也算（同一类说法）', () => {
  assert.ok(claim('换上了，你回头看', {}))
})

console.log('\n=== 2. [换装:] 真的写进"今天穿的" ===')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-wear-'))
ok('★ 换装后，wearingFor 立刻能读到（当天有效）', async () => {
  // 用独立数据目录，别动线上那份
  const W = await import(`../src/memory/wearing.js?t=${Date.now()}`)
  W.configureWearState({ home: dir })
  const k = '2026-11-06'
  W.setWearing(k, { text: '短款女仆装', kind: 'custom' })
  const got = W.wearingFor(k, 'afternoon')
  assert.equal(got?.text, '短款女仆装')
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('★ 晚上 22 点前仍然有效（19:39 那张女仆装就是这么丢的）', async () => {
  const W = await import(`../src/memory/wearing.js?t=${Date.now()}-2`)
  W.configureWearState({ home: dir })
  const k = '2026-11-06'
  W.setWearing(k, { text: '短款女仆装' })
  // 19:39 —— 现场那次生图的时间：必须还能读到
  assert.equal(W.wearingFor(k, 'evening', new Date('2026-11-06T19:39:00'))?.text, '短款女仆装')
  // 22:30 真到睡觉点了 → 让位给睡裙
  assert.equal(W.wearingFor(k, 'evening', new Date('2026-11-06T22:30:00')), null)
  assert.equal(W.wearingFor(k, 'night', new Date('2026-11-06T02:00:00')), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

ok('第二天自动作废', async () => {
  const W = await import(`../src/memory/wearing.js?t=${Date.now()}-3`)
  W.configureWearState({ home: dir })
  W.setWearing('2026-11-06', { text: '短款女仆装' })
  assert.equal(W.wearingFor('2026-11-07', 'afternoon'), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n=== 3. 提示词里必须教这个标记 ===')
ok('★ 提示词含 [换装:…] 的说明（否则她不会写）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /\[换装:一句话描述\]/)
  assert.match(src, /说了"换好了"就必须写/)
})

ok('★ 源码里真的解析 [换装:…] 和别名 [换衣服:…]', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /换装\|换衣服/)
})

console.log('\n=== 4. 换衣服不再触发画图（用户：「我叫她换他会一直发图」）===')
ok('★ 「换就换，等着」→ 只要求 [换装:]，**不要求**画图', () => {
  const r = claim('换就换，等着', {})
  assert.equal(r?.kind, 'wear', `应该是 wear，实际 ${r?.kind}`)
})

ok('★ 「正在换」也算 wear（不是 draw）', () => {
  const r = claim('正在换，别催', {})
  assert.equal(r?.kind, 'wear')
})

ok('真画图的话「这就拍」仍然要求 draw（这条不能丢）', () => {
  assert.equal(claim('这就拍，等我', {})?.kind, 'draw')
})

ok('★ 提示词明确写"换衣服不要自动配图"', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /换衣服不要自动配图/)
})

console.log('\n=== 5. 画图频率上限（防止一直发图）===')
ok('★ 源码里有按会话的次数闸，且可配', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /drawMaxPerWindow/)
  assert.match(src, /drawWindowMs/)
})

ok('★ 默认上限是有限值（不是 0 = 不限）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /drawMaxPerWindow \?\? 2/)
})

console.log('\n=== 6. [换装:] 要"对上衣柜"，不能照抄她的概括 ===')
/*
 * 现场：她写的是
 *   [换装:短款女仆装，藏青连身裙加白蕾丝围裙，裙摆到膝上]
 * 这句里没有「过膝白丝 / 袜口蕾丝花边 / 玛丽珍鞋 / 鲸鱼尾巴」，
 * 衣柜里那套明明是写全的 → 按残缺版记录，生图腿上就是光腿。
 */
const W2 = await import('../src/memory/wardrobe.js')

ok('★ 「短款女仆装…裙摆到膝上」→ 对上**短款**（不是长款）', () => {
  const r = W2.resolveOutfitText('短款女仆装，藏青连身裙加白蕾丝围裙，裙摆到膝上')
  assert.equal(r.matched, true)
  assert.match(r.text, /女仆装短款/)
  assert.match(r.text, /过膝/, '要带上过膝白丝')
  assert.match(r.text, /袜口一圈蕾丝花边/, '要带上蕾丝花边')
})

ok('「长款女仆装」→ 对上长款（不能反过来）', () => {
  const r = W2.resolveOutfitText('长款女仆装')
  assert.match(r.text, /女仆装长款/)
})

ok('「短的那套」→ 也认（她平时这么叫）', () => {
  const r = W2.resolveOutfitText('短的那套')
  assert.equal(r.matched, true)
  assert.match(r.text, /女仆装短款/)
})

ok('「短款外套」不该被认成女仆装（不误伤别的衣物）', () => {
  const r = W2.resolveOutfitText('短款外套')
  assert.equal(r.matched, false)
})

ok('她自己编的衣服 → 原样保留（不能硬套）', () => {
  const r = W2.resolveOutfitText('一件豹纹吊带')
  assert.equal(r.matched, false)
  assert.equal(r.text, '一件豹纹吊带')
})

console.log('\n=== 7. 拍之前先问"拍什么、怎么拍" ===')
ok('★ 提示词里有这两问（不是笼统的"要不要拍"）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /拍之前先问/)
  assert.match(src, /拍什么/)
  assert.match(src, /怎么拍/)
})

ok('★ 已经说全了的，允许当轮直接画（不能一律卡死）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /才可以当轮直接画，不用再问/)
})

console.log('\n=== 8. 没说要拍就不许画（机械闸）===')
ok('★ 源码里有"他没说要拍 → 不画、改问"的闸', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /askInstead/)
  assert.match(src, /画图跳过 —— 他没说要拍/)
})

ok('★ 拦下之后要补一句真的问话（否则这条什么都没发）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /拍什么？全身还是半身、只拍脸？对镜自拍还是前置？/)
})

ok('★ 判据覆盖"？"这种没内容的（不能算 go-ahead）', () => {
  // 2026-11-06：换成短语表 + classifyDrawIntent，直接断言行为
  assert.equal(classifyDrawIntent('？').wantsPic, false, '「？」不该算要拍')
  assert.equal(classifyDrawIntent('').wantsPic, false, '空消息不该算要拍')
  assert.equal(classifyDrawIntent('拍一张').wantsPic, true)
  assert.equal(classifyDrawIntent('全身照').wantsPic, true)
  assert.equal(classifyDrawIntent('对镜自拍').wantsPic, true)
})
console.log('\n=== 9. 衣着以「今天穿着」为准，场景句里的衣服不算 ===')
ok('★ 提示词里有"衣着只按那一行"的优先级说明', () => {
  const src = fs.readFileSync(new URL('../src/photo/photo-prompt.js', import.meta.url), 'utf8')
  assert.match(src, /衣着\*\*只按上面/)
})

ok('★ 历史记录也会被解析成衣柜原文（过膝白丝不能丢）', () => {
  const src = fs.readFileSync(new URL('../src/memory/wearing.js', import.meta.url), 'utf8')
  assert.match(src, /resolveOutfitText/)
  assert.match(src, /读的时候再对一次衣柜/)
})

console.log('\n=== 10. 垫场别每次都发（用户：「发了图之后必带一句话」）===')
ok('★ 源码里有垫场间隔控制，且默认值有限', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /fillerGapMs/)
  assert.match(src, /fillerGapMs \?\? 2 \* 60_000/, '默认 2 分钟')
})

ok('★ 跳过垫场不能当成报错（要单独记一条）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /跳过垫场/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
