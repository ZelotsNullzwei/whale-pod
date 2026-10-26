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

/**
 * DeepSeek 原生 Search 接口。
 *
 * ⚠️ 这不是 Anthropic 兼容层的 `web_search` server tool —— 那个是另一条路：
 *     POST /anthropic/v1/messages + tools:[{type:'web_search_20250305'}]
 *    模型要先把网页全文读进上下文再总结，输入 2~3 万 token，
 *    费用按 token 算（¥0.011~0.03/次），耗时 3~8 秒。
 *
 * 原生接口直接返回结构化结果，**按次 ¥0.005，不按 token、不看返回条数**。
 * 实测 397ms，5 条 result 的 summary 总共才 500 多字符。
 *
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/search
 */
import { fetchWithProxyFallback } from '../net.js'

const SEARCH_ENDPOINT = process.env.DEEPSEEK_SEARCH_ENDPOINT
  ? String(process.env.DEEPSEEK_SEARCH_ENDPOINT)
  : 'https://api.deepseek.com/v1/tools/search'

/** 把搜索结果写成回答用的模型（OpenAI 兼容端点）。 */
const SUMMARIZE_ENDPOINT = process.env.DEEPSEEK_SUMMARIZE_ENDPOINT
  ? String(process.env.DEEPSEEK_SUMMARIZE_ENDPOINT)
  : 'https://api.deepseek.com/v1/chat/completions'

/**
 * 总结用哪个模型。
 *
 * 选 flash：这一步只是"把资料改成通顺的几句话"，不需要强模型。
 * 必须关推理（见下面的 thinking 参数），否则输出 token 翻三倍。
 */
const SUMMARIZE_MODEL = process.env.DEEPSEEK_SUMMARIZE_MODEL || 'deepseek-flash'


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

  // ⚠️ "XX强吗""XX好吗""XX值得吗" 这类**短问句**要单独兜住。
  //    它们含「吗」但前面没有时效词，原来的两段式判定（fresh && question）
  //    不成立 —— 而这类恰恰是群里最常见的问法。
  //    实测踩过：「祀强吗」判成不需要搜索，模型只能拿旧记忆猜。
  // ⚠️ 只认「吗」结尾，不认「么」——「吃什么」「干什么」也以「么」结尾，
  //    但那是日常问句，不是"问某个东西怎么样"。
  const shortAsk = /[\u4e00-\u9fa5A-Za-z0-9]{1,12}吗[？?]?$/.test(t) && t.length <= 20
  /*
   * 生活琐事不算：吃了/睡了/走了/来了/忙吗 这些问了也查不到什么。
   *
   * ⚠️ 两个要覆盖的坑：
   *
   * ① **前面带「你」**：「你吃了吗」和「吃了」是同一类寒暄，
   *    但只写 `^(吃了|...)` 会漏掉 —— 加个可选的「你」前缀。
   *
   * ② **反问/质问**（2026-10-26 实测翻车）：群里说「你不是才吃过吗」，
   *    被判成「在问某个东西好不好」→ 联网搜了这句话 → 搜索顺手带回
   *    一张微信公众号封面图 → 它把那张图当配图发了出去。
   *    一句质问换来一张莫名其妙的图，观感非常怪。
   *    「你不是/你才/你刚」这类**指向对方刚才行为的反问**，
   *    不是在查资料，是在怼人。
   */
  const chitchat = /^你?(吃了|睡了|走了|来了|好了|行吧|好吧|在吗|忙吗|醒了吗|下班了吗|到家了吗)/
  const retort = /^(你不是|你才|你刚|不是才|不是刚|你没|你不是刚|你不是才)/
  if (shortAsk && !chitchat.test(t) && !retort.test(t)) {
    return { need: true, why: '在问某个东西好不好', query: cleanQuery(t) }
  }
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
  // ⚠️ 这里的 `.exec` 会从**第一个能匹配的位置**开始，而中文没有词边界，
  //    于是「赛博朋克2077的新番主角是谁」会从第 2 个字开始匹配，提取出
  //    「博朋克2077的新番主角」—— 丢了首字、还带了多余的尾巴。
  //    改成从字符串开头匹配，并且允许"的"前后都有内容。
  const aboutTitle = /^([\u4e00-\u9fa5A-Za-z0-9]{2,16}?)(?:的)?(?:作者|导演|编剧|主演|声优|制作|公司|工作室|发行商|开发商|出品方)/.exec(t)
  if (aboutTitle) return trimTail(aboutTitle[1])

  const isWho = /([\u4e00-\u9fa5A-Za-z0-9]{2,12}?)(?:是谁|是啥|是什么|怎么样|好看吗|好玩吗|值得看吗|值得买吗)/.exec(t)
  if (isWho) return trimTail(isWho[1])

  // ⑤ 裸名词：只有个名字、没有问句结构（「终末地新干员」）。
  //
  //    ⚠️ 这里必须返回**字符串**（函数契约），不是 {need, why, query} 对象 ——
  //       之前写成返回对象，模板里拼出来是 "[object Object]"，日志完全看不懂。
  const freshEntity = /(新[\u4e00-\u9fa5]{2,6}|[\u4e00-\u9fa5]{2,6}新[作番季版]|第[一二三四五六七八九十\d]+[季代期弹]|即将|预告|联动|复刻)/
  const freshHit = freshEntity.exec(t)
  if (freshHit && t.length <= 24) return freshHit[1]

  // ⑥ 「XX 什么时候/哪年/多少钱/多少集」—— 有明确事实诉求
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
/**
 * 联网搜索。
 *
 * ## 两步走，而不是一步到位
 *
 *   ① Search API 拿结构化结果（按次 ¥0.005，不按 token）
 *   ② 把 title + summary 交给对话模型写成简短回答（几百 token）
 *
 * 对比原来「让模型自己边搜边读网页」的做法：
 *
 *   原做法  输入 2~3 万 token（网页全文）  3~8 秒   ¥0.011~0.03
 *   新做法  搜索 ¥0.005 + 总结 ~¥0.002     约 1 秒   ¥0.007
 *
 * 关键在于 **summary 只有 600~800 字符**，不像网页全文那样把上下文撑爆。
 *
 * @param {object} o
 * @param {string} o.question         要查什么
 * @param {string} o.apiKey           DeepSeek API key
 * @param {number} [o.count]          返回几条结果（1~50，默认 5）
 * @param {number} [o.timeoutMs]      总超时
 * @param {Function} [o.log]
 */
export async function webSearch(o) {
  const started = Date.now()
  const question = String(o.question ?? '').trim()
  const count = Math.min(Math.max(Number(o.count) || 5, 1), 50)
  const timeoutMs = o.timeoutMs ?? 25000
  const fail = (error) => ({
    ok: false, answer: '', sources: [], error,
    ms: Date.now() - started,
    usage: { in: 0, out: 0, searches: 0 },
  })

  if (!question) return fail('没有查询内容')
  if (!o.apiKey) return fail('没有 DeepSeek 凭据（联网搜索需要 DEEPSEEK_API_KEY）')

  // ── ① 调 Search API ───────────────────────────────────────
  let results = []
  try {
    const res = await fetchWithProxyFallback(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${o.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: question.slice(0, 128),
        count,
        // ⚠️ 不要正文。content 是整页 Markdown，塞进去就是原来"2~3 万 token"
        //    的老问题。summary（600~800 字符）已经够写答案了。
        need_content: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) {
      const t = await res.text().catch(() => '')
      // 402 = 余额不足，单独识别 —— 上层据此触发"要饭"提示
      if (res.status === 402) return fail('余额不足（HTTP 402）')
      return fail(`Search HTTP ${res.status} ${t.slice(0, 120)}`)
    }

    const j = await res.json()
    results = Array.isArray(j.results) ? j.results : []
    // 空结果是**不计费**的（文档：只有产生结果才收费）
    if (results.length === 0) return fail('搜索没有结果')
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return fail(aborted ? `搜索超时（${timeoutMs}ms）` : String(e?.message ?? e))
  }

  // 按相关度排序，留 5 条给模型
  const sources = results
    .slice()
    .sort((a, b) => (b.rerank_score ?? 0) - (a.rerank_score ?? 0))
    .slice(0, 5)
    .map((r) => ({
      title: String(r.title ?? '').slice(0, 120),
      url: String(r.url ?? ''),
      summary: String(r.summary ?? r.snippet ?? '').slice(0, 900),
      siteName: r.site_name ?? null,
      date: r.date ?? null,
      score: r.rerank_score ?? null,
      authority: r.authority ?? null,
    }))

  // ── ② 让对话模型把结果写成简短回答 ────────────────────────
  //
  // 这一步才花 token，但只有几百 —— 喂进去的是 summary 而不是正文。
  const material = sources
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.summary}`)
    .join('\n\n')

  let answer = ''
  let inTok = 0
  let outTok = 0
  try {
    const res = await fetchWithProxyFallback(SUMMARIZE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${o.apiKey}`,
      },
      body: JSON.stringify({
        model: SUMMARIZE_MODEL,
        max_tokens: 600,
        // 同搜索：不需要推理，禁掉能省一大半输出 token 和时间
        thinking: { type: 'disabled' },
        messages: [{
          role: 'user',
          content: '下面是刚搜到的资料。请用简洁的中文回答后面的问题。\n'
            + '只给事实，不要客套和开场白。资料互相矛盾时指出矛盾点。\n'
            + '不要列出所有来源，也不要贴链接。\n\n'
            + `问题：${question}\n\n资料：\n${material}`,
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.ok) {
      const j = await res.json()
      // ⚠️ 这是 **OpenAI 兼容**端点，不是 Anthropic 格式：
      //      OpenAI:    choices[0].message.content / prompt_tokens / completion_tokens
      //      Anthropic: content[].text / input_tokens / output_tokens
      //    写错字段的话 answer 恒为空、usage 恒为 0，然后悄悄走兜底拼接 ——
      //    表面上"能用"，实际模型根本没参与。
      answer = String(j.choices?.[0]?.message?.content ?? '').trim()
      inTok = Number(j.usage?.prompt_tokens) || 0
      outTok = Number(j.usage?.completion_tokens) || 0
    }
  } catch { /* 总结失败就用摘要兜底 */ }

  // 总结失败（或空）时用标题+摘要拼一个 —— 总比一个字都没有强
  if (!answer) {
    answer = sources.slice(0, 3).map((s) => `· ${s.title}：${s.summary.slice(0, 120)}`).join('\n')
  }

  const ms = Date.now() - started
  o.log?.(`联网：已查到「${question.slice(0, 30)}」→ ${answer.length} 字 / ${sources.length} 个来源（${ms}ms）`)

  return {
    ok: true,
    answer,
    sources,
    ms,
    // 搜索按次计价（¥0.005），一次请求算一次；总结的 token 单独记
    usage: { in: inTok, out: outTok, searches: 1 },
  }
}

/**
 * 查 DeepSeek 账户余额（人民币）。
 *
 * 为什么要它：搜索走的是**官方付费 API**，余额见底就搜不了了。而这个账户
 * 平时没人看，等发现搜不到东西时往往已经欠费。
 *
 * 大肥鱼的人格里有"Token 是脑力口粮""我要 token""白米饭"这一串设定，
 * 所以余额低的时候提一句完全符合她的性格 —— 不用额外编文案。
 *
 * @returns {Promise<{ok:boolean, cny:number, available:boolean, error?:string}>}
 */
export async function checkBalance(apiKey, timeoutMs = 8000) {
  if (!apiKey) return { ok: false, cny: 0, available: false, error: '没有凭据' }
  try {
    const res = await fetchWithProxyFallback('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false, cny: 0, available: false, error: `HTTP ${res.status}` }
    const j = await res.json()
    const info = (j.balance_infos ?? []).find((x) => x.currency === 'CNY') ?? j.balance_infos?.[0] ?? {}
    return {
      ok: true,
      cny: Number(info.total_balance) || 0,
      available: j.is_available !== false,
    }
  } catch (e) {
    return { ok: false, cny: 0, available: false, error: String(e?.message ?? e).slice(0, 80) }
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
      const res = await fetchWithProxyFallback(s.url, {
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
