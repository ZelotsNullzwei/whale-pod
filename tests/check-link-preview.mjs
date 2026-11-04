/**
 * A（链接预览）+ B（车牌识别）+ C（别乱搜）的测试。
 *
 * ## 三件事分别防什么
 * · **A**：非 B 站链接原来**根本不去看**（只有 B 站抓）。现在抓 og 标签。
 * · **B**：`JM123456` 这种代号原来要么被拿去搜索、要么完全没反应。
 * · **C**：搜索是要花钱的（一次约 ¥0.02），而**把 URL 或编号丢给搜索引擎
 *        从来搜不出内容** —— 只会返回一堆无关结果把模型带偏，
 *        还把用户发的编号白送给搜索引擎。
 *
 * ## 为什么解析要单独测
 * 抓取要联网（全量测试里 flaky 又慢），而**解析**才是最容易写错的地方：
 * `og:` 那几个 meta 的**属性顺序会反**（有些站 content 写在 property 前面），
 * 只认一种必然漏。所以 `parseLinkPreview` 单独导出，用 fixture HTML 测。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseLinkPreview, extractLink, formatLinkContext } from '../src/gateway/link-preview.js'
import { detectCode, formatCodeContext } from '../src/gateway/codes.js'
import { cleanAlbumFields, formatAlbumContext } from '../src/gateway/jm.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── A：从文本里挑链接 ────────────────────────────────────────
console.log('\n=== A. 挑链接 ===')

ok('★★ 分享卡片「【标题】URL」要能挑出 URL（不要标题）', () => {
  assert.equal(
    extractLink('【新地图瓦尔基里「围城」解读】https://www.xiaoheihe.cn/app/bbs/link/abc'),
    'https://www.xiaoheihe.cn/app/bbs/link/abc',
  )
})

ok('★ 中文标点紧跟后面时不能把标点吃进 URL', () => {
  assert.equal(extractLink('看看这个 https://example.com/a。'), 'https://example.com/a')
  assert.equal(extractLink('（https://example.com/b）'), 'https://example.com/b')
})

ok('★ 没有链接就返回 null（别乱抓）', () => {
  assert.equal(extractLink('今天天气不错'), null)
  assert.equal(extractLink(''), null)
})

ok('★ 图片/视频直链不当网页抓（那些走媒体那条路）', () => {
  assert.equal(extractLink('https://example.com/pic.jpg'), null)
  assert.equal(extractLink('https://example.com/v.mp4'), null)
})

// ── A：解析 og 标签（不联网）──────────────────────────────────
console.log('\n=== A. 解析 ===')

ok('★★★ og 标签：**属性顺序反过来也要认**', () => {
  // 有些站写成 content 在前 —— 只认一种写法的话这种就漏了
  const html = '<head><meta content="反过来写的标题" property="og:title">'
    + '<meta property="og:description" content="正常顺序的描述"></head>'
  const p = parseLinkPreview(html, 'https://x.com/')
  assert.equal(p.title, '反过来写的标题', 'content 在前的 og:title 必须认')
  assert.equal(p.description, '正常顺序的描述', 'property 在前的也要认')
})

ok('★ 没有 og 时退回 <title>', () => {
  const p = parseLinkPreview('<html><head><title>普通标题</title></head><body>x</body></html>', 'https://x.com/')
  assert.equal(p.title, '普通标题')
})

ok('★ HTML 实体要解码（不然标题里带 &amp; 那种）', () => {
  const html = '<meta property="og:title" content="A&amp;B &#8212; C">'
  assert.equal(parseLinkPreview(html, 'https://x.com/').title, 'A&B — C')
})

ok('★★ 没有 og 描述时，才退用正文摘要', () => {
  const html = '<html><head><title>标题</title></head>'
    + '<body><nav>导航</nav><p>这是正文的第一段话，应该被取到。</p></body></html>'
  const p = parseLinkPreview(html, 'https://x.com/')
  assert.ok(p.body.includes('这是正文的第一段'), '没有描述时要给正文兜底')
  assert.ok(!p.body.includes('<p>'), '标签要剥掉')
})

ok('★ 有描述时**不要**再塞正文（省上下文）', () => {
  const html = '<head><meta property="og:description" content="有描述"></head>'
    + '<body><p>很长的正文，不该出现</p></body>'
  const p = parseLinkPreview(html, 'https://x.com/')
  assert.equal(p.description, '有描述')
  assert.equal(p.body, '', '有描述就不该再取正文，否则挤掉别的上下文')
})

ok('★ script/style 里的内容不能被当正文', () => {
  const html = '<head><title>T</title></head><body><script>var secret=1</script><p>真正文</p></body>'
  const p = parseLinkPreview(html, 'https://x.com/')
  assert.ok(!p.body.includes('secret'), '脚本内容不能进正文')
  assert.ok(p.body.includes('真正文'))
})

// ── A：抓不到时的措辞 ────────────────────────────────────────
console.log('\n=== A. 抓不到时不许装懂 ===')

ok('★★★ 抓不到必须**明说打不开**，且禁止猜内容', () => {
  const note = formatLinkContext(null)
  assert.ok(/打不开/.test(note), '要让模型知道打不开')
  assert.ok(/不许猜|别猜/.test(note), '必须禁止它猜网页里讲了什么')
})

/*
 * ⚠️ 2026-11-03 改过措辞：原来是「（我打开看了）」，现在换成
 * 「（我读到了这些文字）」+ 一句「我点不动、进不去的参加不了」。
 *
 * 换的原因：老措辞虽然把"抓到了"标清楚了，但**顺带告诉模型"我是个会点网页的人"**
 * —— 群里于是出现「群友发联机房间链接 → 她回『来了来了，这就进』」。
 * 这条测试的**意图没变**（成功/失败两种注记必须能区分开、抓到了才给标题），
 * 所以断言改成新措辞、并加一条"不许再出现『我打开看了』"。
 */
ok('★ 抓到了才说"我读到了这些文字"（不再说"我打开看了"）', () => {
  const note = formatLinkContext({ title: '标题', description: '描述', siteName: '某站', body: '' })
  assert.ok(/读到了/.test(note), `要标清楚"抓到了"：${note}`)
  assert.ok(!/打开看了/.test(note), '不许再摆出"我会点网页"的姿态')
  assert.ok(note.includes('标题'))
  assert.ok(note.includes('描述'))
})

ok('★★ 抓到的那条也要说清"进不去、参加不了"', () => {
  const note = formatLinkContext({ title: '标题', description: '', siteName: '', body: '' })
  assert.ok(/点不动|进不去/.test(note), `要说清网页点不动：${note}`)
  assert.ok(/参加不了/.test(note), '要划清"要登录/扫码/进房间的场子参加不了"')
  assert.ok(/这就进/.test(note), '要点名那句错话（她真说过「来了来了，这就进」）')
})

// ── B：车牌识别 ──────────────────────────────────────────────
console.log('\n=== B. 车牌识别 ===')

ok('★★★ JM 编号要认出来（大小写/中间空格都认）', () => {
  for (const [t, id] of [
    ['JM123456', '123456'],
    ['jm123456', '123456'],
    ['JM 123456', '123456'],
    ['看看这个 jm1234 呗', '1234'],
  ]) {
    const c = detectCode(t)
    assert.ok(c, `${t} 应该被认出来`)
    assert.equal(c.id, id)
    assert.equal(c.kind, 'jm')
  }
})

ok('★★ 认出编号的注记必须留「看不到内容」+ 禁止猜', () => {
  /*
   * ⚠️ 断言跟着**措辞的演进**走，别锁死字面。
   *    老版本写的是「我看不到里面的内容」；2026-11-02 因为被绕过一次
   *    （她说了「扫了眼标题」，而标题并没拿到），改成了
   *    **「我这次什么都没拿到」** —— 更明确。
   *    所以这里断言的是**语义**（说了"没有/拿不到"），不是某一句原话。
   */
  const note = formatCodeContext(detectCode('JM123456'))
  assert.ok(/看不到|没拿到|没有/.test(note), '必须说明"我这边没有内容"')
  assert.ok(/看不到/.test(note) || /什么都没拿到/.test(note), '要有一句明确的"我手里是空的"')
  assert.ok(/不许猜/.test(note), '必须禁止它编内容')
  assert.ok(/禁漫/.test(note), '要说明这是什么编号')
})

ok('★★ 反向：不像车牌的**不能**误认', () => {
  for (const t of ['JM12', '今天JM了', '123456', 'room 123456', 'JM123456789012']) {
    assert.equal(detectCode(t), null, `${t} 不该被当车牌（前缀+位数都要卡住）`)
  }
})

// ── C：别乱搜（源码锁）────────────────────────────────────────
console.log('\n=== C. 别乱搜（源码锁）===')

ok('★★★ 搜索前必须有 skipSearch 闸，且四条都接上', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = src.indexOf('const skipSearch =')
  assert.ok(at > 0, '要有 skipSearch')
  const line = src.slice(at, src.indexOf('\n', at))
  for (const [what, re] of [
    ['页面已抓到（bili/link 上下文）', /Boolean\(biliContext\)/],
    ['页面已抓到（通用预览）', /Boolean\(linkContext\)/],
    ['消息里有链接', /hasAnyUrl/],
    ['认出车牌编号', /Boolean\(code\)/],
  ]) {
    assert.match(line, re, `skipSearch 要包含：${what}`)
  }
  // 真正的搜索判断必须用 skipSearch（别漏改回 !biliContext）
  assert.match(src, /this\.searchKey && !skipSearch/,
    '搜索分支必须用 !skipSearch —— 否则前面算的闸白算了')
})

ok('★★ 源码锁：链接预览超时必须给（不许让它拖慢回复）', () => {
  const src = fs.readFileSync(new URL('../src/gateway/link-preview.js', import.meta.url), 'utf8')
  assert.match(src, /timeoutMs\s*=\s*opts\.timeoutMs\s*\?\?\s*\d+/, '要有默认超时')
  const m = /timeoutMs\s*=\s*opts\.timeoutMs\s*\?\?\s*(\d+)/.exec(src)
  assert.ok(Number(m[1]) <= 5000, `默认超时 ${m[1]}ms 太长了 —— 回复会被拖住`)
})

ok('★ 源码锁：JS 站有渲染兜底（后台 + 24h 内存缓存）', () => {
  const lp = fs.readFileSync(new URL('../src/gateway/link-preview.js', import.meta.url), 'utf8')
  assert.match(lp, /export async function fetchLinkPreviewRendered/, '要有渲染兜底函数')
  const br = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(br, /fetchLinkPreviewRendered/, 'bridge 要接上它')
  assert.match(br, /_scheduleLinkRender\(/, '快路失败要排后台渲染')
  assert.match(br, /24 \* 3600 \* 1000/, '缓存最多 24 小时（用户要求）')
})

ok('★★ 源码锁：车牌模块刻意**不生成站点 URL**（不擅自去连成人站）', () => {
  const src = fs.readFileSync(new URL('../src/gateway/codes.js', import.meta.url), 'utf8')
  // 注释里说明"为什么不生成 URL"是可以的，但不能真的拼出 http(s) 链接
  const codeOnly = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  assert.ok(!/https?:\/\//.test(codeOnly),
    'codes.js 的**代码**里不该出现站点 URL —— 一旦有，link-preview 就会真去连')
})

// ── B2：禁漫抓回来的字段要清洗 ────────────────────────────────
console.log('\n=== B2. 车牌抓回来的字段 ===')

ok('★★★ 站点标语不能当作品简介（否则每部作品都是同一句废话）', () => {
  // 实测：随便抓一部，og:description 都是这同一句
  for (const slogan of ['免費成人H漫線上看', '免费成人H漫画在线看', '免費成人H漫線上看。']) {
    const r = cleanAlbumFields({ title: '某作品', description: slogan })
    assert.equal(r.description, '',
      `站点标语「${slogan}」要丢掉 —— 留着的话每部作品的"简介"都一样，`
      + '模型反而以为"这部讲的就是这个"')
  }
  // 真的简介要留着
  const keep = cleanAlbumFields({ title: '某作品', description: '一个关于勇者的故事' })
  assert.equal(keep.description, '一个关于勇者的故事', '真简介必须保留')
})

ok('★★ 标题尾巴上的站名要剥掉', () => {
  /*
   * ⚠️ 这里第一版写成了 `for (const [raw, want] of [...])` ——
   *    **解构二元组**的写法，但数组里放的是**纯字符串**。
   *    对字符串解构拿到的是**第一个字符**，于是 `raw` = `'['`，
   *    标题变成 `[` → "没有站名"过了、"有作品名"不过，
   *    报出来像代码坏了。**测试自己的错，别去改代码。**
   */
  for (const raw of [
    '[汉化组][作者] 作品名 - 禁漫天堂',
    '[汉化组][作者] 作品名 | 18comic',
    '[汉化组][作者] 作品名 – JMComic',
  ]) {
    const r = cleanAlbumFields({ title: raw })
    assert.ok(!/禁漫天堂|18comic|JMComic/i.test(r.title), `站名要剥掉：${r.title}`)
    assert.ok(r.title.includes('作品名'), `作品名本身不能弄丢：${JSON.stringify(r.title)}`)
  }
})

ok('★ 标题里正常的「-」不能被当站名剥掉', () => {
  const r = cleanAlbumFields({ title: '前篇 - 后篇' })
  assert.equal(r.title, '前篇 - 后篇', '不是站名的分隔符要留着')
})

ok('★ 清洗函数不能炸（字段缺失 / 空值）', () => {
  assert.deepEqual(cleanAlbumFields(), { title: '', description: '' })
  assert.deepEqual(cleanAlbumFields({}), { title: '', description: '' })
  assert.deepEqual(cleanAlbumFields({ title: '  x  ' }).title, 'x')
})

ok('★★★ 阅读器页的**两层**尾巴都要剥（原来只剥一层）', () => {
  /*
   * 实测两页的标题尾巴形态不同：
   *   作品页：  … [翻譯] - 禁漫天堂
   *   阅读器页：… [翻譯]|H漫內頁瀏覽 Comics - 禁漫天堂      ← ★ 多一层
   * 只剥一层的话会剩 `|H漫內頁瀏覽 Comics` 挂在那儿（实测就是这么漏的）。
   */
  const reader = '[汉化组][作者] 作品名 (原作) [翻译]|H漫內頁瀏覽 Comics - 禁漫天堂'
  const r = cleanAlbumFields({ title: reader })
  assert.ok(!/禁漫天堂|18comic|Comics|內頁瀏覽/i.test(r.title), `两层都要剥：${r.title}`)
  assert.ok(r.title.endsWith('[翻译]'), `尾巴要剥到作品信息为止：${r.title}`)
})

ok('★★★ 认出编号的注记必须**点名堵死**「我扫了眼标题」这种虚报', () => {
  /*
   * 实测被绕过一次（2026-11-02，群里追问「看完没」）：
   * ```
   * 她：「没看完，**就扫了眼标题**。本鱼说一眼就是一眼，没骗你。」
   * 而标题根本没抓到（所有域名都失败了）。
   * ```
   * ⚠️ 老措辞「我看不到**里面的内容**」拦不住它 —— 那句只否定了内页，
   *    **没否定标题**，于是"扫了眼标题"在它看来不算撒谎。
   * 所以必须：① 逐项说清"标题也没有" ② 把这种说法**点名**禁掉。
   */
  const note = formatCodeContext(detectCode('JM350234'))
  assert.ok(/标题没|标题我也没拿到/.test(note), '★ 要明说**标题也没拿到**（老版本只说"看不到内容"）')
  assert.ok(/扫了眼标题|瞅了一眼/.test(note), '★ 要把"扫了眼标题"这种说法**点名**堵死')
  assert.ok(/什么都没拿到/.test(note), '要说清手里是空的')
  assert.ok(/不许猜/.test(note), '仍然要禁止猜内容')
})

ok('★★ 抓回来的注记要留「没看内页画面」这句', () => {
  const note = formatAlbumContext({ id: '123456', title: '某作品', description: '' })
  assert.ok(/没有看内页画面|没看内页/.test(note),
    '只有标题和简介，必须说清"没看画面" —— 否则它会编画面里有什么')
  assert.ok(note.includes('某作品'))
})

ok('★ 域名缓存是**落盘**的（重启后不用重新趟死域名）', () => {
  const src = fs.readFileSync(new URL('../src/gateway/jm.js', import.meta.url), 'utf8')
  assert.match(src, /writeFileSync\(this\.file/, '学到域名要写盘')
  assert.match(src, /readFileSync\(this\.file/, '启动要读回来')
  // 且 bridge 那边确实把数据目录传进去了
  const bridge = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(bridge, /new JmHostCache\(this\.cfg\.home/, '_jmHosts 要用 cfg.home')
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(idx, /home: args\.home/, 'index.js 要把 home 传进 bridge 的 cfg')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)