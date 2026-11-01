/**
 * B 站链接的**免费**信息抓取（2026-10-31）。
 *
 * ## 为什么需要
 * 群里分享 B 站视频时，机器人拿到的只有 `【标题】https://...` ——
 * 她不点链接、也不会去看，**只能从标题猜**。标题党的话基本等于瞎聊。
 *
 * ## 实测（本机、无 cookie、无登录）
 * ```
 * GET https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7
 *   code=0  title=【官方 MV】…  owner=索尼音乐中国  dur=213s  播放=1.08亿
 * ```
 * **完全免费、免登录** —— 只要带 `Referer: https://www.bilibili.com/` 和普通 UA。
 *
 * ## 字幕：拿不到（所以不做）
 * `/x/player/v2?bvid=&cid=` 匿名访问 `subtitle.subtitles` **恒为 0 条**
 * （B 站 CC 字幕要登录态）。所以**不指望"看内容"，只给元信息 + 简介**。
 * 简介（desc）通常就是内容概述，对教程/评测类已经够模型接话了。
 *
 * ## 短链
 * `b23.tv/xxxx` 要**跟随跳转**才能拿到真 BV 号（`res.url` 里）。
 */

/** BV 号：`BV` + 10 位（base58 风格，无 0/o/i/l）。 */
const BV_RE = /\bBV[1-9A-HJ-NP-Za-km-z]{10}\b/
/** 短链。 */
const B23_RE = /https?:\/\/b23\.tv\/[A-Za-z0-9]+/i
/** 任意 B 站视频链接（含 av 号、带参数的）。 */
const BILI_RE = /https?:\/\/(?:www\.)?bilibili\.com\/video\/[^\s"'）)]+/i

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/**
 * 从一段文本里找 BV 号（直接给 BV 或 bilibili.com/video/BV… 都行）。
 * @param {string} text
 * @returns {string|null}
 */
export function extractBvid(text) {
  const m = String(text ?? '').match(BV_RE)
  return m ? m[0] : null
}

/**
 * 这段文本里有没有 B 站链接（BV / b23 短链 / bilibili.com/video）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasBiliLink(text) {
  const s = String(text ?? '')
  return BV_RE.test(s) || B23_RE.test(s) || BILI_RE.test(s)
}

/**
 * 把 `b23.tv/xxx` 跟跳到真链接，取出 BV 号。
 *
 * @param {string} text
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<string|null>}
 */
export async function resolveBvid(text, opts = {}) {
  const s = String(text ?? '')
  // ① 文本里直接有 BV 号 → 最省事
  const direct = extractBvid(s)
  if (direct) return direct
  // ② 短链 → follow redirect
  const short = s.match(B23_RE)
  const target = short ? short[0] : (s.match(BILI_RE)?.[0] ?? null)
  if (!target) return null
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return null
  try {
    const ctl = AbortSignal.timeout(Number(opts.timeoutMs ?? 8000))
    const res = await fetchImpl(target, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: ctl,
    })
    // 跳转后的真实地址（fetch 会自动跟）
    const finalUrl = String(res?.url ?? target)
    return extractBvid(finalUrl)
  } catch {
    return null
  }
}

/**
 * 抓视频元信息（免费接口）。
 *
 * @param {string} bvid
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<null|{bvid:string,title:string,owner:string,duration:number,view:number,desc:string,cid:number}>}
 */
export async function fetchVideoInfo(bvid, opts = {}) {
  const id = String(bvid ?? '').trim()
  if (!BV_RE.test(id)) return null
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return null
  try {
    const ctl = AbortSignal.timeout(Number(opts.timeoutMs ?? 8000))
    const res = await fetchImpl(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(id)}`,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json',
        },
        signal: ctl,
      },
    )
    const j = await res.json()
    if (j?.code !== 0 || !j?.data) return null
    const d = j.data
    return {
      bvid: id,
      aid: Number(d.aid ?? 0),
      cid: Number(d.cid ?? 0),
      title: String(d.title ?? '').trim(),
      owner: String(d.owner?.name ?? '').trim(),
      duration: Number(d.duration ?? 0),
      view: Number(d.stat?.view ?? 0),
      desc: String(d.desc ?? '').trim(),
    }
  } catch {
    return null
  }
}

/**
 * 抓**热门评论**（免登录；`x/v2/reply/main` 返回的本身就是按热度排的）。
 *
 * @param {number} aid
 * @param {{limit?:number, fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<Array<{like:number, text:string}>>}
 */
export async function fetchTopComments(aid, opts = {}) {
  const id = Number(aid)
  if (!Number.isFinite(id) || id <= 0) return []
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return []
  const limit = Math.max(1, Number(opts.limit ?? 5))
  try {
    const ctl = AbortSignal.timeout(Number(opts.timeoutMs ?? 8000))
    const res = await fetchImpl(
      `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${id}&mode=3&next=0`,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json',
        },
        signal: ctl,
      },
    )
    const j = await res.json()
    if (j?.code !== 0) return []
    const out = []
    for (const rp of j.data?.replies ?? []) {
      const t = String(rp.content?.message ?? '').replace(/\s+/g, ' ').trim()
      if (!t) continue
      // 纯表情/纯符号的评论没信息量
      if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) continue
      out.push({ like: Number(rp.like ?? 0), text: t.slice(0, 120) })
      if (out.length >= limit) break
    }
    return out
  } catch {
    return []
  }
}

/**
 * 抓**弹幕**，按「出现次数」取最有代表性的（免登录）。
 *
 * ## 为什么按次数而不是按时间
 * 弹幕的价值在**重复** —— 同一个梗被刷了几十遍，那就是这个视频的"共识"。
 * 按时间取前 20 条只是开头几秒的零星反应，没什么代表性。
 * （实测那条 MV：`非 物 质 文 化 遗 产`、`永不撒谎，不伤害你` 都是高频梗。）
 *
 * ## 接口
 * `x/v1/dm/list.so?oid=<cid>` 返回 deflate 压缩的 XML（**也可能没压**），
 * 所以要「先试解压、失败按原文读」两种都兜住。
 *
 * @param {number} cid
 * @param {{limit?:number, fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<Array<{text:string, count:number}>>}
 */
export async function fetchDanmaku(cid, opts = {}) {
  const id = Number(cid)
  if (!Number.isFinite(id) || id <= 0) return []
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return []
  const limit = Math.max(1, Number(opts.limit ?? 10))
  try {
    const ctl = AbortSignal.timeout(Number(opts.timeoutMs ?? 10000))
    const res = await fetchImpl(`https://api.bilibili.com/x/v1/dm/list.so?oid=${id}`, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
      signal: ctl,
    })
    let buf
    if (typeof res.arrayBuffer === 'function') buf = Buffer.from(await res.arrayBuffer())
    else buf = Buffer.from(await res.text(), 'utf8')
    let xml = ''
    try {
      const zlib = await import('node:zlib')
      for (const fn of [zlib.inflateRawSync, zlib.inflateSync, zlib.gunzipSync]) {
        try { xml = fn(buf).toString('utf8'); break } catch { /* 试下一个 */ }
      }
    } catch { /* 没 zlib 就按原文读 */ }
    if (!xml) xml = buf.toString('utf8')
    // 解析 <d p="...">正文</d>
    const counts = new Map()
    for (const m of xml.matchAll(/<d p="[^"]*">([^<]+)<\/d>/g)) {
      const t = m[1].replace(/\s+/g, ' ').trim()
      if (!t) continue
      if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) continue
      if (t.length > 30) continue // 太长的多半是复制粘贴的长评，不是弹幕梗
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    const arr = [...counts.entries()].map(([text, count]) => ({ text, count }))
    // 先按次数，再按长度（短的更像弹幕梗）
    arr.sort((a, b) => b.count - a.count || a.text.length - b.text.length)
    return arr.slice(0, limit)
  } catch {
    return []
  }
}

/** 秒 → 「12分34秒」/「1小时02分」。 */
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${String(m % 60).padStart(2, '0')} 分`
}

/** 万/亿 缩写。 */
function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)} 亿`
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)} 万`
  return String(v)
}

/**
 * 拼成给模型看的一段（**说明这是真实抓到的元信息，不是你的猜测**）。
 *
 * ⚠️ 明确写「你没看过视频」—— 否则模型会顺着简介编出"我看过了"。
 *
 * @param {object} info `fetchVideoInfo` 的返回
 * @param {number} [descLimit]
 * @returns {string}
 */
export function formatVideoContext(info, descLimit = 160) {
  if (!info || !info.title) return ''
  const parts = []
  parts.push(`标题：${info.title}`)
  if (info.owner) parts.push(`UP主：${info.owner}`)
  if (info.duration) parts.push(`时长：${fmtDuration(info.duration)}`)
  if (info.view) parts.push(`播放：${fmtCount(info.view)}`)
  const desc = String(info.desc ?? '').replace(/\s+/g, ' ').trim()
  /*
   * B 站简介经常是**占位符**而不是内容 —— 实测见过 `-`、`www`、`...`。
   * 这些塞给模型只会让它以为"简介就这"，反而更糊涂。
   * （`www` 只有 3 个字，光判 `length > 2` 挡不住，得按形态判。）
   */
  const isJunkDesc = (d) =>
    !d
    || d.length < 3
    || /^[-—_.·。、，,~/\\\s]+$/.test(d)
    || /^w{2,}$/i.test(d)
  if (!isJunkDesc(desc)) {
    parts.push(`简介：${desc.slice(0, descLimit)}${desc.length > descLimit ? '…' : ''}`)
  }
  let body = `## 对方分享的 B 站视频\n${parts.join('\n')}`

  /*
   * ★ **评论区**（2026-10-31）—— 用户原话：「评论和弹幕才是重点」。
   * 标题/简介只是作者自述；评论是**观众怎么看**，对群里接话有用得多。
   */
  const comments = Array.isArray(info.comments) ? info.comments : []
  if (comments.length > 0) {
    const lines = comments.map((c) => `· 【${fmtCount(c.like)}赞】${c.text}`)
    body += `\n\n## 评论区怎么说（按点赞）\n${lines.join('\n')}`
  }

  /*
   * ★ **弹幕** —— 按「出现次数」取，重复多的就是这视频的梗。
   * 只列 `count >= 2` 的（只出现一次的不叫梗，列出来反而乱）。
   */
  const danmaku = Array.isArray(info.danmaku) ? info.danmaku : []
  const hotDm = danmaku.filter((d) => d.count >= 2)
  if (hotDm.length > 0) {
    const lines = hotDm.map((d) => `· ×${d.count} ${d.text}`)
    body += `\n\n## 弹幕在刷什么（按出现次数）\n${lines.join('\n')}`
  }

  body += '\n（⚠️ 上面是**抓到的真实评论/弹幕**，不是你的猜测；但你**没看过这个视频本身**。'
    + '按大家的反应接话就行；真要聊视频里讲了啥、而评论弹幕没说，就直说没看过、别编。）'
  /*
   * ★ **必须"说"出来**（2026-10-31）。
   *
   * 实测踩过：这条信息**确实进了 system prompt**（8365 字里第 3573 字），
   * 但模型只回「换了个链接啊，这次本鱼没看出是哪个」—— **连标题都没用**。
   *
   * 根因是**优先级冲突**：输出要求里写着「默认往短了说…别把知道的都倒出来」，
   * 模型把"有料"理解成"不用讲"。而**真人收到视频分享是会说的**
   * （「看了，评论都在刷『你就宠她吧』」）。
   *
   * 所以这里明确要求：**至少提一个具体的东西**（标题 / 评论 / 弹幕），
   * 而不是靠它自觉。而且给的是**短句示范**，不违反"往短了说"。
   */
  body += '\n⚠️ **对方分享了视频，你得说点具体的** —— 光「看到了」等于没看。'
    + '挑**一个**最有意思的说：标题里那个点、或者评论区在刷什么、或者弹幕的梗。'
    + '一两句就够（「评论区都在刷你就宠她吧」这种），**不用把上面全念一遍**。'
  return body
}
