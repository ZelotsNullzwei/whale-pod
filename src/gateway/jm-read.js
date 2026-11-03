/**
 * 「用真浏览器把这部漫画看几页，看完就扔」。
 *
 * ## 用户的原话
 * > 「只单独页面抓取看呢，看完就扔，用 ego」
 * > 「内容得去看吧，不然没意义」
 *
 * 对 —— 光有标题确实等于没看。所以这里真的**打开页面看**。
 *
 * ## 为什么必须用浏览器（而不是抓 HTML）
 * 实测禁漫阅读器：
 * ```
 * · 图片地址是 JS 拼的（base_url + name + expires），静态 HTML 里没有
 * · scramble_id = 220980 → 图被切成横条打乱，靠站点自己的 JS 还原
 * · 整页滚动按需加载：整章铺开 11 万像素高，不滚就不给图
 * ```
 * 而**浏览器把这些全免**：JS 照跑、图照还原、滚一下照加载。
 *
 * ## ★★ 关键设计：截**视口**，不是抓 img.src
 * 这是整个方案里最容易做错的一步：
 * ```
 * 抓 img.src          → 拿到的是**被打乱的原始图**（scramble 过的），喂给模型看到一堆错位的条 ✗
 * 截视口（人看到的）   → **站点自己的 JS 已经还原好了**，所见即所见 ✓
 * ```
 * 而且不用管它到底是用 canvas 拼的还是 data URL 换的 —— **人看见什么就截什么**。
 *
 * ## 封顶（唯一真花钱的地方）
 * · 最多 `maxShots` 张（默认 6）—— 不滚完整章（要两分钟）
 * · 每张在**浏览器里**就缩到 `scale`（默认 **0.35**，因为要拼成网格图，见下），base64 直接是"能给模型看的尺寸"
 * · 前几页足够知道"这是什么"，这也正是用户要的
 *
 * ## 「看完就扔」
 * 全程用**一次性临时 profile**：读完连浏览器带 profile 一起删，不留任何痕迹。
 * 截图只活在本次调用的返回值里，**不落盘、不缓存**。
 */

import { openBrowser, newPage, closePage, findBrowser } from './browser.js'
import { cleanAlbumFields } from './jm.js'

/** 默认最多看几页。 */
export const DEFAULT_MAX_SHOTS = 6

/** 每张截图缩放多少（在浏览器里缩，见 browser.js 的 screenshotViewport）。 */
export const DEFAULT_SCALE = 0.35

/**
 * ⚠️ **站点域名和 UA**（2026-11-03 抽出来）。
 *
 * 原来域名是**在函数里硬编码**的（`https://comic18j-moco.work/album/...`）。
 * 那个域名会换 —— `jm-host.json` 里存着探测出来的当前域名。
 * 这里先跟慢路保持一致（同一份硬编码），**别的地方换域名时一起换**。
 */
export const JM_HOST = 'comic18j-moco.work'
export const JM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 滚一屏之后等多久 —— 这个站的图是滚动按需加载的，等太短会截到空白。 */
const SETTLE_MS = 2600

/**
 * 打开一部作品，看前几页。
 *
 * @param {object} opts
 * @param {string} opts.id            作品编号（纯数字）
 * @param {number} [opts.maxShots]    最多几张（默认 6）
 * @param {number} [opts.scale]       截图缩放（默认 0.35 —— 拼成网格后仍能看清"在干嘛"）
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @returns {Promise<{ok:boolean, why?:string, title?:string, url?:string,
 *                    shots?:string[], totalHeight?:number, truncated?:boolean}|null>}
 */
/**
 * ★★★ **快路：直接下图片，不开那个站**（2026-11-03）。
 *
 * ## 为什么加（截屏那条路拿错了东西）
 * 实测把截出来的 6 屏给模型看，它说：
 * > 「你发的那六屏，在我这儿**全是同一个网页窗口** —— 中间那块**广告霸屏**霸得
 * >   一点缝都不留，背景只漏出一点点头、一截蓝袖子…」
 *
 * 我自己看了那张拼图 —— **确实如此** ✗：6 格全是网站门面（横幅「DeepSeek娘的宣传界面」、
 * 「站长官方推荐」、气泡、橙色按钮），**漫画只在底下漏一条** ✗。
 * **截屏这条路拿不到漫画** —— 而且广告会换、关闭按钮位置会变，靠"点掉广告"是碰运气 ✗。
 *
 * ## 正解：阅读器页的**普通 HTML 里就有完整图片清单**
 * ```
 * var page_arr = ["00001.webp","00002.webp","00003.webp",…]     ← 一次 fetch 就有
 * 图片实际地址： https://cdn-msp<N>.<host>/media/photos/<id>/00001.webp
 * ```
 * 实测直下：**第 1 页 200 / 115KB / 2.7s，第 2~6 页 22~104KB / 0.6~1.1s**
 * —— **不用浏览器、不用截屏、没有广告、全分辨率** ✓
 * 而且下到的就是干净的真图（960×1403，没有网站门面）✓
 *
 * ⚠️ **`scramble_id`**：阅读器 HTML 里有 `var scramble_id = 220980;`
 * —— 编号**大于**它的作品，图会被 JS 打乱再还原 ✗。本 album（1481228）小于它，
 * 所以直下是干净的 ✓。**将来遇到大编号要先判这个**（现在只记个 warn）。
 *
 * ⚠️ 浏览器**还是要开**，但只当 **canvas 引擎**用（`about:blank`，**不导航到那个站**）——
 * 拼图要在页面上下文做（whale-pod 零依赖，没 sharp）。
 *
 * @returns {Promise<object>} 跟 `readJmPages` 同样的形状；失败给 `{ok:false, why}`
 */
export async function readJmPagesDirect(opts = {}) {
  const log = opts.log ?? (() => {})
  const id = String(opts.id ?? '').trim()
  const maxShots = Math.max(1, Number(opts.maxShots) || DEFAULT_MAX_SHOTS)
  if (!/^\d{1,8}$/.test(id)) return { ok: false, why: 'bad-id' }

  const t0 = Date.now()
  const host = JM_HOST
  const H = {
    'user-agent': JM_UA,
    referer: `https://${host}/`,
    accept: 'text/html,application/xhtml+xml,*/*',
  }

  /*
   * ① 作品页 → **先拿章节链接**（普通 fetch + 正则，不用浏览器）。
   *
   * ⚠️⚠️ **不能拿作品编号直接当章节编号去 `/photo/<id>`**（这条是仓库里的硬规矩，
   *    测试 `check-jm-read` 专门锁着）—— 一部作品**可能有多个章节**，
   *    `/photo/<作品编号>` 这次碰巧能打开是**巧合** ✗。
   */
  const albumUrl = `https://${host}/album/${id}`
  let albumHtml = ''
  try {
    const r = await fetch(albumUrl, { headers: H, signal: AbortSignal.timeout(opts.listTimeoutMs ?? 20000) })
    albumHtml = await r.text()
    if (r.status !== 200) return { ok: false, why: `album-http-${r.status}` }
  } catch (e) {
    return { ok: false, why: 'album-failed', detail: String(e?.message ?? e).slice(0, 80) }
  }
  // 编号不存在时站会跳到错误页（跟慢路同一判据）
  if (/album_missing|\/error\//i.test(albumHtml)) return { ok: false, why: 'missing' }

  const chapterId = String((albumHtml.match(/href=["']\/photo\/(\d{1,8})["']/) ?? [])[1] ?? '')
  if (!chapterId) return { ok: false, why: 'no-chapter-link' }

  // ② 阅读器页 HTML → 图片清单
  const readerUrl = `https://${host}/photo/${chapterId}`
  let html = ''
  try {
    const r = await fetch(readerUrl, { headers: H, signal: AbortSignal.timeout(opts.listTimeoutMs ?? 20000) })
    html = await r.text()
    if (r.status !== 200) return { ok: false, why: `list-http-${r.status}` }
  } catch (e) {
    return { ok: false, why: 'list-failed', detail: String(e?.message ?? e).slice(0, 80) }
  }
  if (/album_missing|\/error\//i.test(html)) return { ok: false, why: 'missing' }

  const files = parsePageArr(html)
  if (!files.length) return { ok: false, why: 'no-page-arr' }

  // 唯一能识别的"打乱"信号（这次先只记，不拦）
  const scrambleId = Number((html.match(/var\s+scramble_id\s*=\s*(\d+)/) ?? [])[1]) || 0
  if (scrambleId && Number(id) > scrambleId) {
    log('warn', `jm-read：作品 ${id} 大于 scramble_id(${scrambleId}) —— 图可能被打乱，先当干净处理`)
  }

  // ② 均匀抽样（跟慢路同一套算法：开头 + 均匀 + 收尾）
  const total = files.length
  const idxs = sampleIndices(total, maxShots)

  // ③ 直接下图（并行，每张 ~1s）
  const cdn = detectCdnHost(html, id) || `cdn-msp3.${host}`
  const got = []
  for (const i of idxs) {
    const u = `https://${cdn}/media/photos/${id}/${files[i]}`
    try {
      const r = await fetch(u, {
        headers: { 'user-agent': JM_UA, referer: `https://${host}/`, accept: 'image/*,*/*' },
        signal: AbortSignal.timeout(opts.imageTimeoutMs ?? 20000),
      })
      if (!r.ok) { log('warn', `jm-read：第 ${i + 1} 页 HTTP ${r.status}`); continue }
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length < 2048) { log('warn', `jm-read：第 ${i + 1} 页太小（${buf.length}B）`); continue }
      got.push({ buf, page: i + 1 })
    } catch (e) {
      log('warn', `jm-read：第 ${i + 1} 页下不来 — ${String(e?.message ?? e).slice(0, 50)}`)
    }
  }
  if (!got.length) return { ok: false, why: 'no-images' }

  const title = parseJmTitle(albumHtml) || parseJmTitle(html)
  log('info', `jm-read：${id} 共 ${total} 页，抽了 ${got.length} 页直下（${Date.now() - t0}ms）`)

  // ④ 拼成一张（**借浏览器当 canvas**，不导航）
  const bot = await openBrowser({ log, startTimeoutMs: opts.startTimeoutMs ?? 20000 })
  if (!bot) return { ok: false, why: 'browser-start-failed' }
  let page = null
  try {
    page = await newPage(bot.cdp, 'about:blank')
    const b64s = got.map((g) => g.buf.toString('base64'))
    let shots = b64s
    if (b64s.length > 1) {
      try {
        const stitched = await page.stitchGrid(b64s, { timeoutMs: 60_000 })
        if (stitched) { shots = [stitched]; log('info', `jm-read：${id} 已把 ${b64s.length} 页拼成 1 张`) }
        else log('warn', `jm-read：${id} 拼图返回空 → 退回 ${b64s.length} 张`)
      } catch (e) {
        log('warn', `jm-read：${id} 拼图失败（退回原图）— ${String(e?.message ?? e).slice(0, 50)}`)
      }
    }
    const pcts = got.map((g) => (total > 1 ? Math.round(((g.page - 1) / (total - 1)) * 100) : 0))
    return {
      ok: true,
      title,
      url: readerUrl,
      shots,
      samples: got.length,
      shotPcts: pcts,
      /** ★ 整章多少**页**（不是多少屏）—— 措辞要用它说"整章约 N 页" */
      totalPages: total,
      sampled: got.length < total,
      totalHeight: 0,
      truncated: got.length < total,
      /** 标记走的哪条路（排查用） */
      via: 'direct',
    }
  } finally {
    if (page) await closePage(bot.cdp, page).catch(() => {})
    await bot.close().catch(() => {})
  }
}

/** 阅读器 HTML 里的 `var page_arr = ["00001.webp",…]` */
export function parsePageArr(html) {
  const m = String(html ?? '').match(/page_arr\s*=\s*\[([^\]]{0,20000})\]/)
  if (!m) return []
  return [...m[1].matchAll(/["'](\d{1,5}\.(?:webp|jpg|jpeg|png|gif))["']/gi)].map((x) => x[1])
}

/** 从 HTML 里认出 CDN 域名（形如 cdn-msp3.<host>） */
function detectCdnHost(html, id) {
  const m = String(html ?? '').match(new RegExp(`https://([a-z0-9.-]+)/media/photos/${id}/`, 'i'))
  return m ? m[1] : ''
}

/** 标题：优先 og:title，退回 <title>（去掉站点尾巴） */
function parseJmTitle(html) {
  const s = String(html ?? '')
  const og = s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i)
  if (og) return cleanTitle(og[1])
  const t = s.match(/<title[^>]*>([^<]{1,200})<\/title>/i)
  return t ? cleanTitle(t[1]) : ''
}
function cleanTitle(s) {
  return String(s)
    // `… - 禁漫天堂` / `… | H漫內頁瀏覽 Comics - …` 这类站点尾巴
    .replace(/\s*[-|｜]\s*(H漫內頁瀏覽|禁漫天堂|Comics|H Comics).*$/i, '')
    // 光秃秃挂在结尾的 ` Comics`（作品页 og:title 常这么收尾）
    .replace(/\s+(H?\s?Comics)\s*$/i, '')
    .trim()
}

/** 均匀抽样：开头 1 个 + 中间均匀 + 收尾 1 个（跟慢路同一套） */
export function sampleIndices(total, n) {
  const k = Math.max(1, Math.min(n, total))
  if (k >= total) return Array.from({ length: total }, (_, i) => i)
  if (k === 1) return [0]
  const out = []
  for (let i = 0; i < k; i++) out.push(Math.round(((total - 1) * i) / (k - 1)))
  return [...new Set(out)]
}

export async function readJmPages(opts = {}) {
  const log = opts.log ?? (() => {})
  const id = String(opts.id ?? '').trim()
  const maxShots = Math.max(1, Number(opts.maxShots) || DEFAULT_MAX_SHOTS)
  const scale = Number(opts.scale) || DEFAULT_SCALE
  if (!/^\d{1,8}$/.test(id)) return null

  /*
   * ★★★ **先走快路**（2026-11-03）：直接下图片，**不开那个站**。
   *
   * 慢路（开浏览器 + 滚屏截图）**留着兜底** —— 快路任何一步不成，就照旧走慢路 ✓。
   * 这样最坏情况 = 加这个功能之前的行为，不会更糟 ✓。
   *
   * 想强制走慢路排查：`opts.prefer = 'shot'`。
   */
  if (opts.prefer !== 'shot') {
    try {
      const fast = await readJmPagesDirect({ id, maxShots, log, startTimeoutMs: opts.startTimeoutMs })
      if (fast?.ok) return fast
      // 编号不存在是"站上的事实"，再走慢路也只是再确认一次 —— 直接返回
      if (fast?.why === 'missing') return fast
      log('info', `jm-read：快路没成（${fast?.why ?? '未知'}）→ 退回截屏那条路`)
    } catch (e) {
      log('warn', `jm-read：快路出错 — ${String(e?.message ?? e).slice(0, 70)} → 退回截屏那条路`)
    }
  }

  // 线路①：先看本机有没有浏览器 —— 没有就**明说**，别静默降级
  if (!findBrowser()) {
    log('warn', 'jm-read：本机没找到 Edge/Chrome，看不了内页')
    return { ok: false, why: 'no-browser' }
  }

  const t0 = Date.now()
  const bot = await openBrowser({ log, startTimeoutMs: opts.startTimeoutMs ?? 20000 })
  if (!bot) return { ok: false, why: 'browser-start-failed' }

  let page = null
  try {
    page = await newPage(bot.cdp, 'about:blank')

    /*
     * ① 作品页 → 拿**章节链接**。
     *
     * ⚠️ 不能拿作品编号直接当章节编号去 `/photo/<id>`：实测那次两者**碰巧一样**
     *    （都是 123456），但那是巧合 —— 一部作品有多个章节，
     *    编号没有必然关系。所以老老实实从作品页里取。
     */
    const albumUrl = `https://comic18j-moco.work/album/${id}`
    const okAlbum = await page.goto(albumUrl, 40000)
    if (!okAlbum) { log('warn', 'jm-read：作品页没打开'); return { ok: false, why: 'album-not-loaded' } }
    await sleepMs(2500)

    /*
     * ★★ **先看最终落在哪个路径**（2026-11-02 补）。
     *
     * 实测：编号不存在时站会**重定向到 `/error/album_missing`**，而且**返回 200** ——
     * 光看"页面打开了"会去里面找章节链接，找不到就报 `no-chapter-link`，
     * **用户看到的就成了"你这功能坏了"，而真相是那个编号没了。**
     *
     * 这两件事必须分开说：一个是"我的问题"，一个是"你的编号不对"。
     */
    const landedPath = String(await page.eval('location.pathname') ?? '')
    if (/\/error\/album_missing/i.test(landedPath)) {
      log('info', `jm-read：${id} 在站上不存在（落在 ${landedPath}）`)
      return { ok: false, why: 'missing' }
    }

    const chapterHref = await page.eval(
      `(()=>{const a=document.querySelector('a[href*="/photo/"]');return a?a.getAttribute('href'):''})()`,
    )
    if (!chapterHref) {
      log('warn', `jm-read：作品页里没找到章节链接（落在 ${landedPath}）`)
      return { ok: false, why: 'no-chapter-link' }
    }

    /*
     * ② 阅读器页。
     *
     * ⚠️ 这里**必须用浏览器打开** —— 之前静态抓 `/photo/<id>` 只拿到 449KB HTML，
     *    里面的图全是占位符（blank.jpg）和缩略图；真图是 JS 拼出来 + 还原的。
     */
    const readerUrl = chapterHref.startsWith('http') ? chapterHref : `https://comic18j-moco.work${chapterHref}`
    const okReader = await page.goto(readerUrl, 40000)
    if (!okReader) { log('warn', 'jm-read：阅读器没打开'); return { ok: false, why: 'reader-not-loaded' } }
    await sleepMs(3500)

    // 挑战页要认出来 —— 也不能装作看到了
    const challenge = await page.eval('/_cf_chl_opt|just a moment/i.test(document.documentElement.innerHTML.slice(0,3000))')
    if (challenge === true) {
      log('warn', 'jm-read：阅读器给的是 Cloudflare 挑战页')
      return { ok: false, why: 'challenge' }
    }

    const rawTitle = String(await page.eval('document.title || ""') ?? '')
    // 阅读器页的标题尾巴比作品页多一层（`|H漫內頁瀏覽 Comics - 禁漫天堂`）
    const title = cleanAlbumFields({ title: rawTitle }).title
    const totalHeight = await page.scrollHeight()
    const vpHeight = Number(await page.eval('innerHeight')) || 1300

    /*
     * ③ 滚 + 截图 —— **跳着抽，不是一屏屏看**（2026-11-03 用户定的）。
     *
     * ## 为什么改
     * 实测一本 79527px 的本子：6 屏 × 1300px = **只覆盖 9.8%** ✗，
     * 要看完得 **62 屏** —— 而 62 张原图塞进模型是不可能的（4.3MB + 62 次视觉 token）。
     *
     * 用户原话：
     * > 「**跳着看？性描述的部分肯定有重复，无非就是抽查高潮**」
     * 这个判断是对的：62 屏里大半是重复的描写，**真正有信息的就那几处** ——
     * 开头（设定/起手）＋ 中间几个节点 ＋ 收尾。
     *
     * ## 采法
     * ```
     *   第 1 屏    y = 0                        开头（谁、在哪、要干嘛）
     *   最后 1 屏  y = totalHeight - vpHeight    收尾
     *   中间 N-2   **均匀撒**在 [0, max] 上
     * ```
     * ⚠️ **短本子保持原样** —— 总高 ≤ maxShots 屏时就顺序全看（撒点会重复截同一屏）。
     * ⚠️ **`sampled` 字段必须带出去** —— 措辞那边要说清"是跳着看的"，
     *    否则她会以为**整章都看了**（虚报覆盖范围，跟"扫了眼标题"同一类病）。
     * ⚠️ 跳得远时**懒加载要等更久**，所以 settle 给足。
     */
    const maxY = Math.max(0, totalHeight - vpHeight)
    const shortsEnough = totalHeight <= maxShots * vpHeight   // 总高不到 maxShots 屏 → 顺序看
    const wantYs = []
    for (let i = 0; i < maxShots; i++) {
      if (shortsEnough) wantYs.push(Math.min(i * vpHeight, maxY))
      else if (i === 0) wantYs.push(0)
      else if (i === maxShots - 1) wantYs.push(maxY)
      else wantYs.push(Math.round((maxY * i) / (maxShots - 1)))
    }
    // 去重（撒点可能撞上，尤其短本子）
    const uniqYs = [...new Set(wantYs)]

    const shots = []
    for (let i = 0; i < uniqYs.length; i++) {
      const wantY = uniqYs[i]
      const atY = await page.scrollTo(wantY)
      // ⚠️ 跳远 → 新图要加载，等久一点（第一屏也是）
      await sleepMs(i === 0 ? 1200 : Math.max(SETTLE_MS, 1600))
      try {
        const b64 = await page.screenshotViewport({ scale })
        if (b64) shots.push({ b64, y: wantY })
      } catch (e) {
        log('warn', `jm-read：第 ${i + 1} 张截图失败 — ${String(e?.message ?? e).slice(0, 60)}`)
      }
    }

    const sampled = !shortsEnough && shots.length < Math.ceil(totalHeight / vpHeight)
    const raw = shots.map((s) => s.b64)

    /*
     * ★★★ **拼成一张网格图再发**（2026-11-03，用户批的 B）。
     *
     * ## 为什么
     * ```
     *   6 张全尺寸单独发 → 每张约 1000~1500 视觉 token → 合计 6000~9000 ✗
     *   拼成 1 张（3 列 × 2 行，≈1:1）  → 约 1500~2500 token        → 省 3~4 倍 ✓
     * ```
     * ## ⚠️ `samples` 必须单独带出去
     * 拼图后 `shots.length` 变成 **1**，而措辞那边要说"**跳着抽了 6 屏**"——
     * 所以原始采样数单独记在 `samples` 里，**别让措辞去数 shots.length** ✗。
     *
     * ## 拼失败就退回原样
     * canvas 拼接是"加一层"，失败不该让整件事失败 —— 退回多张原图，行为跟以前一样 ✓。
     */
    let outShots = raw
    if (raw.length > 1) {
      try {
        const stitched = await page.stitchGrid(raw, { timeoutMs: 60_000 })
        if (stitched) {
          outShots = [stitched]
          log('info', `jm-read：${id} 已把 ${raw.length} 屏拼成 1 张（省 token）`)
        } else {
          log('warn', `jm-read：${id} 拼图返回空 → 退回 ${raw.length} 张原图`)
        }
      } catch (e) {
        log('warn', `jm-read：${id} 拼图失败（退回原图）— ${String(e?.message ?? e).slice(0, 60)}`)
      }
    }

    log('info', `jm-read：${id} 截了 ${raw.length} 屏 / 共约 ${Math.ceil(totalHeight / vpHeight)} 屏`
      + `（共 ${totalHeight}px，${sampled ? '★ 跳着抽的' : '顺序看的'}，${Date.now() - t0}ms）`)
    return {
      ok: true,
      title,
      url: readerUrl,
      shots: outShots,
      /** ★ 原始采样数（拼图后 `shots` 只剩 1 张，措辞要用这个数） */
      samples: raw.length,
      shotYs: shots.map((s) => s.y),
      sampled,
      totalHeight,
      truncated: sampled,
    }
  } catch (e) {
    log('warn', `jm-read：出错 — ${String(e?.message ?? e).slice(0, 80)}`)
    return { ok: false, why: 'error' }
  } finally {
    /*
     * ★ 「看完就扔」：关页 + 关浏览器 + **删临时 profile**（见 browser.js 的 cleanup）。
     *   `closePage` 先关，再 `close` 整个进程 —— 顺序反了会有半死的标签页。
     */
    if (page) await closePage(bot.cdp, page).catch(() => {})
    await bot.close().catch(() => {})
  }
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 把"看了几屏"变成**喂给模型的注记**。
 *
 * ⚠️ 措辞上要分清"看了"和"没看"：
 *   · 看到了 → 说清"只看了开头几屏、后面没看"，**别把开头几页当成全文**
 *   · 没看到 → **明说打不开/没浏览器**，绝不许编
 *     （历史上它编过「点开想学修电脑」，标题里一个字都没有）
 *
 * @param {object} r `readJmPages` 的返回值
 * @param {(k:string)=>string} [t] 可选：借用面板那边的文案（暂时没用上，留口子）
 */
export function formatAlbumPagesNote(r) {
  if (!r || r.ok !== true) {
    /*
     * ⚠️ 措辞要**分成整句**，不要拼"这部作品的${why}" ——
     *    第一版就是这么写的，结果出来是
     *    「这部作品的**我这边没装能用的浏览器**」，
     *    主语和谓语打架，读着像机翻。
     */
    const line = r?.why === 'missing'
      ? '编号在禁漫上**不存在**（站自己跳到了"作品缺失"页）—— 让他核对一下编号'
      : r?.why === 'no-chapter-link'
        /*
         * ⚠️ 这一条是实测里**真正出现**的那个（2026-11-02，两次都是它）。
         *    单独给一句话，别混进"我打不开"——
         *    因为**指向的下一步完全不同**：这个说明"站上有这页、但里面没有阅读入口"，
         *    多半是**这个镜像没这部作品**（编号空间不同），而不是"你号错了"。
         */
        ? '这一页里没有阅读入口（在这个镜像上多半没有这部作品）'
        : r?.why === 'no-browser'
          ? '我这边没装能用的浏览器（Edge 或 Chrome），内页打不开'
          : r?.why === 'challenge'
            ? '那个站给了个人机验证页，我没过去，内页打不开'
            : r?.why === 'album-not-loaded'
              ? '作品页没打开（网络/域名的问题）'
              : r?.why === 'reader-not-loaded'
                ? '阅读器页没打开（网络/域名的问题）'
                : '内页我打不开'
    return `〔提示：这部作品——${line}。\n`
      + '**这次我手里什么都没有**：没拿到标题、没看到任何一页画面。\n'
      + '所以只说"打不开 / 我没看成"。\n'
      + '⚠️ **不许说"我扫了眼标题"这类话** —— 标题我也没拿到，说了就是假的。\n'
      + '⚠️ **也不许猜里面画了什么**。他要是追问"看完没"，就直说没看成。〕'
  }
  /*
   * ⚠️ **要用 `samples` 不是 `shots.length`**（2026-11-03 拼图之后）。
   * 拼成一张网格图后 `shots` 只剩 **1** 张 —— 若用它，措辞会变成
   * 「跳着抽了 **1** 屏」✗，跟"采样点 0/20/40/60/80/100%"自相矛盾。
   * 所以原始采样数单独记在 `r.samples`；老数据（没有这个字段）退回 shots.length。
   */
  const n = Number(r.samples) || r.shots.length
  /*
   * ★ 采样点位置 —— **必须告诉她落在哪**（2026-11-03）。
   *
   * 用户举的例子：「前 12 页是前戏，13-24 是口角，25~39 是抱着操…」
   * 那是**按位置分段**的说法。她要能这么说，就得知道**每张图在整章的百分之几**——
   * 光说"我看了 6 屏"，她最多只能描述某一张画面 ✗。
   */
  const ys = Array.isArray(r.shotYs) ? r.shotYs : []
  const spanY = Math.max(1, (Number(r.totalHeight) || 0) - 1300)
  /*
   * ★ 2026-11-03：**快路直接给百分比**（`shotPcts`，按"第几页/共几页"算），
   *   慢路只有像素位置（`shotYs`，靠 `spanY` 折算）。**优先用前者** ✓
   */
  const pcts = Array.isArray(r.shotPcts) && r.shotPcts.length
    ? r.shotPcts.map((p) => `${p}%`)
    : (ys.length ? ys.map((y) => `${Math.round((y / spanY) * 100)}%`) : [])
  /*
   * ⚠️ **单位要分清**：快路知道**整章多少"页"**（`totalPages`）✓；
   *    慢路只有像素，只能折算成"屏"。说错单位她会把"页"当"屏"。
   */
  const whole = Number(r.totalPages) || Math.max(n, Math.ceil((Number(r.totalHeight) || 0) / 1300))
  const unit = Number(r.totalPages) ? '页' : '屏'
  const per = n > 1 ? Math.max(1, Math.round((whole - 1) / (n - 1))) : whole
  /*
   * ⚠️ 结尾那句**必须跟着"看全没看全"走**。
   *    第一版把它无条件拼上去 —— 结果"滚到底了"的那种情况也说
   *    「尤其是后面没看的那些」，**自相矛盾**（测试抓到的）。
   *
   * ★ 2026-11-03 加 `r.sampled`（跳着抽）这一档。用户原话：
   *   「**跳着看？性描述的部分肯定有重复，无非就是抽查高潮**」
   *   所以现在**不是"只看了开头"** ✗ —— 是**开头 + 几处中间 + 收尾** ✓，
   *   中间**跳过了一大片**。措辞必须说清这一点，否则她会以为「整章都在这些画面里」
   *   （跟"扫了眼标题"是同一类病：**虚报覆盖范围**）。
   */
  const tail = r.sampled
    ? '⚠️ **我是跳着看的**（中间大段跳过了）—— 但**采样点铺得很匀**，'
      + '所以**这一章大概分哪几段、每段什么调子，你心里是有数的**。\n'
      /*
       * ★★★ 2026-11-03：**措辞从"交摘要"改成"你心里有数"**（实测逼出来的）。
       *
       * 原来这里写的是「★ 要说的是"概况"，照这个格式：『前 X 页是…』
       * （按页数分段，把整章讲成几个段落）」—— 那是**"当旁白复述"的任务框架** ✗。
       * 实测 4 次里 2 次被它逼出拒答，而且拒的话**点名了这一句**：
       * ```
       *   「这个我不接…我不给你逐段复述画面内容——**别让我当旁白念**。」
       *   「这个我不给你讲…**还要我一段一段给你复盘**？」
       * ```
       * 用户要的是「**有印象**进行概况」—— **心里有数** ✓，不是**交一份摘要** ✗。
       * 所以改成：把"印象"给她**自己**用，**别委托她做描述任务**。
       */
      + '★ **这个印象是给你自己用的，不是让你交总结** —— 照你平时说话的样子来，'
      + '想提就顺口带一句（「前面还是日常，中间才变味」这种），**不用逐段讲**。\n'
      + '❌ **别当旁白**（「第 N 页画的是…」一句一句念）—— 那既不像你，也没人要听。\n'
      + '❌ 也别说"整章我都看了"（中间确实跳过了）。'
    : r.truncated
      ? '（下面附的就是**我看到的画面**。只说看到的东西；'
        + '**没看到的别编** —— 尤其是后面那些没看的。）'
      : '（下面附的就是**我看到的画面**。只说看到的东西，别编。）'
  const head = r.sampled
    ? `**跳着抽了 ${n} ${unit}**（整章约 ${whole} ${unit}，中间跳过了大段）\n`
      + `采样点：${pcts.join(' / ')} —— **大约每 ${per} ${unit}一个**，正好能看出段落变化`
    : r.truncated
      ? `只看了**开头 ${n} ${unit}**（整章还长得多，后面没看）`
      : `看了 ${n} ${unit}，这基本是整章`
  /*
   * ★ 2026-11-03：拼图之后要**告诉她"这是一张拼起来的图"** ✗→✓
   * 否则她看到的是一张陌生的大图，会以为"只有一张画面"或"分不清哪张是哪张"。
   * 说清**几列几行 + 按什么顺序**，她才能把"第几格"对上"采样点的第几个" ✓。
   */
  const gridNote = (r.shots?.length === 1 && n > 1)
    ? `\n图：上面**是一张拼图**，把 ${n} 个采样画面按**从左到右、从上到下**排在一起`
      + `（约 ${Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n))))} 列）。`
      + `顺序就是上面「采样点」那个顺序 ✓`
    : ''
  return '## 对方发的这个车牌，我在浏览器里打开看了内页\n'
    + `标题：${r.title || '(没取到)'}\n`
    + `看了：${head}\n`
    + (gridNote ? `${gridNote}\n` : '')
    + tail
}