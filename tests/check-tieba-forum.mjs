/**
 * 订阅贴吧（2026-11-01）。
 *
 * ## 起因
 * 用户：「加贴吧不能实现吗，比如说我想加**明日方舟吧**或者其他游戏的」。
 *
 * ## 找端点的过程（记下来省得下次再试一遍）
 * ```
 * f?kw=明日方舟          → 403   （PC UA / 移动 UA / 带 cookie 全都是）
 * f/lite?kw=明日方舟      → 200 但只有 2.5KB（空壳，没内容）
 * mo/q/m?kw=明日方舟      → 403
 * mo/q/sync              → 200 但 {"error":"user not login"}
 * mo/q/mindex?kw=明日方舟 → 200  386KB  ← ★ 只有这个通
 * ```
 * ⚠️ 我一开始只试了 PC 端的 `f?kw=`，看到 403 就下结论"百度堵死了"——
 * **一个端点 403 不等于做不到**，只说明这个端点被拦了。
 *
 * ## 三条要锁住的规矩
 * 1. **必须用移动 UA** —— 同一个 `mo/q/mindex`，PC UA 403、移动 UA 200
 * 2. **昵称类噪声要滤** —— 直接按 `"title"` 抓会捞到「活跃吧主」这种用户头衔
 * 3. **限频是硬要求** —— 一条 386KB + 反爬；抓狠了被封，整个功能就废了
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseForumPage, fetchForum, HotTopicStore, filterTopics, forumKeywords } from '../src/qq/hot-topics.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}

/** 造一段像真页面的 HTML（HTML 路 + JSON 路 + 噪声）。 */
const SAMPLE = `
<li class="tl_shadow" data-tid="11156068106">
  <a href="/p/11156068106?lp=5028"><div class="ti_title">
    <span class="ti_title_icon ti_icon_zhiding">置顶</span>
    <span>给吧友们的一封道歉信以及对一些吧友关切问题的答复</span></div></a></li>
<li class="tl_shadow" data-tid="11156068107">
  <a href="/p/11156068107?lp=5028"><div class="ti_title"><span>塔露拉&amp;冻河 博士们都抽了多少发啊！</span></div></a></li>
<div data-x='{"title":"塔露拉弱这事，经典20%的人发出80％声音","reply_num":219}'>
<div data-x='{"title":"活跃吧主","reply_num":0}'>
<div data-x='{"title":"就抽到一个陪跑","reply_num":48}'>
`

console.log('=== ① 解析（HTML 路 + JSON 路 + 噪声过滤）===')

ok('★ 两条路都能抠出帖子标题', () => {
  const items = parseForumPage(SAMPLE)
  const titles = items.map((i) => i.title)
  assert.ok(titles.some((t) => t.includes('给吧友们的一封道歉信')), 'HTML 路要能抠到')
  assert.ok(titles.some((t) => t.includes('经典20%的人'), 'JSON 路要能抠到'))
  assert.ok(items.length >= 4, `至少 4 条，实际 ${items.length}`)
})

ok('★ 内嵌标签要剥掉（`<span class="ti_title_icon">置顶</span>`）', () => {
  const items = parseForumPage(SAMPLE)
  for (const it of items) {
    assert.ok(!/<[a-z]/i.test(it.title), `标题里不该有标签：${it.title}`)
    assert.ok(!it.title.includes('置顶'), '角标「置顶」不该进标题')
  }
})

ok('★ HTML 实体要解码（`&amp;` → `&`）', () => {
  /*
   * 实测踩过：标题出来是 `塔露拉&amp;冻河` —— 从 HTML 属性里带出来的。
   * 虽然不影响读，但发出去就是错的。
   */
  const items = parseForumPage(SAMPLE)
  const t = items.find((i) => i.title.includes('冻河'))
  assert.ok(t, '要能找到那条')
  assert.ok(t.title.includes('&'), '实体要解码成 &')
  assert.ok(!t.title.includes('&amp;'), '不能留 &amp; 原文')
})

ok('★ 昵称类噪声要滤掉（`活跃吧主` 是用户头衔不是帖子）', () => {
  const items = parseForumPage(SAMPLE)
  assert.ok(!items.some((i) => i.title === '活跃吧主'), '「活跃吧主」必须被滤')
})

ok('回复数要能带出来（HTML 路没有，JSON 路有）', () => {
  const items = parseForumPage(SAMPLE)
  const t = items.find((i) => i.title.includes('经典20%'))
  assert.equal(t.reply, 219, 'JSON 路的 reply_num 要带上')
})

ok('按回复数降序（有讨论的排前面）', () => {
  const items = parseForumPage(SAMPLE)
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1].reply >= items[i].reply, `第 ${i} 条没按回复数排`)
  }
})

ok('有 tid 的要给出帖子链接', () => {
  const items = parseForumPage(SAMPLE)
  const t = items.find((i) => i.title.includes('给吧友们'))
  assert.match(t.url, /tieba\.baidu\.com\/p\/11156068106/)
})

ok('空输入 / 垃圾输入 → 空数组（不抛）', () => {
  assert.deepEqual(parseForumPage(''), [])
  assert.deepEqual(parseForumPage('随便一段没有帖子的文本'), [])
  assert.deepEqual(parseForumPage(null), [])
})

console.log('\n=== ② 抓取 ===')

ok('★ 必须用**移动 UA**（PC UA 会 403）', () => {
  /*
   * 这是这个功能能不能用的**前提**。实测：同一个 `mo/q/mindex` 端点，
   * PC UA 返回 403、移动 UA 才 200。贴吧对 `/mo/` 路径会校验客户端类型。
   */
  const src = fs.readFileSync(new URL('../src/qq/hot-topics.js', import.meta.url), 'utf8')
  assert.match(src, /const MOBILE_UA = 'Mozilla\/5\.0 \(Linux; Android/, '要有移动 UA 常量')
  const at = src.indexOf('export async function fetchForum')
  const seg = src.slice(at, at + 1200)
  assert.match(seg, /'User-Agent': MOBILE_UA/, '★ fetchForum 必须用 MOBILE_UA，不能用 PC UA')
  assert.match(seg, /mo\/q\/mindex\?kw=/, '要用 mo/q/mindex 端点')
})

ok('★ 吧名带「吧」字也要容错（用户会写成"明日方舟吧"）', async () => {
  const fake = async (url) => ({ ok: true, text: async () => SAMPLE })
  const r = await fetchForum('明日方舟吧', { fetchImpl: fake })
  assert.equal(r.name, '明日方舟', '「明日方舟吧」要归一化成「明日方舟」')
  assert.ok(r.items.length > 0)
})

ok('HTTP 非 200 → ok:false 且带错误（不抛）', async () => {
  const fake = async () => ({ ok: false, status: 403, text: async () => '' })
  const r = await fetchForum('显卡', { fetchImpl: fake })
  assert.equal(r.ok, false)
  assert.match(r.error, /403/)
})

ok('网络异常 → ok:false（不抛）', async () => {
  const fake = async () => { throw new Error('boom') }
  const r = await fetchForum('显卡', { fetchImpl: fake })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
})

ok('空吧名 → 直接失败，不发请求', async () => {
  let called = false
  const fake = async () => { called = true; return { ok: true, text: async () => SAMPLE } }
  const r = await fetchForum('   ', { fetchImpl: fake })
  assert.equal(r.ok, false)
  assert.equal(called, false, '空吧名不该发请求')
})

console.log('\n=== ③ 存储（订阅吧独立一个文件）===')

ok('★ 订阅吧要存到 `tieba-forums.json`（不能和热议共用）', () => {
  /*
   * 两者刷新节奏差一个数量级（热议 30 分钟，订阅吧 1 小时/吧），
   * 而且订阅吧是**按吧独立计时**的。混在一起会互相拖累。
   */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-forum-'))
  const s = new HotTopicStore({ home })
  s.saveForum('明日方舟', [{ title: '测试帖一条', url: 'https://x', reply: 5 }])
  assert.ok(fs.existsSync(path.join(home, 'tieba-forums.json')), '要落在 tieba-forums.json')
  assert.ok(!fs.existsSync(path.join(home, 'hot-topics.json')), '不该写进热议那个文件')
})

ok('★ 限频：刚抓过的吧算"新鲜"，不该再抓', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-forum-'))
  const s = new HotTopicStore({ home })
  assert.equal(s.forumFresh('明日方舟'), false, '没抓过 → 不新鲜')
  s.saveForum('明日方舟', [{ title: 'x', url: '', reply: 1 }])
  assert.equal(s.forumFresh('明日方舟'), true, '刚抓过 → 新鲜（1 小时内不再抓）')
  assert.equal(s.forumFresh('原神'), false, '★ 按吧独立计时，别的吧不受影响')
})

ok('限频窗口可调（传 maxAgeMs=0 就立刻过期）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-forum-'))
  const s = new HotTopicStore({ home })
  s.saveForum('显卡', [{ title: 'x', url: '', reply: 1 }])
  assert.equal(s.forumFresh('显卡', 0), false, '窗口 0 → 立刻算过期')
})

ok('重启后还在（落盘 + 读回）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-forum-'))
  const a = new HotTopicStore({ home })
  a.saveForum('明日方舟', [{ title: '落盘测试', url: '', reply: 3 }])
  const b = new HotTopicStore({ home })
  assert.equal(b.forumFresh('明日方舟'), true, '重启后新鲜度还在')
  assert.equal(b.forumItems(['明日方舟']).length, 1)
  assert.equal(b.forumItems(['明日方舟'])[0].title, '落盘测试')
})

ok('★ forumItems 每个条目带 `from`（标出是哪个吧）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-forum-'))
  const s = new HotTopicStore({ home })
  s.saveForum('明日方舟', [{ title: 'A', url: '', reply: 1 }])
  s.saveForum('原神', [{ title: 'B', url: '', reply: 1 }])
  const items = s.forumItems(['明日方舟', '原神'])
  assert.equal(items.length, 2)
  assert.ok(items.every((i) => i.from), '每条都要有 from')
  assert.ok(items.some((i) => i.from === '贴吧·明日方舟吧'), 'from 要能看出来源吧')
})

ok('每个吧取几条可限（别一次塞太多）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-forum-'))
  const s = new HotTopicStore({ home })
  s.saveForum('明日方舟', Array.from({ length: 20 }, (_, i) => ({ title: `帖${i}`, url: '', reply: i })))
  assert.equal(s.forumItems(['明日方舟'], 5).length, 5, 'perForum=5 就最多 5 条')
})

ok('没抓过的吧 → 空数组（不抛）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-forum-'))
  const s = new HotTopicStore({ home })
  assert.deepEqual(s.forumItems(['从没抓过']), [])
  assert.deepEqual(s.forumItems([]), [])
  assert.deepEqual(s.forumItems(null), [])
})

console.log('\n=== ④ 黑名单仍然生效（订阅的吧也不能例外）===')

ok('★ 吧里也会有地域/时政帖，一起走同一套黑名单', () => {
  /*
   * "自己订的吧"不等于"什么都能进" —— 吧里一样有地域争论、时政搬运。
   */
  const items = [
    { title: '塔露拉强度这事怎么说', url: '', reply: 219 },
    { title: '某地震最新消息', url: '', reply: 500 },
    { title: '台湾问题最新进展', url: '', reply: 300 },
  ]
  const kept = filterTopics(items).map((i) => i.title)
  assert.ok(kept.some((t) => t.includes('塔露拉')), '正常帖要留')
  assert.ok(!kept.some((t) => t.includes('地震')), '灾难要挡')
  assert.ok(!kept.some((t) => t.includes('台湾')), '地域敏感要挡')
})

console.log('\n=== ⑤ 接线检查（源码锁）===')

ok('★ 订阅吧要**独立检查**（不能被热议的早退挡住）', () => {
  /*
   * `_ensureHotTopics` 里热议那段会早退（fresh 没过期就 return）。
   * 订阅吧如果塞在里面，热议新鲜时它就**永远不抓**。
   */
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = src.indexOf('async _ensureHotTopics(')
  const seg = src.slice(at, at + 1400)
  assert.match(seg, /this\._ensureForumTopics\(\)/, '★ 订阅吧要单独起一个 job')
  assert.match(seg, /forumJob/, '要能等它（wait 时一起 await）')
})

ok('★ 一轮只抓一个吧（限频 + 别拖太久）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = src.indexOf('async _ensureForumTopics(')
  const seg = src.slice(at, at + 1600)
  assert.match(seg, /break\s+\/\/\s*★\s*一轮只抓一个/, '要有「抓一个就 break」')
  assert.match(seg, /forumFresh\(name\)/, '要先查新鲜度')
})

ok('★ 订阅吧在提示词里**单独一段**（不被 interest 筛掉）', () => {
  /*
   * `hotHint` 是按 interest 筛过的全站热议；
   * 订阅吧是用户**自己指定**的垂直源，再筛一遍等于把他的选择又 judge 了一次。
   *
   * ⚠️ 2026-11-01 改：这里原来是 `forumItems`（给**热帖列表**），
   * 后来按用户判断改成了 `forumTopics`（给**词频**）——
   * 用户原话：「**热帖感觉没啥用**」。热帖排的是累积回复数，
   * `[7894回复] 【记录帖】入坑五个月…` 可能是几周前的，却永远排在最上面。
   */
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /const forumTopics = this\.hotTopics\?\.forumTopics\?\./, '要单独取订阅吧（词频）')
  assert.match(src, /你订阅的吧最近在聊什么/, '要有独立小节标题')
  const at = src.indexOf('const hintWithHot =')
  assert.match(src.slice(at, at + 200), /forumHint/, '★ 要拼进提示词')
})

ok('★ 不能在提示词里给"热帖列表"（用户明确说没用）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.ok(
    !/forumList\.map\(\(x\) => `· \[\$\{x\.from\}\]/.test(src),
    '热帖那种「[贴吧·X吧] 标题（N 回复）」的渲染已经撤掉了',
  )
})

ok('配置默认值是空数组（不订就不抓）', () => {
  const src = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8')
  assert.match(src, /tiebaForums: \[\]/, '默认空数组')
})

console.log('\n=== ⑥ 词频提炼「这个吧在聊什么」（2026-11-01）===')

ok('★ 反复出现的名字要浮上来', () => {
  const items = [
    { title: '塔露拉弱这事，经典20%的人发出80％声音' },
    { title: '克莱门莎和塔露拉哪个强？' },
    { title: '所以为什么塔露拉不可以弱' },
    { title: '今天天气不错' },
  ]
  const kws = forumKeywords(items, { limit: 5 })
  assert.ok(kws.includes('塔露拉'), `塔露拉要上榜，实际 ${kws.join('/')}`)
})

ok('★ 跨词边界的碎片要挡住（`的人` / `捂嘴` / `说话`）', () => {
  /*
   * ⚠️ n-gram 不知道词边界：
   * `"前几天嘴硬说塔露拉很强在吧里捂嘴的人呢？说话！"`
   * 会切出 `捂嘴的` / `的人` / `说话` —— 它们和真名字**一样长**，
   * 实测占满了 top5，整个词条就废了。
   *
   * 判据是**上下文多样性**：真名字出现在各种上下文里，
   * 碎片只在它原来那一句里（邻居固定）。
   */
  const items = [
    { title: '前几天嘴硬说塔露拉很强在吧里捂嘴的人呢？说话！' },
    { title: '塔露拉弱这事，经典20%的人发出80％声音' },
    { title: '所以为什么塔露拉不可以弱' },
  ]
  const kws = forumKeywords(items, { limit: 8 })
  for (const bad of ['的人', '捂嘴', '捂嘴的', '说话']) {
    assert.ok(!kws.includes(bad), `碎片「${bad}」不该上榜，实际 ${kws.join('/')}`)
  }
})

ok('★ 同一标题只计一次（同句里重复出现不该翻倍）', () => {
  const once = forumKeywords([{ title: '塔露拉塔露拉塔露拉' }], { minCount: 1 })
  const twice = forumKeywords([{ title: '塔露拉塔露拉塔露拉' }], { minCount: 2 })
  // 一条标题里出现 3 次，但只算"1 条"，所以 minCount=2 时就该被滤掉
  assert.ok(once.length >= 0, '不抛就行')
  assert.deepEqual(twice, [], '一条标题内的重复不该让它达到 minCount=2')
})

ok('空输入 / 极端输入都不抛', () => {
  assert.deepEqual(forumKeywords([]), [])
  assert.deepEqual(forumKeywords(null), [])
  assert.deepEqual(forumKeywords([{ title: '！！！？？？' }, { title: '。。。' }]), [])
  assert.deepEqual(forumKeywords([{ title: '好' }]), [], '太短的不算')
})

ok('★ `parseForumPage` 按**标题**去重（HTML 路和 JSON 路是同一批帖子）', () => {
  /*
   * ⚠️⭐ 这是"词频调不出来"的真正根因：
   * HTML 路有 tid、JSON 路没有，原来 `key = tid || t` 导致
   * **同一条帖子在两路各存一份** —— 58 条里一半是重复的。
   * 重复会让词频权重翻倍，也让"上下文多样性"判据失效。
   */
  const html = `
    <li class="tl_shadow" data-tid="111"><a href="/p/111?x"><div class="ti_title"><span>塔露拉弱这事</span></div></a></li>
    <div data-x='{"title":"塔露拉弱这事","reply_num":9}'>
  `
  const items = parseForumPage(html)
  const same = items.filter((x) => x.title === '塔露拉弱这事')
  assert.equal(same.length, 1, `同一条帖子只能留一份，实际 ${same.length} 份`)
  assert.match(same[0].url, /\/p\/111/, '★ 去重后要保住 HTML 路给的帖子链接')
})

ok('★ `forumTopics` 按吧聚合（一个词都提不出来就不写那一行）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fk-'))
  const s = new HotTopicStore({ home })
  s.saveForum('明日方舟', [
    { title: '塔露拉弱这事' }, { title: '塔露拉强不强' }, { title: '塔露拉到底行不行' },
  ])
  s.saveForum('没内容的吧', [{ title: '啊' }])
  const t = s.forumTopics(['明日方舟', '没内容的吧', '从没抓过的吧'])
  assert.equal(t.length, 1, '只有内容够的那个吧该出现')
  assert.equal(t[0].forum, '明日方舟')
  assert.ok(t[0].keywords.includes('塔露拉'))
  assert.equal(t[0].count, 3, '要带上条数')
})

ok('带「吧」字的吧名在 forumTopics 里也容错', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fk-'))
  const s = new HotTopicStore({ home })
  s.saveForum('显卡', [{ title: '显卡涨价了' }, { title: '显卡又涨价了' }, { title: '显卡什么时候降价' }])
  assert.equal(s.forumTopics(['显卡吧']).length, 1, '「显卡吧」要能对上存进去的「显卡」')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)