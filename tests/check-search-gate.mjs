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
import fs from 'node:fs'
import { needsFreshInfo, formatSearchContext } from '../src/gateway/search.js'

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

// ── ② 搜索结果**怎么用**（2026-10-30 加）────────────────────
/*
 * 用户的原话：「少发一点，或者分开发短句」。
 *
 * 实测反例（那次的真实输出）：
 *   [我]「这链接是《明日方舟》卫戍协议：盟约的组队邀请，房号 UXMP，
 *        邀请人 Null_zwei，终极模拟模式，四人一队。」
 *
 * 四个要素全列 —— 那是**资料复述**，不是群聊说话。
 * 原来只写「用你自己的口吻简短转述」，光说"简短"模型不知道短到哪，
 * 所以要给**正反例**。
 */
const fakeResult = {
  ok: true,
  answer: '这是一个《明日方舟》卫戍协议：盟约的组队邀请，房号 UXMP，邀请人 Null_zwei，终极模拟模式，四人一队。',
  sources: [{ title: '组队邀请', url: 'https://example.com/x' }],
}

ok('搜索结果注入：要点到「只挑一个点」，别列要素', () => {
  const t = formatSearchContext(fakeResult)
  assert.match(t, /只挑\*\*一个\*\*最该说的点/, '要有"只挑一个点"')
  assert.match(t, /资料复述/, '要命名这个坏模式')
})

ok('搜索结果注入：给出正反例（光说"简短"没用）', () => {
  const t = formatSearchContext(fakeResult)
  assert.match(t, /✗ 反例/, '要有反例')
  assert.match(t, /✓ 正例/, '要有正例')
})

ok('搜索结果注入：允许空行拆成多条短句', () => {
  const t = formatSearchContext(fakeResult)
  assert.match(t, /空一行拆成两三条短句/, '长内容要允许拆句')
  assert.match(t, /发成多条消息/, '要说明上层真的会拆（否则模型以为是空话）')
})

ok('搜索结果注入：失败时返回空串（不注入噪音）', () => {
  assert.equal(formatSearchContext({ ok: false, error: 'x' }), '')
  assert.equal(formatSearchContext(null), '')
})

ok('⚠️ 源码锁：注入块必须保留「优先于训练记忆」', () => {
  // 这条是 2026-10 早先就有的关键约束，别在改文风时顺手删掉
  const t = formatSearchContext(fakeResult)
  assert.match(t, /优先于你的训练记忆/, '要压过训练记忆（知识有截止日期）')
  assert.match(t, /不要在群里贴长链接/, '别贴长链接')
})

// ── 链接不该触发搜索（2026-10-31）────────────────────────────
/*
 * ## 事故
 * ```
 * 21:00:28  B站：BV1bbeY6wE9x 评论 5 条 / 弹幕 10 条   ✅ 真信息抓到了
 * 21:00:28  bridge：需要联网（提到具体名字「https」）→ 查「【哔哩哔哩】https://b23.tv/…」
 * 21:00:30  bridge：联网：已查到 → 264 字 / 5 个来源      ← 垃圾
 * 21:00:34  我「还是没展开，短链跳不过去」                ← 被搜索带偏
 * ```
 * **拿一条链接去联网搜**本来就是错的：短链搜不到，只会返回无关内容，
 * 让模型以为"这个链接打不开"。而 B 站的真信息**已经抓到了**，再搜一遍纯帮倒忙。
 */

ok('★ 整段含 URL 时不触发"专有名词"搜索', () => {
  const urls = [
    '【哔哩哔哩】https://b23.tv/1sA58D7',
    '【哔哩哔哩】https://b23.tv/1sA58D7?share_medium=android&share_source=qq&bbid=XX4F12F4&ts=1793451604063',
    '看这个 https://www.bilibili.com/video/BV1bbeY6wE9x',
    'https://example.com/abc',
  ]
  for (const t of urls) {
    const r = needsFreshInfo(t)
    assert.equal(r.need, false, `不该因为链接就搜：${t} → why=${r.why}`)
  }
})

ok('★ 短链尾部的随机段（`sA58D7`）不能被当成"具体名字"', () => {
  /*
   * 第一版只判断"这个词前后紧邻 URL 字符" ——
   * `b23.tv/1sA58D7` 结尾那段后面什么都没有，仍然被当成名字
   * （实测 why=「提到具体名字「sA58D7」」）。
   * 所以补了"整段含 URL 就直接返回 null"。
   */
  const r = needsFreshInfo('【哔哩哔哩】https://b23.tv/1sA58D7')
  assert.equal(r.need, false)
  assert.ok(!/sA58D7/.test(r.why ?? ''), `why 里不该出现短链片段：${r.why}`)
})

ok('⚠️ 但不能因为这条把真问题也拦掉', () => {
  // 这些**没有** URL，仍然该搜（否则模型拿旧记忆编人名/新番）
  for (const t of ['黑神话出新DLC了吗', '《咒术回战》第二季播了吗', '祀强吗', '影之刃零真好玩吗']) {
    const r = needsFreshInfo(t)
    assert.equal(r.need, true, `漏搜了：${t}`)
  }
})

ok('文本 + 链接混排（链接只是附带）时也按不搜处理', () => {
  const r = needsFreshInfo('看这个 https://b23.tv/abc 挺好笑的')
  assert.equal(r.need, false, `实际 why=${r.why}`)
})

console.log('\n=== 2026-11-01：翻真实账单后收紧的几条 ===')
/*
 * ## 起因
 * 用户截图：今天 `消费 ¥0.18 / 58 次调用 / 56,602 tokens`。拆开对下来：
 * ```
 * tool-search 本身   40,242 tokens   72%   ← 大头（按检索条数线性涨）
 * 总结（chat）       16,360 tokens   28%
 *                  ─────────
 *                   56,602          ✅ 和账单分毫不差
 * ```
 * **一次搜索 ≈ 6,300 token ≈ ¥0.02** —— 原来以为的「¥0.005/次」只是**接口费**，
 * 返回内容的 token 另算。而当天 9 次里 **4 次根本不该搜**，白花 44%。
 */

// 今天日志里真实误触的（括号里是当时记的 why）
const NEW_FALSE = [
  '看不到吗',                     // 短问句「XX吗」
  '真的吗',                       // 元问题
  '是你吗',                       // 元问题
  '那我给你加新功能去了',            // freshEntity 的裸「新XX」吃掉了「新功能去了」
  'GPT变的比你大不是正常吗',         // 反问句 + 里面有个外文词 GPT（走了两条路才挡住）
  // 用户点名：「吃饭了吗那些日常问题都不该搜索」
  '吃饭了吗', '你吃了吗', '睡了吗', '干嘛呢', '忙吗', '下班了吗',
  '想我吗', '心情好吗', '在吗', '在不在', '有事吗',
  // 无主语单形容词
  '好看吗', '好玩吗', '能看见吗', '听得见吗',
  // 元问题
  '是吗', '对吧', '当真', '不会吧',
  // 「即将」收紧后不该再中
  '我即将下班',
]

// ⚠️ 收紧时**一个都不许误伤**的
const NEW_TRUE = [
  // ★ 有主语的仍然要搜 —— 这是"不能一刀切"的关键
  '这游戏好玩吗', '这图好看吗', '祀强吗', '塔露拉强吗',
  '你玩过影之刃零吗',              // 含"你"但问外部作品
  '黑神话出新DLC了吗', '这季新番有啥好看的', '显卡涨价了吗',
  // ★ freshEntity 收紧成枚举后，这些真的新作品词要命中
  '终末地新干员', '三角洲联动合金装备', '孤独摇滚第二季', '这个角色的新皮肤',
  // ★ 「吃鸡」不能被"吃饭"那条误挡
  '吃鸡更新了吗',
]

ok('★ 2026-11-01 的误触样本一条都不许再搜', () => {
  const bad = NEW_FALSE.filter((t) => needsFreshInfo(t).need)
  assert.deepEqual(bad, [], `还在搜：${bad.join(' / ')}`)
})

ok('★ 同上那批"该搜的"一条都不许误伤', () => {
  const bad = NEW_TRUE.filter((t) => !needsFreshInfo(t).need)
  assert.deepEqual(bad, [], `误伤了：${bad.join(' / ')}`)
})

ok('★ 日常/反问要**两条路共用**（`notLookup`，不能只管 shortAsk）', () => {
  /*
   * ⚠️ 原来日常寒暄只在 `shortAsk` 分支判 —— `fresh && question` 那条盖不着，
   * 于是「今天做饭了吗」只要撞上时效词就漏出去搜。
   */
  const src = fs.readFileSync(new URL('../src/gateway/search.js', import.meta.url), 'utf8')
  assert.match(src, /const notLookup = \(\)/, '要有统一的 notLookup')
  const uses = (src.match(/!notLookup\(\)/g) ?? []).length
  assert.ok(uses >= 3, `至少 3 处要用它（shortAsk / fresh / properNoun），实际 ${uses}`)
})

ok('★ `detectProperNoun` 那条也要排除反问', () => {
  const src = fs.readFileSync(new URL('../src/gateway/search.js', import.meta.url), 'utf8')
  const at = src.indexOf('const properNoun = detectProperNoun(t)')
  assert.ok(at > 0, '要能找到那行')
  assert.match(src.slice(at, at + 600), /properNoun && !notLookup\(\)/, '反问句里提到的名字不算求知')
})

ok('★ `count` 默认 3（不是 5）—— 一次搜索约 ¥0.02，按条数线性涨', () => {
  const src = fs.readFileSync(new URL('../src/gateway/search.js', import.meta.url), 'utf8')
  assert.match(src, /Number\(o\.count\) \|\| 3/, '默认值要是 3')
  assert.ok(!/Number\(o\.count\) \|\| 5/.test(src), '不能再是 5')
})

ok('★ `freshEntity` 不能再是裸的「新XX」', () => {
  /*
   * 原来第一分支 `新[\u4e00-\u9fa5]{2,6}` 什么都吃 ——
   * 「那我给你加新功能去了」被判成"提到新作品"，白搜一次（约 ¥0.02）。
   */
  const src = fs.readFileSync(new URL('../src/gateway/search.js', import.meta.url), 'utf8')
  const at = src.indexOf('const freshEntity =')
  const seg = src.slice(at, at + 900)
  assert.ok(!/新\[\\u4e00-\\u9fa5\]\{2,6\}/.test(seg), '不能再有裸的「新 + 任意 2~6 字」')
  assert.match(seg, /新\(\?:番\|作\|干员/, '要枚举作品类后缀')
})

console.log('\n=== 2026-11-01 第二轮：用户在"元讨论"里被误搜 ===')
/*
 * ## 起因（用户原话）
 * > 「哎，**72 次**了，又搜索啥了 **我也没问啥啊**」
 *
 * 查日志：13:43~14:09 之间 4 次搜索**全是白花的** ——
 * 用户当时在**跟我讨论"搜索这件事"**：
 * ```
 *   13:43:38  搜索bug 不知道为啥          [用户明确要求搜索]  ← 命中裸的「搜索」
 *   13:43:49  你今天调了58次api搜索        [用户明确要求搜索]
 *   13:57:42  你后台的agent 也是你         [提到具体名字「agent」]
 *   13:58:06  你两都是4.1flash 你搜的       [提到具体名字「flash」]
 *   14:09:37  你中午吃吗                  [在问某个东西好不好]
 * ```
 * ## 两个病灶
 * 1. `explicit` 里有**裸的「搜索」「联网」** —— 讨论功能时必然命中
 * 2. STOP 词表没有 `agent`/`flash` —— 在**这个群**里它们是"我俩在聊的东西"
 */

const META_FALSE = [
  '搜索bug 不知道为啥',
  '你今天调了58次api搜索',
  '联网老是失败',
  '你后台的agent 也是你',
  '你两都是4.1flash 你搜的 她查到了',
  // chitchat 带时间词（"你中午吃吗"原来漏了）
  '你中午吃吗', '你晚上吃吗', '今天吃了吗', '你现在忙吗',
]

const META_TRUE = [
  // ★ 明确请求式（动词 + 宾语）仍要搜
  '帮我搜一下明日方舟半周年', '查一下RTX5090价格', '百度一下这个bug',
  '搜一下明日方舟新干员', '帮我查查显卡价格',
]

ok('★ 元讨论（在聊"搜索/agent"这件事本身）不许搜', () => {
  const bad = META_FALSE.filter((t) => needsFreshInfo(t).need)
  assert.deepEqual(bad, [], `元讨论被搜了：${bad.join(' / ')}`)
})

ok('★ 但不能连"明确请求搜索"一起砍掉', () => {
  /*
   * ⚠️ 收紧 `explicit` 时最容易过头 —— 去掉裸的「搜索」「联网」之后，
   * 「帮我搜一下」「搜一下」「帮我查查」这些**有宾语结构的**必须还认得。
   */
  const bad = META_TRUE.filter((t) => !needsFreshInfo(t).need)
  assert.deepEqual(bad, [], `把该搜的砍了：${bad.join(' / ')}`)
})

ok('★ `explicit` 里不能有裸的「搜索」或「联网」', () => {
  const src = fs.readFileSync(new URL('../src/gateway/search.js', import.meta.url), 'utf8')
  const at = src.indexOf('const explicit =')
  const seg = src.slice(at, at + 400)
  // 词表里不能出现「独立成项的 搜索 / 联网」
  assert.ok(!/'搜索'/.test(seg), "explicit 里不该有裸的 '搜索'（讨论功能时会命中）")
  assert.ok(!/'联网'/.test(seg), "explicit 里不该有裸的 '联网'")
  assert.match(seg, /搜一下|搜索一下/, '但要保留「搜一下 / 搜索一下」这种带宾语的')
})

ok('★ STOP 词表要挡住元讨论词（agent/flash/model）', () => {
  const src = fs.readFileSync(new URL('../src/gateway/search.js', import.meta.url), 'utf8')
  const at = src.indexOf('const STOP = new Set([')
  const seg = src.slice(at, at + 1200)
  for (const w of ['agent', 'flash']) {
    assert.ok(seg.includes(`'${w}'`), `STOP 里要有 ${w}`)
  }
})

ok('★ chitchat 要容忍时间词（"你中午吃吗"）', () => {
  for (const t of ['你中午吃吗', '你晚上吃吗', '今天吃了吗']) {
    assert.equal(needsFreshInfo(t).need, false, `日常漏搜：${t}`)
  }
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)