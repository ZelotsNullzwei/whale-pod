/**
 * 收藏表情的**标签库**（2026-10-31）。
 *
 * ## 为什么需要
 * NapCat 的 `fetch_custom_face` 只返回**一组 URL** —— 没有名字、没有描述。
 * 所以机器人发表情时是**闭着眼睛随机甩一张**：不知道自己有什么、也不知道
 * 挑中的那张是什么内容。
 *
 * 实测事故：对方发表情包 → 她回了一个"流泪" → 对方问「哭啥」。
 *
 * ## 参考麦麦（MaiBot）的 `emoji_content_analysis`
 * ```
 * 请提取这个表情包主要表达的情绪、语气或常见使用场景标签，最多 5 个，逗号分隔。
 * 只返回纯文本标签，不要解释。
 * ```
 * 本模块只负责**存**；打标签的模型调用在 `bridge._tagNewStickers()`。
 *
 * ## key 用「URL 去掉 query」
 * QQ 的图片地址带时效签名（`?term=...&spec=...`），**query 会变、path 不变**。
 * 所以 `stickerKey()` 只留 path 部分，标签能跨签名一直挂着。
 * （不用图片 sha256：那要下载每张才算得出来，两次发送之间成本太高。）
 */

import fsDefault from 'node:fs'
import path from 'node:path'

/** 一个人物/表情最多留几个标签。 */
const MAX_TAGS = 5
/** 最多记多少张表情的标签（防文件无限增长）。 */
const MAX_ENTRIES = 500

/**
 * URL 的稳定 key：去掉 query 与 hash。
 *
 * @param {string} url
 * @returns {string}
 */
export function stickerKey(url) {
  const s = String(url ?? '').trim()
  if (!s) return ''
  const cut = s.search(/[?#]/)
  return cut >= 0 ? s.slice(0, cut) : s
}

/** 把模型吐出来的一行标签切成数组（容忍中英文逗号、顿号、空格、换行）。 */
export function splitTags(text) {
  return String(text ?? '')
    .split(/[\n,，、;；|]+/)
    .map((s) => s.trim().replace(/^[-*·\d.、\s]+/, '').trim())
    .filter(Boolean)
    .filter((s) => s.length <= 12) // 太长的多半是解释，不是标签
    .slice(0, MAX_TAGS)
}

/**
 * 明显是「思考过程 / 指令复述」的片段 —— **不是标签**。
 *
 * ⚠️ 2026-10-31 实测踩到的坑：当前模型是**推理模型**，`chunk.text` 里
 * 会把 reasoning 一起吐出来。第一批 5 张的"标签"全是这种：
 * ```
 * 分析用户请求**：、可能是动画的一帧）、语气或常见使用场景标签、不提供解释、不编号
 * ```
 * 所以 `set()` 必须过一遍这个过滤器 —— 宁可不打标签，也不能存垃圾。
 */
const TAG_NOISE = /(分析|任务|限制|观察|提取|请求|提示|要求|格式|输出|思考|步骤|用户|图片内容|标签本身|中文逗号|最多|不提供|不编号|不要|只返回|例如|限制：|任务：)/

/**
 * 一个片段像不像真标签：**短、纯词、没有 markdown 残留**。
 *
 * @param {string} s
 * @returns {boolean}
 */
export function isCleanTag(s) {
  const t = String(s ?? '').trim()
  if (!t) return false
  if (t.length > 6) return false // 「哭」「无语」「得意」都很短；长句必是解释
  if (TAG_NOISE.test(t)) return false
  if (/[*#`［］[\]：:（）()、，,]/.test(t)) return false // markdown/标点残留
  return /[\u4e00-\u9fa5A-Za-z]/.test(t) // 至少得有个字
}

export class StickerTagStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] 数据目录
   * @param {import('node:fs')} [opts.fs] 测试可注入
   * @param {object} [opts.log]
   */
  constructor(opts = {}) {
    this.file = opts.home ? path.join(opts.home, 'sticker-tags.json') : null
    this.fs = opts.fs ?? fsDefault
    this.log = opts.log ?? {}
    /** @type {Map<string, {tags:string[], at:number}>} */
    this.map = new Map()
    if (this.file) this.load()
  }

  load() {
    try {
      const raw = this.fs.readFileSync(this.file, 'utf8')
      const d = JSON.parse(raw)
      const items = d?.items ?? {}
      for (const [k, v] of Object.entries(items)) {
        if (!k || !Array.isArray(v?.tags)) continue
        this.map.set(k, { tags: v.tags.slice(0, MAX_TAGS), at: Number(v.at) || 0 })
      }
    } catch {
      // 首次运行 / 文件坏了 —— 从零开始（标签是可重建的，不值得因为它崩）
    }
  }

  save() {
    if (!this.file) return
    try {
      const items = {}
      for (const [k, v] of this.map) items[k] = v
      const tmp = `${this.file}.tmp`
      this.fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf8')
      this.fs.renameSync(tmp, this.file)
    } catch (e) {
      this.log.warn?.(`表情标签：落盘失败 — ${String(e?.message ?? e)}`)
    }
  }

  /**
   * 这张表情的标签（没有就 null）。
   * @param {string} url
   * @returns {string[]|null}
   */
  get(url) {
    const e = this.map.get(stickerKey(url))
    return e ? e.tags : null
  }

  /**
   * 按**图片内容的 md5** 找库里那条表情（2026-11-04）。
   *
   * ## 为什么需要
   * 用户发一张表情过来说「这个标签打错了」时，手上只有**这条消息里的
   * 图片引用**（`multimedia.nt.qq.com.cn/...`），而标签库的 key 是
   * 收藏表情的 URL（`p.qpic.cn/qq_expression/...`）—— 两串完全不一样，
   * 没法直接对上。
   *
   * 实测确认（2026-11-04）：收藏 URL 文件名里那串 32 位十六进制
   * **就是图片字节的 md5** —— 拿同一张图算 md5 就能精确命中，不靠猜。
   *
   * @param {string} hash 32 位十六进制（大小写都行）
   * @returns {string|null} 命中的库 URL
   */
  findUrlByHash(hash) {
    const h = String(hash ?? '').toUpperCase()
    if (!/^[0-9A-F]{32}$/.test(h)) return null
    for (const k of this.map.keys()) {
      if (String(k).toUpperCase().includes(h)) return k
    }
    return null
  }

  /**
   * 记下标签。
   * @param {string} url
   * @param {string[]} tags
   * @returns {boolean} 是否有变化
   */
  set(url, tags) {
    const k = stickerKey(url)
    if (!k) return false
    /*
     * ⚠️ **必须过 `isCleanTag`**（2026-10-31）。
     * 推理模型的 reasoning 会混在 `chunk.text` 里吐出来，第一批实测存进去的是
     * 「分析用户请求**：、可能是动画的一帧）、语气或常见使用场景标签…」这种垃圾。
     * 宁可不打标签，也不能让垃圾进库 —— 否则 `toPrompt` 会把它喂给模型。
     */
    const clean = splitTags(Array.isArray(tags) ? tags.join(',') : tags).filter(isCleanTag)
    if (clean.length === 0) return false
    const old = this.map.get(k)
    // 标签没变就不写盘（省 IO）
    if (old && old.tags.join('|') === clean.join('|')) return false
    this.map.delete(k) // 重新 set 让它排到 Map 末尾（近似 LRU）
    this.map.set(k, { tags: clean, at: Date.now() })
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
    this.save()
    return true
  }

  /**
   * 按「标签组合相似度」去重：**同一类最多留 N 张**，保留**最近入库的**那些。
   *
   * ## 为什么需要（2026-11-02 用户要求）
   * 收藏表情越攒越多，**同一情绪**的图往往有十几张。池子太大会：
   *   ① 提示词清单越来越长，白占 token
   *   ② 按标签挑时同类互相挤，效果更差
   * 用户原话：「**同类型的表情只留 3 个**」。
   *
   * ## 为什么不用"第一个标签"归类（第一版就是这么写的，被数据打回）
   * 库里「无语」打头的有 **14 张**，但第二标签差别很大：
   * ```
   * 无语、愤怒、压迫感、发疯
   * 无语、嫌弃、警告、暴躁、别惹我
   * 无语、嫌弃、冷漠、看戏、死亡凝视
   * ```
   * 只按第一个标签归类，会把这 14 张当同类**砍到 3 张** ——
   * 等于把"愤怒/警告/看戏"这些明显不同的图删掉。用户选了"按相似度"。
   *
   * ## 算法
   * 两两算 **Jaccard**（交集 / 并集）。相似度 ≥ `minSimilarity`（默认 **0.5**）
   * 就算同一类，用并查集归到一起；每类只留**最新**的 N 张。
   *
   * ### 0.5 是怎么定的（**对着真实库试跑出来的，不是猜的**）
   * 拿现有 72 张逐档试：
   * ```
   * 0.4 → 清 9 张   把「狂笑、嘲讽、得意、看戏」和「无语、冷漠、看戏」归成一组 —— 过度合并
   * 0.5 → 清 3 张   组内全是真同义（"无语+嫌弃+冷漠" 的各种排列）  ★ 取这个
   * 0.6 → 清 0 张   完全不触发（这个库里没有两张相似到 0.6）
   * 0.7 → 清 0 张
   * ```
   * ⚠️ 我最初把默认值写成 0.6，理由是"0.5~0.6 最能分开同义和只是都带无语"——
   *    **那是猜的**，试跑发现 0.6 在这份库上一张都不清。所以改成 0.5。
   *    以后库变了要重新试跑（`_scratch/sticker-dedupe-dryrun.mjs` 就是干这个的）。
   *
   * ## 为什么留"最近的"
   * `set()` 每次把条目挪到 Map 末尾（近似 LRU），末尾就是最新的。
   * 用户刚收藏的通常是他现在想用的。
   *
   * ⚠️ 只清理**标签库**，**不删表情本身** —— 图还在她收藏里，
   *    只是不再进提示词清单、也不被按标签挑到。删图要经过用户。
   *
   * @param {number} [keep] 每类留几张
   * @param {number} [minSimilarity] 判定同类的 Jaccard 阈值
   * @returns {{removed:string[], classes:number}}
   */
  dedupeByTag(keep = 3, minSimilarity = 0.5) {
    const n = Math.max(1, Number(keep) || 3)
    const th = Number(minSimilarity) || 0.6
    const keys = [...this.map.keys()]
    if (keys.length <= n) return { removed: [], classes: keys.length }

    const tagsOf = (k) => new Set((this.map.get(k)?.tags ?? []).map((t) => t.trim()))
    /* 并查集：把"像"的归到一起 */
    const parent = new Map(keys.map((k) => [k, k]))
    const find = (x) => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)
      while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx }
      return r
    }
    const union = (a, b) => {
      const ra = find(a); const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }

    for (let i = 0; i < keys.length; i++) {
      const ta = tagsOf(keys[i])
      if (ta.size === 0) continue
      for (let j = i + 1; j < keys.length; j++) {
        const tb = tagsOf(keys[j])
        if (tb.size === 0) continue
        let inter = 0
        for (const t of ta) if (tb.has(t)) inter++
        const unionSize = ta.size + tb.size - inter
        if (unionSize > 0 && inter / unionSize >= th) union(keys[i], keys[j])
      }
    }

    /* 每组按"新的在后"排（Map 顺序 ≈ LRU），留最后 n 个 */
    const groups = new Map()
    for (const k of keys) {
      const r = find(k)
      if (!groups.has(r)) groups.set(r, [])
      groups.get(r).push(k)
    }
    const removed = []
    for (const [, ks] of groups) {
      if (ks.length <= n) continue
      for (const k of ks.slice(0, ks.length - n)) {
        this.map.delete(k)
        removed.push(k)
      }
    }
    if (removed.length) this.save()
    return { removed, classes: groups.size }
  }

  /**
   * 在**给定的 URL 列表**里，按标签找最合适的一张。
   *
   * 匹配规则（从紧到松）：
   *   ① 标签**完全相同**
   *   ② 标签里**包含**请求词（「哭」命中「大哭」）
   *   ③ 请求词里**包含**标签（「想哭」命中「哭」）
   *
   * @param {string[]} urls
   * @param {string} name
   * @returns {string|null}
   */
  findByTag(urls, name) {
    const want = String(name ?? '').trim()
    if (!want || !Array.isArray(urls) || urls.length === 0) return null
    // ① 完全相同
    for (const u of urls) {
      const t = this.get(u)
      if (t && t.some((x) => x === want)) return u
    }
    // ② 标签包含请求词
    for (const u of urls) {
      const t = this.get(u)
      if (t && t.some((x) => x.includes(want) || want.includes(x))) return u
    }
    return null
  }

  /**
   * 生成注入提示词的一段：告诉模型「你收藏了哪些表情」。
   *
   * ⚠️ 只列**有标签**的 —— 没打过标签的她自己也不认识，列出来只会让她乱猜。
   *
   * @param {string[]} urls 当前收藏的 URL 列表（用来核对还在不在）
   * @param {number} [limit]
   * @returns {string}
   */
  toPrompt(urls, limit = 12) {
    const alive = []
    for (const u of Array.isArray(urls) ? urls : []) {
      const t = this.get(u)
      if (t && t.length) alive.push(t.join('、'))
      if (alive.length >= limit) break
    }
    // 去重（不同表情可能有同一个标签组合）
    const uniq = [...new Set(alive)]
    if (uniq.length === 0) return ''
    return `## 你收藏的表情\n${uniq.map((s) => `· ${s}`).join('\n')}\n`
      + '（想发就写 `[表情包:<上面某个标签>]`；写不出合适的标签就别发）'
  }

  /** 面板/日志用。 */
  stats() {
    return { entries: this.map.size }
  }
}

export default StickerTagStore
