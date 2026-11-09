/**
 * 「定妆照」canon（2026-11-06）。
 *
 * ## 解决什么
 * 同一套衣服每次生图都重新设计：三围漂、款式漂、尾巴还能长出两条。
 * 文字锁（部件清单、对称约束、尾巴"只许一条"）实测只能收窄概率，锁不死。
 *
 * 这里给「某套衣服」指定一张**参考图**：之后画这套就走图生图，
 * 款式 + 体型 + 尾巴数量一次带过去。日常穿搭不受影响（没配 canon 就走老路）。
 *
 * ## 文件
 * `<数据目录>/canon.json`：
 * ```json
 * {
 *   "entries": [
 *     { "match": "女仆装短款", "file": "C:/.../canon/maid-short.png", "note": "短款女仆定妆照" }
 *   ]
 * }
 * ```
 * `match` 是**正则字符串**，拿去测衣柜原文；第一条命中就用它的 file。
 * 想换定妆照 = 换 `file` 指向的文件（或把文件覆盖掉），不用改代码。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let HOME = process.env.WHALE_POD_HOME
  || path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'whale-pod')
let _cache = { mtime: -1, entries: [] }

/** 告诉它数据目录在哪（启动时调一次，测试也用它）。 */
export function configureCanon({ home } = {}) {
  if (typeof home === 'string' && home.trim()) HOME = home.trim()
  _cache = { mtime: -1, entries: [] }
}

export function canonPath() {
  return path.join(HOME, 'canon.json')
}

function loadEntries() {
  const file = canonPath()
  let st
  try { st = fs.statSync(file) } catch { _cache = { mtime: -1, entries: [] }; return [] }
  if (_cache.mtime === st.mtimeMs) return _cache.entries
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(j) ? j : (Array.isArray(j?.entries) ? j.entries : [])
    const entries = list
      .filter((e) => e && typeof e.match === 'string' && typeof e.file === 'string')
      /*
       * ★ 保留条目自身的服装元数据（2026-11-09，P1-1b 5B）：
       *   resolveReference() 需要「命中的那一条」的 outfitText/outfitId/version，
       *   而不是全局 config 里的同名值。缺失就是空串，绝不编造。
       */
      .map((e) => ({
        match: e.match,
        file: e.file,
        note: String(e.note ?? ''),
        outfitText: String(e.outfitText ?? ''),
        outfitId: String(e.outfitId ?? ''),
        version: String(e.version ?? ''),
      }))
    _cache = { mtime: st.mtimeMs, entries }
    return entries
  } catch {
    _cache = { mtime: st.mtimeMs, entries: [] }
    return []
  }
}

/**
 * 这套衣服有没有定妆照。
 *
 * @param {string} outfitText 衣柜原文（"今天穿着"那一行）
 * @returns {null|{file:string, note:string, match:string, outfitText:string, outfitId:string, version:string}}
 */
export function canonFor(outfitText) {
  const s = String(outfitText ?? '')
  if (!s.trim()) return null
  for (const e of loadEntries()) {
    let re
    try { re = new RegExp(e.match) } catch { continue }
    if (!re.test(s)) continue
    if (!fs.existsSync(e.file)) continue
    return { file: e.file, note: e.note, match: e.match, outfitText: e.outfitText, outfitId: e.outfitId, version: e.version }
  }
  return null
}
