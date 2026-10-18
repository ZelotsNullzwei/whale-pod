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

/** 用于搜索的模型（必须支持 web_search 服务端工具）。 */
const SEARCH_MODEL = process.env.DEEPSEEK_SEARCH_MODEL || 'deepseek-chat'

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
  ].join('|'), 'i')
  const question = /[?？]|吗|呢|是不是|有没有|怎么|什么|多少|如何/.test(t)
  if (fresh.test(t) && question) {
    return { need: true, why: '问的是时效性内容', query: cleanQuery(t) }
  }

  // ③ 出现"某模型/产品 + 存在性/真伪"的组合（我们踩过的坑）
  if (/(真的|假的|存在|有没有|发布了|开放)/.test(t) && /[A-Za-z][A-Za-z0-9.\-]{2,}/.test(t)) {
    return { need: true, why: '在问某个具体名字的真伪/存在', query: cleanQuery(t) }
  }

  return { need: false, why: '', query: '' }
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
        max_tokens: 1500,
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
