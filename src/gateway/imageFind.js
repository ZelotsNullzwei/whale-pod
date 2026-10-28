/**
 * 按描述找图。
 *
 * ## 为什么要自己实现（而不是用现成的图片搜索）
 *
 * 对比过三条路：
 *   ① DeepSeek `POST /v1/tools/search` —— **只搜网页，不返回图片**。
 *      响应里只有 title / url / summary / site_name / date，没有图片字段。
 *   ② DeepSeek `POST /v1/tools/fetch` —— 返回的是**已抽取正文的 Markdown**，
 *      图片被剥掉了。实测抓一个图片站，返回 366 字符纯文字，
 *      `![...](...)` 一个都没有。所以这条路也断了。
 *   ③ **Search 拿结果页 URL → 自己 fetch 原始 HTML → 提取 <img>** ✅
 *
 * 所以本文件走 ③：Search 负责「找到可能相关的页面」，我们自己解析 HTML。
 *
 * ## 关键发现：`alt` 文本就是图片描述
 *
 * 实测某图片站：
 *   alt="蓝发鲸尾的 DeepSeek 娘身着深蓝金饰礼裙，立在夜色庭院"
 *   alt="DeepSeek娘身穿深蓝色女仆装，侧坐在浅蓝色沙发上"
 *
 * 这些描述是人工/站点生成的，**比任何图片搜索 API 的标签都准**。
 * 它就是「准确找图」的匹配依据 —— 不需要 OCR，也不需要视觉模型。
 *
 * ## 计费
 *
 * 只有 Search 花钱（¥0.005/次，按次不按 token）。
 * 抓 HTML 和下载图片都是普通 HTTP，免费。
 * 所以一次找图 ≈ 半分钱。
 */

import { fetchWithProxyFallback } from '../net.js'

const SEARCH_ENDPOINT = process.env.DEEPSEEK_SEARCH_ENDPOINT
  ? String(process.env.DEEPSEEK_SEARCH_ENDPOINT)
  : 'https://api.deepseek.com/v1/tools/search'

/** 抓页面时伪装成浏览器 —— 有些站对非浏览器 UA 直接给空页。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 明显不是「内容图」的路径片段。
 *
 * ⚠️ 这些必须过滤掉，否则每页前几张永远是站点头像和 logo ——
 *    实测某站 27 个 <img> 里前两个都是 `/avatar.png`。
 */
const BAD_IMG = /(^|\/)(avatar|logo|icon|favicon|sprite|placeholder|blank|spacer|badge|button|qrcode|emoji)\b/i

/** 太小或太怪的扩展名通常不是想要的图。 */
const OK_EXT = /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i

/**
 * 从 HTML 里提取图片。
 *
 * 纯正则实现 —— 不引 cheerio/jsdom：
 *   · 我们只需要 `src` 和 `alt`，不需要 DOM 语义
 *   · 引入解析器会让这个独立包多一个依赖，代价不划算
 *
 * 兼容三种常见写法：
 *   `<img src alt>` / `<img data-src ...>`（懒加载）/ `srcset`
 *
 * @param {string} html
 * @param {string} baseUrl  用于把相对路径转绝对
 * @returns {Array<{url:string, alt:string, w:number, h:number}>}
 */
export function extractImages(html, baseUrl) {
  const out = []
  const seen = new Set()
  const s = String(html ?? '')

  // 逐个 <img ...> 标签处理 —— 先把标签切出来，再各取属性，
  // 比一次性写一个大正则稳（属性顺序、引号风格都不固定）。
  const tagRe = /<img\b[^>]*>/gi
  let m
  while ((m = tagRe.exec(s)) !== null) {
    const tag = m[0]
    const attr = (name) => {
      const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i')
      return (tag.match(re) ?? [])[1] ?? ''
    }

    // 懒加载优先：`data-src` / `data-original` 才是真图，`src` 常是占位图
    let src = attr('data-src') || attr('data-original') || attr('data-lazy-src') || attr('src')
    if (!src) continue
    // srcset 兜底（取第一个候选）
    if (!src && attr('srcset')) src = String(attr('srcset')).split(',')[0].trim().split(/\s+/)[0]
    if (!src) continue

    // 转绝对路径
    let url
    try {
      url = new URL(src, baseUrl).href
    } catch { continue }
    if (!/^https?:\/\//i.test(url)) continue
    if (BAD_IMG.test(url)) continue
    // 没有扩展名的通常是追踪像素或接口图，跳过（但保留带查询串的）
    if (!OK_EXT.test(url) && !/\?/.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)

    const alt = (attr('alt') || attr('title') || '').trim()
    const w = Number(attr('width')) || 0
    const h = Number(attr('height')) || 0
    out.push({ url, alt, w, h })
  }
  return out
}

/**
 * 给图片和需求打分（0~1）。
 *
 * ## 为什么是「逐词命中率」而不是整串包含
 *
 * 「鲸鱼娘 女仆装 插画」这种需求里，三个词的重要度差不多。
 * 整串包含的命中率极低（alt 不会一字不差），
 * 逐词统计能反映「这张图讲了几成我要的东西」。
 *
 * @param {string} alt
 * @param {string[]} terms  需求拆出来的关键词
 * @returns {number}
 */
export function scoreImage(alt, terms, opts = {}) {
  const list = (Array.isArray(terms) ? terms : []).filter(Boolean)
  if (list.length === 0) return 0

  const altText = String(alt ?? '')
  const urlText = String(opts.url ?? '')
  const a = altText.toLowerCase()
  const u = urlText.toLowerCase()

  // ① 整词命中（最强信号）
  let hit = 0
  for (const t of list) {
    const tt = String(t).trim().toLowerCase()
    if (tt && (a.includes(tt) || u.includes(tt))) hit++
  }
  const ratio = hit / list.length

  // ② 逐字重合（中文没分词，见 queryChars 注释）
  const chars = opts.chars ?? queryChars(list)
  let charRatio = 0
  if (chars.length > 0) {
    const pool = a + '\n' + u
    let c = 0
    for (const ch of chars) if (pool.includes(ch)) c++
    charRatio = c / chars.length
  }

  // ③ 描述越长越可能是正经内容图（弱加成，不能单独构成「相关」）
  const richBonus = Math.min(0.1, altText.length / 800)
  return Math.min(1, ratio * 0.7 + charRatio * 0.3 + richBonus)
}

/**
 * 关键词里值得**逐字**匹配的汉字。
 *
 * ## 为什么需要
 *
 * 中文没分词，`toTerms` 给的是整段词（「明日方舟终末地」），
 * 而图片 alt 里往往只出现其中一个字。实测 2026-10-28：
 *
 * ```js
 * toTerms('明日方舟终末地 祀 立绘') → ['明日方舟终末地', '立绘']
 * alt = '尺寸2814x4462 女孩和祀 2K图片'      // 含「祀」，其实是**对的图**
 * ```
 *
 * 整词匹配判 0 分 → 好图被当成无关图丢掉。
 * 所以额外用**单字重合率**兜一层（代词/虚词先剔掉，否则「的」「是」到处都中）。
 *
 * @param {string[]} terms
 * @returns {string[]} 去重后的汉字
 */
export function queryChars(terms) {
  const out = new Set()
  for (const t of terms ?? []) {
    for (const ch of String(t ?? '')) {
      if (!/[\u4e00-\u9fa5]/.test(ch)) continue
      if (COMMON_CHAR.has(ch)) continue
      out.add(ch)
    }
  }
  return [...out]
}

/**
 * 这张图跟需求**有没有**关系。
 *
 * ⚠️ 和 `scoreImage` 是两件事：`scoreImage` 只负责**排序**，
 *    而这个负责**设下限**。
 *
 * ## 为什么必须分开（2026-10-28 用户报「找到东西不相关」）
 *
 * 原来挑选时**不要求分数 > 0**，注释理由是「有些站 alt 是空的，
 * 但图本身可能就是对的」。实测代价：新闻页 57 张图 alt 全空 →
 * 全部并列 0 分 → 按 `alt.length` 也全并列 → **退化成按文档顺序取第一张**
 * → 取到 17173 的广告横幅（`/novar/2026xxxx/YgJRcFbufreCxad.jpg`），
 * 配在回复里发给群里。
 *
 * **发一张无关图比不发图糟得多** —— 前者是错的，后者只是没有。
 *
 * ## 判据：整词命中 **或** 双字词组命中
 *
 * ⚠️ **不能用「单字重合」当判据** —— 太松。实测：
 *    「说明文字」里有「明」，就把一张完全无关的图判成相关。
 *    改成双字词组后，「明日」这组命中不了，就正确判为无关。
 *
 * ⚠️ 单字词（如人名「祀」）走**整词**这一支 —— 它在 `toTerms` 里
 *    被特意保留了（见那里的注释）。
 *
 * @returns {boolean}
 */
export function isRelevant(alt, terms, opts = {}) {
  const list = (Array.isArray(terms) ? terms : []).filter(Boolean)
  if (list.length === 0) return false

  const pool = String(alt ?? '').toLowerCase() + '\n' + String(opts.url ?? '').toLowerCase()

  // ① 整词（含单字内容词）
  for (const t of list) {
    const tt = String(t).trim().toLowerCase()
    if (tt && pool.includes(tt)) return true
  }

  // ② 双字词组
  const grams = opts.bigrams ?? queryBigrams(list)
  return grams.some((g) => pool.includes(g))
}

/**
 * 把用户需求拆成可匹配的关键词。
 *
 * ## ⚠️ 中文没有空格，不能只按空白切
 *
 * 实测踩过：
 *   toTerms('给我找一张鲸鱼娘 女仆装 的图片')
 *   → ['给我找一张鲸鱼娘', '女仆装', '的图片']
 *
 * 「给我找一张鲸鱼娘」被当成**一个词**，`STOP` 匹配不上，
 * 于是整句拿去跟 alt 比 —— 命中率恒为 0，永远挑不到图。
 *
 * 所以分两步：
 *   ① **先剥前后缀的动作词**（「给我」「帮我」「找一张」「的图片」…）
 *   ② 再按空白/标点切，剩下的才算关键词
 *
 * 中文没有分词器可用，但这些动作词的位置很固定 ——
 * 几乎都在句首或句尾。剥掉就够了，中间的实际内容（鲸鱼娘/女仆装）
 * 本来就靠空格或自然断句分开。
 *
 * @param {string} q
 * @returns {string[]}
 */
export function toTerms(q) {
  const s = stripActionWords(q)

  // ③ 切词
  const STOP = /^(给我|帮我|请|找|搜|来|要|想要|看看|下|一张|一幅|一个|张|幅|个|点|的|了|图|图片|照片|表情包|啥|什么)$/
  const out = []
  for (const raw of s.replace(/[，。！？、,.!?]/g, ' ').split(/\s+/)) {
    const x = raw.trim()
    if (STOP.test(x)) continue
    /*
     * ⚠️ **单字内容词必须留下**（2026-10-28 修）。
     *
     * 原来写的是 `if (x.length < 2) continue` —— 于是
     * `toTerms('明日方舟终末地 祀 立绘')` 变成 `['明日方舟终末地','立绘']`，
     * **「祀」这个人名被整条丢掉**（它才是这次要找的东西）。
     * 结果就是：真正对的那张图（alt = 「…女孩和祀 2K图片」）判 0 分，
     * 而一张无关的广告图因为「并列 0 分」被选中。
     *
     * 现在：长度 ≥2 照旧；长度 ==1 且是汉字、且不在常见虚词表里 → 保留。
     * 虚词表只放「到处都会出现」的字，宁少勿多。
     */
    if (x.length >= 2) { out.push(x); continue }
    if (x.length === 1 && /[\u4e00-\u9fa5]/.test(x) && !COMMON_CHAR.has(x)) out.push(x)
  }

  /*
   * 兜底：上面剥完如果什么都不剩（用户只说了「找张图」没说找什么），
   * 就把原始输入当关键词 —— 总比空数组好，ScoreImage 至少还能按
   * 「有描述的图优先」排一排。
   */
  if (out.length === 0 && s.length >= 2) out.push(s)
  return out
}

/** 单字里「到处都有」的虚词/量词 —— 不作为关键词保留。 */
const COMMON_CHAR = new Set([...'的了在是有和与及之也就都还很更最一个这那什么怎么样子们你我他她它们谁哪啥吗呢吧啊哦嗯呀图张幅点来去找搜看想要给帮请下上大小多几等把被从到向对为以于由并或但而则若如因所者其此该本某各每些太超真假'])

/**
 * 剥掉「给我找一张…的图片」这类**动作词**，留下真正的内容。
 *
 * ⚠️ 抽出来是因为 `toTerms`（切词用）和 `queryChars`（逐字用）
 *    必须看到**同一份内容**，否则两边的口径会对不上。
 *
 * @param {string} q
 * @returns {string}
 */
export function stripActionWords(q) {
  let s = String(q ?? '').trim()
  // ① 前缀：给我/帮我找一张/来点…
  s = s.replace(
    /^(?:请|麻烦)?(?:给我|帮我|替我|给我来|来|要|想要)?(?:找|搜|找一?张|来一?张|整一?张|发一?张|看看|看)?(?:一?张|一?幅|一?个|点)?/,
    '',
  )
  // ② 后缀：的图/图片/表情包/长什么样…
  s = s.replace(/(?:的)?(?:图|图片|照片|表情包|插画|壁纸|头像)(?:呢|吗|啊)?$/, '')
  s = s.replace(/(?:长什么样|什么样|是什么样)$/, '')
  return s
}

/**
 * 从关键词里取「双字词组」—— 用于判断相关性。
 *
 * `明日方舟终末地` 的双字词组是 明日/日方/方舟/舟终/终末/末地。
 * 这样既能接受「页面里只写了明日方舟」，又能挡掉
 * 「说明文字」这种**只有一个字偶然相同**的误判。
 *
 * @param {string[]} terms
 * @returns {string[]}
 */
export function queryBigrams(terms) {
  const out = new Set()
  for (const t of terms ?? []) {
    const s = String(t ?? '')
    if (s.length < 2) continue
    for (let i = 0; i + 2 <= s.length; i++) {
      const g = s.slice(i, i + 2)
      if (/^[\u4e00-\u9fa5]{2}$/.test(g)) out.add(g)
      else if (/^[a-z0-9]{2}$/i.test(g)) out.add(g.toLowerCase())
    }
  }
  return [...out]
}

/**
 * 找图主流程。
 *
 * @param {object} o
 * @param {string} o.query    用户的需求（自然语言）
 * @param {string} o.apiKey   DeepSeek key（Search 要用）
 * @param {number} [o.count]  搜几个网页（默认 3）
 * @param {number} [o.want]   返回几张候选（默认 3）
 * @param {number} [o.timeoutMs]
 * @param {(m:string)=>void} [o.log]
 * @returns {Promise<{ok:boolean, images:Array, error?:string, ms:number, usage:object}>}
 */
export async function findImages(o = {}) {
  const started = Date.now()
  const fail = (error) => ({ ok: false, images: [], error, ms: Date.now() - started, usage: { searches: 0 } })

  const query = String(o.query ?? '').trim()
  if (!query) return fail('没有查询内容')
  if (!o.apiKey) return fail('没有 DeepSeek 凭据（找图需要它来搜网页）')

  const count = Math.max(1, Math.min(5, Number(o.count ?? 3)))
  const want = Math.max(1, Math.min(8, Number(o.want ?? 3)))
  const timeoutMs = Number(o.timeoutMs ?? 12000)

  // ── ① Search 拿结果页 ──────────────────────────────────────
  let pages = []
  try {
    const res = await fetchWithProxyFallback(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.slice(0, 128), count, need_content: false }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return fail(`Search HTTP ${res.status} ${t.slice(0, 100)}`)
    }
    const j = await res.json()
    const results = Array.isArray(j?.results) ? j.results : []
    pages = results
      .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0))
      .slice(0, count)
      .map((r) => String(r.url ?? ''))
      .filter((u) => /^https?:\/\//i.test(u))
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return fail(aborted ? '搜索超时' : String(e?.message ?? e))
  }

  if (pages.length === 0) return fail('搜索没有结果')

  o.log?.(`找图：搜索到 ${pages.length} 个页面，开始抓图`)

  // ── ② 并发抓 HTML + 提取图片 ──────────────────────────────
  const terms = toTerms(query)
  // 逐字/词组表只算一次（所有候选共用）
  const chars = queryChars(terms)
  const bigrams = queryBigrams(terms)
  const all = []
  await Promise.all(pages.map(async (pageUrl) => {
    try {
      const res = await fetchWithProxyFallback(pageUrl, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return
      // 只读前 400KB —— 图片列表都在前面，没必要下整页
      const buf = await res.arrayBuffer()
      const html = Buffer.from(buf.slice(0, 400_000)).toString('utf8')
      const imgs = extractImages(html, pageUrl)
      if (imgs.length > 0) o.log?.(`找图：${new URL(pageUrl).host} 提取到 ${imgs.length} 张`)
      for (const img of imgs) {
        const opts = { url: img.url, chars, bigrams }
        all.push({
          ...img,
          page: pageUrl,
          score: scoreImage(img.alt, terms, opts),
          relevant: isRelevant(img.alt, terms, opts),
        })
      }
    } catch { /* 单个页面失败不影响整体 */ }
  }))

  if (all.length === 0) return fail('页面上没找到可用的图片')

  /*
   * ── ③ 挑图 ────────────────────────────────────────────────
   *
   * ## 先过相关性下限，再排序（2026-10-28 修）
   *
   * 用户原话：「找到东西不相关」。
   *
   * 实测翻车链：新闻页 57 张图 alt 全空 → 全部并列 0 分 →
   * 长描述加成也都是 0 → 排序退化成**文档顺序** →
   * 取到 17173 的广告横幅（`/novar/2026xxxx/YgJRcFbufreCxad.jpg`）
   * 配在回复里发进群。
   *
   * 原来这里**刻意不要求 score > 0**，理由是「alt 空的图可能就是对的」。
   * 但代价太大了：**发一张无关图比不发图糟得多** ——
   * 前者是明确错误，后者只是这次没找到。
   *
   * 所以现在：
   *   · `isRelevant` 为 false 的候选**直接丢掉**
   *   · 一个都不剩就 `ok:false`，让上层如实说「没找到对得上的图」
   *   · 排序仍在相关候选内做（整词命中 > 逐字重合 > 描述长）
   *
   * ⚠️ 不能用 `score > 0` 当门槛 —— `richBonus` 会让「描述长但完全无关」
   *    的图也拿到 0.1。必须用 `isRelevant` 这个独立判据。
   */
  const relevant = all.filter((x) => x.relevant)
  if (relevant.length === 0) {
    return fail(`找到 ${all.length} 张图，但没有一张和「${query}」对得上`)
  }

  relevant.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(b.alt).length - String(a.alt).length
  })

  // 同一个 URL 只留一张
  const picked = []
  const seen = new Set()
  for (const img of relevant) {
    if (seen.has(img.url)) continue
    seen.add(img.url)
    picked.push(img)
    if (picked.length >= want) break
  }

  // 日志带上「相关/总数」—— 排查「为什么没发图」时一眼看出是被相关性筛掉的
  o.log?.(
    `找图：${all.length} 张里 ${relevant.length} 张和需求相关，挑了 ${picked.length} 张`
    + `（首选 ${picked[0]?.score.toFixed(2) ?? '-'} 分）`,
  )

  return {
    ok: true,
    images: picked,
    ms: Date.now() - started,
    // Search 按次计费，这里如实上报一次
    usage: { searches: 1 },
  }
}
