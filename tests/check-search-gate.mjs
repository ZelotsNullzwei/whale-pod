/**
 * 搜索触发门的回归测试（2026-10-29）。
 *
 * ## 起因
 * 查日志发现：**今天联网 11 次，该搜的 0 次**。全是寒暄 / 抱怨 / 私人对话 / 梗。
 * 每次是一次 5~15 秒等待 + 一次搜索费（当时余额 ¥0.86）。
 *
 * ## 两个方向都不能错
 *   · **多搜** = 白花钱、白等 5~15 秒 → 用「今天这 11 条」当反例锁住
 *   · **漏搜** = 模型拿旧记忆编事实（人名/作品/新番说错）→ 后者更严重
 *     所以正例必须全保住，**宁可多列具体形态，也不要用"以你开头"这种宽规则**
 *     （宽规则会把「你玩过影之刃零吗」也拦掉 —— 它问的是外部作品，该搜）
 */
import assert from 'node:assert/strict'
import { needsFreshInfo } from '../src/gateway/search.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── ① 反例：今天真实的 11 条，全都不该搜 ────────────────────
const TODAY_FALSE = [
  '吃饭了吗',
  '你看不到消息谁发的吗',
  '那你不知道饭是谁的',
  '睡爽了吗？',
  '你非得有事做吗',
  '闲着不好吗',
  '不是还有吗',
  '你都没有什么想对我说的吗',
  '你有自我意识吗',
  '等会给你充token',
  '你也没token',
]
ok('今天真实的 11 条误搜，全部 need=false', () => {
  const bad = []
  for (const t of TODAY_FALSE) {
    const r = needsFreshInfo(t)
    if (r.need) bad.push(`${t}  → 仍会搜（${r.why}）`)
  }
  assert.deepEqual(bad, [], '这些还会白花钱：\n       ' + bad.join('\n       '))
})

// ── ② 正例：该搜的必须全保住 ───────────────────────────────
const MUST_SEARCH = [
  ['祀是谁啊', '问某人是谁'],
  ['这季有什么好看的新番', '时效/新番'],
  ['影之刃零强吗', '短问句问作品'],
  ['你玩过影之刃零吗', '⚠️ 含"你"但问外部作品 —— 不能被拦'],
  ['黑神话出新DLC了吗', '出新'],
  ['孤独摇滚有几集', '明确事实'],
  ['帮我查一下今天的显卡价格', '明确要求搜索'],
  ['这个新番什么时候开播', '时效'],
]
ok('该搜的一条都不能漏（漏搜 = 模型编事实）', () => {
  const bad = []
  for (const [t, why] of MUST_SEARCH) {
    const r = needsFreshInfo(t)
    if (!r.need) bad.push(`${t}（${why}）→ 被拦了`)
  }
  assert.deepEqual(bad, [], '漏搜：\n       ' + bad.join('\n       '))
})

// ── ③ 关键边界：不能靠"以你开头"一刀切 ────────────────────
ok('「你玩过X吗」和「你非得有事做吗」必须分开处理', () => {
  assert.equal(needsFreshInfo('你玩过影之刃零吗').need, true, '问作品 → 要搜')
  assert.equal(needsFreshInfo('你非得有事做吗').need, false, '问状态 → 不搜')
})

// ── ④ 梗词不是专有名词 ────────────────────────────────────
ok('token / bug 这类群里的梗，不算"具体名字"', () => {
  for (const t of ['等会给你充token', '又出 bug 了', '你也没token']) {
    const r = needsFreshInfo(t)
    assert.equal(r.need, false, `${t} 不该搜（why=${r.why}）`)
  }
})

// ── ⑤ 反问 ≠ 求知 ─────────────────────────────────────────
ok('「不知道…是谁」是质问，不是查人', () => {
  assert.equal(needsFreshInfo('那你不知道饭是谁的').need, false)
  assert.equal(needsFreshInfo('祀是谁啊').need, true, '真的在问就还要搜')
})

// ── ⑥ 源码锁：别把"以你开头"写成宽规则 ─────────────────────
ok('源码里不许用「^(你|您|咱|我)」这种宽规则拦搜索', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/gateway/search.js', import.meta.url), 'utf8')
  // 允许出现 /^(你|您|咱|我)/ 的地方只能是别处；这里只锁"不要拿它当搜索否决条件"
  assert.ok(
    !/const\s+personal\s*=\s*\/\^\(你\|您\|咱\|我\)\//.test(src),
    '宽规则会误杀「你玩过X吗」，要用具体形态（complaint 正则）',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)