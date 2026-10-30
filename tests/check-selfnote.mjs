/**
 * selfNote（摘要第三段「【我】」）的回归测试（2026-10-29）。
 *
 * ## 这是什么
 *
 * 前三段记的都是「你」（【人】谁是谁、【事】在聊什么、「我说过」），
 * 缺一段记「它」——**说话方式有没有变、对什么开始有反应**。
 *
 * 参考 `qq-dsh-bridge` 的 selfNote：
 * > 以前它记得「你常熬夜」，但不记得「我好像越来越会等你说完再回了」。
 * > 前者是资料，后者才是性格的连续性。
 *
 * ## 为什么排在摘要里，而不是单独一个文件
 *
 * 摘要本来就会进生成层提示词，所以放进摘要 = **零新增模型调用、零新增注入点**，
 * 复用刚刚验证过的通路（`【人】` 那条）。
 *
 * ## 段落顺序是刻意的
 *
 * `【人】→【事】→【我】`，【我】在**最后**。这样：
 *   · `parsePeople`（取【人】..【事】）不用改
 *   · `parsePersonLines` 不用改
 *   · 只有 `parseTopics` 需要**在【我】处停下**（否则【我】会被当成话题吞掉）
 * 反过来把【我】插在中间会同时破坏前两者。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  LongTermStore, renderPeople, parseSelf, parseTopics, parsePeople, parsePersonLines,
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
  for (let i = 0; i < n; i++) {
    const id = String(100000000 + i)
    m.set(id, `${id} | 群友${i} | 印象第${i}条，爱发表情包`)
  }
  return m
}

// ── ① 向后兼容：不传 self 时输出与旧版逐字节相同 ─────────────
ok('不传【我】时，输出与旧版**逐字节相同**', () => {
  const out = renderPeople(new Map([['111111111', '111111111 | 甲 | 印象']]), '话题')
  assert.equal(out, '【人】\n111111111 | 甲 | 印象\n\n【事】\n话题')
  assert.ok(!out.includes('【我】'), '没有 self 时不该凭空多出一段')
})

ok('不传【我】= 空串 / null / undefined 都一样', () => {
  const a = renderPeople(P(2), '话题', '')
  const b = renderPeople(P(2), '话题', null)
  const c = renderPeople(P(2), '话题', undefined)
  const d = renderPeople(P(2), '话题')
  assert.equal(a, d); assert.equal(b, d); assert.equal(c, d)
})

// ── ② 有【我】时的渲染与解析 ─────────────────────────────────
ok('传了【我】就渲染出第三段，且顺序是 人→事→我', () => {
  const out = renderPeople(new Map([['111111111', '111111111 | 甲 | 印象']]), '话题', '我最近会先听完再接')
  const iPeople = out.indexOf('【人】')
  const iTopic = out.indexOf('【事】')
  const iSelf = out.indexOf('【我】')
  assert.ok(iPeople >= 0 && iTopic > iPeople, '【人】在【事】之前')
  assert.ok(iSelf > iTopic, '【我】必须排在【事】之后（否则会破坏 parsePeople）')
  assert.ok(out.includes('我最近会先听完再接'))
})

ok('parseSelf 能读回', () => {
  const out = renderPeople(new Map(), '话题', '我最近会先听完再接')
  assert.equal(parseSelf(out), '我最近会先听完再接')
})

ok('没有【我】段时 parseSelf 返回空串', () => {
  assert.equal(parseSelf('【人】\n111111111 | 甲 | x\n\n【事】\ny'), '')
  assert.equal(parseSelf(''), '')
})

// ── ③ 边界：parseTopics 不能在【我】里吞内容 ─────────────────
ok('parseTopics 在【我】处停下（不把自我叙述当成话题）', () => {
  const out = '【人】\n111111111 | 甲 | x\n\n【事】\n在聊渲染\n\n【我】\n我学会了先听完'
  assert.equal(parseTopics(out), '在聊渲染')
  assert.ok(!parseTopics(out).includes('先听完'), '【我】的内容不该进话题')
})

ok('parsePeople / parsePersonLines 不受【我】影响', () => {
  const out = '【人】\n111111111 | 甲 | 爱抬杠\n\n【事】\n在聊渲染\n\n【我】\n我学会了先听完'
  assert.equal(parsePeople(out).size, 1)
  assert.equal(parsePeople(out).get('111111111'), '111111111 | 甲 | 爱抬杠')
  const lines = parsePersonLines(out)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].impression, '爱抬杠')
})

ok('【我】里出现数字也不会被 parsePeople 误收成人', () => {
  const out = '【事】\nx\n\n【我】\n我聊到过 2026 和 3 次改口'
  assert.equal(parsePeople(out).size, 0, '【我】在【事】之后，parsePeople 看不到它')
})

// ── ④ merge：带上【我】，且模型忘格式时不丢 ──────────────────
function mkStore() {
  return new LongTermStore({ cfg: { enabled: true, summarizeAfter: 999 }, summarize: async () => '', log: {} })
}

ok('merge 会把新的【我】写进去', () => {
  const m = mkStore().get('group:1')
  m.merge('【人】\n111111111 | 甲 | 爱抬杠\n\n【事】\n在聊渲染\n\n【我】\n我开始会承认自己不确定')
  assert.equal(parseSelf(m.summary), '我开始会承认自己不确定')
})

ok('新摘要**没有**【我】时，旧【我】要保住（模型偶尔忘格式）', () => {
  const m = mkStore().get('group:2')
  m.summary = renderPeople(new Map([['111111111', '111111111 | 甲 | 爱抬杠']]), '旧话题', '我会先听完再回')
  // 这次模型只给了【事】
  m.merge('【事】\n新话题')
  assert.equal(parseSelf(m.summary), '我会先听完再回', '不该因为一次格式失误就把自我叙述冲掉')
  assert.ok(m.summary.includes('新话题'), '话题照常更新')
  assert.ok(m.summary.includes('111111111'), '人也照常保住')
})

ok('新的【我】覆盖旧的【我】', () => {
  const m = mkStore().get('group:3')
  m.summary = renderPeople(new Map(), '旧话题', '旧的我')
  m.merge('【人】\n111111111 | 甲 | x\n\n【事】\n新话题\n\n【我】\n新的我')
  assert.equal(parseSelf(m.summary), '新的我')
})

// ── ⑤ 长度：三段都超时的裁剪顺序 ────────────────────────────
ok('三段都超长 → 仍然 ≤ 上限，且【我】是最后一个让位的', () => {
  const out = renderPeople(P(40), '话'.repeat(2000), '我'.repeat(2000))
  assert.ok(out.length <= MAX, `输出 ${out.length} > ${MAX}`)
  assert.ok(out.includes('【我】'), '【我】该留到最后（它有 400 字上限，正常走不到被砍）')
  assert.ok(parseSelf(out).length <= 400, '【我】被裁到 400 字内')
})

ok('【我】自己超长 → 裁到 400 字', () => {
  const out = renderPeople(new Map(), '短话题', '我'.repeat(3000))
  assert.ok(out.length <= MAX)
  assert.ok(parseSelf(out).length <= 400)
})

ok('全空 → 空串', () => {
  assert.equal(renderPeople(new Map(), '', ''), '')
  assert.equal(renderPeople(null, null, null), '')
})

// ── ⑥ 源码锁 ────────────────────────────────────────────────
ok('SUMMARY_PROMPT 必须定义【我】段，并说清它与【人】【事】的区别', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'memory', 'long.js'), 'utf8')
  const at = src.indexOf('export const SUMMARY_PROMPT')
  const prompt = src.slice(at, at + 4000)
  assert.match(prompt, /【我】/, '提示词里必须有【我】段')
  assert.match(prompt, /这一段只写你自己/, '必须说清它只写「它自己」')
  assert.match(prompt, /那是【人】|那是【事】/, '必须给出「这是【人】/【事】不是【我】」的反例')
  assert.match(prompt, /照抄上一次的/, '没变化时要求照抄，避免每轮硬编')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)