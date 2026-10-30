/**
 * 术语库「【梗】」段的回归测试（2026-10-29）。
 *
 * ## 为什么独立成段
 * `SUMMARY_PROMPT` 原来只在【事】里要求「反复出现的梗 / 内部玩笑」。
 * 但【事】是**近期消耗品**：它会被新话题冲掉、会被裁剪到 1400 字。
 * 而术语是**结构化的「词 → 意思」**，而且同一个梗第二次出现时，
 * 它需要的是"这词什么意思"，不是"上周聊过"。
 *
 * 实测已有的例子（来自线上摘要）：
 * ```
 * 【事】最近多了「减速器」梗：丢包的加速器被说成反着加速，我接「专治网速太快」
 * ```
 * 这本来是术语，却混在散文里，下个月就没了。
 *
 * ## 关键：只收「这个群内部的」
 * 提示词明确排除「绝绝子」「YYDS」这类网络流行语 —— 那不用记（模型本来就会），
 * 记下来只会让它像在学舌。要记的是**这个群才懂的说法**。
 *
 * ## 段落顺序 人→事→我→梗
 * 每段解析器只需收一个边界：
 *   parsePeople → 到【事】  parseTopics → 到【我】
 *   parseSelf   → 到【梗】  parseGloss  → 到结尾
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  LongTermStore, renderPeople, parseGloss, parseSelf, parseTopics, parsePeople, parsePersonLines,
} from '../src/memory/long.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const MAX = 3000
const P = (n) => {
  const m = new Map()
  for (let i = 0; i < n; i++) m.set(String(100000000 + i), `${100000000 + i} | 群友${i} | 印象${i}`)
  return m
}

// ── ① 向后兼容 ────────────────────────────────────────────
ok('不传 gloss 时，输出与上一版**逐字节相同**', () => {
  const a = renderPeople(new Map([['111111111', '111111111 | 甲 | 印象']]), '话题', '我会先听完')
  assert.equal(a, '【人】\n111111111 | 甲 | 印象\n\n【事】\n话题\n\n【我】\n我会先听完')
  assert.ok(!a.includes('【梗】'), '没有 gloss 时不该多出一段')
})

ok('不传 gloss = 空串 / null / undefined 都一样', () => {
  const base = renderPeople(P(2), '话题', '我')
  assert.equal(renderPeople(P(2), '话题', '我', ''), base)
  assert.equal(renderPeople(P(2), '话题', '我', null), base)
  assert.equal(renderPeople(P(2), '话题', '我', undefined), base)
})

// ── ② 渲染顺序与解析边界 ──────────────────────────────────
ok('顺序必须是 人 → 事 → 我 → 梗', () => {
  const out = renderPeople(
    new Map([['111111111', '111111111 | 甲 | 印象']]),
    '在聊渲染', '我会先听完', '减速器 | 丢包的加速器',
  )
  const i = ['【人】', '【事】', '【我】', '【梗】'].map((k) => out.indexOf(k))
  for (let k = 1; k < i.length; k++) assert.ok(i[k] > i[k - 1], `顺序错了：${i}`)
})

ok('parseGloss 能读回', () => {
  const out = renderPeople(new Map(), '话题', '我', '减速器 | 丢包的加速器')
  assert.equal(parseGloss(out), '减速器 | 丢包的加速器')
})

ok('没有【梗】段时 parseGloss 返回空串', () => {
  assert.equal(parseGloss('【事】\nx\n\n【我】\ny'), '')
  assert.equal(parseGloss(''), '')
})

ok('⚠️ parseSelf 必须在【梗】处停下（不吞术语库）', () => {
  const out = '【事】\n话题\n\n【我】\n我会先听完\n\n【梗】\n减速器 | 丢包的加速器'
  assert.equal(parseSelf(out), '我会先听完', '自我叙述不该把术语吞进去')
  assert.equal(parseGloss(out), '减速器 | 丢包的加速器')
})

ok('parseTopics / parsePeople / parsePersonLines 不受【梗】影响', () => {
  const out = '【人】\n111111111 | 甲 | 爱抬杠\n\n【事】\n在聊渲染\n\n【我】\n我\n\n【梗】\n减速器 | 丢包的加速器'
  assert.equal(parseTopics(out), '在聊渲染')
  assert.equal(parsePeople(out).size, 1)
  assert.equal(parsePersonLines(out)[0].impression, '爱抬杠')
})

// ── ③ merge ───────────────────────────────────────────────
function mkStore() {
  return new LongTermStore({ cfg: { enabled: true, summarizeAfter: 999 }, summarize: async () => '', log: {} })
}

ok('merge 会把新的【梗】写进去', () => {
  const m = mkStore().get('group:1')
  m.merge('【人】\n111111111 | 甲 | x\n\n【事】\n话题\n\n【我】\n我\n\n【梗】\n睡鲸 | 睡过头')
  assert.equal(parseGloss(m.summary), '睡鲸 | 睡过头')
})

ok('新摘要**没有**【梗】时，旧的术语库要保住', () => {
  const m = mkStore().get('group:2')
  m.summary = renderPeople(new Map([['111111111', '111111111 | 甲 | x']]), '旧话题', '我', '减速器 | 丢包的加速器')
  m.merge('【事】\n新话题')
  assert.equal(parseGloss(m.summary), '减速器 | 丢包的加速器', '一次格式失误不该把术语库冲掉')
  assert.ok(m.summary.includes('新话题'), '话题照常更新')
})

ok('新的【梗】覆盖旧的', () => {
  const m = mkStore().get('group:3')
  m.summary = renderPeople(new Map(), '话题', '我', '旧的 | 旧意思')
  m.merge('【人】\n111111111 | 甲 | x\n\n【事】\n话题\n\n【我】\n我\n\n【梗】\n新的 | 新意思')
  assert.equal(parseGloss(m.summary), '新的 | 新意思')
})

// ── ④ 长度 ────────────────────────────────────────────────
ok('【梗】自己超长 → 裁到 300 字', () => {
  const out = renderPeople(new Map(), '短', '我', '梗'.repeat(2000))
  assert.ok(out.length <= MAX, `${out.length} > ${MAX}`)
  assert.ok(parseGloss(out).length <= 300, `实际 ${parseGloss(out).length}`)
})

ok('四段全超长 → 总长仍 ≤ 上限，且【梗】【我】留到最后', () => {
  /*
   * ⚠️ 显式传 `{ total: MAX }`（2026-10-30）：默认存储上限已提到 12000，
   *    这条测的是**裁剪顺序**，所以把上限压回 3000 来触发它。
   */
  const out = renderPeople(P(40), '话'.repeat(2000), '我'.repeat(1500), '梗'.repeat(1000), { total: MAX })
  assert.ok(out.length <= MAX, `${out.length} > ${MAX}`)
  assert.ok(out.includes('【梗】'), '【梗】该留到最后动')
})

// ── ⑤ 源码锁 ──────────────────────────────────────────────
ok('SUMMARY_PROMPT 必须有【梗】段，且排除网络烂大街流行语', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'memory', 'long.js'), 'utf8')
  const at = src.indexOf('export const SUMMARY_PROMPT')
  const prompt = src.slice(at, at + 5000)
  assert.match(prompt, /【梗】/, '要有这一段')
  assert.match(prompt, /这个群内部/, '要限定"群内部"')
  assert.match(prompt, /烂大街的流行语/, '要明确排除网络流行语 —— 否则它记一堆没用的')
  assert.match(prompt, /最多 10 行/, '要有条数上限')
})

ok('提示词里说的部分数要和实际一致（四部分）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'memory', 'long.js'), 'utf8')
  assert.match(src, /一共四部分/, '开头要说四部分')
  assert.match(src, /只输出上述四部分/, '结尾也要一致')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)