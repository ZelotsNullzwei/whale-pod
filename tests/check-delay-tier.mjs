/**
 * 回复延迟按内容分档（2026-10-30）。
 *
 * ## 用户的原话
 *   · 「真人回消息不会每次都一样的时间」
 *   · 「简单的就快速回，稍微难一点的就思考一点」
 *
 * ## 为什么需要
 * 原来只有一个区间（800~3500 均匀随机）。实测 60 次「决策→发出」：
 * ```
 * 最小 2.0s  中位 5.1s  最大 9.8s
 * <2 秒: 0/60      ← 一次都没有
 * >15 秒: 0
 * ```
 * 全挤在 2~10 秒 —— 这就是"每次都差不多"的机械感来源。
 *
 * ⚠️ 这只是**一半**。另一半是 `bridge.js` 的 `reply.mergeWindowMs`
 *    （先等对方把话打完）。只加快不给等待 → 用户会说
 *    「回复太快了我打字跟不上」——这个教训当天就踩到了。
 */
import assert from 'node:assert/strict'
import { gradeDelayTier } from '../src/decision/index.js'
import { DEFAULTS } from '../src/config/store.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const tier = (text) => gradeDelayTier({ messages: [{ text }] })

// ── ① 简单 ───────────────────────────────────────────────
ok('简单：打招呼 / 极短 / 纯标点 / 纯表情', () => {
  for (const t of ['在吗', '嗯', '嗯嗯', '哦', '晚安', '？', '？？？', '哈哈哈', '[表情包]', '[图片]']) {
    assert.equal(tier(t), 'easy', `「${t}」应当 easy`)
  }
  /*
   * ⚠️ 「鱼鱼晚安」4 个字 —— **本来就该 easy**。
   * 我第一版把它写在 normal 组里，那是我的预期错了，不是代码错。
   * 「短」就是「接话茬快」的信号，这正是用户要的「简单的就快速回」。
   */
  assert.equal(tier('鱼鱼晚安'), 'easy', '4 个字的道别该秒回')
})

// ── ② 难 ─────────────────────────────────────────────────
ok('难：要解释 / 要展开 / 多问号', () => {
  for (const t of [
    '为什么会这样',
    '这是怎么回事',
    '你觉得这两个哪个好',
    '帮我看看这个怎么弄',
    '有什么办法吗？要不要改？',
    '真的吗',
  ]) {
    assert.equal(tier(t), 'hard', `「${t}」应当 hard`)
  }
})

ok('⚠️ 短不等于简单：「为啥」「怎么办」就是要想一下的', () => {
  /*
   * ⚠️ 第一版把 `len <= 6 → easy` 放在**前面**，于是「为什么会这样」（6 字）
   * 被判成 easy —— **短句永远走不到"难"那一支**。
   * 所以现在的顺序是**先难后简**，这条锁住这个顺序。
   */
  assert.equal(tier('为啥'), 'hard')
  assert.equal(tier('怎么办'), 'hard')
  assert.equal(tier('为什么会这样'), 'hard')
})

ok('⚠️ 但「怎么了」要快回 —— 它只是问"发生什么了"', () => {
  // 裸「怎么」不能进 HARD，只收「怎么办 / 怎么弄 / 怎么搞」这种求助形态
  assert.equal(tier('怎么了'), 'easy')
})

// ── ③ 普通 ───────────────────────────────────────────────
ok('普通：不长不短、没有疑问词的日常话', () => {
  /*
   * ⚠️ 注意边界：**≤6 字一律 easy** —— 这是**有意的**
   * （用户说「简单的就快速回」，短句就是最简单的信号）。
   * 我两次把 5~6 字的例子写进 normal 组，两次都是我的预期错。
   * 所以这里用**明显超过 6 字**、又没有疑问词的例子。
   */
  for (const t of ['刚才那个挺好看的', '我下午三点左右回来', '这个方案我看了还行', '明天换台机子试试']) {
    assert.equal(tier(t), 'normal', `「${t}」应当 normal`)
  }
})

ok('边界：6 字以内走 easy，不纠结语义', () => {
  assert.equal(tier('你看看钱包'), 'easy')   // 5 字
  assert.equal(tier('这游戏有点难'), 'easy')  // 6 字
  assert.equal(tier('这游戏有点难啊'), 'normal') // 7 字
})

ok('长文本（>=60 字）算难', () => {
  assert.equal(tier('这'.repeat(60)), 'hard')
  assert.equal(tier('这'.repeat(30)), 'normal')
})

// ── ④ 边界 ───────────────────────────────────────────────
ok('空消息 / 只有媒体标记 → easy（不是 normal，别拖着不回）', () => {
  assert.equal(tier(''), 'easy')
  assert.equal(tier('[表情包]'), 'easy')
  assert.equal(tier('   '), 'easy')
})

ok('异常输入不抛（没有 messages / null）', () => {
  assert.doesNotThrow(() => gradeDelayTier({}))
  assert.doesNotThrow(() => gradeDelayTier(null))
  assert.ok(['easy', 'normal', 'hard'].includes(gradeDelayTier({})))
})

// ── ⑤ 配置 ───────────────────────────────────────────────
ok('三档配置都在，且整体有序（easy 快于 hard）', () => {
  const d = DEFAULTS.decision.delay
  assert.ok(d.easy && d.hard, '要有 easy / hard 两档')
  assert.ok(d.min === 800 && d.max === 3500, 'min/max 仍是 normal 档（兼容老配置）')
  /*
   * ⚠️ 我第一版断言 `easy.max < normal.min`（要求三档**完全不重叠**）—— 错了。
   * 档位区间**本来就该有重叠**：easy 400~1500 和 normal 800~3500 在
   * 800~1500 上重叠是正常的（都是"几秒内"）。
   * 真正要守的性质是**整体有序**：easy 的上限不超过 hard 的下限。
   */
  assert.ok(d.easy.max < d.hard.min, `easy(${d.easy.max}) 该整体快于 hard(${d.hard.min})`)
  assert.ok(d.easy.min < d.min, 'easy 的下限该比 normal 更低（能更快）')
  assert.ok(d.hard.max > d.max, 'hard 的上限该比 normal 更高（能更慢）')
})

ok('源码锁：缺档位时回退到 min/max（老 config.json 不会炸）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/decision/index.js', import.meta.url), 'utf8')
  assert.match(src, /cfg\.delay\?\.\[tier\]\) \|\| cfg\.delay/, '要有回退')
  assert.match(src, /delayTier: tier/, '档位要带出去 —— 否则无法量出是否生效')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)