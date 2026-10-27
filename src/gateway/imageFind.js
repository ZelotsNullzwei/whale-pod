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
export function scoreImage(alt, terms) {
  if (!alt || terms.length === 0) return 0
  const a = alt.toLowerCase()
  let hit = 0
  for (const t of terms) {
    if (t && a.includes(t.toLowerCase())) hit++
  }
  // 命中率打底；另外给「描述越长越可能是正经内容图」一点加成
  const ratio = hit / terms.length
  const richBonus = Math.min(0.1, alt.length / 800)
  return Math.min(1, ratio + richBonus)
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
  let s = String(q ?? '').trim()

  // ① 前缀：给我/帮我找一张/来点…
  s = s.replace(
    /^(?:请|麻烦)?(?:给我|帮我|替我|给我来|来|要|想要)?(?:找|搜|找一?张|来一?张|整一?张|发一?张|看看|看)?(?:一?张|一?幅|一?个|点)?/,
    '',
  )
  // ② 后缀：的图/图片/表情包/长什么样…
  s = s.replace(/(?:的)?(?:图|图片|照片|表情包|插画|壁纸|头像)(?:呢|吗|啊)?$/, '')
  s = s.replace(/(?:长什么样|什么样|是什么样)$/, '')

  // ③ 切词
  const STOP = /^(给我|帮我|请|找|搜|来|要|想要|看看|下|一张|一幅|一个|张|幅|个|点|的|了|图|图片|照片|表情包|啥|什么)$/
  const out = []
  for (const raw of s.replace(/[，。！？、,.!?]/g, ' ').split(/\s+/)) {
    const x = raw.trim()
    // 整 token 是动作词就丢；长度 < 2 也丢（单字命中率太虚）
    if (x.length < 2) continue
    if (STOP.test(x)) continue
    out.push(x)
  }

  /*
   * 兜底：上面剥完如果什么都不剩（用户只说了「找张图」没说找什么），
   * 就把原始输入当关键词 —— 总比空数组好，ScoreImage 至少还能按
   * 「有描述的图优先」排一排。
   */
  if (out.length === 0 && s.length >= 2) out.push(s)
  return out
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
        all.push({ ...img, page: pageUrl, score: scoreImage(img.alt, terms) })
      }
    } catch { /* 单个页面失败不影响整体 */ }
  }))

  if (all.length === 0) return fail('页面上没找到可用的图片')

  /*
   * ── ③ 挑图 ────────────────────────────────────────────────
   *
   * 排序依据：
   *   ① alt 匹配度（有没有说到用户要的东西）
   *   ② alt 长度（有描述的图更可能是正经内容图，不是装饰元素）
   *
   * ⚠️ 不用「第一张」—— 页面前几张往往是导航栏和装饰图。
   *    也不要求 score > 0：有些站的 alt 是空的，
   *    但图本身可能就是对的（那种时候只能靠位置兜底）。
   */
  all.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return String(b.alt).length - String(a.alt).length
  })

  // 同一个 URL 只留一张
  const picked = []
  const seen = new Set()
  for (const img of all) {
    if (seen.has(img.url)) continue
    seen.add(img.url)
    picked.push(img)
    if (picked.length >= want) break
  }

  o.log?.(`找图：从 ${all.length} 张里挑了 ${picked.length} 张`)

  return {
    ok: true,
    images: picked,
    ms: Date.now() - started,
    // Search 按次计费，这里如实上报一次
    usage: { searches: 1 },
  }
}
