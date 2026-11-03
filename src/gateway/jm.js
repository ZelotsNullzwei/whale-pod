/**
 * 禁漫（18comic / JM）作品信息抓取。
 *
 * ## 为什么单独一个模块
 * 这个站有两个别处没有的麻烦：
 *   ① **域名一直换**（`18comic.vip` / `.org` / `.ink` / `jmcomic.me` …），
 *      写死必然过期 —— 实测 7 个候选里**6 个直接超时**，只有一个跳转到当前域名
 *   ② 慢（实测 900~3700ms），而且**编号不存在时错误页会挂 Cloudflare 挑战**
 *      —— 那一页拿到的是挑战页而不是内容，很容易误判成"全站被挡"
 *
 * ## 实测结论（2026-11-02，都用普通 fetch，没有浏览器）
 * ```
 * 首页                200  非挑战  277KB
 * /album/123          200  非挑战  281KB   ← 作品页能读
 * /album/123456       200  非挑战  282KB   ← 能读
 * /search/photos?...  200  非挑战  282KB   ← 搜索也能用
 * /album/1            200  ★挑战  174KB    ← 编号不存在，错误页才挂挑战
 * ```
 * ⚠️ **最后那条是关键**：我第一轮就是拿 `/album/1` 探的，差点得出
 *    "作品页全被 Cloudflare 挡着"的错结论。**探路的样本必须是个有效编号。**
 *
 * ## 抓什么
 * 只抓 `og:title` + `og:description`（实测这两个字段都在），
 * **不抓图片列表** —— 那是另一个量级的事（几十张图、还要过阅读器）。
 * 有标题和描述，她就"知道这是什么"了，这正是用户要的。
 *
 * ## 域名怎么找
 * ① 先用**上次成功的域名**（持久化到数据目录，省一次跳转）
 * ② 不行再逐个试候选，**跟着重定向走**（站自己会跳到当前域名）
 * ③ 学到的新域名写回去
 */

import fs from 'node:fs'
import path from 'node:path'
import { fetchWithProxyFallback } from '../net.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 候选域名。换域名时这里可以加，但**别删旧的** —— 说不定哪天又切回来。 */
const DOMAINS = [
  '18comic.ink',
  '18comic.vip',
  '18comic.org',
  '18comic.art',
  'jmcomic.me',
  'jmcomic1.me',
]

/** 域名演技的缓存时限：一天。太短会天天重试死域名，太长会跟不上换域名。 */
const HOST_TTL_MS = 24 * 60 * 60_000
/** 同一部作品的缓存时限：一小时。 */
const ALBUM_TTL_MS = 60 * 60_000

/** 挑战页的特征 —— 拿到这个说明**不是内容页**，要换个编号或换个域名再试。 */
const CHALLENGE_RE = /just a moment|cf-chl|challenge-platform|_cf_chl_opt|Enable JavaScript and cookies/i

/**
 * 持久化的「当前可用域名」。
 *
 * ⚠️ 存盘而不是只放内存：whale-pod 经常重启（我一天就重启十几次），
 *    放内存等于每次启动都要重新趟一遍死域名 —— 那是 6 次超时，
 *    用户等的是回复，不该浪费在这上面。
 */
export class JmHostCache {
  /** @param {string} home whale-pod 数据目录 */
  constructor(home) {
    this.file = home ? path.join(home, 'jm-host.json') : null
    this.load()
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.host = typeof j?.host === 'string' ? j.host : ''
      this.at = Number(j?.at ?? 0)
    } catch {
      this.host = ''
      this.at = 0
    }
  }

  get() {
    if (!this.host) return ''
    if (Date.now() - this.at > HOST_TTL_MS) return ''
    return this.host
  }

  set(host) {
    if (!host || host === this.host) { this.at = Date.now(); return }
    this.host = host
    this.at = Date.now()
    try { fs.writeFileSync(this.file, JSON.stringify({ host, at: this.at }), 'utf8') } catch { /* 存不下就算了 */ }
  }
}

/**
 * 标题尾巴上的**站名/栏目名** —— 实测有**两种形态**：
 * ```
 * 作品页：  [汉化组][作者] 作品名 (原作) [翻译] - 禁漫天堂
 * 阅读器页：[汉化组][作者] 作品名 (原作) [翻译]|H漫內頁瀏覽 Comics - 禁漫天堂
 *                                              ↑↑↑↑↑ 这一层原来没剥掉
 * ```
 * 所以不能只写"末尾是禁漫天堂" —— 它前面还挂着栏目名。
 * 这里用「**分隔符 + 中间夹着站名标记**」来认，并且**循环剥到不再变**：
 * 第一轮剥掉 ` - 禁漫天堂`，第二轮剥掉 `|H漫內頁瀏覽 Comics`。
 *
 * ⚠️ 中间那段用了 `[^|｜]`（不许跨分隔符），避免一口吞掉半个标题。
 */
const SITE_SUFFIX_RE = /\s*[-–|｜]\s*[^|｜]{0,40}?(?:禁漫天堂|禁漫|18comic|JMComic|Comics|內頁瀏覽|内页浏览|H漫)[^|｜]{0,40}?\s*$/i

/**
 * ★★ 站点自己给的「这个作品没有」路径 —— 实测会**重定向**到它：
 * ```
 * /album/350234  →  /error/album_missing        ← 这个编号在站上不存在
 * /photo/350234  →  /error/album_missing
 * ```
 *
 * ⚠️ 要害在于**它返回 200、不是 404** —— 光看状态码会以为"抓到了"，
 *    然后拿一个空页去解析，最后笼统报「抓不到」。
 *    于是用户看到的是"你这功能坏了"，**而真相是那个编号没了**。
 *    这两句话对用户的价值完全不同，必须分开说。
 */
const MISSING_PATH_RE = /\/error\/album_missing/i

/**
 * ★★ **JM 编号 ≠ 站内作品号** —— 实测（2026-11-02）：
 * ```
 * /album/350000  →  重定向到  /album/339768/
 * ```
 * 这个站会**改写编号**。所以必须看**最终落在哪个路径**，
 * 拿那个真正的作品号去拼后续 URL（阅读器那一步尤其要紧）。
 */
const ALBUM_PATH_RE = /\/album\/(\d+)/i

/** 站点自己的口号 —— 它出现在每部作品的 `og:description` 里，
 * **不是作品简介**。
 *
 * 实测：随便抓一部，description 都是「免費成人H漫線上看」这同一句。
 * 留着的话：
 *   · 那片上下文等于没给（模型学不到任何关于这部作品的信息）
 *   · 而且**每部作品都长一样**，反而让它以为"这部作品讲的是这个"
 * 所以直接丢掉，宁可 description 空着。
 */
const SITE_SLOGAN_RE = /^(?:免費|免费)?(?:成人)?(?:H)?(?:漫|漫画)?(?:線上看|线上看|在線看|在线看|免費看|免费看)[。.!！]?$/

/** HTML 实体（够用就行）。 */
function unescapeHtml(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)) } catch { return '' } })
}

/** 从 HTML 里取 og:title / og:description（两种属性顺序都认）。 */
function ogMeta(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const re of [
    new RegExp(`<meta[^>]+property=["']${k}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${k}["']`, 'i'),
  ]) {
    const m = re.exec(html)
    if (m && m[1].trim()) return unescapeHtml(m[1].trim())
  }
  return ''
}

/**
 * 清理抓来的字段。
 *
 * 抽成纯函数是为了**能测** —— 抓取要联网（测试里 flaky），
 * 而"站点标语别当简介"这种判断才是容易写错、且错了很难发现的地方。
 *
 * @param {{title?:string, description?:string}} raw
 * @returns {{title:string, description:string}}
 */
export function cleanAlbumFields(raw = {}) {
  /*
   * ⚠️ **循环剥**，不是剥一次 —— 阅读器页的标题有两层尾巴：
   *     `… [翻譯]|H漫內頁瀏覽 Comics - 禁漫天堂`
   *    第一轮剥 ` - 禁漫天堂`，第二轮才剥掉 `|H漫內頁瀏覽 Comics`。
   *    只剥一次的话会剩一截栏目名挂在那儿（实测就是这么漏的）。
   */
  let title = String(raw.title ?? '').trim()
  for (let i = 0; i < 3; i++) {
    const next = title.replace(SITE_SUFFIX_RE, '').trim()
    if (next === title) break
    title = next
  }
  let description = String(raw.description ?? '').trim()
  if (SITE_SLOGAN_RE.test(description)) description = ''
  return { title, description }
}

/**
 * 抓一部作品的基本信息。
 *
 * @param {object} opts
 * @param {string} opts.id          作品编号（纯数字）
 * @param {JmHostCache} [opts.hosts] 域名缓存
 * @param {number} [opts.timeoutMs]  默认 9000（实测这站要 0.9~3.7s，别给太短）
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @returns {Promise<{id:string,title:string,description:string,url:string,host:string}|null>}
 */
export async function fetchAlbum(opts = {}) {
  const log = opts.log ?? (() => {})
  const id = String(opts.id ?? '').trim()
  if (!/^\d{1,8}$/.test(id)) return null
  const timeoutMs = opts.timeoutMs ?? 9000

  // 先试上次成功的域名，再逐个试候选
  const cached = opts.hosts?.get?.() ?? ''
  const order = [cached, ...DOMAINS].filter(Boolean).filter((h, i, a) => a.indexOf(h) === i)

  for (const host of order) {
    const url = `https://${host}/album/${id}`
    const t0 = Date.now()
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetchWithProxyFallback(url, {
        signal: ctrl.signal,
        timeoutMs,
        redirect: 'follow',
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
      })
      clearTimeout(timer)
      if (!res.ok) { log('warn', `jm：${host} 回 ${res.status}`); continue }

      /*
       * ★★ **先看最终落在哪个路径**（2026-11-02 补，这是之前漏的关键一步）。
       *
       * 实测两个反直觉的事实：
       * ```
       * · /album/350234 → 重定向到 /error/album_missing  且**返回 200**
       *   → 光看状态码会以为"抓到了"，然后拿空页去解析，
       *     最后笼统报"抓不到"。**用户以为功能坏了，其实是编号没了。**
       * · /album/350000 → 重定向到 /album/339768/
       *   → **JM 编号 ≠ 站内作品号**，站会改写。得拿最终那个号去拼后续 URL。
       * ```
       */
      const finalUrl = String(res.url ?? url)
      if (MISSING_PATH_RE.test(finalUrl)) {
        log('info', `jm：${id} 在站上**不存在**（跳到 ${new URL(finalUrl).pathname}）`)
        // 特殊返回：不是"抓取失败"，是"这个编号没有" —— 两者要对用户分开说
        return { id, title: '', description: '', url: finalUrl, host, missing: true }
      }
      const realId = ALBUM_PATH_RE.exec(finalUrl)?.[1] ?? ''

      const buf = await res.arrayBuffer()
      const html = Buffer.from(buf.slice(0, 400_000)).toString('utf8')

      /*
       * ⚠️ **拿到挑战页不算成功**，换下一个域名。
       *    而且注意：**编号不存在时也会给挑战页** —— 所以"挑战页"既可能是
       *    域名不对、也可能是编号不存在。两条都传下去让调用方判断，
       *    别在这里下结论（`notFound` 留给上层决定要不要说"这号没有"）。
       */
      if (CHALLENGE_RE.test(html)) {
        log('warn', `jm：${host} 给的是挑战页（可能是域名过期，也可能这个编号不存在）`)
        continue
      }

      const rawTitle = ogMeta(html, 'og:title')
      const rawDesc = ogMeta(html, 'og:description')
      const { title, description } = cleanAlbumFields({ title: rawTitle, description: rawDesc })
      if (!title && !description) { log('warn', `jm：${host} 页面里没有可用的 og 字段`); continue }

      // 学到当前域名（跟着重定向走）
      let finalHost = host
      try { finalHost = new URL(finalUrl).host } catch { /* ignore */ }
      opts.hosts?.set?.(finalHost)

      log('info', `jm：${id} 抓到了（${host} → ${finalHost}${realId && realId !== id ? `，站内号 ${realId}` : ''}，${Date.now() - t0}ms）`)
      return {
        id,
        // ⚠️ **站内真号**：站会改写编号（350000 → 339768），后续拼 URL 要用这个
        realId: realId || id,
        title,
        description,
        url: finalUrl,
        host: finalHost,
      }
    } catch (e) {
      log('warn', `jm：${host} 失败 — ${String(e?.message ?? e).slice(0, 60)}`)
    }
  }
  log('warn', `jm：${id} 所有候选域名都没抓到`)
  return null
}

/**
 * 把作品信息变成**喂给模型的注记**。
 *
 * ⚠️ 有信息时也**不许编画面** —— 只有标题和描述，
 *    没看过内页就该说"我只看到标题"，不能说"我看到画面里…"。
 */
export function formatAlbumContext(album) {
  /*
   * ★ "编号不存在"要**单独说** —— 这跟"抓取失败"对用户是完全不同的两件事：
   *   · 抓取失败 → "我这边出问题了"（用户会怀疑功能坏了）
   *   · 编号不存在 → "**这个号没有东西**"（用户会去核对编号）
   * 混成一句的话，用户永远不知道该怀疑谁。
   */
  if (album?.missing) {
    return `〔提示：编号 ${album.id} 在禁漫上**不存在**（站自己跳到了"作品缺失"页）。`
      + '可以说"这个号我这边打开是空的 / 站上说没有这个作品"，'
      + '**并让他核对一下编号**。不许猜里面有什么。〕'
  }
  const lines = [`编号：${album.id}`]
  if (album.title) lines.push(`标题：${album.title}`)
  if (album.description) lines.push(`简介：${album.description.slice(0, 300)}`)
  return '## 对方发的这个车牌，我打开看了\n' + lines.join('\n')
    + '\n（只看到标题和简介，**没有看内页画面** —— 别描述画面里有什么。）'
}