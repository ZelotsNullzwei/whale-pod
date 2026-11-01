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

// ── 目标总时长（2026-10-31）──────────────────────────────────
/*
 * ## 为什么改成「总时长」
 * 实测 38 次「决策→发出」：
 * ```
 * p10 3.4s   p50 5.1s   p90 6.1s      ← 只差 2.7 秒
 * 配置延迟   0.4s ~ 7.0s              ← 本意差 6.6 秒
 * ```
 * `总时长 = 延迟 + 生成`，而**生成本身抖动 1.3~4 秒**，把延迟的差别吃掉了。
 * 用户反馈「感觉随机时间没生效」—— 他没说错。
 *
 * 所以改成：`targetMs`（目标**总时长**），生成完再补 `目标 - 已用`。
 *
 * ## 用户的原话（澄清过一次）
 * 「根据**上下文**长短进行回复」—— 先前打成「上下午」，不是时段。
 */
const { createDecisionLayer } = await import('../src/decision/index.js')

const layer = createDecisionLayer(
  {
    delay: { min: 800, max: 3500, easy: { min: 400, max: 1500 }, hard: { min: 2000, max: 7000 } },
    model: { enabled: false },
  },
  { random: () => 0.5 },
)

/**
 * ⚠️ 最后一条必须 `mentionsMe: true`。
 *
 * 否则「嗯」「？」会被判**沉默**，`targetMs` 就是 `undefined` ——
 * 我第一版探针没注意这点，把 undefined 打印成 NaN，误判成"算错了"。
 */
const mkInput = (texts) => ({
  scope: 'private:1',
  messages: texts.map((t, i) => ({
    text: t,
    isMe: false,
    sender: '1',
    mentionsMe: i === texts.length - 1,
  })),
})

await (async () => {
  const d = await layer.shouldReply(mkInput(['嗯']))
  ok('★ 会回的时候必须给出 targetMs（目标总时长）', () => {
    assert.equal(d.reply, true, '这条应该会回')
    assert.ok(Number.isFinite(d.targetMs) && d.targetMs > 0, `targetMs 要是正数，实际 ${d.targetMs}`)
  })
})()

await (async () => {
  const easy = await layer.shouldReply(mkInput(['嗯']))
  const hard = await layer.shouldReply(mkInput(['为什么会这样']))
  ok('★ 档位影响目标：hard 明显慢于 easy', () => {
    assert.equal(easy.delayTier, 'easy')
    assert.equal(hard.delayTier, 'hard')
    assert.ok(
      hard.targetMs > easy.targetMs * 1.8,
      `hard(${hard.targetMs}ms) 该明显慢于 easy(${easy.targetMs}ms)`,
    )
  })
})()

await (async () => {
  const filler = '今天下午上课上到九点，回来路上买了个煎饼，边吃边走'
  const small = await layer.shouldReply(mkInput(['嗯']))
  const big = await layer.shouldReply(mkInput([...Array.from({ length: 45 }, () => filler), '嗯']))
  ok('★ 上下文越长 → 目标总时长越长', () => {
    assert.ok(big.delayCtxChars > 1000, `大上下文的字数该 >1000，实际 ${big.delayCtxChars}`)
    assert.ok(
      big.delayCtxK > small.delayCtxK,
      `系数该变大：${small.delayCtxK} → ${big.delayCtxK}`,
    )
    assert.ok(
      big.targetMs > small.targetMs,
      `目标该变长：${small.targetMs}ms → ${big.targetMs}ms`,
    )
  })
})()

await (async () => {
  const media = await layer.shouldReply(mkInput(['[表情包]', '[表情包]', '[图片]', '嗯']))
  ok('媒体标记不算上下文（刷几张图不该被判成"聊得深"）', () => {
    assert.ok(
      media.delayCtxChars <= 5,
      `全是 [表情包]/[图片] 时字数该很小，实际 ${media.delayCtxChars}`,
    )
  })
})()

ok('源码锁：`_waitForPace` 必须在**发送前**补时，且两处发送点都调了', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const atDef = src.indexOf('async _waitForPace(')
  assert.ok(atDef > 0, '要有 `_waitForPace` 方法')
  const calls = src.split('this._waitForPace(').length - 1
  assert.ok(calls >= 2, `两处发送点都要调（纯表情 + 正常），实际 ${calls} 处`)
  // 生成前**不该**再睡 delayMs 了 —— 那样会把生成时间又叠加上去
  assert.ok(
    !/if \(d\.delayMs && d\.delayMs > 0\)/.test(src),
    '生成前的 delayMs 睡眠该已删除 —— 改成发送前补足',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)