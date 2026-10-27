/**
 * 「找图」标记的解析与执行。
 *
 * ## 设计：沿用 `[表情包]` 那条路
 *
 * 模型已经能用 `[表情:N]` / `[表情包:猫猫]` 控制发送内容（见
 * `splitFaceMarkers`）。找图用同一套思路，加一个标记：
 *
 *   模型输出：「给你找了张 [找图:鲸鱼娘 女仆装]」
 *      ↓ 拦截标记
 *   调 findImages() 找图
 *      ↓
 *   把图下载下来，文字照发、图附在后面
 *
 * ## 为什么让**模型**决定什么时候找图，而不是正则匹配
 *
 * 正则只能覆盖「给我找张图」这种显式说法，漏掉：
 *   · 「有鲸鱼娘的女仆装吗」
 *   · 「XX 长什么样」
 *   · 「来点 XX 的」
 * 而误伤也难避免（「我刚查了张图」）。
 *
 * 模型的语义判断比正则准得多，而且它本来就在做同类判断
 * （`needsFreshInfo` 判断要不要联网）。
 *
 * ## 两种触发都支持
 *
 *   被动：「帮我找张图」「XX 长什么样」→ 模型识别后输出标记
 *   主动：它觉得这段配张图更清楚 → 也会自己输出标记
 *
 * 主动那条靠提示词引导（见 `_generate` 的 imageHint），代码不区分
 * 两种场景 —— 对执行层来说都是「有个 [找图:...] 标记要处理」。
 */

import { findImages } from '../gateway/imageFind.js'

/**
 * 找出文本里所有 `[找图:关键词]` 标记。
 *
 * 兼容全角冒号（模型经常写成 `[找图：xxx]`）。
 *
 * @param {string} text
 * @returns {Array<{query:string, index:number, raw:string}>}
 */
export function extractFindImageMarkers(text) {
  const out = []
  const s = String(text ?? '')
  const re = /\[找图[:：]\s*([^\[\]]{1,80})\]/g
  let m
  while ((m = re.exec(s)) !== null) {
    const q = String(m[1] ?? '').trim()
    if (!q) continue
    out.push({ query: q, index: m.index, raw: m[0] })
  }
  return out
}

/**
 * 从文本里**移除**所有 `[找图:...]` 标记。
 *
 * 标记是给程序的指令，绝不能让它原样发到群里
 * （这和 `（对方发了…）` / `（+3 秒）` 被照抄是同一类问题，
 * 已经在 `cleanModelText` 里踩过两次）。
 *
 * ⚠️ 剥掉之后要压一下空白：`'穿啊 [找图:x] 可正经了'`
 *    会变成 `'穿啊  可正经了'`（两个空格），发出去有点怪。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFindImageMarkers(text) {
  return String(text ?? '')
    .replace(/\[找图[:：]\s*[^\[\]]{0,80}\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 执行一次找图，并把图片下载成可以发送的形式。
 *
 * @param {object} o
 * @param {string} o.query
 * @param {string} o.apiKey
 * @param {(m:string)=>void} [o.log]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ok:boolean, images:Array<{buffer:Buffer, url:string, alt:string, mime:string}>, error?:string}>}
 */
export async function resolveFindImage(o = {}) {
  const log = o.log ?? (() => {})
  const r = await findImages({
    query: o.query,
    apiKey: o.apiKey,
    count: 3,
    want: 3,
    timeoutMs: o.timeoutMs ?? 12000,
    log,
  })
  if (!r.ok) return { ok: false, images: [], error: r.error }

  const out = []
  for (const img of r.images) {
    try {
      const res = await fetch(img.url, {
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) continue
      const mime = String(res.headers.get('content-type') ?? 'image/webp').split(';')[0]
      if (!/^image\//i.test(mime)) continue
      const buf = Buffer.from(await res.arrayBuffer())
      // 太小的通常是占位图/追踪像素
      if (buf.length < 2000) continue
      out.push({ buffer: buf, url: img.url, alt: img.alt, mime })
      // 只需要一张 —— 找图是「配一张」，不是相册
      break
    } catch { /* 单张失败就试下一张 */ }
  }

  if (out.length === 0) return { ok: false, images: [], error: '图片下载失败' }
  return { ok: true, images: out }
}
