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
import fs from 'node:fs'
import path from 'node:path'
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
  const raw = String(text ?? '').trim()
  if (!raw) return { need: false, why: '', query: '' }

  /*
   * ★★★ 2026-11-03：**先剥"段标记"、并记住"这条带了图"**（用户现场抓到的）。
   *
   * 实测（日志原文，用户原话：「那个真好吃吗去联网搜索啦」）：
   * ```
   *   bridge：private:2129024700「[表情包] 真好吃吗」 图×1
   *   bridge：需要联网（在问某个东西好不好）→ 查「真好吃吗」   ✗ 搜了
   *   bridge：搜索用量已记录（…搜了 1 次）                    ✗ 花了钱
   * ```
   * **三重代价**：慢 1.85 秒 ✗ / 一天 12 次的预算占掉 1 次 ✗ / 搜回来 148 字毫无用处 ✗
   * —— 那是**接表情包的梗** ✓，不是求知 ✗。
   *
   * **为什么没被挡住**：`bareAsk` 是 `^…$` **锚定整句**的 —— 而收到的文本前面挂着
   * 段标记 `[表情包]`，锚定直接失效 ✗；而且它是「**真**好吃吗」，名单里也没这个形态 ✗。
   * 于是 `shortAsk` 那层放行 → 掉到"在问某个东西好不好" ✗✗
   *
   * ⚠️ 这个坑**注释里早写着**（见下面 `bareAsk` 那段："`bareAsk` 盖不着，
   *    于是被判成『在问某个东西好不好』搜了一次"）—— 今天只是**换个触发词**又撞一次。
   */
  const SEG = /\[(?:表情包|图片|视频|语音|文件|动画表情|表情[:：]\d*)\]/
  /** 这条消息带了图/表情包 —— 见下面 `notLookup` 里怎么用它 ✓ */
  const hadSeg = SEG.test(raw)

  // ⚠️ 判据一律跑在**剥掉段标记之后**的文本上（锚定正则才有效 ✓）
  const t = raw.replace(new RegExp(SEG.source, 'g'), ' ').replace(/\s+/g, ' ').trim()
  if (!t) return { need: false, why: '', query: '' }

  // ① 明确要求联网 / 搜索
  /*
   * ⚠️ **不要裸的「搜索」「联网」**（2026-11-01 修）。
   *
   * 实测事故：用户在群里**讨论这个功能本身**
   * ```
   *   搜索bug 不知道为啥            → 命中「搜索」→ 拿去搜了一次
   *   你今天调了58次api搜索          → 同上
   * ```
   * 「搜索」在这里是**名词**（在说"搜索功能"），不是在请求搜索。
   *
   * 所以只认**有宾语结构的请求式**：动词后面得跟得上东西。
   * ```
   *   帮我搜一下明日方舟 / 查一下RTX5090价格 / 百度一下这个bug   → 搜 ✅
   *   搜索bug 不知道为啥 / 联网老是失败                        → 不搜 ✅
   * ```
   */
  const explicit = /(搜一下|搜搜|搜索一下|帮我搜|帮我查|查一下|查查|查查资料|百度一下|百度|谷歌|google|上网查|联网查|网上查|去网上)/i
  if (explicit.test(t)) {
    return { need: true, why: '用户明确要求搜索', query: cleanQuery(t) }
  }

  /*
   * ★★ **亲密 / 私密内容一律不联网**（2026-11-02 加，照用户账单实测）。
   *
   * ## 现场
   * 当天 11 次搜索里混着这些：
   * ```
   *   01:22  「插进去了吗」        → 搜了一次
   *   02:55  「那我们是什么关系」   → 搜了一次
   * ```
   * 两个问题，第二个更要紧：
   *   ① 浪费钱 —— 一次约 ¥0.02，输入 1000~1800 token
   *   ② **把私聊里的亲密内容发给了搜索引擎** —— 这条不该发生
   *
   * 而且搜了也没用：这类话的答案不在网上。
   *
   * ⚠️ **放在「用户明确要求搜索」之后** —— 他点名要查就查；
   *    这条防的是"她自己顺手拿去搜"。
   */
  const intimate = /(做爱|上床|插|舔|含住|硬了|硬硬|湿了|发情|射|裸|脱衣|胸|身子|骚|荤|睡你|要我|想我|爱我|喜不喜欢|什么关系|我们的关系|亲我|摸我)/
  if (intimate.test(t)) return { need: false, why: '', query: '' }

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
   *
   * ⚠️ 2026-11-01 扩展：用户原话「**吃饭了吗那些日常问题都不该搜索**」。
   *
   *   判据不是"含某个词"，而是**这类问题的答案根本不在网上**：
   *     · 问对方的**起居 / 状态 / 心情** → 网上查不到
   *     · 问**本地当下**（吃了没、睡了吗）→ 网上查不到
   *
   *   ⚠️ 结构是「**动词 + 常见后缀**」，不能只写 `^吃`：
   *   ```
   *   吃饭了吗 / 吃了吗 / 吃什么了 / 睡了吗 / 干嘛呢     → 挡 ✅
   *   吃鸡更新了吗                                    → `吃鸡` 不匹配 → 照搜 ✅
   *   ```
   *   （`吃` 后面必须跟「饭/过/了/没/什么」这类**寒暄后缀**，
   *    所以问游戏「吃鸡」不会被误挡 —— 这是我第一版写错的地方。）
   */
  const chitchat = new RegExp('^(?:你)?(?:中午|晚上|早上|今天|现在|明天)?(?:'
    + '吃(?:饭|过|了|没|什么|啥|饱|吗)|'
    + '喝(?:水|了|没|什么|啥|吗)|'
    + '睡(?:了|没|觉|醒|爽|着|好|吗)|'
    + '醒(?:了|没)|起(?:床|了|来)|'
    + '(?:下班|上班|上学|放学|回家|到家|休息|刷牙|洗澡)(?:了|没|吗|不)?|'
    + '(?:忙|累|困|饿|渴|冷|热|开心|难过|无聊)(?:吗|不|了|呢)?|'
    + '心情(?:好|不好|怎么|咋)?|'
    + '(?:干嘛|干啥|做啥|在吗|在不在|在么)(?:呢|吗|不)?|'
    + '(?:想我|喜欢我|爱我|讨厌我)(?:吗|不|了|呢)?|'
    + '有事(?:吗|没|么)?'
    + ')')
  /*
   * 状态 / 反问类 —— 不是求知。
   *
   * ⚠️ 2026-10-29 实测：今天联网 **11 次，该搜的 0 次**，全是这类：
   *    「吃饭了吗」「睡爽了吗？」「闲着不好吗」「不是还有吗」
   *    「你非得有事做吗」「你看不到消息谁发的吗」
   *    「你都没有什么想对我说的吗」「你有自我意识吗」
   * 搜了只是一次 5~15 秒的等待 + 一次搜索费（当时余额 ¥0.86）。
   */
  const stateAsk = /(不好吗|不是(吗|嘛)|不香|不就|对不对|是不是啊|爽了|闲着|有事做|在干嘛|干嘛呢|还有吗|没了|没什么想|自我意识)/
  /*
   * ⚠️ **反问句「不是…吗」**（2026-11-01 加）。
   *
   * 实测漏网：「GPT变的比你大不是正常吗」—— 含「正常吗」但**有主语**，
   * `bareAsk`（只认整句=形容词+吗）盖不着，于是被判成"在问某个东西好不好"搜了一次。
   *
   * 中文里「不是…吗」**基本就是反问**（语用上等于陈述），不是在求知。
   * 「这不是BUG吗」「你不是刚说过吗」都不是在查资料。
   */
  const rhetorical = /不是.{0,8}吗|难道.{0,8}(吗|不成)|不就.{0,8}吗|不也.{0,8}吗|不都.{0,8}吗|不早.{0,6}了吗/
  const retort = /^(你不是|你才|你刚|不是才|不是刚|你没|你不是刚|你不是才)/
  /*
   * 「质问 / 抱怨」—— 在怼人，不是在查资料。
   *
   * ⚠️ 这里**故意用具体形态、不用"以你开头"这种宽规则**：
   *    宽规则会把「你玩过影之刃零吗」也拦掉 —— 那句含"你"，
   *    但问的是**外部作品**，是该搜的。漏搜（编事实）比多搜一次严重得多。
   */
  const complaint = /(你看不到|谁发的|你不|你都没|你非|你倒|你就)/

  /*
   * ⚠️ **元问题** —— 在确认对方刚说的话，不是在查资料（2026-11-01 加）。
   *
   * 实测账单：今天 9 次搜索里 4 次是这类，**一次约 ¥0.02，白花 44%**。
   * 日志原文：
   * ```
   *   真的吗        [在问某个东西好不好]
   *   是你吗        [在问某个东西好不好]
   * ```
   * 这类句子**没有可查的东西** —— 搜「真的吗」能搜到什么？
   */
  const metaAsk = /^(真的|是吗|对吧|是吧|当真|确定|你确定|不会吧|假的吧|真的假的|骗人|开玩笑|是你|不是你)/
  /*
   * ⚠️ **无主语的单形容词问句**（2026-11-01 加）。
   *
   * 判据是「**有没有主语**」：
   * ```
   * 祀强吗            → 问外部作品         → 该搜 ✅
   * 这游戏好玩吗        → 有主语（这游戏）    → 该搜 ✅
   * 好看吗 / 好玩吗     → 无主语             → 在问"眼前这个"（图/东西）→ 不搜 ❌
   * 看不到吗 / 能看见吗  → 无主语             → 在问对方看不看得见    → 不搜 ❌
   * ```
   * 只认**整句就是「形容词 + 吗」**（`^…$`），所以「这图好看吗」这种
   * **带主语的仍然会走 `shortAsk` 去搜** —— 不误杀。
   */
  const bareAsk = /^(?:真|挺|好|蛮|超|太|很|特别|贼|怪)?(好看|好玩|好吃|好喝|好听|好香|好棒|好厉害|舒服|厉害|牛|强|弱|行|可以|能|会|是|有|在|懂|知道|正常|真的|假的|看得见|看得到|能看到|能看见|看得清|能看清|看不见|看不到|看不见|听得见|听得到|能听到|听得清|闻得到)(吗|么|不|吧)[？?]?$/

  /**
   * 「**这根本不是在查资料**」的总判据 —— 两条路都要用它挡（2026-11-01）。
   *
   * ⚠️ 原来只有 `shortAsk` 那条路挡这些，`fresh && question` 那条**盖不着** ——
   * 所以「今天做饭了吗」这类只要撞上时效词就会漏出去搜。
   */
  const notLookup = () => hadSeg   // ★ 带了图/表情包 → 社交行为，不是在查资料（2026-11-03 加）
    || chitchat.test(t) || retort.test(t) || stateAsk.test(t)
    || complaint.test(t) || metaAsk.test(t) || bareAsk.test(t) || rhetorical.test(t)

  if (shortAsk && !notLookup()) {
    return { need: true, why: '在问某个东西好不好', query: cleanQuery(t) }
  }
  if (fresh.test(t) && question && !notLookup()) {
    return { need: true, why: '问的是时效性内容', query: cleanQuery(t) }
  }

  // ③ 出现"某模型/产品 + 存在性/真伪"的组合（我们踩过的坑）
  if (/(真的|假的|存在|有没有|发布了|开放)/.test(t) && /[A-Za-z][A-Za-z0-9.\-]{2,}/.test(t) && !notLookup()) {
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
  /*
   * ⚠️ **反问 / 日常寒暄时，提到的名字也不算"求知"**（2026-11-01 加）。
   *
   * 实测漏网：「GPT变的比你大**不是正常吗**」—— `notLookup()` 已判出是反问
   * （不走 `shortAsk` 了），但**又走到这里**：里面有个外文词 `GPT`，
   * `detectProperNoun` 认它是"具体名字" → 照样搜了一次。
   *
   * 反问句里提到的名字**不是在问它是什么** —— 「你不是刚说过吗」里的「你」
   * 「这不是BUG吗」里的「BUG」，都不该拿去联网。
   */
  if (properNoun && !notLookup()) {
    return { need: true, why: `提到具体名字「${properNoun}」`, query: cleanQuery(t) }
  }

  /*
   * ③.5 「X 是谁 / 谁是 X / 某人是干嘛的」—— 最直白的求知问句。
   *
   * 2026-10-28 实测漏判：群里问「祀是谁啊」，`needsFreshInfo` 返回 need=false
   * （不含「吗」、也不是时效词），于是决策层沉默时连这道兜底也捞不住它。
   *
   * ⚠️ 只认「是谁 / 谁是 / 是啥人 / 干嘛的 / 干什么的」，
   *    **不认裸的「是什么」** —— 那个太宽（「这是什么」「那是什么颜色」都会中）。
   */
  /*
   * ⚠️ 加「不是在问」的排除门（2026-10-29）。
   *
   * 实测误判：「那你不知道饭是谁的」—— 这是**质问**，不是求知，
   * 却因为含「是谁」被搜了一次。判据统一走 `isRhetorical()`，
   * 和 `detectProperNoun` 的 isWho 分支共用同一套标志。
   */
  if (/(是谁|谁是|是啥人|干嘛的|干什么的)/.test(t) && !isRhetorical(t)) {
    return { need: true, why: '在问某个人/东西是谁', query: cleanQuery(t) }
  }

  return { need: false, why: '', query: '' }
}

/**
 * 找出消息里最像"专有名词"的那一段。找不到返回 ''。
 *
 * ⚠️ 这里有意做得"敏感"：误判的代价只是多花 5 秒查一次，
 *    而漏判的代价是模型编造一个名人/作品的事实 —— 后者严重得多。
 */
/**
 * 是不是**反问 / 质问 / 否定** —— 在怼人，不是在查资料。
 *
 * ⚠️ 2026-10-29：实测「那你不知道饭是谁的」被搜了两次路径（`needsFreshInfo`
 * 的 ③.5 和 `detectProperNoun` 的 isWho）。两处都要用这个判据，
 * 所以抽出来。
 */
function isRhetorical(t) {
  return /(不知道|不是|你以为|你猜|谁不知道|哪是|反正|你懂)/.test(String(t ?? ''))
}

/**
 * 抽出来的片段是不是**指代词/虚词打头** —— 那种不是专名。
 *
 * ⚠️ 2026-11-02 实测事故：**「那我们是什么关系」被抽成了「那我们」拿去搜**。
 *
 * 原因在 ④ 那两条正则（`isWho` / `whenWhat`）：它们是
 * 「2~12 个汉字 + 是什么/怎么样」这种**形态**匹配，中文没有词边界，
 * 于是句首的「那我们」正好凑够了字数和后缀。
 *
 * 结果：一句**问关系**的话变成了一次联网搜索 ——
 *   ① 浪费钱（一次约 ¥0.02）
 *   ② **把私聊内容发出去了**（这条更要紧）
 *
 * 判据很简单：真名字不会以「那/这/你/我/咱/他/她/它」打头。
 */
function isPronounish(s) {
  return /^(?:那|这|你|我|咱|他|她|它|谁|什么|怎么|咋|为啥|为了|因为|所以|但是|而且|就是|还是|也是|都是|不是|没有|可以|应该|可能|要不要|想不想|能不能|会不会)/
    .test(String(s ?? '').trim())
}

function detectProperNoun(t) {
  /*
   * ★ **整段是链接 / 含链接时，不当"专有名词"**（2026-10-31）。
   *
   * 光靠"前后紧邻 URL 字符"还不够：`b23.tv/1sA58D7` 结尾的 `sA58D7`
   * 后面什么都没有，仍会被当成名字（实测 why=「提到具体名字「sA58D7」」）。
   *
   * 而"拿一条链接去联网搜"本来就是错的 —— 短链搜不到，只会返回一堆无关内容，
   * 让模型以为"这个链接打不开"。
   * ⚠️ 只有 B 站那类**能拿到真信息**的才特殊处理（由 `_biliContext` 负责）；
   *    这里只保证**不因为链接而误触发搜索**。
   */
  if (/https?:\/\//i.test(String(t ?? ''))) return null

  // ① 书名号 / 各种引号包起来的 —— 几乎必然是作品名
  const quoted = /[《「『"'"]([^》」』"'"\n]{2,20})[》」』"'"」]/.exec(t)
  if (quoted) return quoted[1]

  // ② 外文词（≥3 字符，允许数字/点/连字符）：产品名、外文人名、番剧原名
  //    排除掉纯语气词和常见缩写
  const STOP = new Set([
    'the', 'and', 'for', 'you', 'are', 'was', 'not', 'but', 'all', 'can',
    'qq', 'ok', 'hhh', 'www', 'lol', 'gg', 'api', 'url', 'cpu', 'gpu',
    /*
     * 群里天天说的**梗词**，不是要查的东西（2026-10-29 加）。
     *
     * 实测：「等会给你充token」「你也没token」被判成"提到具体名字「token」"
     * → 白搜两次。在这个群里 token 是口粮梗，跟"查资料"毫无关系。
     */
    'token', 'tokens', 'bug', 'emmm', 'emm', 'prompt', 'llm',
    /*
     * ⚠️ **元讨论词**（2026-11-01 加）。
     *
     * 实测：用户在群里**跟我讨论我自己的实现**时，这些词被判成"具体名字"：
     * ```
     *   你后台的agent 也是你       → 提到具体名字「agent」→ 搜一次
     *   你两都是4.1flash 你搜的     → 提到具体名字「flash」→ 搜一次
     * ```
     * 在**这个群**里，agent / flash / model 是"我俩在聊的东西"，
     * 不是在问"它是什么" —— 跟 token 是口粮梗同一个道理。
     */
    'agent', 'agents', 'flash', 'model', 'models', 'skill', 'plugin', 'workflow',
    /*
     * ⚠️ **URL 里的词不是"具体名字"**（2026-10-31）。
     *
     * 实测事故：一条 B 站分享 `【哔哩哔哩】https://b23.tv/xxx` 被判成
     * 「提到具体名字「https」」→ 拿短链去联网搜 → 搜不到 → 返回一堆无关内容
     * → **模型以为"这个链接打不开"**（它真说了「短链跳不过去」）。
     *
     * 协议名 / 域名 / 常见短链站点 / 文件后缀，全排除。
     */
    'https', 'http', 'ftp', 'bilibili', 'b23', 'tv', 'com', 'cn',
    'html', 'htm', 'json', 'yaml', 'toml', 'png', 'jpg', 'gif', 'webp',
  ])
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9.\-]{2,}/g)) {
    const w = m[0]
    if (STOP.has(w.toLowerCase())) continue
    /*
     * ⚠️ 落在 **URL 内部**的词一律跳过（2026-10-31）。
     * 光靠 STOP 词表不够 —— 短链的随机段（`1sA58D7`）也会被当成"名字"。
     * 判断：这个词**前后紧邻**是不是 URL 字符（`/` `.` `:` `?` `=` `&` `#`）。
     */
    const i = m.index ?? 0
    const before = t[i - 1] ?? ''
    const after = t[i + w.length] ?? ''
    if (/[\/:?=&#.]/.test(before) || /[\/:?=&#.]/.test(after)) continue
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

  // ⚠️ 反问句不走这条（「那你不知道饭是谁的」是质问，不是查人）
  const isWho = /([\u4e00-\u9fa5A-Za-z0-9]{2,12}?)(?:是谁|是啥|是什么|怎么样|好看吗|好玩吗|值得看吗|值得买吗)/.exec(t)
  if (isWho && !isRhetorical(t) && !isPronounish(isWho[1])) return trimTail(isWho[1])

  // ⑤ 裸名词：只有个名字、没有问句结构（「终末地新干员」）。
  //
  //    ⚠️ 这里必须返回**字符串**（函数契约），不是 {need, why, query} 对象 ——
  //       之前写成返回对象，模板里拼出来是 "[object Object]"，日志完全看不懂。
  /*
   * ⚠️ 2026-11-01 收紧：原来第一分支是**裸的 `新[\u4e00-\u9fa5]{2,6}`** ——
   *    任意「新 + 2~6 字」都算"新作品"。
   *
   * 实测账单：今天 9 次搜索里，这一条贡献了
   * ```
   *   那我给你加新功能去了   → 抽出「新功能去了」去搜（一次约 ¥0.02）
   * ```
   * 「新功能」「新衣服」「新手机」全都中招 —— 而设计意图只是抓
   * 「新番 / 新作 / 新干员」这类**作品更新**。
   *
   * 所以改成**枚举作品类后缀**。实测漏搜风险很小：
   * 真正有明确诉求的句子（「黑神话出新DLC了吗」）会走 `shortAsk`
   * 那条路（含「吗」），不依赖这里。
   *
   * ⚠️ 顺带去掉裸的 `即将`（"我即将下班"也会中），`预告` 收成 `预告片`。
   */
  const freshEntity = /(新(?:番|作|干员|角色|版本|皮肤|卡池|赛季|武将|地图|剧情|活动|专辑|电影|剧集|模式|玩法|英雄|武器|装备|职业|门派|资料片|曲|歌)|[\u4e00-\u9fa5]{2,6}新[作番季版]|第[一二三四五六七八九十\d]+[季代期弹]|预告片|联动|复刻)/
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
  /*
   * ⚠️ **默认取 3 条，不是 5**（2026-11-01 改）。
   *
   * ## 依据：翻了一次真实账单
   * 用户截图：今天 `消费 ¥0.18 / 58 次调用 / 56,602 tokens`。
   * 逐项拆开对下来：
   * ```
   * tool-search 本身   40,242 tokens   72%   ← 大头，按检索量算
   * 总结（chat）       16,360 tokens   28%
   *                  ─────────
   *                   56,602          ✅ 和账单分毫不差
   * ```
   * **一次搜索 ≈ 6,300 token ≈ ¥0.02**（原来以为的「¥0.005/次」只是接口费，
   * 返回内容的 token 另算，而且是**按 `count` 线性增长**的）。
   *
   * ## 为什么减少条数划得来
   * 聊天场景里，**3 条来源足够把一件事说清楚**；5 条只是在重复同一个说法，
   * 而且 `need_content: false` 已经在用摘要了 —— 多要两条收益很小，成本是实打实的。
   *
   * ⚠️ 调用方仍可通过 `o.count` 指定更多（上限 50），这里只改**默认值**。
   */
  const count = Math.min(Math.max(Number(o.count) || 3, 1), 50)
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
    /*
     * ⚠️ 2026-10-30 加「怎么用」这一节。
     *
     * 原来只写「用你自己的口吻简短转述」—— 实测不管用：
     * ```
     * [我]「这链接是《明日方舟》卫戍协议：盟约的组队邀请，房号 UXMP，
     *      邀请人 Null_zwei，终极模拟模式，四人一队。」
     * ```
     * 四个要素全列 —— 那是**资料复述**，不是群聊说话。
     * 用户的原话：「少发一点，或者分开发短句」。
     *
     * 关键是给**正反例**：光说"简短"模型不知道短到哪。
     */
    '',
    '**怎么用（重要）：**',
    '- 只挑**一个**最该说的点，别把查到的要素全列一遍。',
    '  ✗ 反例：「房号 UXMP，邀请人 Null_zwei，终极模拟模式，四人一队」← 资料复述',
    '  ✓ 正例：「哦，明日方舟的组队邀请，房号 UXMP」← 只给关键的那个',
    '- 一个点说不完时，**空一行拆成两三条短句**（上层会发成多条消息），',
    '  别一口气全塞进一条长消息。',
    '- 别照抄原文、别用 Markdown 标题、不要在群里贴长链接。',
  ].filter(Boolean).join('\n')
}

/**
 * **每天搜索次数的限额**（2026-11-01 新加）。
 *
 * ## 为什么要有这个
 *
 * 用户问：「**这样看了，每天限额搜索是不是没有生效**」——
 * 查下来答案是：**根本不存在这个功能**。
 *
 * 原来配置里有个 `maxUses`，面板上写着「最多搜几次」，
 * 但它在 `webSearch()` 里**只出现在 JSDoc，零处实现** ——
 * 传进去就没人读了。实测某天搜了 **12 次**，配置写的是 3，什么也没拦。
 *
 * 而**一次搜索实际约 ¥0.02**（`tool-search` 返回内容的 token 按条数算，
 * 不是那个 ¥0.005 的接口费）。没有上限 = 账单没有上限。
 *
 * ## 为什么按"天"而不是"每次对话"
 * 一天聊几百条，按会话计数等于没有上限。按天算才对应**真实的花钱节奏**。
 *
 * ## 计数写盘（不是内存）
 * ⚠️ 内存计数会被重启清零 —— 而这个插件**开发期一天重启几十次**，
 * 那样等于没限额。所以落 `<data>/search-usage.json`，跨天自动作废。
 */
export class SearchQuota {
  /**
   * @param {object} opts
   * @param {string} opts.home  数据目录
   * @param {object} [opts.log]
   */
  constructor(opts = {}) {
    this.file = opts.home ? path.join(opts.home, 'search-usage.json') : null
    this.log = opts.log ?? {}
    /** @type {{day:string, count:number}} */
    this.data = { day: '', count: 0 }
    this._load()
  }

  /** 本地时区的 `YYYY-MM-DD`。（跨天要按**本地**算，不能按 UTC。） */
  static todayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  _load() {
    if (!this.file) return
    try {
      if (!fs.existsSync(this.file)) return
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (j && typeof j.day === 'string' && Number.isFinite(Number(j.count))) {
        this.data = { day: j.day, count: Number(j.count) }
      }
    } catch (e) {
      this.log.warn?.(`搜索限额：读取失败（忽略，从 0 开始）— ${String(e?.message ?? e)}`)
    }
  }

  _save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.data), 'utf8')
    } catch (e) {
      this.log.warn?.(`搜索限额：写入失败 — ${String(e?.message ?? e)}`)
    }
  }

  /** 今天已经搜了几次（跨天自动归零，归零后会写一次盘）。 */
  usedToday() {
    const today = SearchQuota.todayKey()
    if (this.data.day !== today) {
      this.data = { day: today, count: 0 }
      this._save()
    }
    return this.data.count
  }

  /**
   * 还能不能搜。
   *
   * @param {number} maxPerDay 每天上限（`<= 0` 表示不限）
   * @returns {{ok:boolean, used:number, max:number}}
   */
  check(maxPerDay) {
    const used = this.usedToday()
    const max = Number(maxPerDay)
    // ⚠️ 没配 / 配 0 / 配负数 → 视为**不限**（别把用户的"关掉"理解成"一次都不许"）
    if (!Number.isFinite(max) || max <= 0) return { ok: true, used, max: 0 }
    return { ok: used < max, used, max }
  }

  /** 记一次（**只在真的要搜之前调**，被拦下的不算）。 */
  take() {
    this.usedToday()   // 先确保跨天重置
    this.data.count += 1
    this._save()
    return this.data.count
  }
}
