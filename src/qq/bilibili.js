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
 * ## 字幕：拿不到，所以改成**听**
 * `/x/player/v2?bvid=&cid=` 匿名访问 `subtitle.subtitles` **恒为 0 条**
 * （B 站 CC 字幕要登录态）。AI 总结接口也 `-403`。
 *
 * **但音频流是免登录的**（2026-11-01 实测）：
 * ```
 * x/player/playurl?fnval=16  → dash.audio[]  每条带 baseUrl + backupUrl
 * ```
 * 拿到地址就能下载 → 本地 whisper 转写 → **等于"听懂"了视频说了什么**。
 *
 * ⚠️ **主地址常常连不上**（实测 `mcdn.bilivideo.cn:8082` DNS 直接解析不了），
 * 但 `backupUrl` 里的 `*.bilivideo.com` 能下。所以必须**按顺序试所有候选**。
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
 * @param {{fetchImpl?:Function, timeoutMs?:number, log?:object}} [opts]
 *   `log` 用来把**跳转失败的原因**说出来 —— 见下面的 catch。
 *   2026-11-01 实测事故：这里原来是 `catch { return null }`（**静默**），
 *   而当时环境里配的代理（`https_proxy=127.0.0.1:7890`）**没在跑** →
 *   短链一律 ECONNREFUSED → 返回 null → 日志里**一个字都没有**。
 *   用户问「鱼说又看不了视频了」，只能靠手工复现才查出原因。
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
  let body = `## 对方分享的 B 站视频（**他刚发来的，你以前没看过**）\n${parts.join('\n')}`

  /*
   * ★ **长视频：还在后台听**（2026-11-01）—— 见 `_biliContext`。
   *
   * 长视频的音频太大（26 分钟那条就有 12.9MB，超过 12MB 上限），同步转写会让回复
   * 多等十几秒（用户明确抱怨过的量级）。所以改成：**先回一句**，
   * 转写丢后台（只取开头 2MB），完了再补一条。
   *
   * ⚠️ 这里必须**在最前面就返回**，连评论/弹幕都不给 —— 两个理由：
   *   ① 下面弹幕那段会追加一句「你**没看过**这个视频本身」，
   *      和我这句「先应一声」**自相矛盾**（这个仓库为同类矛盾修过一次注释）。
   *   ② 用户要的就是「先回复我先看看」：**一条短的应声**，
   *      不是拿评论弹幕硬凑一段"观后感"。评论区一给，它就会去念。
   */
  if (info.pendingLong) {
    body += '\n\n⚠️ **这条比较长，你刚开始听** —— 也就是说：**你现在还不知道里面讲了什么。**\n'
      + '先应一声就行（「我去看看」「等下跟你说」这种，一两句，语气随意）。\n'
      + '**别装作看过，也别拿标题硬凑"内容"。** 等听完了再聊里面具体的东西。'
    return body
  }

  /*
   * ★★ **视频里说了什么**（2026-11-01）—— 放在评论**前面**。
   *
   * 这是唯一"真内容"：评论是别人怎么看，弹幕是别人在刷什么，
   * 只有这段是**视频本身**。
   *
   * ⚠️ 转写是 whisper 出的，会有错字（尤其人名/术语，实测
   * 「DeepSeek Harness」被转成「DipSikHanis」）。所以要明说"可能有错字"，
   * 别让模型拿它当精确引文。
   */
  const transcript = String(info.transcript ?? '').trim()
  /*
   * ⚠️ **太短的转写 = 没语音**（2026-11-01）。
   *
   * 实测音乐视频（`gemini 翻唱《人是猫》`，132 秒）只转出 20 个字：
   * ```
   * Hit-o-watt-dada-dada
   * ```
   * 那是**歌词拟声**，不是内容。这种塞给模型只会让它拿"dada-dada"瞎猜。
   * 所以短于 30 字就当成"没有可用语音"，只给元信息。
   */
  const USABLE_TRANSCRIPT_MIN = 30
  const usableTranscript = transcript.length >= USABLE_TRANSCRIPT_MIN ? transcript : ''

  if (usableTranscript) {
    /*
     * ★ **只听了开头一段**（2026-11-01）：长视频走异步补听，
     *   这里拿到的是**前缀转写**（Range 取的 2MB ≈ 前 4 分钟）。
     *
     * ⚠️ **必须说清范围** —— 不然她会把开头几分钟当成整条视频，
     *    后面一旦聊到结尾就露馅（这跟"别装作看过"是同一类毛病）。
     */
    const headNote = info.prefixOnly
      ? '（你**只听了开头几分钟**，不是整条 —— 后面发生了什么你没听到，\n'
        + '别把开头的东西说成"整条都在讲这个"。）'
      : '（这段是**机器听写**的，大意准，但人名/术语可能有错字 —— '
        + '别把里面的词当精确引文，也别逐字复述。）'
    body += `\n\n## ${info.prefixOnly ? '视频开头讲了什么' : '视频里说了什么'}（**你刚听到的**语音转文字）\n${usableTranscript.slice(0, 1200)}`
      + (usableTranscript.length > 1200 ? '…' : '')
      + '\n' + headNote
  } else if (transcript) {
    /*
     * 有转写但太短 → 大概率是唱歌 / 纯音乐 / 只有音效。
     *
     * ⚠️ 这里**只说"没有台词"这个事实**，不指定"该聊什么" ——
     * 「该聊什么」统一放到结尾那段说（那里才看得到弹幕/评论长什么样）。
     * 之前两处都写了建议，结果**互相矛盾**（这里说"聊标题"、结尾说"别聊标题"）。
     */
    body += '\n\n（这条**没有台词** —— 转出来只有拟声词（"dada-dada"这种），'
      + '说明它是**唱歌 / 纯音乐 / 没配音**。别拿那串拟声词当内容。）'
  }

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

  /*
   * ⚠️ **结尾的提醒要分情况**（2026-11-01 修）。
   *
   * 原来一律写「你没看过这个视频本身」—— 但**有转写时这句话就是错的**：
   * 已经听过语音了，再说"没看过"会让模型自我怀疑（实测它真的回
   * 「本鱼一条都没真看到啊」）。所以有转写和没转写要说不同的话。
   */
  if (usableTranscript) {
    /*
     * ⚠️ **措辞要点：先说"你知道内容"，再说"画面细节不知道"**（2026-11-01）。
     *
     * 原来写的是「你听过这条视频的语音，但**没看过画面**」——
     * 实测模型抓住"没看过"三个字，回「这条没看到内容诶，是个啥」，
     * **明明上面 546 字转写就在 prompt 里**。
     *
     * 这是措辞顺序的问题：**负面暗示在前，模型就只记住负面**。
     * 改成正面陈述在前。
     */
    body += '\n（⚠️ 上面那段**就是视频里说的话**（机器听写）—— 你刚听到，所以**知道它讲了什么**。'
      + '只有**画面细节**（表情、演示、字幕贴纸）你没看到，那种别编。'
      + '⚠️ 如果是动画/短剧配音，听写出来会是**角色之间的对话**（有"我""你"来回）——'
      + '那是剧情台词，不是有人在跟你说话，别对着台词直接答。）'
  } else if (transcript) {
    /*
     * 有转写但太短 → 唱歌 / 纯音乐 / 只有音效。
     *
     * ⚠️ **这里什么都不加** —— "没有台词"这句话在**上面渲染转写的地方**
     * 已经说过一次了（紧跟在标题/简介后面，位置更自然）。
     * 这里再加一遍就是**同一句出现两次**，白占 prompt。
     * 实测过：两处都写，模型反而更乱。
     */
  } else {
    body += '\n（⚠️ 上面是**抓到的真实评论/弹幕**，不是你的猜测；但你**没看过这个视频本身**。'
      + '按大家的反应接话就行；别聊视频里讲了啥、也**别编「我点开想干嘛」**。）'
    /*
     * ★★ **连"我点开想看什么"也不许编**（2026-11-02 实测事故）。
     *
     * 现场：视频标题是「你爸回你消息了」，评论弹幕全在聊"大肥鱼/赛博养鱼"。
     * 她的回复是：
     *   「（看完，先笑了一声）**点开想学修电脑**，结果评论全在要饭。」
     *
     * - 「点开想学修电脑」—— 标题/简介/评论/弹幕里**一个字都没有**，纯编
     * - 「评论全在要饭」—— 半对（弹幕「人来！✋😡🤚」确实像在喊人）
     *
     * **为什么上面那句警告没拦住**：它只禁"聊视频里讲了啥"。
     * 而"我点开是想学修电脑"是**编了个观看理由** —— 模型不觉得那算"讲内容"，
     * 而且它比"我没看过"更像聊天，所以选了它。
     *
     * ⚠️ **这段必须短**：B 站上下文有个"距结尾不超过 600 字"的约束
     *    （见 `tests/check-prompt-order.mjs`），加长了会把 B 站那段推出窗口，
     *    约束力反而变弱 —— 第一版写了 180 字，两个测试当场就红了。
     */
  }

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
   * 所以这里明确要求：**至少提一个具体的东西**，而不是靠它自觉。
   * 而且给的是**短句示范**，不违反"往短了说"。
   *
   * ⚠️ 有转写时，**转写内容排第一优先** —— 那才是"视频说了什么"。
   *
   * ⚠️⚠️ 还有一条**措辞禁令**（2026-11-01 实测）：
   * 不许说「这个有印象」/「我记得」/「以前看过」。
   * 实测它回「**这个有印象**，冰棍是从地下一百米挖出来的万年冰…」——
   * 内容全对，但「有印象」是**假话**（明明刚收到）。
   * 这属于"把刚拿到的信息说成自己的记忆"，比说错更让人不舒服。
   */
  /*
   * ★★ **三样信息各有分工，要结合起来用**（2026-11-01 用户提出）。
   *
   * 用户原话：「都参考怎么样，分开分类，弹幕，音频，评论三者结合」。
   *
   * 对 —— 现在只是把三段**平铺**在那儿，没告诉模型它们**分别回答什么问题**。
   * 于是它要么只念一样，要么把三样混着倒。
   *
   * 定角色：
   *   · **音频转写** = 视频**本身**（讲了什么）
   *   · **弹幕**     = **当场反应**（哪个瞬间炸了、哪句被反复刷 = 梗）
   *   · **评论**     = **事后评价**（值不值、大家怎么看）
   *
   * 三样合起来才是"看完一个视频的真实感受"。
   * 位置：**最末尾**（紧贴生成位置，前面验证过位置越靠后约束力越强）。
   */
  const hasTranscript = Boolean(usableTranscript)
  const hasDanmaku = hotDm.length > 0
  const hasComments = comments.length > 0

  if (hasTranscript || hasDanmaku || hasComments) {
    const roles = []
    if (hasTranscript) roles.push('**音频转写** = 视频本身讲了什么（内容）')
    if (hasDanmaku) roles.push('**弹幕** = 当场反应（哪个瞬间炸了、哪句被反复刷 = 梗）')
    if (hasComments) roles.push('**评论** = 事后评价（值不值、大家在吐槽什么）')
    if (roles.length >= 2) {
      body += '\n\n## 上面这几块怎么用（**结合起来，别只念一样**）\n'
        + roles.map((r) => `· ${r}`).join('\n')
        /*
         * ⚠️ 措辞要**动态**（2026-11-01）：
         * 原来写死「三样是互补的」，但实测有条视频弹幕全是 count=1（被过滤掉），
         * 实际只有**两样**（转写 + 评论）→ 文案和事实对不上，模型会找不存在的第三样。
         */
        + `\n\n⚠️ 这${roles.length === 3 ? '三' : '两'}样是**互补**的，不是几份材料各念一句 —— `
        + '真人看完一个视频，说的是"讲了什么 + 哪里好玩 + 值不值"的**混合体**。'
        + '比如：「视频讲 X，但评论区全在说 Y」/「大家觉得 Z，我看完觉得…」'
    }
  }

  body += '\n⚠️ **对方分享了视频，你得说点具体的** —— 光「看到了」等于没看。'
  if (hasTranscript) {
    body += '从**听写**里挑一件事说（视频讲了什么、他提了什么梗），'
      + '再叠一句**弹幕或评论**里的反应。'
  } else if (transcript) {
    // 音乐 / 纯音乐：**别拿标题当话题**，内容在听众反应里
    body += '这条没有台词，所以**从弹幕和评论里挑** —— '
      + '弹幕反复刷的那句、或者评论区在说的梗，挑一个说。**别聊标题**（歌名没信息量）。'
  } else {
    body += '挑**一个**最有意思的说：标题里那个点、或者评论区在刷什么、或者弹幕的梗。'
  }
  body += '一两句就够，**不用把上面全念一遍**。'
  body += '\n⚠️ **别写「这个有印象」/「我记得」/「以前看过」** —— '
    + '这是**刚收到**的视频，你以前没看过。直接说「看了」「这条…」就行。'
  return body
}

/**
 * 拿**音频流**的候选地址（免登录，2026-11-01）。
 *
 * ## 为什么能拿到
 * `x/player/playurl` 是匿名可用的 —— 它返回 DASH 清单，
 * 里面每条音轨都有 `baseUrl` + `backupUrl[]`。
 * **不需要登录、不需要 cookie**，只要 Referer + 普通 UA。
 *
 * ## ⚠️ 必须返回**一组**地址，不是一个
 * 实测：`baseUrl` 常常指向 `mcdn.bilivideo.cn:8082` ——
 * **这个域名在本机 DNS 直接解析不了**（`EBADNAME`），下载必然失败。
 * 而 `backupUrl` 里的 `*.bilivideo.com` 能通（HTTP 200）。
 *
 * 所以这里**把主地址和所有备用地址平铺成一个列表**，由调用方按顺序试。
 *
 * @param {string} bvid
 * @param {number} cid
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<string[]>} 候选地址（可能为空）
 */
export async function fetchAudioCandidates(bvid, cid, opts = {}) {
  const id = String(bvid ?? '').trim()
  const c = Number(cid)
  if (!BV_RE.test(id) || !Number.isFinite(c) || c <= 0) return []
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return []
  try {
    const ctl = AbortSignal.timeout(Number(opts.timeoutMs ?? 8000))
    const res = await fetchImpl(
      `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(id)}&cid=${c}&fnval=16&fourk=1`,
      {
        headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
        signal: ctl,
      },
    )
    const j = await res.json()
    if (j?.code !== 0) return []
    const audios = j.data?.dash?.audio ?? []
    if (!audios.length) return []
    // 挑**码率最低**的那条（转写够用，体积最小）
    const pick = audios.slice().sort((a, b) => Number(a.bandwidth ?? 0) - Number(b.bandwidth ?? 0))[0]
    const urls = [pick.baseUrl, pick.base_url, ...(pick.backupUrl ?? []), ...(pick.backup_url ?? [])]
      .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
    // 去重，保持顺序
    return [...new Set(urls)]
  } catch {
    return []
  }
}

/**
 * 按顺序试候选地址，下第一个成功的。
 *
 * ⚠️ **大小上限是硬要求**：长视频的音频能到几十 MB，
 * 转写之前得先把内存撑爆了。默认 12MB（约 20 分钟中等码率）。
 *
 * ## ★ 只要开头一段（2026-11-01）
 *
 * 传 `prefixBytes` 就发 `Range: bytes=0-N-1`，只要**开头 N 字节**。
 * 这是给长视频用的：26 分钟的音频有 12.9MB，会被上面的 `maxBytes` 直接挡死 ——
 * 于是**长视频连一句内容都没有**（实测：两道门，300 秒时长 + 12MB 音频）。
 *
 * 实测（BV1dXxp6xEk3，26 分 46 秒）：
 * ```
 * accept-ranges=bytes                       ← B 站 CDN 支持
 * Range: 0-2MB     → HTTP 206，2.00MB，496ms
 * 2MB ≈ 前 4 分 09 秒音频
 * whisper(tiny)    → 1518 字，用时 9.6s      ← 截断的 m4a **能解码**（这点必须先验）
 * ```
 * 截断的 m4a 之所以能解：DASH 的 moov 在文件前部，前缀就是一段可播的音频。
 * 但这**不是普适真理** —— 换平台/换封装就可能解不了，所以调用方拿到空串要当"没听到"。
 *
 * @param {string[]} candidates
 * @param {{fetchImpl?:Function, maxBytes?:number, timeoutMs?:number, prefixBytes?:number, log?:object}} [opts]
 * @returns {Promise<{buffer:Buffer, url:string, truncated:boolean}|null>}
 */
export async function downloadAudio(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : []
  if (!list.length) return null
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return null
  const maxBytes = Number(opts.maxBytes ?? 12 * 1024 * 1024)
  const timeoutMs = Number(opts.timeoutMs ?? 25000)
  /** >0 = 只取开头这么多字节（长视频用）；0 = 整条下（原行为） */
  const prefixBytes = Math.max(0, Number(opts.prefixBytes ?? 0))
  for (const url of list) {
    try {
      const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
      if (prefixBytes > 0) headers.Range = `bytes=0-${prefixBytes - 1}`
      const ctl = AbortSignal.timeout(timeoutMs)
      const res = await fetchImpl(url, { headers, signal: ctl })
      /*
       * ⚠️ Range 模式下**必须是 206**。有的 CDN 不认 Range 会回 200（整条），
       * 那就等于白下了几十 MB —— 宁可换下一个源，也不要在这里悄悄下整条。
       */
      if (prefixBytes > 0 && res.status !== 206) {
        opts.log?.debug?.(`B站音频：${hostOf(url)} 不支持 Range（HTTP ${res.status}），换下一个源`)
        continue
      }
      if (!res.ok && res.status !== 206) {
        opts.log?.debug?.(`B站音频：${hostOf(url)} HTTP ${res.status}`)
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 1024) {
        opts.log?.debug?.(`B站音频：${hostOf(url)} 内容太小（${buf.length}B）`)
        continue
      }
      if (buf.length > maxBytes) {
        opts.log?.info?.(`B站音频：${hostOf(url)} 太大（${(buf.length / 1048576).toFixed(1)}MB > 上限），跳过`)
        return null
      }
      // truncated=true 表示这是**开头一段**，不是完整音频 —— 调用方要据此如实告诉模型
      return { buffer: buf, url, truncated: prefixBytes > 0 }
    } catch (e) {
      // DNS 解析不了 / 连接重置 —— 换下一个，别抛
      opts.log?.debug?.(`B站音频：${hostOf(url)} 失败 — ${String(e?.message ?? e).slice(0, 60)}`)
    }
  }
  return null
}

/** 取 URL 的 host（只用于日志，失败给 `?`）。 */
function hostOf(url) {
  try { return new URL(url).host } catch { return '?' }
}
