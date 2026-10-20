/**
 * 联网搜索：让机器人能回答"新闻 / 新版本 / 这事真假"这类**训练数据之外**的问题。
 *
 * ## 为什么需要
 *
 * 我们的模型（各免费渠道）训练数据都有截止日期。实测踩过：
 * 群里发了「GPT-6 Luna 已向免费用户开放」的截图，机器人回
 * 「这图一眼假，纯段子」—— 而 GPT-6 Luna **确实存在**（2026-09 发布），
 * 连它自己的模型库里都有 `gpt-6-luna`。它靠过时记忆否定了真实信息。
 *
 * 接上联网后，这类问题先查再答。
 *
 * ## 为什么不用 DSH 的搜索插件
 *
 * dsh-web-search-deepseek 是 cordis 插件，peer 依赖一大串
 * （dsh-agent / dsh-session / dsh-launch-environment…），
 * 而 WhalePod 只有一个极简的独立 Context。直接调它底层的
 * Anthropic 兼容接口更省事，也少一层版本耦合。
 *
 * ## 返回结构（实测）
 *
 *   content: [
 *     { type:'text', text:'我来帮您搜索…' },
 *     { type:'server_tool_use', ... },
 *     { type:'web_search_tool_result', content:[{type,title,url,encrypted_content}] },
 *     { type:'text', text:'综合后的答案（带引用）' },   ← 这才是我们用的
 *   ]
 *
 * ⚠️ 搜索结果**没有明文摘要**（只有 title/url，正文是 encrypted_content）。
 *    所以不能自己拼摘要，必须用接口合成的最后那段 `text`。
 */

const SEARCH_URL = process.env.DEEPSEEK_SEARCH_BASE_URL
  ? String(process.env.DEEPSEEK_SEARCH_BASE_URL).replace(/\/$/, '') + '/messages'
  : 'https://api.deepseek.com/anthropic/v1/messages'

/**
 * 用于搜索的模型（必须支持 web_search 服务端工具）。
 *
 * 选 flash 而不是 chat 的原因，实测数据（2026-10）：
 *
 *   模型                        耗时      单次费用    每月100次
 *   deepseek-chat（原）          6.8s     ¥0.060     ¥6.00
 *   deepseek-flash + 开推理     12.3s     ¥0.030     ¥3.00
 *   deepseek-flash + 禁推理      3.2s     ¥0.011     ¥1.14   ← 现在
 *
 * 两个关键点：
 *   · flash 的**输入**价只有 chat 的一半（0.14 vs 0.28 /M）——
 *     搜索场景输入是大头（搜索结果正文全塞进上下文，2~3 万 token），
 *     所以这一项才是省钱的地方，输出价降幅反而是次要的。
 *   · 必须**禁用推理**。flash 默认先输出 thinking，实测 1500 max_tokens
 *     会被思考吃光（stop_reason: max_tokens，正文 0 字）。禁掉之后
 *     输出从 ~2000 降到 ~600，正文完整、速度还快一半。
 */
const SEARCH_MODEL = process.env.DEEPSEEK_SEARCH_MODEL || 'deepseek-flash'

/**
 * 判断一句话是不是"需要联网才能答"。
 *
 * 分两档：
 *   explicit —— 用户明确让查（"搜一下""帮我查查"），一定搜
 *   implicit —— 问的是时效性内容（"最新""刚出""真的假的"），且是疑问句才搜
 *
 * 为什么不一味搜：每次搜索要 5~15 秒，还会烧一次模型调用。
 * 群聊里绝大多数消息是闲聊，不该为它们付这个代价。
 *
 * @param {string} text
 * @returns {{need:boolean, why:string, query:string}}
 */
export function needsFreshInfo(text) {
  const t = String(text ?? '').trim()
  if (!t) return { need: false, why: '', query: '' }

  // ① 明确要求联网 / 搜索
  const explicit = /(搜一下|搜索|搜搜|查一下|查查|帮我查|百度|谷歌|google|上网|联网|网上说|去网上|b?ing)/i
  if (explicit.test(t)) {
    return { need: true, why: '用户明确要求搜索', query: cleanQuery(t) }
  }

  // ② 时效性 / 真伪类问题
  //
  // ⚠️ 这里的关键词要收得紧一点。踩过的两个坑：
  //    · 单独一个「今天」会把「今天中午吃什么」误判成要联网 —— 生活闲聊
  //      不该付这个代价（一次搜索 5~15 秒）。所以「今天」必须和
  //      新闻类词同现才算。
  //    · 反过来，「黑神话出新DLC了吗」这种有明确时效诉求的反而漏了 ——
  //      得把「出了/发售/上线/新作」这类也算上。
  const fresh = new RegExp([
    '最新', '最近', '刚刚', '新闻', '发布会', '发布了',
    '什么时候', '哪年', '几号', '更新了', '新版本', '版本号',
    '涨价', '降价', '真的假的', '是不是真的', '有没有这回事', '证实', '辟谣',
    // 「出了吗 / 发售 / 上线 / 新作 / 新出 / 出了」—— 游戏、剧集、产品都常用
    // 「出新X了吗」这种口语说法（如"黑神话出新DLC了吗"）用「出新」兜住
    '出了吗', '出没出', '出新', '出[^？?，。]{0,6}(了吗|了没)',
    '发售', '上线', '开服', '新作', '新出', '出了',
    // 「今天」+ 新闻类词才触发（避免"今天吃什么"误判）
    '今天.{0,6}(新闻|发布|消息|比赛|更新|出|上线|发售)',
    '昨天.{0,6}(新闻|发布|消息|比赛|更新|出|上线|发售)',
    // ── 番剧 / 影视 / 游戏赛事：这几类是「知识截止」重灾区 ──
    // 模型训练数据永远落后一季，问「这季有什么好看的新番」它只会从
    // 旧记忆里翻几年前的作品，或者干脆编一个不存在的新番名 —— 必须查。
    '新番', '番剧', '这一季', '这季', '本季', '当季',
    '开播', '完结', '续订', '第二季', '第三季', '第[二三四五]季',
    '剧场版', '动画化', '漫画.*动画', '轻小说.*动画',
    '这个月.*(番|动画|剧|电影)', '这周.*(番|动画|剧|电影)',
    '最近.*(番|动画|剧|电影|游戏)', '新出.*(番|动画|剧|游戏)',
    '上映', '定档', '预告片', 'pv', 'PV',
    '赛季', '开赛', '决赛', '夺冠', '转会',
  ].join('|'), 'i')
  // ⚠️ 别只认「吗/呢/问号」。口语里「这季新番有啥好看的」完全是疑问句，
  //    但没有一个传统疑问标记 —— 原来这种就漏了，模型只能硬编。
  const question = /[?？]|吗|呢|是不是|有没有|怎么|什么|多少|如何|啥|哪些|哪个|哪个好|推荐/.test(t)
  if (fresh.test(t) && question) {
    return { need: true, why: '问的是时效性内容', query: cleanQuery(t) }
  }

  // ③ 出现"某模型/产品 + 存在性/真伪"的组合（我们踩过的坑）
  if (/(真的|假的|存在|有没有|发布了|开放)/.test(t) && /[A-Za-z][A-Za-z0-9.\-]{2,}/.test(t)) {
    return { need: true, why: '在问某个具体名字的真伪/存在', query: cleanQuery(t) }
  }

  // ④ 出现**具体的专有名词**（人名 / 作品名 / 产品名）—— 优先查
  //
  // 为什么单独做一条：模型对"具体名字"最容易翻车。它会把《咒术回战》的
  // 作者记成别人、把新番的导演说错、把一个真实存在的人说成虚构角色 ——
  // 而且**说得非常肯定**。这类错误比"不知道"伤害大得多。
  //
  // 判断依据（宁可多搜几次，也别让人名/作品名被编）：
  //   · 书名号 / 引号包起来的内容  → 必然是作品名
  //   · 拉丁字母词（≥3 字符）      → 产品名 / 外文人名
  //   · 中文「XX的YY」「YY·XX」结构 → 常见人名/作品名形态
  const properNoun = detectProperNoun(t)
  if (properNoun) {
    return { need: true, why: `提到具体名字「${properNoun}」`, query: cleanQuery(t) }
  }

  return { need: false, why: '', query: '' }
}

/**
 * 找出消息里最像"专有名词"的那一段。找不到返回 ''。
 *
 * ⚠️ 这里有意做得"敏感"：误判的代价只是多花 5 秒查一次，
 *    而漏判的代价是模型编造一个名人/作品的事实 —— 后者严重得多。
 */
function detectProperNoun(t) {
  // ① 书名号 / 各种引号包起来的 —— 几乎必然是作品名
  const quoted = /[《「『"'"]([^》」』"'"\n]{2,20})[》」』"'"」]/.exec(t)
  if (quoted) return quoted[1]

  // ② 外文词（≥3 字符，允许数字/点/连字符）：产品名、外文人名、番剧原名
  //    排除掉纯语气词和常见缩写
  const STOP = new Set([
    'the', 'and', 'for', 'you', 'are', 'was', 'not', 'but', 'all', 'can',
    'qq', 'ok', 'hhh', 'www', 'lol', 'gg', 'api', 'url', 'cpu', 'gpu',
  ])
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9.\-]{2,}/g)) {
    const w = m[0]
    if (STOP.has(w.toLowerCase())) continue
    // 全小写且很短的两个字母词多半是语气/缩写，跳过
    if (w.length <= 3 && w === w.toLowerCase()) continue
    return w
  }

  // ③ 中文「《》」以外的常见人名/作品名形态：
  //    · 「XX的YY」里 XX 是 2-6 个汉字且不常见 → 可能是人名/作品
  //    · 「XX·YY」（欧美译名）· 「XX第二季」「XX新作」
  const cnTitle = /([\u4e00-\u9fa5]{2,8})(?:第二季|第三季|新作|新番|剧场版|动画化|手游|电影)/.exec(t)
  if (cnTitle) return cnTitle[1]

  const cnName = /([\u4e00-\u9fa5]{2,4})·([\u4e00-\u9fa5]{2,6})/.exec(t)
  if (cnName) return cnName[0]

  // ④ 纯中文的作品名 / 公司名 / 人名，靠**提问方式**反推：
  //    「XX 的作者/导演/主演/公司/什么时候/多少」
  //    「XX 是谁」「XX 怎么样」「XX 好看吗」
  //
  //    这里没法靠词形判断（中文没有大小写），所以看它**在句子里被怎么问**。
  //    命中时返回 XX 那一段作为 query —— 只查这个名字，比整句检索准得多。
  const aboutTitle = /([\u4e00-\u9fa5A-Za-z0-9]{2,12}?)(?:的)?(?:作者|导演|编剧|主演|声优|制作|公司|工作室|发行商|开发商|出品方)/.exec(t)
  if (aboutTitle) return trimTail(aboutTitle[1])

  const isWho = /([\u4e00-\u9fa5A-Za-z0-9]{2,12}?)(?:是谁|是啥|是什么|怎么样|好看吗|好玩吗|值得看吗|值得买吗)/.exec(t)
  if (isWho) return trimTail(isWho[1])

  // ⑤ 「XX 什么时候/哪年/多少钱/多少集」—— 有明确事实诉求
  const whenWhat = /([\u4e00-\u9fa5A-Za-z0-9]{2,12}?)(?:什么时候|哪年|哪一季|多少钱|多少集|几集|第几季)/.exec(t)
  if (whenWhat) return trimTail(whenWhat[1])

  return ''
}

/**
 * 去掉中文匹配贪婪吃进来的尾字。
 *
 * 「孤独摇滚有几集」这条里，捕获组会把「有」也吃进去（正则的最小匹配
 * 是按字符算的，断在「几集」前面时不保证正好停在名字边界）。
 * 这些尾字作为搜索词是噪音，直接削掉。
 */
function trimTail(s) {
  return String(s)
    .replace(/[的有是在和与跟吗呢吧啊了也都还就]+$/, '')
    .trim()
}

/** 把消息清理成适合当搜索词的短句。 */
function cleanQuery(t) {
  return String(t)
    .replace(/\[CQ:[^\]]*\]/g, ' ')      // CQ 码
    .replace(/@\d+/g, ' ')               // @某人
    .replace(/\[图片\]|\[表情[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * 调一次联网搜索。
 *
 * @param {object} o
 * @param {string} o.question      要查的问题
 * @param {string} o.apiKey        DeepSeek API key
 * @param {number} [o.maxUses]     最多搜几次（默认 3）
 * @param {number} [o.timeoutMs]   超时（默认 25s）
 * @param {Function} [o.log]
 * @returns {Promise<{ok:boolean, answer:string, sources:Array<{title:string,url:string}>, error?:string, ms:number}>}
 */
export async function webSearch(o) {
  const started = Date.now()
  const question = String(o.question ?? '').trim()
  const fail = (error) => ({ ok: false, answer: '', sources: [], error, ms: Date.now() - started })

  if (!question) return fail('没有查询内容')
  if (!o.apiKey) return fail('没有 DeepSeek 凭据（联网搜索需要 DEEPSEEK_API_KEY）')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 25000)

  try {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': String(o.apiKey),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SEARCH_MODEL,
        // 2000 是给"搜索多、来源长"的情况留的余量。禁用推理后实际输出
        // 只有 300~700 token，这个上限基本不会碰到。
        max_tokens: 2000,
        // ⚠️ 必须禁用推理。flash 默认先吐 thinking，会：
        //    ① 把 max_tokens 吃光（正文 0 字，stop_reason: max_tokens）
        //    ② 输出 token 翻三倍（2000 vs 600）
        //    ③ 慢一倍（12.3s vs 3.2s）
        // 搜索是"查完照实转述"，不需要推理。
        thinking: { type: 'disabled' },
        messages: [{
          role: 'user',
          content: '请联网搜索后用简洁的中文回答下面的问题。只给事实，不要客套和开场白。'
            + '如果搜到的信息互相矛盾，指出矛盾点。\n\n问题：' + question,
        }],
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: o.maxUses ?? 3,
        }],
      }),
    })

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return fail(`HTTP ${res.status} ${t.slice(0, 160)}`)
    }

    const j = await res.json()
    const blocks = Array.isArray(j.content) ? j.content : []

    // 取最后一段 text —— 那才是"结合搜索结果写出的答案"（前面那段是"我来帮您搜索…"）
    const texts = blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? ''))
    const answer = texts.length ? texts[texts.length - 1].trim() : ''

    // 来源列表（去重）
    const seen = new Set()
    const sources = []
    for (const b of blocks) {
      if (b.type !== 'web_search_tool_result') continue
      for (const it of (Array.isArray(b.content) ? b.content : [])) {
        const url = String(it?.url ?? '')
        if (!url || seen.has(url)) continue
        seen.add(url)
        sources.push({ title: String(it?.title ?? '').slice(0, 120), url })
      }
    }

    const ms = Date.now() - started
    if (!answer) return { ok: false, answer: '', sources, error: '搜索没返回正文', ms }
    o.log?.(`联网：已查到「${question.slice(0, 30)}」→ ${answer.length} 字 / ${sources.length} 个来源（${ms}ms）`)
    return { ok: true, answer, sources, ms }
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return fail(aborted ? `超时（${o.timeoutMs ?? 25000}ms）` : String(e?.message ?? e))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从搜索来源里抓一张**封面图**。
 *
 * ## 为什么这么做
 *
 * 群里聊到具体作品/产品时，光有文字显得干巴巴，发一张封面图更像人 ——
 * 真人聊新番会甩一张海报。搜索接口本身不返回图（sources 只有
 * title/url），所以从来源页面的 og:image / twitter:image 里取。
 *
 * ## 几个约束
 *
 *   · 只试前 3 个来源。再往后命中率低，纯浪费时间。
 *   · 单个来源 3 秒超时 —— 图文回复值得等，但不能把整条消息卡死。
 *   · 只认 http(s)，且排除明显的 logo/icon/avatar（那些不是封面）。
 *   · **失败就返回 null，绝不抛错**：图是锦上添花，不是必需品。
 *
 * @param {Array<{title:string,url:string}>} sources
 * @param {object} [opts]
 * @returns {Promise<{url:string,title:string}|null>}
 */
export async function pickCoverImage(sources, opts = {}) {
  const list = (Array.isArray(sources) ? sources : []).slice(0, opts.maxProbe ?? 3)
  const timeoutMs = opts.timeoutMs ?? 3000

  const BAD = /(logo|icon|avatar|favicon|sprite|placeholder|blank|1x1|spacer|badge|button)/i

  for (const s of list) {
    if (!/^https?:\/\//i.test(String(s?.url ?? ''))) continue
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(s.url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          // 有些站会按 UA 决定要不要给 og:image
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml',
        },
      })
      if (!res.ok) continue
      // 只读前 200KB —— og:image 一定在 <head> 里，没必要下整页
      const buf = await res.arrayBuffer()
      const html = Buffer.from(buf.slice(0, 200_000)).toString('utf8')

      for (const re of [
        /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i,
        /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
      ]) {
        const m = re.exec(html)
        if (!m) continue
        let img = m[1].trim()
        if (img.startsWith('//')) img = 'https:' + img
        else if (img.startsWith('/')) img = new URL(img, s.url).href
        if (!/^https?:\/\//i.test(img)) continue
        if (BAD.test(img)) continue
        return { url: img, title: s.title || '' }
      }
    } catch {
      // 超时 / 网络错误 / 解析失败 —— 换下一个来源
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

/**
 * 把搜索结果拼成给模型看的**参考信息**块。
 *
 * ⚠️ 明确告诉模型"这是刚查到的、优先于你的记忆" —— 否则它仍可能
 *    拿训练数据里的旧认知去否定搜索结果（这正是我们要解决的问题）。
 */
export function formatSearchContext(r) {
  if (!r?.ok) return ''
  const src = (r.sources ?? []).slice(0, 5)
    .map((s, i) => `  ${i + 1}. ${s.title}（${s.url}）`)
    .join('\n')
  return [
    '【刚联网查到的信息】',
    r.answer,
    src ? '\n来源：\n' + src : '',
    '\n注意：以上是刚刚从网上查到的，**优先于你的训练记忆**。',
    '你的知识有截止日期，遇到和上面矛盾的地方以上面为准。',
    '用你自己的口吻简短转述（别照抄、别用 Markdown 标题），不要在群里贴长链接。',
  ].filter(Boolean).join('\n')
}
