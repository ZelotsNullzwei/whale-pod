/**
 * 长期摘要裁剪的**终止性与长度约束**（2026-10-29，P0）。
 *
 * ## 修之前是错的（实测 4/4 栈溢出）
 * 原 `renderPeople` 递归收缩：
 * ```js
 * const keep = [...people.entries()].slice(-Math.floor(people.size * 0.7))
 * return renderPeople(new Map(keep), topics).slice(0, MAX_SUMMARY_CHARS)
 * ```
 *   ① `slice(-0) === slice(0)` —— `Math.floor(0*0.7)=0`，「保留后面 0%」
 *      被当成「保留全部」，**一条都没少** → 人数 < 2 时必然无限递归。
 *   ② `topics` 原样透传 —— 话题自己超上限时永远不缩短，
 *      无论几个人都终止不了。
 *
 * 实测（真实代码）：
 * ```
 * 0 人 + 超长话题 → RangeError: Maximum call stack size exceeded   (9ms)
 * 1 人 + 超长话题 → RangeError: Maximum call stack size exceeded  (34ms)
 * 2 人 + 超长话题 → RangeError: Maximum call stack size exceeded  (32ms)
 * 5 人 + 超长话题 → RangeError: Maximum call stack size exceeded  (28ms)
 * ```
 *
 * ## 现在的保证
 * 迭代收缩：① 裁话题 → ② 逐条移除最旧的人 → ③ 按超出量精确截话题 → ④ 硬 slice。
 * 任何输入都在有限步内结束，且输出 ≤ MAX_SUMMARY_CHARS。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { renderPeople, parsePeople } from '../src/memory/long.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 源码里的上限（未导出）。 */
const MAX = 3000
/** 渲染必须在「瞬间」完成，用时间兜底判「没卡住」。 */
function timed(fn, label) {
  const t0 = Date.now()
  const out = fn()
  const ms = Date.now() - t0
  assert.ok(ms < 500, `${label} 用了 ${ms}ms —— 疑似未终止`)
  return out
}
const P = (n, pad = 0) => {
  const m = new Map()
  for (let i = 0; i < n; i++) {
    const id = String(100000000 + i)
    m.set(id, `${id} | 群友${i} | 印象第${i}条，爱发表情包${'·'.repeat(pad)}`)
  }
  return m
}
const long = (n) => '话'.repeat(n)

// ── ① 话题超长 + 人物列表为空 ───────────────────────────
ok('话题超长 + 人物为空 → 终止且不超上限', () => {
  const out = timed(() => renderPeople(new Map(), long(MAX + 500)), '空人超长话题')
  assert.ok(out.length <= MAX, `输出 ${out.length} > ${MAX}`)
  assert.equal(parsePeople(out).size, 0)
  assert.ok(out.includes('【事】'), '应仍是合法格式')
})

// ── ② 只有一个人物 + 摘要超长 ───────────────────────────
ok('只 1 人 + 超长话题 → 终止（这是 slice(-0) 最容易踩的人数）', () => {
  const out = timed(() => renderPeople(P(1), long(MAX + 500)), '1人超长话题')
  assert.ok(out.length <= MAX, `输出 ${out.length} > ${MAX}`)
})

// ── ③ 多个人物 + 超长摘要 ───────────────────────────────
ok('5 人 + 超长话题 → 终止', () => {
  const out = timed(() => renderPeople(P(5), long(MAX + 500)), '5人超长话题')
  assert.ok(out.length <= MAX)
})

ok('40 人 + 长话题 → 终止，且超出时先砍最旧的人', () => {
  /*
   * ⚠️ 必须**真的超上限**才会触发裁剪。
   *    40 人 × 30 字 + 1400 话题 ≈ 2648 < 3000 —— 那样一条都不会被砍，
   *    断言就会假失败（这个算术当场踩了一次）。
   *    这里把每条印象加长到 ~60 字，人像段约 2400 字，必然要砍。
   */
  const people = P(40, 30)
  /*
   * ⚠️ 显式传 `{ total: MAX }`（2026-10-30）。
   *
   * 默认存储上限已经从 3000 提到 **12000**（跟"注入预算"拆开了），
   * 所以 40 人 + 1500 话题（约 4000 字）**在新默认下根本不会触发裁剪**。
   * 这条测的是**裁剪算法本身**，所以把上限压回 3000 来触发它。
   */
  const out = timed(() => renderPeople(people, long(1500), '', '', { total: MAX }), '40人')
  assert.ok(out.length <= MAX, `输出 ${out.length} > ${MAX}`)
  const kept = parsePeople(out)
  assert.ok(kept.size > 0, '不该把人砍光（话题应先让位）')
  assert.ok(kept.size < 40, `应当真的砍了人，实际留了 ${kept.size}`)
  assert.ok(kept.has('100000039'), '最新的一个必须留下')
  assert.ok(!kept.has('100000000'), '最旧的应被先砍掉')
})

// ── ④ 某条人物记录异常长 ────────────────────────────────
ok('单条人物印象异常长 → 被裁到 120 字内', () => {
  const m = new Map([['123456789', `123456789 | 甲 | ${'啰'.repeat(5000)}`]])
  const out = timed(() => renderPeople(m, '短话题'), '超长单条')
  assert.ok(out.length <= MAX, `输出 ${out.length}`)
  const kept = parsePeople(out)
  assert.equal(kept.size, 1, '这个人应当还在')
  assert.ok(kept.get('123456789').length <= 120, `单条应被截到 120 字内，实际 ${kept.get('123456789').length}`)
})

ok('单条异常长 + 超长话题 同时存在 → 仍然终止', () => {
  const m = new Map([
    ['123456789', `123456789 | 甲 | ${'啰'.repeat(4000)}`],
    ['223456789', `223456789 | 乙 | ${'嗦'.repeat(4000)}`],
  ])
  const out = timed(() => renderPeople(m, long(MAX + 800)), '双超长')
  assert.ok(out.length <= MAX)
})

// ── ⑤ 空数据 / 缺失字段 / 非法数据 ──────────────────────
ok('空 Map + 空话题 → 空串（不抛）', () => {
  assert.equal(renderPeople(new Map(), ''), '')
})

ok('null / undefined 入参不抛', () => {
  assert.doesNotThrow(() => renderPeople(null, null))
  assert.doesNotThrow(() => renderPeople(undefined, undefined))
  assert.equal(renderPeople(null, null), '')
})

ok('人物行是空串 / 纯空白 → 被丢掉，不留空行', () => {
  const m = new Map([['111111111', '   '], ['222222222', '']])
  const out = renderPeople(m, '有话题')
  assert.ok(!out.includes('【人】'), '全空的人不该渲染出空标题')
  assert.ok(out.includes('【事】'))
})

ok('Map 的值不是字符串（数字/对象）→ 不抛', () => {
  const m = new Map([['111111111', 12345], ['222222222', { a: 1 }]])
  assert.doesNotThrow(() => renderPeople(m, '话题'))
})

ok('话题是数字 → 不抛', () => {
  assert.doesNotThrow(() => renderPeople(P(1), 12345))
})

// ── ⑥ 正常数据与现有格式兼容 ────────────────────────────
ok('正常数据：格式与旧版一致（【人】每行 QQ号 | 昵称 | 印象，空行，【事】）', () => {
  const m = new Map([
    ['123450002', '123450002 | 🍅阿乙🍅 | 爱考据较真'],
    ['1095169608', '1095169608 | 不是不是阿甲 | 话很少'],
  ])
  const out = renderPeople(m, '在聊渲染图。我说过：天光出味这版算过了。')
  assert.equal(out, [
    '【人】',
    '123450002 | 🍅阿乙🍅 | 爱考据较真',
    '1095169608 | 不是不是阿甲 | 话很少',
    '',
    '【事】',
    '在聊渲染图。我说过：天光出味这版算过了。',
  ].join('\n'), '输出应与旧版逐字节一致')
  assert.equal(parsePeople(out).size, 2, '且能被 parsePeople 读回')
})

ok('短内容原样返回（不做任何裁剪）', () => {
  const m = new Map([['111111111', '111111111 | 甲 | 印象']])
  assert.equal(renderPeople(m, '话题'), '【人】\n111111111 | 甲 | 印象\n\n【事】\n话题')
})

// ── ⑦ 话题裁剪优先保住「我说过：」 ──────────────────────
ok('超长话题裁剪时保住「我说过：」那段', () => {
  const topics = `${'铺垫'.repeat(900)}\n我说过：我不承认自己是肥鱼，只认是鲸。`
  const out = renderPeople(new Map(), topics)
  assert.ok(out.length <= MAX, `输出 ${out.length}`)
  assert.ok(out.includes('我说过：'), '「我说过」是人设连续性核心，不该被切掉')
})

ok('「我说过：」自己就超长 → 截它自己，不抛', () => {
  const topics = `开头\n我说过：${'鲸'.repeat(5000)}`
  const out = timed(() => renderPeople(new Map(), topics), '超长我说过')
  assert.ok(out.length <= MAX)
})

// ── ⑧ merge 之后仍然满足约束（端到端） ──────────────────
ok('merge 走一遍超长输入 → 摘要不超上限', async () => {
  const { LongTermStore } = await import('../src/memory/long.js')
  const s = new LongTermStore({ cfg: { enabled: true, summarizeAfter: 999 }, summarize: async () => '', log: {} })
  const mem = s.get('group:trim')
  mem.summary = renderPeople(P(30), '旧话题')
  assert.doesNotThrow(() => mem.merge(`【人】\n999999999 | 新来的 | 刚进群\n\n【事】\n${long(MAX + 900)}`))
  assert.ok(mem.summary.length <= MAX, `merge 后 ${mem.summary.length} > ${MAX}`)
})

// ── ⑨ 源码锁：不许回到递归实现 ──────────────────────────
ok('源码锁：renderPeople 不得再用递归收缩', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'memory', 'long.js'), 'utf8')
  const lines = src.split('\n').map((l) => l.trim())
  const at = lines.findIndex((l) => l.startsWith('export function renderPeople'))
  assert.ok(at >= 0, '应能找到 renderPeople')
  // 取函数体到下一个顶层 export 之前
  const nextAt = lines.findIndex((l, i) => i > at && l.startsWith('export '))
  const body = lines.slice(at, nextAt > at ? nextAt : at + 120).join('\n')
  assert.ok(!/return renderPeople\(/.test(body), '不得递归调用自己（那正是无限递归的成因）')
  assert.ok(!/slice\(-Math\.floor/.test(body), '不得再用 slice(-Math.floor(...)) 这种会退化成 slice(0) 的写法')
  assert.ok(/while \(/.test(body), '应是迭代收缩（带 while）')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)