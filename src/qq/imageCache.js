/**
 * 生成图缓存（2026-11-05）。
 *
 * ## 为什么要有
 * 现在每次 `[画图]` 都是新的一次上游调用（约 20~33 秒、要花钱）。
 * 用户实测：同一句话再要一张、或者「把刚才那张发群里/发空间」——
 * 都得重画，而且长得不一样。
 *
 * ## 存什么
 * `<home>/generated/<key>.png`  +  `<home>/generated/index.json`
 *   key = sha1(提示词 + 关键参数) 前 16 位
 *   索引里记：key / 提示词 / 创建时间 / 文件大小 / 谁要的（scope）
 *
 * ## 清理
 * 默认 **3 天**（`qq.actions.imageCacheDays`），启动时 + 每次写入时顺手清。
 * 上限 200 张，超了按时间删最旧的。
 *
 * ## 导出
 * `scripts/export-images.mjs` —— 把缓存里的图连同 index.json 复制到指定目录，
 * 或者按日期/scope 挑。给用户自己收着用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const DEFAULTS = { days: 3, maxCount: 200 }

export class ImageCache {
  /**
   * @param {object} o
   * @param {string} o.home     数据目录
   * @param {number} [o.days]   保留天数（默认 3）
   * @param {number} [o.maxCount]
   * @param {object} [o.log]
   */
  constructor({ home, days, maxCount, log = {} } = {}) {
    this.dir = path.join(home ?? '', 'generated')
    this.indexFile = path.join(this.dir, 'index.json')
    this.days = Number.isFinite(Number(days)) ? Number(days) : DEFAULTS.days
    this.maxCount = Number.isFinite(Number(maxCount)) ? Number(maxCount) : DEFAULTS.maxCount
    this.log = log
    this.index = this._load()
  }

  /** 提示词 → key（同一段提示词永远同一个 key）。 */
  static keyOf(prompt, extra = '') {
    return createHash('sha1').update(String(prompt ?? '') + '|' + String(extra ?? '')).digest('hex').slice(0, 16)
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      if (raw && typeof raw === 'object' && raw.items) return raw
    } catch { /* 没有就是空 */ }
    return { version: 1, items: {} }
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.indexFile, JSON.stringify(this.index))
    } catch (e) {
      this.log.warn?.(`image-cache：索引写盘失败 — ${String(e?.message ?? e)}`)
    }
  }

  /** 命中返回 { buf, entry }，未命中返回 null。 */
  get(prompt, extra = '') {
    const key = ImageCache.keyOf(prompt, extra)
    const entry = this.index.items[key]
    if (!entry) return null
    try {
      const buf = fs.readFileSync(path.join(this.dir, `${key}.png`))
      if (buf.length < 1024) throw new Error('文件太小')
      entry.hits = (entry.hits ?? 0) + 1
      entry.lastHitAt = Date.now()
      this._save()
      this.log.info?.(`image-cache：命中（${entry.hits} 次）「${String(prompt).slice(0, 30)}」`)
      return { buf, entry, key }
    } catch {
      // 文件丢了/坏了 → 清掉索引项，当作没命中
      delete this.index.items[key]
      this._save()
      return null
    }
  }

  /** 存一张（buf 是 PNG 字节）。 */
  put(prompt, buf, { extra = '', scope = '', ms = 0 } = {}) {
    if (!buf || buf.length < 1024) return null
    const key = ImageCache.keyOf(prompt, extra)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(path.join(this.dir, `${key}.png`), buf)
      this.index.items[key] = {
        key,
        prompt: String(prompt ?? '').slice(0, 300),
        scope,
        ms,
        bytes: buf.length,
        at: Date.now(),
        hits: 0,
      }
      this._save()
      this.prune()
      return key
    } catch (e) {
      this.log.warn?.(`image-cache：写盘失败 — ${String(e?.message ?? e)}`)
      return null
    }
  }

  /** 按天数 + 数量清理（返回删了几张）。 */
  prune(now = Date.now()) {
    const maxAge = this.days * 24 * 3600 * 1000
    let removed = 0
    const items = this.index.items
    for (const [k, v] of Object.entries(items)) {
      if (now - Number(v.at ?? 0) > maxAge) {
        delete items[k]
        try { fs.rmSync(path.join(this.dir, `${k}.png`), { force: true }) } catch { /* ignore */ }
        removed++
      }
    }
    const rest = Object.entries(items).sort((a, b) => Number(a[1].at ?? 0) - Number(b[1].at ?? 0))
    while (rest.length > this.maxCount) {
      const [k] = rest.shift()
      delete items[k]
      try { fs.rmSync(path.join(this.dir, `${k}.png`), { force: true }) } catch { /* ignore */ }
      removed++
    }
    if (removed) {
      this._save()
      this.log.info?.(`image-cache：清理 ${removed} 张（保留 ${this.days} 天 / 最多 ${this.maxCount} 张）`)
    }
    return removed
  }

  /** 给面板/导出用：条目列表（按时间倒序）。 */
  list() {
    return Object.values(this.index.items)
      .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
  }
}

export default ImageCache