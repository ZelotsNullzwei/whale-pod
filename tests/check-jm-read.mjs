/**
 * 「用真浏览器看内页，看完就扔」（gateway/jm-read.js）。
 *
 * ## 这东西为什么存在
 * 用户：「内容得去看吧，不然没意义」+「只单独页面抓取看呢，看完就扔，用 ego」
 *
 * ## ★★ 整个方案里最容易做错的一步：截**视口**，不是抓 img.src
 * ```
 * 抓 img.src          → 拿到的是**被打乱的原始图**（scramble_id=220980 那种），
 *                       喂给模型看到一堆错位的横条 ✗
 * 截视口（人看到的）   → 站点自己的 JS 已经还原好了，所见即所见 ✓
 * ```
 * 而且不用管它到底是用 canvas 拼的还是换 data URL —— **人看见什么就截什么**。
 * 这条**必须锁住**：`img.src` 那条路看起来更"直接"，很容易被后人改成那样。
 *
 * ## 其余要守的
 * · **封顶**：最多几屏（唯一真花钱的地方），不滚完整章（要两分钟）
 * · **明说没看到的**：只看了开头几屏，就别把开头当全文
 * · **看完就扔**：临时 profile 删掉（在 browser.js 里）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { formatAlbumPagesNote, DEFAULT_MAX_SHOTS } from '../src/gateway/jm-read.js'

const SRC = fs.readFileSync(new URL('../src/gateway/jm-read.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── 看过了：说法要准确 ────────────────────────────────────────
console.log('\n=== 看过之后怎么说 ===')

ok('★★ 截断了就必须说"只看了开头 N 屏、后面没看"', () => {
  const note = formatAlbumPagesNote({
    ok: true, title: '某作品', shots: ['a', 'b', 'c'], totalHeight: 90000, truncated: true,
  })
  assert.ok(/只看了/.test(note), '要说清"只看了"')
  assert.ok(/后面没看/.test(note), '★ 必须点明后面没看 —— 否则它会把开头当全文')
  assert.ok(note.includes('某作品'))
})

ok('★ 没截断（滚到底了）时不能说"后面没看"', () => {
  const note = formatAlbumPagesNote({
    ok: true, title: '某作品', shots: ['a', 'b'], totalHeight: 2000, truncated: false,
  })
  assert.ok(!/后面没看/.test(note), '滚到底了就不该说"后面没看"')
  assert.ok(/基本是整章/.test(note))
})

ok('★★★ 必须禁止它编没看到的内容', () => {
  const note = formatAlbumPagesNote({ ok: true, title: 'x', shots: ['a'], truncated: true })
  assert.ok(/别编|不许编/.test(note), '★ 没看到的不许编 —— 这条历史上真的发生过')
})

// ── 没看到：必须明说 ──────────────────────────────────────────
console.log('\n=== 没看到的时候 ===')

ok('★★★ 没浏览器时必须明说，并禁止猜', () => {
  const note = formatAlbumPagesNote({ ok: false, why: 'no-browser' })
  assert.ok(/打不开/.test(note), '要说"打不开"')
  assert.ok(/Edge|Chrome/.test(note), '★ 要说清**缺什么**（用户提的规矩：依赖要写明）')
  assert.ok(/不许猜/.test(note))
})

ok('★★ 措辞不能拼出病句（第一版就拼错了）', () => {
  /*
   * 第一版是 `这部作品的${why}` —— 结果出来是
   * 「这部作品的**我这边没装能用的浏览器**」，主谓打架。
   * 这里直接断言**没有那个拼接痕迹**。
   */
  for (const why of ['no-browser', 'challenge', 'error']) {
    const note = formatAlbumPagesNote({ ok: false, why })
    assert.ok(!/这部作品的[我那内]/.test(note), `拼出病句了：${note.slice(0, 60)}`)
  }
})

ok('★ 挑战页要说人机验证，不能笼统说"打不开"', () => {
  const note = formatAlbumPagesNote({ ok: false, why: 'challenge' })
  assert.ok(/人机验证|验证页/.test(note), '要区分"被验证拦了"和"没浏览器"')
})

ok('★★★ 每种失败都要说清"是哪一种"（不能全糊成一句"打不开"）', () => {
  /*
   * 实测教训（2026-11-02，群里那个 jm350234）：
   * 她老实说了「这号本鱼打不开」—— **没编，这点是对的**；
   * 但对用户**没用**：收到的是"她做不到"，而不是"**为什么**做不到"。
   * 而这几种原因**指向完全不同的下一步**：
   *   · missing（站上说这号没有）      → 让用户核对编号
   *   · no-chapter-link（页里没入口）  → 多半是这个**镜像**没这部作品
   *   · no-browser                     → 让他装浏览器
   *   · challenge                      → 人机验证拦了
   * 糊成一句的话，用户根本不知道该往哪查。
   */
  const seen = new Set()
  for (const why of ['missing', 'no-chapter-link', 'no-browser', 'challenge', 'album-not-loaded', 'reader-not-loaded']) {
    const note = formatAlbumPagesNote({ ok: false, why })
    assert.ok(/打不开|核对|没有/.test(note), `${why} 要给出说明`)
    assert.ok(/不许猜/.test(note), `${why} 也要禁止编内容`)
    seen.add(note)
  }
  assert.equal(seen.size, 6, `6 种原因要给 6 种说法（实际 ${seen.size} 种）—— 别糊成一句`)

  // 最关键的那条单独点出来（实测里出现的就它）
  assert.match(formatAlbumPagesNote({ ok: false, why: 'no-chapter-link' }), /阅读入口|镜像/,
    'no-chapter-link 要说"页里没有阅读入口/镜像上没有" —— 实测两次都是它')
})

ok('★★★ 失败时的注记要**点名堵死**「我扫了眼标题」这种虚报', () => {
  /*
   * 实测被绕过一次（2026-11-02）：群里追问「看完没」，她回
   * ```
   * 「没看完，**就扫了眼标题**。本鱼说一眼就是一眼，没骗你。」
   * ```
   * 而标题根本没抓到。老措辞只说"打不开、不许猜内容"——
   * **"扫了眼标题"在语义上不算"猜内容"**，于是绕过去了。
   * 编造里最阴的不是"编内容"，是**虚报"我看过"**（读起来毫无破绽）。
   */
  /*
   * ⚠️ 断言**认语义，别把措辞抠死** —— 这个测试我改了三回，
   *    每回都是"正则跟自己的新措辞对不上"，红了一条看着像代码坏了的。
   *    所以这里只查**关键意思在不在**（"手里是空的""标题也没""扫了眼标题被禁"）。
   */
  const note = formatAlbumPagesNote({ ok: false, why: 'no-chapter-link' })
  assert.ok(/什么都没拿到|什么都没有/.test(note), '要说清手里是空的')
  assert.ok(/没拿到标题|标题也没|标题我也没/.test(note), '★ 要明说标题也没拿到')
  assert.ok(/扫了眼标题|瞅了一眼/.test(note), '★ 要**点名**禁掉"扫了眼标题"这种说法')
  assert.ok(/不许猜/.test(note))
})

ok('★ null / undefined 也不能炸', () => {
  for (const bad of [null, undefined, {}, { ok: false }]) {
    const note = formatAlbumPagesNote(bad)
    assert.ok(typeof note === 'string' && note.length > 0, '要给出可用的注记')
  }
})

// ── 源码锁 ────────────────────────────────────────────────────
console.log('\n=== 源码锁 ===')

ok('★★★ 必须截**视口**，不许抓 img.src（那条拿到的是打乱的原图）', () => {
  /*
   * 这是整个方案的要害。抓 img.src 看起来更直接，
   * 但那个 src 是 **scramble 过的原始图** —— 喂给模型是一堆错位的条。
   */
  assert.match(SRC, /screenshotViewport\(/, '要用「按视口截图」')
  const noComment = SRC.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  assert.ok(!/\.src\b\s*(=|\)|,)|getAttribute\(['"]src|naturalWidth/.test(noComment),
    '★ 代码里不许去抓 img.src / naturalWidth —— 那拿到的可能是打乱的原图')
})

ok('★ 必须有封顶（唯一真花钱的地方）', () => {
  assert.match(SRC, /maxShots/, '要有"最多几屏"')
  assert.ok(DEFAULT_MAX_SHOTS <= 10, `默认 ${DEFAULT_MAX_SHOTS} 屏太多了 —— 每屏都是一张图进模型`)
  const noComment = SRC.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  assert.match(noComment, /i < maxShots/, '循环要有上限')
})

ok('★★ 章节链接要从**作品页**取，不能拿作品编号直接当章节编号', () => {
  /*
   * 实测那次两者碰巧一样（都是 123456），但那是巧合 ——
   * 一部作品有多个章节，编号没有必然关系。
   */
  assert.match(SRC, /querySelector\('a\[href\*="\/photo\/"\]'\)/, '要从作品页里取章节链接')
  const noComment = SRC.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n')
  assert.ok(!/\/photo\/\$\{id\}/.test(noComment), '★ 不许直接拼 /photo/<作品编号>')
})

ok('★★ 必须认挑战页，并且明说（不能装作看到了）', () => {
  assert.match(SRC, /_cf_chl_opt/, '要认 Cloudflare 挑战页')
  assert.match(SRC, /challenge/, '要把它当失败返回')
})

ok('★★ 没有浏览器时要**明说**，不能静默失败', () => {
  assert.match(SRC, /findBrowser\(\)/, '要检测有无浏览器')
  assert.match(SRC, /'no-browser'/, '要给出这个原因码（界面/注记据此说明缺什么）')
})

ok('★ 「看完就扔」：收尾必须关页 + 关浏览器', () => {
  assert.match(SRC, /finally\s*\{/, '收尾要放 finally（出错也要收）')
  assert.match(SRC, /closePage\(bot\.cdp/, '要关标签页')
  assert.match(SRC, /bot\.close\(\)/, '要关浏览器（它内部会删临时 profile）')
})

// ── 接线（bridge）──────────────────────────────────────────────
 /*
  * ★★ 26 秒的活**绝不能卡在回复里**。跟长视频同一个模式：
  *     `_generate` 里 `void` 派出去 → 回复照常发 → `_handle` 发完接上收尾。
  */
const BRIDGE = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

ok('★★★ 看内页必须走后台（不许 await 在回复里）', () => {
  const at = BRIDGE.indexOf('this._jmJobs.set(')
  assert.ok(at > 0, '要有 _jmJobs 登记')
  const seg = BRIDGE.slice(Math.max(0, at - 600), at + 200)
  assert.ok(!/await readJmPages/.test(seg), '★ 不许 await —— 26 秒会把回复卡死')
  assert.match(seg, /promise:\s*readJmPages\(/, '要把 promise 挂到任务上，让 _handle 去收')
})

ok('★★★ `_handle` 发完要接上收尾（照长视频那样 void）', () => {
  const at = BRIDGE.indexOf('const jmjob = this._jmJobs?.get(')
  assert.ok(at > 0, '要在 _handle 里取任务')
  const seg = BRIDGE.slice(at, at + 400)
  assert.match(seg, /void this\._jmFollowUp\(/, '要 void 派出去，不等')
  assert.match(seg, /this\._jmJobs\.delete\(/, '取了要删掉（不然下次接同一个）')
})

ok('★★ 同一会话只挂一个任务（两个 26 秒的浏览器会互相抢）', () => {
  assert.match(BRIDGE, /if \(this\._jmJobs\.has\(scope\)\)/,
    '要有"已有任务就跳过"的判断 —— 否则第二个会覆盖第一个，第一个永远不补')
})

ok('★★★ 补发时的三道闸（都是别处踩过的）', () => {
  const at = BRIDGE.indexOf('async _jmFollowUp(')
  assert.ok(at > 0, '要有 _jmFollowUp')
  const end = BRIDGE.indexOf('\n  async _videoFollowUp(', at)
  const body = BRIDGE.slice(at, end > at ? end : at + 4000)
  assert.match(body, /typeof gen\?\.text !== 'string'/,
    '★ `_generate` 返回的是对象不是字符串 —— 长视频那边发过「[object Object]」')
  assert.match(body, /\[SILENT\]/, '`[SILENT]` 要按整条判断')
  assert.match(body, /blocks\.size === 0/,
    '★ 一张图都没入库就别硬发 —— 那等于说"我看了"却没画面')
  assert.match(body, /maxAge/, '要有"聊走了就不补"的判据')
})

ok('★★ 截图要能进上下文（base64 不走 QQ 那条下载路）', () => {
  assert.match(BRIDGE, /_collectImages\(recent, preRef, extraBlocks = null\)/,
    '_collectImages 要收 extraBlocks')
  /*
   * ⚠️ **别锁第三个参数的名字** —— 2026-11-03 它从 `extraBlocks` 变成了 `blocks`
   *    （因为 **B 站分镜图**和**车牌截图**是两路图源，要在 `_generate` 里合并，
   *     详见 `src/qq/videoshot.js` 那条路）。
   *    锁死名字会让"功能没坏但测试红"，然后逼人去修没坏的东西 —— 认语义即可。
   */
  assert.match(BRIDGE, /_collectImages\(history, imgReferrer, \w+\)/,
    '要真的把"额外图块"传进 _collectImages')
  assert.match(BRIDGE, /_generate\(msg, mem, scene, self, extraBlocks = null, extraNote = ''\)/,
    '_generate 要收 extraBlocks / extraNote')
  // 图块要放进 imageCache
  const at = BRIDGE.indexOf('extraBlocks && typeof extraBlocks[Symbol.iterator]')
  assert.ok(at > 0, '要把 extraBlocks 并进 out')
})

ok('★★ `jmRead` 配置要从 index.js 传进 bridge（别又"配置写了没人读"）', () => {
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.match(idx, /jmRead: cfg\.jmRead/, 'index.js 要把它带进 bridge 的 cfg')
  const cfgSrc = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8')
  assert.match(cfgSrc, /jmRead:\s*\{[\s\S]{0,200}?enabled:/, '配置默认值要有')
  assert.match(cfgSrc, /maxShots:/, '要有封顶配置')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)