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
    /** @type {{day:string, source:string, at:number, items:Array}|null} */
    this.data = null
    this._load()
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

  /** 今天有货吗。 */
  today() {
    if (!this.data) return null
    return this.data.day === todayKey() ? this.data : null
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