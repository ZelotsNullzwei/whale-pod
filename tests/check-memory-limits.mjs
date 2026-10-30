/**
 * 「存储 / 注入」拆开 + 可配的回归测试（2026-10-30）。
 *
 * ## 起因
 * B 站评论说「3000 太小了」。查下来 `MAX_SUMMARY_CHARS = 3000` 是**一个数管两件事**：
 * 存多少 + 每轮塞进 prompt 多少。后果是**超了就永久裁掉**
 * （`renderPeople` 删最旧的人、截话题）—— 用户感受就是「它忘事」。
 *
 * ## 参考先例
 * · `dsh-qqchat`（同生态）：群/成员记忆各 2000 字符**注入**预算，
 *   但**数据仍存 SQLite、不因预算被删**
 * · MaiBot：向量库不限，`top_k` + `max_chars` 控注入
 *
 * 两家都是**存储给足、注入给预算**。所以我们拆成两个数：
 * ```
 * memory.long.maxChars    = 12000   // 存多少（超了才淘汰）
 * memory.long.injectChars = 3000    // 每轮带多少（不涨成本）
 * ```
 *
 * ## 裁剪优先级（这是「忘事先忘什么」的规则）
 * | 段 | 处理 | 理由 |
 * |---|---|---|
 * | 【人】【我】【梗】 | 全带 | 长期资产，砍了就真没了 |
 * | 【事】 | 从头部砍，保留最新的 | 话题是消耗品 |
 */
import assert from 'node:assert/strict'
import {
  LongTermMemory, LongTermStore, DEFAULT_LIMITS,
  renderPeople, clipForPrompt, parseTopics,
} from '../src/memory/long.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const P = (n, len = 30) => {
  const m = new Map()
  for (let i = 0; i < n; i++) m.set(String(100000000 + i), `${100000000 + i} | 群友${i} | ${'印'.repeat(len)}`)
  return m
}

// ── ① 默认值 ──────────────────────────────────────────────
ok('默认：存 12000 / 带 3000（原来都是 3000）', () => {
  assert.equal(DEFAULT_LIMITS.total, 12000, '存储上限应提到 12000')
  assert.equal(DEFAULT_LIMITS.inject, 3000, '注入预算保持 3000（不涨成本）')
  assert.ok(DEFAULT_LIMITS.total > DEFAULT_LIMITS.inject, '存储必须大于等于注入')
})

ok('子段上限保持绝对值（事 1400 / 我 400 / 梗 300）', () => {
  assert.equal(DEFAULT_LIMITS.topic, 1400)
  assert.equal(DEFAULT_LIMITS.self, 400)
  assert.equal(DEFAULT_LIMITS.gloss, 300)
})

// ── ② 向后兼容 ────────────────────────────────────────────
ok('不传 limits == 传 DEFAULT_LIMITS（逐字节相同）', () => {
  const args = [P(3), '在聊渲染', '我会先听完', '减速器 | 丢包的加速器']
  assert.equal(renderPeople(...args), renderPeople(...args, DEFAULT_LIMITS))
})

// ── ③ 存储上限可配 ────────────────────────────────────────
ok('存储上限调小 → 真的会裁；调大 → 不裁', () => {
  const people = P(40, 30)
  const topics = '话'.repeat(1500)
  const small = renderPeople(people, topics, '', '', { total: 3000 })
  const big = renderPeople(people, topics, '', '', { total: 20000 })
  assert.ok(small.length <= 3000, `小上限：${small.length}`)
  assert.ok(big.length > 3000, `大上限应当存得更多，实际 ${big.length}`)
  assert.ok(big.length <= 20000)
})

// ── ④ clipForPrompt：注入预算 ─────────────────────────────
ok('没超预算 → 原样返回（不加工）', () => {
  const s = '【人】\n111111111 | 甲 | x\n\n【事】\n在聊渲染'
  assert.equal(clipForPrompt(s, 3000), s)
  assert.equal(clipForPrompt(s, 0), s, '预算 <= 0 视为不裁')
  assert.equal(clipForPrompt('', 100), '')
})

ok('超预算 → 总长 ≤ 预算', () => {
  const s = '【人】\n111111111 | 甲 | ' + '印'.repeat(100)
    + '\n\n【事】\n' + '话'.repeat(800)
    + '\n\n【我】\n' + '我'.repeat(200)
    + '\n\n【梗】\n' + '梗'.repeat(150)
  const out = clipForPrompt(s, 400)
  assert.ok(out.length <= 400, `实际 ${out.length}`)
})

ok('⚠️ 优先级：【人】【我】【梗】保住，【事】先被砍', () => {
  const s = '【人】\n111111111 | 甲 | 爱抬杠\n\n【事】\n' + '旧话'.repeat(300)
    + '\n\n【我】\n我会先听完\n\n【梗】\n减速器 | 丢包的加速器'
  const out = clipForPrompt(s, 300)
  assert.ok(out.length <= 300, `实际 ${out.length}`)
  assert.ok(out.includes('111111111'), '【人】必须在')
  assert.ok(out.includes('我会先听完'), '【我】必须在')
  assert.ok(out.includes('减速器'), '【梗】必须在')
  const topics = parseTopics(out)
  assert.ok(topics.length < '旧话'.repeat(300).length, '【事】应当被缩短')
  assert.ok(topics.startsWith('…'), '截断要有省略号，看得出被裁过')
})

ok('保留的是【事】的**最新**部分（砍头不砍尾）', () => {
  /*
   * ⚠️ 用**标记词**区分头尾，不能用全同字符（`'AAA'.repeat(200)`）——
   *    那样任何长度的尾部都仍然包含 `AAA`，断言会假失败（当场踩了一次）。
   */
  const topics = '【最旧】' + '中'.repeat(400) + '【最新】'
  const out = clipForPrompt(`【事】\n${topics}`, 120)
  assert.ok(out.includes('【最新】'), '尾部（最新）必须留下')
  assert.ok(!out.includes('【最旧】'), '头部（最旧）应被砍掉')
  assert.ok(out.length <= 120, `实际 ${out.length}`)
})

// ── ⑤ 注入裁剪**不改存储** ────────────────────────────────
ok('⚠️ toPrompt() 只裁注入，不动 this.summary', () => {
  const m = new LongTermMemory('group:1', { total: 12000, inject: 300 })
  m.summary = '【人】\n111111111 | 甲 | x\n\n【事】\n' + '话'.repeat(2000)
  const before = m.summary.length
  const p = m.toPrompt()
  assert.equal(m.summary.length, before, '存储一个字都不能少')
  assert.ok(p.length < before + 40, `注入应被裁短，实际 ${p.length}`)
  assert.ok(p.includes('【关于这个会话你已经知道的】'))
})

// ── ⑥ 配置读取与夹紧 ─────────────────────────────────────
const mk = (cfg) => new LongTermStore({ cfg: { enabled: true, ...cfg }, summarize: async () => '', log: {} })

ok('从 cfg 读 maxChars / injectChars', () => {
  const s = mk({ maxChars: 5000, injectChars: 1500 })
  assert.equal(s.limits.total, 5000)
  assert.equal(s.limits.inject, 1500)
  assert.equal(s.get('g:1').limits.total, 5000, 'memory 实例也要拿到')
})

ok('不传就用默认', () => {
  const s = mk({})
  assert.equal(s.limits.total, DEFAULT_LIMITS.total)
  assert.equal(s.limits.inject, DEFAULT_LIMITS.inject)
})

ok('范围夹紧：太小抬到下限、太大压到上限', () => {
  assert.equal(mk({ maxChars: 1 }).limits.total, 1500, '存储下限 1500')
  assert.equal(mk({ maxChars: 999999 }).limits.total, 50000, '存储上限 50000')
  assert.equal(mk({ injectChars: 1 }).limits.inject, 500, '注入下限 500')
  assert.equal(mk({ injectChars: 999999 }).limits.inject, 20000, '注入上限 20000')
})

ok('非法值（NaN / 负数 / 字符串）退回默认', () => {
  for (const bad of [NaN, -1, 'abc', null, undefined]) {
    const s = mk({ maxChars: bad, injectChars: bad })
    assert.equal(s.limits.total, DEFAULT_LIMITS.total, `maxChars=${String(bad)}`)
    assert.equal(s.limits.inject, DEFAULT_LIMITS.inject, `injectChars=${String(bad)}`)
  }
})

ok('stats() 带上 limits（面板要从这读当前值）', () => {
  const s = mk({ maxChars: 8000, injectChars: 2500 })
  const st = s.stats()
  assert.equal(st.limits.total, 8000)
  assert.equal(st.limits.inject, 2500)
})

// ── ⑦ 端到端：存得多、带得少 ──────────────────────────────
ok('端到端：摘要存到 10000+，但每轮只带 3000', () => {
  const s = mk({ maxChars: 20000, injectChars: 3000 })
  const m = s.get('group:9')
  m.merge('【人】\n' + Array.from({ length: 120 }, (_, i) => `${100000000 + i} | 群友${i} | ${'印'.repeat(50)}`).join('\n'))
  assert.ok(m.summary.length > 5000, `存储应当很长，实际 ${m.summary.length}`)
  const p = m.toPrompt()
  const body = p.replace('【关于这个会话你已经知道的】\n', '')
  assert.ok(body.length <= 3000, `注入应当 ≤ 3000，实际 ${body.length}`)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)