/**
 * 免费热点源（2026-10-29）。
 *
 * ## 为什么不用付费搜索
 * `gateway/search.js` 走的是 DeepSeek Search API，**按次收费**，
 * 当时余额只剩 ¥0.86。而热点榜大多有公开接口 —— 实测：
 *
 * ```
 * 源            直连              条数  内容
 * 贴吧热议      ✅ 200  103ms      30   影之刃零真香,吧友调侃黑猴钟馗 / 表情包大赛32强
 * B站热门       ✅ 200  200ms      20   《崩坏：星穹铁道》千星纪游PV / 【2026全球总决赛】
 * 头条热榜      ✅ 200  186ms      50   中共中央30日上午举行新闻发布会 ← 时政，不能用
 * 微博热搜      ❌ 403（要 cookie）
 * 知乎热榜      ❌ 401
 * ```
 *
 * **首选贴吧**：贴吧是游戏/ACG 梗的源头，而且实测那次刚好命中群里在聊的
 * 「影之刃零」。B站作备用 —— 它会限流（同一天先 200 后 403）。
 *
 * ## 为什么「只当接话的料，不当开口的理由」
 * 群聊里最烦的是**转发新闻的机器人**。所以这里只做两件事：
 *   1. 每天取一次，存下来（当天有效）
 *   2. **只有跟本群近期话题挂得上钩的**才进提示词
 * 挂不上钩就什么都不注入 —— 不允许"热搜有啥就说啥"。
 *
 * ## 时政/负面必须挡在门外
 * 头条热榜第一条就是「中共中央30日上午举行新闻发布会」。
 * 这类内容进了群聊是事故，所以用**黑名单**（不是白名单 —— 白名单会漏新梗）。
 *
 * ## 2026-11-01 加：订阅**具体某个吧**
 *
 * 原来只有**全站热议**一个源 —— 覆盖面广但不贴兴趣
 * （实测会在技术群里聊「表情包大赛」）。现在能订具体的吧
 * （`明日方舟吧` / `显卡吧`）当**垂直源**。
 *
 * ⚠️ **PC 端的 `f?kw=` 全 403**（PC/移动 UA、带不带 cookie 都一样），
 * 能用的只有**移动版的 `mo/q/mindex`**，而且**必须带移动 UA**。
 * 这是试了很多端点才找到的，别再回头去试这些：
 * ```
 * f?kw=明日方舟          → 403
 * f/lite?kw=明日方舟      → 200 但只有 2.5KB（空壳）
 * mo/q/m?kw=明日方舟      → 403
 * mo/q/sync              → 200 但 {"error":"user not login"}
 * mo/q/mindex?kw=明日方舟 → 200  386KB  ← ★ 只有这个通
 * ```
 */
import fs from 'node:fs'
import path from 'node:path'

/** 数据源。`extract` 从各家 JSON 里取标题。 */
const SOURCES = [
  {
    id: 'tieba',
    name: '贴吧热议',
    url: 'https://tieba.baidu.com/hottopic/browse/topicList?res_type=0',
    extract: (j) => (j?.data?.bang_topic?.topic_list ?? [])
      .map((x) => ({ title: String(x?.topic_name ?? ''), url: x?.topic_url ?? '', hot: Number(x?.discuss_num ?? 0) })),
  },
  {
    id: 'bilibili',
    name: 'B站热门',
    url: 'https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1',
    extract: (j) => (j?.data?.list ?? [])
      .map((x) => ({ title: String(x?.title ?? ''), url: x?.short_link_v2 ?? x?.bvid ? `https://www.bilibili.com/video/${x?.bvid}` : '', hot: Number(x?.stat?.view ?? 0) })),
  },
]

/**
 * 黑名单：时政 / 军事 / 灾难 / 案件 / 敏感。
 *
 * ⚠️ 用黑名单而不是白名单：白名单会把"还没流行起来的新梗"全挡掉，
 *    而那恰恰是最有价值的。黑名单漏一个的代价可控（人能看到能删），
 *    白名单漏一片的代价是"它永远只会说老梗"。
 */
const BLOCK = new RegExp([
  // 时政 / 官方
  '中共中央', '中央', '总书记', '国务院', '人大', '政协', '外交部', '国防部',
  '党委', '纪委', '反腐', '双开', '落马', '官员', '政府', '政策', '两会',
  '主席', '总理', '部长', '省委', '市委', '县委',
  // 军事 / 国际冲突
  '军事', '战争', '导弹', '军队', '解放军', '演习', '开战', '停火', '和谈',
  '俄乌', '以色列', '巴勒斯坦', '加沙', '乌克兰', '美国大选', '特朗普',
  // 地域敏感
  '台湾', '香港', '新疆', '西藏', '南海', '钓鱼岛',
  // 灾难 / 事故
  '地震', '洪水', '台风', '火灾', '爆炸', '坍塌', '矿难', '遇难', '死亡',
  '确诊', '疫情', '病毒', '疫苗',
  // 案件 / 负面
  '车祸', '坠楼', '自杀', '凶杀', '强奸', '猥亵', '贩毒', '判刑', '被捕',
  '拘留', '诈骗', '非法', '查处', '曝光', '举报',
  // 群体 / 抗议
  '示威', '抗议', '游行', '罢工', '暴乱', '骚乱',
].join('|'))

/**
 * 加分词：这个群（游戏 / 二次元 / 主播）可能关心的方向。
 *
 * ⚠️ 只用来**排序**，不用来过滤 —— 过滤交给黑名单。
 */
const INTEREST = /游戏|动漫|动画|番剧|新番|漫画|二次元|手办|抽卡|版本|联动|复刻|开服|测试服|攻略|角色|卡池|剧情|主播|直播|虚拟主播|VTuber|电竞|比赛|决赛|赛季|更新|DLC|模组|mod|梗|表情包|名场面|翻车|整活|抽象/i

/** 今天（本地时区）的 `YYYY-MM-DD`。 */
export function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 拉一次热点。失败返回 `{ ok:false, error }`，不抛。
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl]  测试注入
 * @returns {Promise<{ok:boolean, source?:string, items?:Array, error?:string, ms:number}>}
 */
export async function fetchHotTopics(opts = {}) {
  const started = Date.now()
  const timeoutMs = opts.timeoutMs ?? 12000
  const doFetch = opts.fetchImpl ?? fetch
  const errors = []

  for (const src of SOURCES) {
    try {
      const res = await doFetch(src.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          Referer: 'https://tieba.baidu.com/',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) { errors.push(`${src.id}: HTTP ${res.status}`); continue }
      const j = await res.json()
      const items = src.extract(j)
        .map((x) => ({ ...x, title: x.title.trim() }))
        .filter((x) => x.title.length >= 4)
      if (items.length === 0) { errors.push(`${src.id}: 0 条`); continue }
      return { ok: true, source: src.name, items, ms: Date.now() - started }
    } catch (e) {
      errors.push(`${src.id}: ${String(e?.message ?? e).slice(0, 50)}`)
    }
  }
  return { ok: false, error: errors.join(' / ') || '全部源都失败', ms: Date.now() - started }
}

/* ────────────────────────────────────────────────────────────
 * 订阅某个吧（2026-11-01）
 * ──────────────────────────────────────────────────────────── */

/**
 * ⚠️ **必须用移动端 UA**。
 *
 * 实测：同一个 `mo/q/mindex` 端点，PC UA 会 403、移动 UA 才 200。
 * 这不是"随便写一个 UA 就行"—— 贴吧对 `/mo/` 路径会校验客户端类型。
 */
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

/** 一条帖子最多留这么长的标题（再长的是复制粘贴的长文，当话题没用）。 */
const FORUM_TITLE_MAX = 60

/** 噪声标题：这些是**用户昵称/角标**，不是帖子。 */
const FORUM_NOISE = /^(活跃吧主|吧主|小吧主|图片小编|视频小编|吧务|全部|精华|看贴|置顶|公告)$/

/**
 * 标题开头的**角标词**（要剥）。
 *
 * ⚠️ 实测踩过：HTML 是
 * ```html
 * <div class="ti_title">
 *   <span class="ti_title_icon ti_icon_zhiding">置顶</span>
 *   <span>【将雪投火】出货庆祝集中贴</span>
 * </div>
 * ```
 * 把标签剥掉之后，「置顶」**变成了纯文本**、粘在标题前面：
 * `置顶【将雪投火】出货庆祝集中贴`。
 * 所以光剥标签不够，还得把开头的角标词也去掉。
 */
const FORUM_BADGE = /^(?:置顶|精华|公告|直播|活动|加精|推荐|热帖|吧广播)+/

/** 条目里的 HTML 实体 —— 实测标题会有 `&amp;`（`塔露拉&amp;冻河`）。 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

/**
 * 从「吧首页」的 HTML 里抠帖子列表。
 *
 * ## 两条路一起走（互为补充）
 *
 * **① HTML 结构** —— 稳，但只覆盖页面上真正渲染出来的那些：
 * ```html
 * <li class="tl_shadow" data-tid="11156068106">
 *   <a href="/p/11156068106?..."><div class="ti_title"><span>标题</span></div></a>
 * ```
 *
 * **② JSON 字段配对** —— 页面里还嵌了一份数据（`"title":"…"` 和
 * `"reply_num":N` 在同一个对象里、顺序固定），能多捞到几条，
 * 而且**带回复数**（HTML 那条路拿不到）。
 *
 * ⚠️ 两条路都要**排除昵称类噪声** —— 实测直接按 `"title"` 抓会捞到
 * 「活跃吧主」这种**用户头衔**（`name` 字段才是昵称，`title` 在两个语境里都用）。
 *
 * @param {string} html
 * @returns {Array<{title:string, url:string, reply:number}>}
 */
export function parseForumPage(html) {
  const s = String(html ?? '')
  const out = new Map() // tid 或 title → 条目（去重）

  const push = (title, tid, reply) => {
    const t = String(title ?? '')
      .replace(/<[^>]*>/g, '')   // 剥内嵌标签（`<span class="ti_title_icon">置顶</span>`）
      .replace(/&(#?\w{2,6});/g, (m, k) => ENTITIES[k] ?? ENTITIES[k.toLowerCase()] ?? m)
      .replace(/\s+/g, ' ')
      .trim()
      /*
       * ⚠️ **剥标签之后还要剥角标词** —— 上面那个 `<span>置顶</span>` 剥掉标签后
       * 会变成纯文本「置顶」，粘在标题前面。
       */
      .replace(FORUM_BADGE, '')
      .trim()
    if (t.length < 4 || t.length > FORUM_TITLE_MAX) return
    if (FORUM_NOISE.test(t)) return
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return
    /*
     * ⚠️⭐ **按标题去重，不要按 tid**（2026-11-01 修）。
     *
     * ## 踩的坑
     * 上面两条路：**HTML 路有 tid、JSON 路没有**。原来写成 `key = tid || t`，
     * 于是**同一条帖子在两路各存一份**：
     * ```
     * HTML 路 → key = "11156068107"
     * JSON 路 → key = "塔露拉弱这事，经典20%的人发出80％声音"
     * ```
     * 实测 **58 条里有一半是重复的**（`塔露拉` 14 条 = 7 个唯一标题 × 2）。
     *
     * ## 为什么危害比"多几条"大得多
     * 重复条目会让**词频权重翻倍**，还让下面 `forumKeywords` 的
     * **上下文多样性**判据失效 —— 同一条标题出现两次，它的邻居就被
     * 当成"两种上下文"，于是碎片（`的人`/`捂嘴的`）看起来和真词（`红刀`）
     * 一样"多样"。我因为这个错判白调了两轮阈值。
     *
     * ## 为什么不用 tid 当主键
     * 那要两路**合并**（JSON 路补进 HTML 路的 entry），复杂且脆弱。
     * 按标题去重简单够用 —— 同一吧里两条帖子标题完全一样极罕见，
     * 就算撞了少一条也不影响"在聊什么"。
     */
    const key = t
    if (out.has(key)) {
      // 已有条目就只补 url（HTML 路才有 tid）
      const prev = out.get(key)
      if (tid && !prev.url) prev.url = `https://tieba.baidu.com/p/${tid}`
      return
    }
    out.set(key, {
      title: t,
      url: tid ? `https://tieba.baidu.com/p/${tid}` : '',
      reply: Number(reply ?? 0),
    })
  }

  // ① HTML：`/p/<tid>` 链接 + 紧随其后的 ti_title
  for (const m of s.matchAll(/href="\/p\/(\d+)[^"]*"[\s\S]{0,400}?<div class="ti_title">([\s\S]{0,300}?)<\/div>/g)) {
    push(m[2], m[1], 0)
  }

  // ② JSON 配对：`"title":"…"` … `"reply_num":N`
  const unesc = (x) => { try { return JSON.parse(`"${x}"`) } catch { return x } }
  for (const m of s.matchAll(/"title":"((?:[^"\\]|\\.){4,200})"[\s\S]{0,600}?"reply_num":(\d+)/g)) {
    push(unesc(m[1]), '', Number(m[2]))
  }

  // 回复多的排前面（有信息量的讨论）
  return [...out.values()].sort((a, b) => b.reply - a.reply)
}

/**
 * 抓一个吧的帖子列表。
 *
 * ## ⚠️ 频率
 * 一条 386 KB，而且百度有反爬。**调用方必须限频**（这个函数自己不管）——
 * 实测同一个吧连抓 3 次都 200，但没人保证第 30 次还是。
 *
 * @param {string} name 吧名（`明日方舟`，不要带「吧」字）
 * @param {{fetchImpl?:Function, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, name:string, items:Array, error?:string, ms:number}>}
 */
export async function fetchForum(name, opts = {}) {
  const started = Date.now()
  const kw = String(name ?? '').trim().replace(/吧$/, '')   // 顺手容忍用户写成「明日方舟吧」
  if (!kw) return { ok: false, name: '', items: [], error: '吧名为空', ms: 0 }

  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 15000
  try {
    const res = await doFetch(
      `https://tieba.baidu.com/mo/q/mindex?kw=${encodeURIComponent(kw)}`,
      {
        headers: {
          'User-Agent': MOBILE_UA,
          Referer: 'https://tieba.baidu.com/',
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
    if (!res.ok) return { ok: false, name: kw, items: [], error: `HTTP ${res.status}`, ms: Date.now() - started }
    const html = await res.text()
    const items = parseForumPage(html)
    return {
      ok: items.length > 0,
      name: kw,
      items,
      error: items.length ? undefined : '解析出 0 条',
      ms: Date.now() - started,
    }
  } catch (e) {
    return { ok: false, name: kw, items: [], error: String(e?.message ?? e).slice(0, 60), ms: Date.now() - started }
  }
}

/**
 * 从一堆帖子标题里**提炼「这个吧在聊什么」**（2026-11-01）。
 *
 * ## 为什么不用热帖
 *
 * 用户看过实际效果后的判断：**「热帖感觉没啥用」**。
 *
 * 对 —— 热帖排的是**累积回复数**，而那是时间堆出来的：
 * `[7894回复] 【记录帖】入坑五个月废新刀客塔` 可能是几周前的帖子，
 * 却永远排在"最近在聊什么"的头上。**热度 ≠ 当下**。
 *
 * 而标题本身又很多是碎片（`捂嘴的还能说话吗`、`到底什么情况？`），
 * 单看不知道在说什么。所以要做的是**把 58 条标题压成几个词** ——
 * 一个吧此刻反复出现的名字，就是它此刻在聊的东西。
 *
 * ## 算法：n-gram 词频（不引入分词库）
 *
 * 中文没有空格，正经做法要分词库（jieba 之类，几十 MB）。
 * 但这里的目标不是"正确分词"，而是**找出重复出现的名字**：
 * ```
 * 塔露拉弱这事，经典20%的人发出80％声音
 * 塔露拉&冻河 博士们都抽了多少发啊！
 * 克莱门莎和塔露拉哪个强？
 * ```
 * 切 2~4 字的片段数一遍，`塔露拉` 自然浮到最上面。**不需要知道它是人名。**
 *
 * ## 三个坑（都踩过）
 *
 * 1. **子串包含**：`塔露拉` 和 `塔露` 会同时上榜 →
 *    只保留**更长**的那个（去掉被高频长词包含的短词）
 * 2. **虚词霸榜**：`什么`/`这个`/`多少`/`怎么` 天然高频 →
 *    停用词表必须够（但**不能太狠**，宁可漏几个也别把真名字滤掉）
 * 3. **同一标题内重复**：`塔露拉…塔露拉` 数两次会让一条帖顶两条 →
 *    **每条标题内每个片段只计一次**（用 Set）
 *
 * @param {Array<{title:string}>} items
 * @param {{limit?:number, minCount?:number}} [opts]
 * @returns {string[]} 高频词（按"出现在几条标题里"降序）
 */
export function forumKeywords(items, opts = {}) {
  const limit = opts.limit ?? 6
  const minCount = opts.minCount ?? 2
  /*
   * ⚠️ 邻居数的下限，**实测调出来的**（2026-11-01）。
   *
   * 拿真实数据（明日方舟吧）试：
   * ```
   * 去重前（58 条，一半是重复的）：
   *   minNeighbors=2 → 塔露拉 / 的人 / 捂嘴 / 说话 / 红刀   ← 碎片霸榜
   *   minNeighbors=3 → 只剩「塔露拉」                      ← 误杀真词
   *   判据在这组数据上**根本分不开** —— 因为重复条目让碎片的"邻居"翻倍
   *
   * 去重后（30 条）：
   *   minNeighbors=3 → 塔露拉 / 设计师 / 冻河               ← ✅ 都是真话题
   *   minNeighbors=2 → 塔露拉 / 设计师 / 冻河 / 明日方舟 / 怎么样 / 的一 / 不用
   *                                                          ↑ 后几个是噪声
   * ```
   *
   * **教训**：判据"调不出来"的时候，先去看**上游数据脏不脏** ——
   * 我在这里白调了两轮阈值，真正的问题是 `parseForumPage` 把同一条帖子存了两份。
   */
  const minNeighbors = opts.minNeighbors ?? 3
  const list = Array.isArray(items) ? items : []

  /*
   * 停用词：**只放真正没信息量的**。
   *
   * ⚠️ 原则是"宁可漏滤，不可错杀" —— 把真名字（`塔露拉`）滤掉比留下
   * 一个虚词代价大得多：滤掉名字 → 这个词条完全没有价值；
   * 留个虚词 → 只是占一个位置，看一眼就知道该忽略。
   */
  const STOP = new Set([
    '这个', '那个', '什么', '怎么', '为什么', '多少', '现在', '已经', '还是',
    '真的', '就是', '可以', '没有', '不是', '一个', '一下', '一样', '要是',
    '感觉', '觉得', '有人', '大家', '我们', '你们', '他们', '自己', '时候',
    '问题', '情况', '东西', '事情', '地方', '时间', '今天', '昨天', '明天',
    '老哥', '哥们', '楼主', '大佬', '兄弟', '请问', '求助', '分享', '讨论',
    '如何', '是否', '不能', '不会', '不要', '还能', '还有', '到底', '果然',
    '居然', '竟然', '难道', '是不是', '有没有', '这么', '那么',
    // ⚠️ 2026-11-01 实测补：这些在 58 条里各出现 4 次，全是"看着像词其实不是"
    '全部', '这次', '两年', '一直', '很多', '最后', '开始', '出来', '进去',
    '那样', '这样', '一样', '一起', '一点', '有点', '真是', '好像是',
  ])

  /*
   * ⚠️ **跨词边界的碎片**（2026-11-01 实测，试了三版才定下来）。
   *
   * ## 现象
   * n-gram 不知道词边界，`"前几天嘴硬说塔露拉很强在吧里捂嘴的人呢？说话！"`
   * 会切出 `捂嘴的` / `的人` / `说话` —— 它们和 `塔露拉` **一样长**，
   * 实测 top5 里占了三个，整个词条就废了。
   *
   * ## 试过但**不行**的两版
   * · **按尾字滤**（`[的了呢吗吧]$`）：`的人` 以「人」结尾，滤不掉；
   *   `捂嘴的` 滤掉后还剩 `捂嘴`
   * · **加停用词**：碎片是无穷的，`的人` `说话` `捂嘴` 之后还有别的
   *
   * ## 现在用**上下文多样性**（这才是真差异）
   * 真名字会出现在**各种不同的上下文**里：
   * ```
   * 塔露拉弱这事…   克莱门莎和塔露拉哪个强？   171抽全部都是塔露拉
   * ```
   * 而碎片只出现在**它原来那一句**里（切出来的片段没有别处可去）。
   *
   * 所以统计每个候选词**左右邻居的组合种类**，只留下 ≥ `MIN_NEIGHBORS` 种的。
   * 这条判据不依赖词性、不依赖词典，而且**不会误杀真名字** ——
   * 一个反复被提到的名字，邻居必然花。
   */
  

  /** 片段 → 出现在**几条标题**里。 */
  const count = new Map()
  /** 片段 → 它出现过的**左右邻居组合**（`左字+右字`）。用来分辨真词和碎片。 */
  const neighbors = new Map()

  for (const it of list) {
    const t = String(it?.title ?? '')
    // 只留中文和字母数字，标点/emoji 一律当分隔
    const clean = t.replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, ' ')
    const seen = new Set()   // ⚠️ 坑 3：同一标题内只计一次（count 用）
    for (const seg of clean.split(/\s+/)) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) {
          const g = seg.slice(i, i + n)
          if (!/[\u4e00-\u9fa5A-Za-z]/.test(g)) continue   // 纯数字的不要
          if (STOP.has(g)) continue
          seen.add(g)
          /*
           * ⚠️ 邻居**每次出现都要记**（不像 `seen` 那样去重）——
           * 同一个标题里出现两次，那是两个不同的上下文，都得算。
           * 用 `^` / `$` 标记句首句尾（它们也是一种"邻居"）。
           */
          const left = i > 0 ? seg[i - 1] : '^'
          const right = i + n < seg.length ? seg[i + n] : '$'
          if (!neighbors.has(g)) neighbors.set(g, new Set())
          neighbors.get(g).add(left + right)
        }
      }
    }
    for (const g of seen) count.set(g, (count.get(g) ?? 0) + 1)
  }

  /*
   * 去掉被**更长的高频词**包含的短词（坑 1）。
   *
   * 例：`塔露拉` 5 次、`塔露` 5 次、`露拉` 5 次 →
   * 只留 `塔露拉`（`塔露` 是它的子串，且出现次数不比它多）。
   */
  const entries = [...count.entries()]
    .filter(([g, c]) => c >= minCount && (neighbors.get(g)?.size ?? 0) >= minNeighbors)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)

  const kept = []
  for (const [word, c] of entries) {
    const covered = kept.some((k) => k.word.includes(word) && k.count >= c)
    if (!covered) kept.push({ word, count: c })
  }

  // 再按"长度优先"去一层同类项：`塔露拉` 在，就不要 `塔露拉弱`
  const final = []
  for (const k of kept) {
    if (final.some((f) => f.word.includes(k.word) || k.word.includes(f.word))) continue
    final.push(k)
  }

  return final
    .slice(0, limit)
    .map((k) => k.word)
    .filter((w) => w.length >= 2)
}

/**
 * 过黑名单 + 打分排序。
 *
 * @param {Array<{title:string}>} items
 * @returns {Array}
 */
export function filterTopics(items) {
  const seen = new Set()
  const out = []
  for (const it of items ?? []) {
    const title = String(it?.title ?? '').trim()
    if (!title) continue
    if (BLOCK.test(title)) continue
    // 太短的（「短」这种）当不了聊天素材；太长的多半是标题党长句
    if (title.length < 4 || title.length > 60) continue
    const key = title.slice(0, 12)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...it, title, score: INTEREST.test(title) ? 2 : 1 })
  }
  // 兴趣向优先，其次保持原顺序（原顺序≈热度）
  return out.sort((a, b) => b.score - a.score)
}

/**
 * 从热点里挑出**跟本群近期话题挂得上钩**的。
 *
 * 做法：把近期消息切成 2~4 字的中文片段，看哪些片段出现在标题里。
 * **纯字符串匹配，零模型调用。**
 *
 * ⚠️ 挂不上钩就返回空数组 —— 调用方据此"什么都不注入"。
 *    这是「只当接话的料，不当开口的理由」的落地点。
 *
 * @param {Array<{title:string}>} topics
 * @param {string[]} recentTexts  近期消息文本
 * @param {number} [limit]
 */
export function pickRelevant(topics, recentTexts, limit = 3) {
  const texts = (recentTexts ?? []).map((s) => String(s ?? '')).join('\n')
  if (!texts.trim()) return []
  const hits = []
  for (const t of topics ?? []) {
    const title = String(t?.title ?? '')
    if (!title) continue
    let best = ''
    // 从标题里取 2~4 字的片段，看有没有出现在近期聊天里
    const cjk = title.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}/g) ?? []
    for (const seg of cjk) {
      for (let n = Math.min(4, seg.length); n >= 2; n--) {
        for (let i = 0; i + n <= seg.length; i++) {
          const piece = seg.slice(i, i + n)
          if (piece.length >= 2 && texts.includes(piece)) {
            if (piece.length > best.length) best = piece
          }
        }
      }
    }
    if (best) hits.push({ ...t, match: best })
    if (hits.length >= limit) break
  }
  return hits
}

/**
 * 当天热点的落盘存储（当天有效，跨天自动作废）。
 */
export class HotTopicStore {
  /**
   * @param {object} opts
   * @param {string} opts.home
   * @param {object} [opts.log]
   */
  constructor(opts = {}) {
    this.home = opts.home
    this.log = opts.log ?? {}
    this.file = opts.home ? path.join(opts.home, 'hot-topics.json') : null
    /**
     * 订阅吧单独一个文件（2026-11-01）。
     *
     * ⚠️ **不能和热议共用一个文件** —— 两者刷新节奏差一个数量级
     * （热议 30 分钟，订阅吧 1 小时/吧），而且订阅吧是**按吧独立计时**的
     * （`明日方舟` 刚抓过不代表 `原神` 也新鲜）。混在一起会互相拖累。
     */
    this.forumsFile = opts.home ? path.join(opts.home, 'tieba-forums.json') : null
    /** @type {{day:string, source:string, at:number, items:Array}|null} */
    this.data = null
    /** @type {Record<string, {at:number, items:Array}>} 吧名 → 缓存 */
    this.forums = {}
    this._load()
    this._loadForums()
  }

  _load() {
    if (!this.file) return
    try {
      if (!fs.existsSync(this.file)) return
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (j && typeof j.day === 'string' && Array.isArray(j.items)) this.data = j
    } catch (e) {
      this.log.warn?.(`热点：读取失败（忽略）— ${String(e?.message ?? e)}`)
    }
  }

  /* ── 订阅吧的存储（2026-11-01）────────────────────────── */

  _loadForums() {
    if (!this.forumsFile) return
    try {
      if (!fs.existsSync(this.forumsFile)) return
      const j = JSON.parse(fs.readFileSync(this.forumsFile, 'utf8'))
      if (j && typeof j === 'object') {
        for (const [k, v] of Object.entries(j)) {
          if (v && Array.isArray(v.items)) this.forums[k] = { at: Number(v.at ?? 0), items: v.items }
        }
      }
    } catch (e) {
      this.log.warn?.(`贴吧订阅：读取失败（忽略）— ${String(e?.message ?? e)}`)
    }
  }

  _saveForums() {
    if (!this.forumsFile) return
    try {
      fs.mkdirSync(path.dirname(this.forumsFile), { recursive: true })
      fs.writeFileSync(this.forumsFile, JSON.stringify(this.forums), 'utf8')
    } catch (e) {
      this.log.warn?.(`贴吧订阅：写入失败 — ${String(e?.message ?? e)}`)
    }
  }

  /**
   * 这个吧的数据还新鲜吗（默认 1 小时）。
   *
   * ⚠️ **限频是硬要求**：一条响应 386 KB + 百度反爬。
   * 抓太勤轻则变慢，重则被封 —— 封了就是"这个功能整个不能用"。
   *
   * @param {string} name
   * @param {number} [maxAgeMs] 默认 1 小时
   * @returns {boolean}
   */
  forumFresh(name, maxAgeMs = 60 * 60_000) {
    const f = this.forums[String(name ?? '').trim()]
    if (!f || !Number.isFinite(f.at)) return false
    /*
     * ⚠️ 用 **`<`** 而不是 `<=` —— 这样 `maxAgeMs = 0` 表示"立刻算过期"，
     * 符合直觉（也方便测试）。用 `<=` 的话刚存进去的也算新鲜，
     * `maxAgeMs=0` 就失去意义了。
     */
    return Date.now() - f.at < maxAgeMs
  }

  /** 存一个吧的抓取结果。 */
  saveForum(name, items) {
    const k = String(name ?? '').trim()
    if (!k) return
    this.forums[k] = { at: Date.now(), items: Array.isArray(items) ? items : [] }
    this._saveForums()
  }

  /**
   * 拿所有订阅吧的帖子，**跨吧合并**。
   *
   * 用 `filterTopics` 之外的黑名单（同一套 `BLOCK`）——
   * 吧里也会有地域/时政帖，不能因为是"自己订的"就放行。
   *
   * @param {string[]} names 订阅的吧名
   * @param {number} [perForum] 每个吧最多取几条（默认 6）
   * @returns {Array<{title:string, url:string, reply:number, from:string}>}
   */
  forumItems(names, perForum = 6) {
    const out = []
    for (const raw of Array.isArray(names) ? names : []) {
      const k = String(raw ?? '').trim().replace(/吧$/, '')
      const f = this.forums[k]
      if (!f?.items?.length) continue
      for (const it of f.items.slice(0, perForum)) {
        out.push({ ...it, from: `贴吧·${k}吧` })
      }
    }
    return out
  }

  /** 今天有货吗。 */
  today() {
    if (!this.data) return null
    return this.data.day === todayKey() ? this.data : null
  }

  /**
   * 每个订阅的吧 → **它此刻在聊什么**（2026-11-01）。
   *
   * ## 为什么用词频而不是热帖
   * 用户看过实际效果后的判断：**「热帖感觉没啥用」**。
   * 热帖排的是**累积回复数** —— `[7894回复] 【记录帖】入坑五个月…`
   * 可能是几周前的帖子，却永远排在"最近在聊什么"的头上。**热度 ≠ 当下**。
   *
   * 而裸标题又多是碎片（`捂嘴的还能说话吗`、`到底什么情况？`），
   * 单看不知道在说什么。所以压成几个词：**一个吧此刻反复出现的名字，
   * 就是它此刻在聊的东西**。
   *
   * @param {string[]} names 订阅的吧名
   * @param {{limit?:number}} [opts] 每个吧取几个词
   * @returns {Array<{forum:string, keywords:string[], count:number}>}
   */
  forumTopics(names, opts = {}) {
    const limit = opts.limit ?? 5
    const out = []
    for (const raw of Array.isArray(names) ? names : []) {
      const k = String(raw ?? '').trim().replace(/吧$/, '')
      const f = this.forums[k]
      if (!f?.items?.length) continue
      const keywords = forumKeywords(f.items, { limit })
      // ⚠️ 一个词都提不出来就别写这一行 —— 空行比没有更难看
      if (keywords.length) out.push({ forum: k, keywords, count: f.items.length })
    }
    return out
  }

  /**
   * 有多少时间内的**新鲜**热点（2026-10-31 加）。
   *
   * ## 为什么不能只用 `today()`
   * `today()` 只看「是不是今天」—— 于是**一天只抓一次**：
   * 实测 `hot-topics.json` 最后更新 **00:03**，到 **18:29** 还在用同一批，
   * 等于拿 **18 小时前**的热点当"今天外面在聊什么"。热点时效性最强，
   * 上午的榜到晚上早就凉了。
   *
   * @param {number} [maxAgeMs] 允许的最大年龄，默认 30 分钟
   * @returns {object|null}
   */
  fresh(maxAgeMs = 30 * 60_000) {
    const d = this.today()
    if (!d) return null
    if (!Number.isFinite(d.at)) return d
    return Date.now() - d.at <= maxAgeMs ? d : null
  }

  /**
   * 给**主动发言**用的热点 —— 按"**这个群/这个人关心什么**"筛选（2026-10-31）。
   *
   * ## 为什么不能直接给榜单前几条
   * 用户原话：「**不是啥都分享**」。
   *
   * 把贴吧前四名无脑甩给它 → 它会在一个技术群里聊「表情包大赛」，
   * 在私聊里聊别人的瓜 —— **变成没眼色的转发机器人**。
   *
   * ## 依据从哪来
   * - **群**：这个群的摘要【事】（= 他们平时在聊什么）
   * - **私聊 / @某人**：那个人的档案（`people.json` 的 impression + facts）
   *   比如他是「在玩一款手游、周末要值班」，就挑游戏/校园相关的，别挑明星八卦。
   *
   * ## 筛不出来就不给
   * `interest` 非空但一条都挂不上 → **返回空串**（→ 主动发言没有话头 → 沉默）。
   * 这才是「不是啥都分享」。只有 `interest` 为空（拿不到依据）才退回按热度给。
   *
   * @param {{interest?:string, limit?:number}} [opts]
   * @returns {string}
   */
  toPromptForProactive(opts = {}) {
    const { interest = '', limit = 4 } = opts
    const d = this.fresh() ?? this.today()
    if (!d || !Array.isArray(d.items) || d.items.length === 0) return ''
    const want = Math.max(1, Number(limit) || 4)
    const hint = String(interest ?? '').trim()
    // 有依据 → 按它筛；筛不出来就是空（不是啥都分享）
    const items = hint ? pickRelevant(d.items, [hint], want) : d.items.slice(0, want)
    if (items.length === 0) return ''
    const lines = items.map((h) => `- ${h.title}`)
    return `## 今天外面在聊什么（可以挑一条当话头）\n${lines.join('\n')}`
  }

  /** 写入今天的热点。 */
  setToday(source, items) {
    this.data = { day: todayKey(), source: String(source ?? ''), at: Date.now(), items: items ?? [] }
    this._save()
  }

  _save() {
    if (!this.file) return
    try {
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
    } catch (e) {
      this.log.warn?.(`热点：落盘失败 — ${String(e?.message ?? e)}`)
    }
  }

  /** 给提示词用的一段文本（没有就返回空串）。 */
  toPrompt(recentTexts, limit = 3) {
    const d = this.today()
    if (!d) return ''
    const hits = pickRelevant(d.items, recentTexts, limit)
    if (hits.length === 0) return ''
    const lines = hits.map((h) => `- ${h.title}（因为聊到「${h.match}」）`)
    return `## 今天外面在聊什么（跟你们刚说的能挂上钩，可以拿来添一句）\n${lines.join('\n')}`
  }
}