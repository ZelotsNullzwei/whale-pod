/**
 * B 站链接的**免费**元信息抓取（2026-10-31）。
 *
 * ## 为什么
 * 群里分享 B 站视频，机器人拿到的只有 `【标题】https://...` —— 不点、不搜，
 * 只能从标题猜。B 站的 `x/web-interface/view` 接口**免费、免登录**（实测 code=0），
 * 拿得到 标题/UP主/时长/播放/简介。
 *
 * ## 字幕拿不到
 * 匿名 `x/player/v2` 的 `subtitle.subtitles` **恒为 0 条**（要登录态），
 * 所以 `formatVideoContext` 里明确写「**你没看过这个视频，别编**」。
 *
 * ## 测试原则
 * **不打真实网络** —— 全部用 `fetchImpl` 注入，否则测试会慢、会飘、会被风控。
 */

import assert from 'node:assert/strict'
import {
  hasBiliLink, extractBvid, resolveBvid, fetchVideoInfo, fetchTopComments, fetchDanmaku, formatVideoContext,
} from '../src/qq/bilibili.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}

console.log('=== 识别 ===')

ok('hasBiliLink：BV 号 / bilibili.com/video / b23 短链都算', () => {
  assert.equal(hasBiliLink('【标题】https://www.bilibili.com/video/BV1GJ411x7h7'), true)
  assert.equal(hasBiliLink('看这个 BV1GJ411x7h7'), true)
  assert.equal(hasBiliLink('https://b23.tv/abcd123'), true)
  assert.equal(hasBiliLink('今天吃了个橘子'), false)
  assert.equal(hasBiliLink(''), false)
})

ok('extractBvid：从带参数的链接里抠出 BV 号', () => {
  assert.equal(extractBvid('https://www.bilibili.com/video/BV1GJ411x7h7?p=1&t=30'), 'BV1GJ411x7h7')
  assert.equal(extractBvid('https://b23.tv/abcd123'), null, '短链里没有 BV，要跟跳')
  assert.equal(extractBvid('没有链接'), null)
})

console.log('\n=== 短链跟跳 ===')

await ok('★ b23 短链 → 跟跳后拿到 BV 号', async () => {
  const fake = async (url) => ({
    url: 'https://www.bilibili.com/video/BV1xx411c7mD?share_source=copy',
    ok: true,
    json: async () => ({}),
  })
  const bv = await resolveBvid('https://b23.tv/abcd123', { fetchImpl: fake })
  assert.equal(bv, 'BV1xx411c7mD')
})

await ok('文本里直接有 BV 号时**不该**发请求', async () => {
  let called = 0
  const fake = async () => { called++; return { ok: true, url: '' } }
  const bv = await resolveBvid('看 BV1GJ411x7h7', { fetchImpl: fake })
  assert.equal(bv, 'BV1GJ411x7h7')
  assert.equal(called, 0, '有 BV 就不用跟跳')
})

await ok('跟跳失败返回 null（不抛）', async () => {
  const fake = async () => { throw new Error('ECONNRESET') }
  assert.equal(await resolveBvid('https://b23.tv/x', { fetchImpl: fake }), null)
})

console.log('\n=== 抓元信息 ===')

await ok('★ 正常返回 → 解析出 title/owner/duration/view/desc', async () => {
  const fake = async () => ({
    json: async () => ({
      code: 0,
      data: {
        title: '【官方 MV】Never Gonna Give You Up',
        owner: { name: '索尼音乐中国' },
        duration: 213,
        stat: { view: 107887133 },
        desc: '经典老歌',
        cid: 137649199,
      },
    }),
  })
  const info = await fetchVideoInfo('BV1GJ411x7h7', { fetchImpl: fake })
  assert.equal(info.title, '【官方 MV】Never Gonna Give You Up')
  assert.equal(info.owner, '索尼音乐中国')
  assert.equal(info.duration, 213)
  assert.equal(info.view, 107887133)
  assert.equal(info.desc, '经典老歌')
})

await ok('code !== 0 → 返回 null（不抛）', async () => {
  const fake = async () => ({ json: async () => ({ code: -400, message: '请求错误' }) })
  assert.equal(await fetchVideoInfo('BV1GJ411x7h7', { fetchImpl: fake }), null)
})

await ok('网络异常 → 返回 null（不抛）', async () => {
  const fake = async () => { throw new Error('boom') }
  assert.equal(await fetchVideoInfo('BV1GJ411x7h7', { fetchImpl: fake }), null)
})

await ok('非法 BV 号直接 null（不去请求）', async () => {
  let called = 0
  const fake = async () => { called++; return { json: async () => ({ code: 0, data: {} }) } }
  assert.equal(await fetchVideoInfo('not-a-bv', { fetchImpl: fake }), null)
  assert.equal(called, 0)
})

console.log('\n=== 拼给模型 ===')

const base = { bvid: 'BV1', title: '显卡驱动更新完三角洲行动很卡怎么办', owner: '某UP', duration: 754, view: 32000, desc: '这期讲驱动回滚和设置' }

ok('★ 拼出 标题/UP主/时长/播放/简介', () => {
  const t = formatVideoContext(base)
  assert.match(t, /对方分享的 B 站视频/)
  assert.match(t, /显卡驱动更新完三角洲行动很卡怎么办/)
  assert.match(t, /某UP/)
  assert.match(t, /12 分 34 秒/, '754 秒 = 12 分 34 秒')
  assert.match(t, /3\.2 万/, '32000 → 3.2 万')
  assert.match(t, /这期讲驱动回滚和设置/)
})

ok('★★ 必须写明「你没看过这个视频，别编」', () => {
  /*
   * 这是本功能最要紧的一句。她只拿到了**元信息**，没看视频。
   * 不写清楚，模型会顺着简介编出"我看过了""里面说…"。
   */
  const t = formatVideoContext(base)
  assert.match(t, /没看过这个视频/, '要明确告知')
  assert.match(t, /别编/, '要禁止编造')
})

ok('占位简介（`-` / `www`）不当内容写进去', () => {
  const t1 = formatVideoContext({ ...base, desc: '-' })
  assert.ok(!/简介：/.test(t1), '「-」是占位，不该输出')
  const t2 = formatVideoContext({ ...base, desc: 'www' })
  assert.ok(!/简介：/.test(t2), '「www」也是占位')
})

ok('没有 title → 空串（别硬拼一段空的）', () => {
  assert.equal(formatVideoContext({ bvid: 'BV1' }), '')
  assert.equal(formatVideoContext(null), '')
})

ok('超长简介会截断', () => {
  const t = formatVideoContext({ ...base, desc: 'x'.repeat(500) }, 50)
  assert.match(t, /…/, '要加省略号')
  assert.ok(t.length < 400, '不能把 500 字全塞进去')
})

console.log('\n=== 评论（用户说：评论和弹幕才是重点）===')
/*
 * 用户原话：「光是标题和简介只是作者说明，**评论和弹幕才是重点**」。
 * 实测两者都**免登录**：评论 20 条、弹幕 1200 条，均 code=0。
 */

const mkReplyJson = (list) => ({ json: async () => ({ code: 0, data: { replies: list } }) })

await ok('★ fetchTopComments：解析 like + message，保序（接口本身按热度）', async () => {
  const fake = async () => mkReplyJson([
    { like: 771963, content: { message: '坏消息：被骗了 好消息：真好听' } },
    { like: 361573, content: { message: '虽然被钓，但这首其实很好听' } },
  ])
  const c = await fetchTopComments(80433022, { fetchImpl: fake, limit: 5 })
  assert.equal(c.length, 2)
  assert.equal(c[0].like, 771963)
  assert.match(c[0].text, /坏消息：被骗了/)
})

await ok('fetchTopComments：纯符号/纯表情评论跳过（没信息量）', async () => {
  const fake = async () => mkReplyJson([
    { like: 100, content: { message: '……' } },
    { like: 90, content: { message: '(=・ω・=)' } },
    { like: 80, content: { message: '真的好笑' } },
  ])
  const c = await fetchTopComments(1, { fetchImpl: fake })
  assert.equal(c.length, 1, '只留带字的')
  assert.match(c[0].text, /真的好笑/)
})

await ok('fetchTopComments：code!==0 / 异常 → 空数组（不抛）', async () => {
  assert.deepEqual(await fetchTopComments(1, { fetchImpl: async () => ({ json: async () => ({ code: -404 }) }) }), [])
  assert.deepEqual(await fetchTopComments(1, { fetchImpl: async () => { throw new Error('x') } }), [])
  assert.deepEqual(await fetchTopComments(0, {}), [], 'aid 非法直接空')
})

console.log('\n=== 弹幕（按出现次数取）===')
/*
 * 弹幕的价值在**重复** —— 同一个梗刷几十遍，那就是这视频的"共识"。
 * 按时间取前几条只是开头几秒的零星反应。
 */

const dmXml = (texts) => {
  const body = texts.map((t) => `<d p="0,1,25,16777215">${t}</d>`).join('')
  return { arrayBuffer: async () => Buffer.from(`<i>${body}</i>`, 'utf8') }
}

await ok('★ fetchDanmaku：按出现次数排序（重复的才是梗）', async () => {
  const fake = async () => dmXml([
    '你被骗了', '你被骗了', '你被骗了', '你被骗了',
    '草', '草',
    '恭喜破亿',
  ])
  const d = await fetchDanmaku(1, { fetchImpl: fake, limit: 5 })
  assert.equal(d[0].text, '你被骗了')
  assert.equal(d[0].count, 4, '第一次的频次要是 4')
  assert.equal(d[1].text, '草')
  assert.equal(d[1].count, 2)
  assert.equal(d[2].text, '恭喜破亿')
  assert.equal(d[2].count, 1)
})

await ok('fetchDanmaku：过滤纯符号 / 超长（长的大半是复制粘贴不是弹幕）', async () => {
  const fake = async () => dmXml([
    '……', '233', 'x'.repeat(50), '好家伙',
  ])
  const d = await fetchDanmaku(1, { fetchImpl: fake, limit: 10 })
  const texts = d.map((x) => x.text)
  assert.ok(!texts.includes('……'), '纯符号要滤')
  assert.ok(!texts.some((t) => t.length > 30), '超长要滤')
  assert.ok(texts.includes('好家伙'))
})

await ok('fetchDanmaku：异常 → 空数组（不抛）', async () => {
  assert.deepEqual(await fetchDanmaku(1, { fetchImpl: async () => { throw new Error('x') } }), [])
  assert.deepEqual(await fetchDanmaku(0, {}), [])
})

console.log('\n=== 拼装：评论 + 弹幕要出现在上下文里 ===')

ok('★ formatVideoContext 带上评论区（按赞）和弹幕（按次数）', () => {
  const t = formatVideoContext({
    ...base,
    comments: [{ like: 771963, text: '坏消息：被骗了 好消息：真好听' }],
    danmaku: [{ text: '你被骗了', count: 34 }, { text: '草', count: 12 }],
  })
  assert.match(t, /评论区怎么说/)
  assert.match(t, /77\.2 万/, '点赞要缩写')
  assert.match(t, /坏消息：被骗了/)
  assert.match(t, /弹幕在刷什么/)
  assert.match(t, /×34 你被骗了/, '弹幕要带次数')
})

ok('弹幕只出现 1 次的不算梗，不列', () => {
  const t = formatVideoContext({ ...base, danmaku: [{ text: '只刷过一次', count: 1 }] })
  assert.ok(!/弹幕在刷什么/.test(t), 'count<2 不该开这一段')
})

ok('★★ 必须明确要求「说点具体的」（否则模型只回「看到了」）', () => {
  /*
   * ⚠️ 实测踩过：这条信息**确实进了 system prompt**（8365 字里第 3573 字），
   * 但模型只回「换了个链接啊，这次本鱼没看出是哪个」—— **连标题都没用**。
   *
   * 根因是**优先级冲突**：输出要求写着「默认往短了说…别把知道的都倒出来」，
   * 模型把"有料"理解成"不用讲"。而真人收到视频分享是会说的。
   *
   * 所以必须**明确要求**，不能靠它自觉。
   */
  const t = formatVideoContext({ ...base, comments: [{ like: 1, text: '评论' }] })
  assert.match(t, /你得说点具体的/, '要明确要求说具体的')
  assert.match(t, /光「看到了」等于没看/, '要点破"只回看到了"是错的')
  assert.match(t, /一两句就够/, '要说明短也可以（不违反"往短了说"）')
  assert.match(t, /不用把上面全念一遍/, '别变成念清单')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
