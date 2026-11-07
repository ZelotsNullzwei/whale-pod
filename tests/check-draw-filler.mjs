/**
 * 画图的两处收口（2026-11-07）。
 *
 * ## ① 垫场句别只有那两句
 * 用户：「发自拍会触发一句拖时间的话，好像只有两句，不是现编的，像是在参考」。
 * 实测最近 12 次垫场只出现 5 种句子 —— 原来是一个写死的 6 句数组纯 random。
 * 现在：池子扩到 20+ 句、按**时段**分组，并拼一小段今日计划里在做什么。
 *
 * ## ② 只有「文字」能触发生图
 * 用户：「自拍那一点只有说话能触发，图片和表情都不行」。
 * 现场：他要一个表情自拍 → 她画了一张；他补发一个表情包当"参考"，
 * 表情包走看图路径，模型又写 `[画图:]` → 又画一张（正文还都是空的）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge } from '../src/qq/bridge.js'

const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 垫场句：扩池 + 按时段 ===')
ok('★ 有 morning/afternoon/evening/night 四组', () => {
  for (const s of ['morning', 'afternoon', 'evening', 'night']) {
    assert.match(SRC, new RegExp(`${s}: \\[`), `缺「${s}」这一组`)
  }
})
ok('★ 句子总数 ≥ 15（不再只有 6 句）', () => {
  const i = SRC.indexOf('const FILLER_BY_SLOT = {')
  const j = SRC.indexOf('const FILLER_GENERIC = [', i)
  assert.ok(i > 0 && j > i, '找不到这两个常量')
  const block = SRC.slice(i, j) + SRC.slice(j, SRC.indexOf(']', j) + 1)
  const lines = block.match(/'[^']{4,}'/g) ?? []
  // 时段 key 不是句子，扣掉
  const sentences = lines.filter((x) => !/'(morning|afternoon|evening|night)'/.test(x))
  assert.ok(sentences.length >= 15, `只有 ${sentences.length} 句`)
})
ok('★ 按当前时段优先挑（七成），而不是纯 random', () => {
  const i = SRC.indexOf('const slotPool = FILLER_BY_SLOT[slotNow]')
  const seg = SRC.slice(i, i + 400)
  assert.match(seg, /Math\.random\(\) < 0\.7/, '没有"七成走当前时段"的策略')
})
ok('★ 垫场句**不许**拼今日计划（2026-11-07 线上出过「刚在六点四十蒸了碗鸡蛋羹」）', () => {
  assert.ok(!/刚在${planAct}/.test(SRC), '又拼了今日计划')
  assert.ok(!SRC.includes('this._send(msg, fillerLine)'), '垫场句还在拼 planAct')
  assert.ok(SRC.includes('this._send(msg, filler)'), '垫场句没发出去')
})

console.log('\n=== 2. 只有文字能触发生图 ===')
const onlyMedia = (t) => /^\s*(?:\[表情包(?::[^\]\[]*)?\]|\[表情\]|\[图片\])\s*$/.test(String(t ?? '').trim())
ok('★ 纯表情包 / 纯图片 → 命中（不许画）', () => {
  for (const t of ['[表情包]', '[表情包:无语]', '[表情]', '[图片]']) {
    assert.equal(onlyMedia(t), true, `${t} 没命中`)
  }
})
ok('★ 带文字的不命中（照常画）', () => {
  for (const t of ['拍一张', '看这个[表情包]', '[表情包] 拍一张']) {
    assert.equal(onlyMedia(t), false, `${t} 被误判`)
  }
})
ok('★ 源码锁：闸在 saidNo 之前，跳过原因写清楚', () => {
  const i = SRC.indexOf('if (triggerOnlyMedia)')
  const j = SRC.indexOf('} else if (saidNo) {')
  assert.ok(i > 0, '没有纯媒体闸')
  assert.ok(i < j, '纯媒体闸排在 saidNo 之后')
  assert.match(SRC.slice(i, i + 500), /纯图片\/表情不触发生图/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
