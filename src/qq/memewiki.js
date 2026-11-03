/**
 * 梗百科 —— 让鲸鱼**接得住梗**，而不是硬猜或装懂。
 *
 * 机制移植自 [`thawline/dsh-memewiki`](https://github.com/thawline/dsh-memewiki)
 * （那个又是移植自 AstrBot 的 `astrbot_plugin_memewiki`，作者 in1t1a1）。
 *
 * ## 它解决的是什么
 * 群里出现一个新梗/缩写/黑话时，现在的表现只有两种：
 * ```
 *   ① 硬猜 —— 编一个像模像样的解释 ✗
 *   ② 当没看见 —— 跳过这个词接着聊别的 ✗
 * ```
 * 有了词库就有第三种：**查得到就直接接梗** ✓（像本来就会那样）。
 *
 * ## 三段机制（照抄它的，都是被实测打磨过的）
 * ```
 * ① 判据 `extractQuery`
 *      「…是什么梗 / 啥意思 / 怎么用」结尾 → 取前面那个词
 *      或者整条消息就是个 2~10 字的裸词 → 当梗查
 *      排掉：无语义词（这/那/它）、停用词（哈哈/草/典/乐）、闲聊短语、带句子成分的
 * ② 查库 `lookup` —— **5 级匹配**（顺序很重要，越靠前越精确）
 *      ① 完全一样
 *      ② 别名（`kskbl` → `康神开播了`）
 *      ③ 标题前缀（「48」→「48上单」）—— 取**最短**的，最接近
 *      ④ 查询词里包含标题（问「去码头整点薯条是什么梗」）—— 取**最长**的，最具体
 *      ⑤ 标题里包含查询词（短着问「码头整」）—— **中文 ≥3 字**才做，
 *         纯数字/字母 2 字放宽（「48」「233」够 specific，不放宽就查不到「48上单」）
 * ③ 注入 —— 只把**命中的那一条**（几百字）塞进上下文，不搞"整库注入"
 * ```
 *
 * ## ★★★ 跟联网搜索的关系（用户原话：「我们还可以保留联网搜索兜底」）
 * ```
 *   像在问梗 → 本地查
 *                ├─ 命中 → 用词条，**这次不联网搜** ✓（省钱，而且比搜得准）
 *                └─ 没命中 → **不拦** → 走原来那条联网搜索路 ✓（兜底）
 * ```
 * **两套判据各管各的**，别混：
 * ```
 *   needsFreshInfo（src/gateway/search.js）  判"要不要联网"
 *   extractQuery  （本文件）                  判"是不是在问梗"
 * ```
 * 本文件**只负责"拦下来"** —— 拦下来的那次不必再搜（词条就是答案）。
 *
 * ## 数据
 * `memes.db`（SQLite，6668 条）放在**数据目录**（`<home>/memes.db`），
 * **不进仓库**（16.7MB，而且它的版权归 cnmeme.wiki）。
 * 用 Node 自带的 `node:sqlite`（Node ≥ 22.5）打开 —— **零依赖** ✓。
 * 库里没有 / Node 不支持 → 整套**静默降级**（什么都不加，行为跟以前一样）。
 *
 * ## ⚠️ 词库版权
 * 数据来自 [cnmeme.wiki](https://cnmeme.wiki) 的整理（原插件 `data/memes.db`，
 * 构建于 2026-10-26）。**本项目只做查询，不重新分发数据**。
 */

/** 梗库文件名（放数据目录） */
export const MEME_DB_NAME = 'memes.db'

/*
 * ⚠️ Node 22.5+ 才自带 `node:sqlite`。没有就**只降级不报错** ——
 *    这个仓库的其它功能不该因为一个可选词库起不来。
 */
let DatabaseSync = null
try {
  ;({ DatabaseSync } = await import('node:sqlite'))
} catch {
  DatabaseSync = null
}

// ── 判据 ────────────────────────────────────────────────────────────────

/**
 * 「像在问梗」的结尾模式。照抄原插件 —— 这几个说法覆盖了绝大多数问法。
 * ⚠️ 只认**结尾**（`$` 锚定）：句中随便出现"什么意思"不算。
 */
const ASK_PATTERN = /(?:是)?(?:什么梗|啥梗|什么来头|什么来历|什么出处|什么意思|啥意思|怎么用|怎么接|怎么玩|如何用)(?:啊|呀|呢|的|啊这是)?[？?。！!~～]*$/

/** 整条消息就是一个裸词 */
const BARE_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/

/** 这些"词"太泛，指着谁都不确定，别拿去查 */
const PRONOUNS = new Set([
  '这', '那', '它', '他', '她', '这个', '那个', '你', '这句话', '那句话', '上面', '刚才', '下文', '前面',
])

/** 日常寒暄 —— 它们可能碰巧命中词库，但那不是"在问梗" */
const SMALLTALK = new Set([
  '在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安',
  '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐',
])

/** 明显是闲聊/问状态的整句，别当梗去查 */
const CHITCHAT = new Set([
  '我是谁', '错了', '情绪', '接下一句', '你也学一个', '今天看什么', '到底多少了',
  '搜出来了吗', '来点贴吧评价', '都是同龄人', '你同事', '道德这么高',
  '这是谁的手臂', '比我能串', '宝宝你醒了', '中国人能不能飞', '你现在什么人格',
  /*
   * ★ 2026-11-03 补：这几个是**裸词模式**漏网的（原文里只有"干嘛"这种整词，
   *   而群里说的是"你在干嘛"）。实测「你在干嘛」会被当梗去查 ✗。
   * ⚠️ 代价其实很小（本地毫秒，查不到就放行）—— 但白查一次不如不查。
   */
  '你在干嘛', '在干嘛', '你干嘛', '在干嘛呢', '干嘛呢', '干什么', '在干什么',
  '吃了吗', '吃了吗你', '睡了吗', '在不在呢', '干嘛去了', '忙什么呢',
])

/** 句子里有这些成分 = 在问事，不是在问词 */
const SENTENCE_BITS = /怎么样|怎么|多少|为什么|能不能|是不是|什么|了吗|了没|一下|你说|要不要|有没有/

/**
 * 剥掉 QQ 的 `@某人` 前缀。
 *
 * ## ★★★ 为什么**不**做"唤醒词"（2026-11-03，用户提的）
 * 原插件（AstrBot 场景）有一串唤醒词（「小鲸鱼」「大肥鱼」「奶鱼」…）会在判据前剥掉。
 * **这里是 QQ 群，那套不能抄** ✗：
 * ```
 *   群友说「大肥鱼是什么梗」
 *     剥掉唤醒词 → 「是什么梗」  → **取不到词，反而把梗名吃了** ✗
 *     不剥       → 「大肥鱼」    → 正常查 ✓
 * ```
 * 而且那群词本身就是**社区里的梗名/昵称** —— 剥掉等于把最该查的东西丢掉。
 *
 * ⚠️ 剥 `@` 是**另一回事**（那是 QQ 的协议格式，不是内容）——
 *    群里消息常常长得像 `@123450003 这什么梗`，不剥前缀判据会失配。
 */
export function stripMentions(text) {
  return String(text ?? '').trim().replace(/^(@\S+\s*)+/, '').trim()
}

/**
 * 从一句话里提取"要查的词"；不像在问梗就返回 `null`。
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractQuery(text) {
  const t = stripMentions(text)
  if (!t) return null

  // ── ① 显式问法：「XX 是什么梗 / 啥意思 / 怎么用」──
  const m = ASK_PATTERN.exec(t)
  if (m) {
    let head = t.slice(0, m.index).replace(/^[ ，,。.！!？?]+|[ ，,。.！!？?]+$/g, '')
    head = head.replace(/^[是]+|[是]+$/g, '').trim()
    head = head.replace(/(这个梗|那个梗|这梗|那梗|这个|那个)$/, '').trim()
    head = head.replace(/(到底|究竟)$/, '').trim()
    if (PRONOUNS.has(head)) return null
    if (head.length <= 2 && '这那它他她'.includes(head[0])) return null
    // ⚠️ 上限 12 字：再长多半是整句话，不是词
    return (head.length > 1 && head.length <= 12) ? head : null
  }

  // ── ② 整条就是个裸词 ──
  if (BARE_PATTERN.test(t) && !SMALLTALK.has(t) && !CHITCHAT.has(t)) {
    if (SENTENCE_BITS.test(t)) return null
    return t
  }
  return null
}

// ── 词库 ────────────────────────────────────────────────────────────────

/**
 * 打开词库（只读，懒开、进程内复用）。
 *
 * @param {string} file  `memes.db` 的绝对路径
 * @returns {object|null} 连接；打不开就 null（调用方静默降级）
 */
export function openMemeDb(file) {
  if (!DatabaseSync || !file) return null
  try {
    const conn = new DatabaseSync(file, { readOnly: true })
    /*
     * ⚠️ `aliases` 这一列**在 README 的表结构里没有**，但原插件的代码在用 ——
     *    说明实际库有、README 没跟上。所以**先探列再查**，别硬写 SQL 把自己搞崩。
     */
    let hasAliases = false
    try {
      const cols = conn.prepare('PRAGMA table_info(memes)').all()
      hasAliases = cols.some((c) => String(c?.name ?? '') === 'aliases')
    } catch { hasAliases = false }
    conn.__hasAliases = hasAliases
    return conn
  } catch {
    return null
  }
}

/**
 * 查词条 —— **5 级匹配**，顺序就是精确度顺序。
 *
 * @param {object} conn  `openMemeDb` 的连接
 * @param {string} query
 * @returns {object|null}
 */
export function lookup(conn, query) {
  const q = String(query ?? '').trim()
  if (!conn || !q) return null
  const get = (sql, arg) => { try { return conn.prepare(sql).get(arg) ?? null } catch { return null } }

  // ① 完全一样
  const exact = get('SELECT * FROM memes WHERE title = ?', q)
  if (exact) return exact

  // ② 别名（逗号分隔的缩写/俗称）
  if (conn.__hasAliases) {
    const alias = get(
      "SELECT * FROM memes WHERE aliases IS NOT NULL AND instr(',' || lower(aliases) || ',', ',' || lower(?) || ',') > 0 LIMIT 1",
      q,
    )
    if (alias) return alias
  }

  // ③ 标题以查询词**开头**（前缀比"包含"精确，两字中文也不会乱中）；取最短的
  const prefix = get(
    "SELECT * FROM memes WHERE lower(title) LIKE lower(?) || '%' ORDER BY length(title) ASC LIMIT 1",
    q,
  )
  if (prefix) return prefix

  // ④ 查询词里**包含标题**（「去码头整点薯条是什么梗」）——取最长的，最具体
  const inside = get(
    'SELECT * FROM memes WHERE length(title) >= 2 AND instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1',
    q,
  )
  if (inside) return inside

  // ⑤ 标题里**包含查询词**（短着问「码头整」）
  //    中文 ≥3 字才做（「码头」「典」这种两字随手就会乱中）；
  //    纯数字/字母 2 字放宽（「48」「233」够 specific，不放宽就查不到「48上单」）
  const shortOk = q.length >= 2 && /^[0-9a-z]+$/i.test(q)
  if (q.length >= 3 || shortOk) {
    const contains = get(
      'SELECT * FROM memes WHERE instr(title, ?) > 0 ORDER BY length(title) ASC LIMIT 1',
      q,
    )
    if (contains) return contains
  }
  return null
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 词条 → 给模型看的文本。
 *
 * ⚠️ **「怎么用 / 怎么接」放最前面** —— 目标是"接梗"，不是"科普"。
 *    出处放后面，模型只有被明确问起才会说到。
 *
 * @param {object} row
 */
export function formatEntry(row) {
  if (!row) return ''
  const title = String(row.title ?? '')
  const usage = clip(row.usage, 700)
  const meaning = clip(row.summary || row.origin || '', 500)
  const tags = clip(row.tags, 120)
  const lines = [`[梗百科]「${title}」`]
  if (tags) lines.push(`标签：${tags}`)
  if (usage) lines.push(`怎么用 / 怎么接：\n${usage}`)
  if (meaning) lines.push(`出处与含义：\n${meaning}`)
  return lines.join('\n')
}

/**
 * 接梗规则 —— 拼在词条前面。
 *
 * ⚠️ 第 1 条（**先接梗、别科普**）是这套东西的**灵魂**：
 *    查词库的目的是让它**像本来就会**那样接一句，
 *    而不是把词条念给群里听（那就成了搜索引擎，不是群友）。
 *
 * ⚠️ 第 3 条跟"联网搜索兜底"配套：本地没收录**不代表**这词不存在 ——
 *    所以说"不知道"而不是"这不是梗"。真要查是走联网那条路（见文件头）。
 */
export const MEME_RULES = [
  '[梗百科·内置用法]',
  '1. 查到词条就**先接梗、别科普**：照「怎么用/怎么接」回一句，像本来就会；',
  '2. 只有对方明确问「这是什么梗」才解释出处，一两句就够，不要念词条；',
  '3. **没查到就说不知道**，别硬编，也别把两个不相干的梗拼一起；',
  '4. 说话用短句，别用客服腔。',
].join('\n')

/**
 * 一站式：判据 → 查库 → 拼文本。
 *
 * @param {string} text          用户这一条消息
 * @param {object} opts
 * @param {object|null} opts.conn  `openMemeDb` 的连接（null = 没有词库，直接返回 null）
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{query:string, title:string, text:string}|null}
 *          `null` = 没拦下来（**该走联网兜底那条路**）
 */
export function memeHint(text, opts = {}) {
  const conn = opts.conn ?? null
  if (!conn) return null
  let query = null
  try {
    query = extractQuery(text)
  } catch { return null }
  if (!query) return null

  let row = null
  try {
    row = lookup(conn, query)
  } catch (e) {
    opts.log?.(`梗库查询出错（忽略）：${String(e?.message ?? e).slice(0, 60)}`)
    return null
  }
  if (!row) {
    /*
     * ★ **查不到就返回 null，别当成"不是梗"** ——
     *   本地只有 6668 条，新梗天天在出。调用方据此**放行联网搜索**。
     */
    opts.log?.(`梗库没收录「${query}」→ 放行（交给联网兜底）`)
    return null
  }
  const entry = formatEntry(row)
  if (!entry) return null
  opts.log?.(`梗库命中「${query}」→「${String(row.title ?? '').slice(0, 30)}」`)
  return { query, title: String(row.title ?? ''), text: `${MEME_RULES}\n\n${entry}` }
}