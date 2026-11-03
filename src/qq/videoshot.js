/**
 * B 站分镜图 —— **"看画面"这一层，B 站自己就给**。
 *
 * ## 这个发现省掉了一整个重活
 * 原计划是"装 ffmpeg → 下视频 → 自己抽帧 → 自己拼网格图"（参考 dsh-bili-eyes 的做法）。
 * 但归档里有条 2026-11-01 的实测结论：**B 站有现成接口**。
 * 2026-11-03 复测，**还活着，而且和归档完全一致**：
 * ```
 * GET https://api.bilibili.com/x/player/videoshot?bvid=<BV>&index=1
 *   带浏览器 UA + Referer，**免登录**
 *   返回 img_x_len/img_y_len（网格，恒 10×10）
 *        img_x_size/img_y_size（每格像素，恒 480×270）
 *        image[]（拼图 URL，`//` 开头要补 https:）
 *        index[]（每格的时间点，**单位是秒**）
 * ```
 * 实测三例：
 * ```
 * BV1VGxp69EWt   70s →  1 张 139KB  index 13 个  [0,0,8,14,…]
 * BV17sxY6xEWK  533s →  2 张 794KB  index 107 个 尾值 528  (跨度/时长 0.99)
 * BV1TxxC6vEo4  968s →  2 张 539KB  index 195 个 尾值 965  (1.00)
 * ```
 *
 * ## ★★ 为什么用**整张网格图**而不是裁成一格格
 * ```
 * 整张 4800×2700 缩到模型能看的尺寸 → **一次调用**，成本固定
 * 裁成 100 张 → 100 次调用，而且每格只剩约 200×110，**字更读不出来**
 * ```
 * 所以：**整张喂进去**，配文字说明"这是 10×10 网格，第 N 格 = X 秒"。
 *
 * ## ⚠️ 三个必须兜住的坑（都实测过）
 * ① **`index` 的单位是秒，不是毫秒** —— 文档通常写毫秒，按毫秒读会得到
 *    "533 秒的视频只有 528 毫秒"这种荒谬结果。**任何实现都要先按"跨度÷时长"校验。**
 * ② **`index` 条数 ≈ 时长÷5，但不是等间隔**（70 秒那条是 `0,0,8,14,19,…`），
 *    像按场景挑的真实时间点 —— **所以必须用 index 给的时间，不能自己按等间隔算**。
 * ③ **网格里只填 `index.length` 格**，其余格子是**空的**（70 秒只填 13 格）。
 *    文案必须说清，否则模型会以为"后面那些空的是漏抓了"。
 * ④ 偶发 `code=0` 但 `image` 为空 → **直接跳过视觉层，不降级成瞎猜**。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 一张拼图最大允许多大（防止意外拉个超大文件）。实测最大 794KB。 */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024

/**
 * 拉一个视频的分镜图。
 *
 * @param {object} opts
 * @param {string} opts.bvid
 * @param {number} [opts.duration]  视频时长（用来**校验 index 单位**；不给就跳过校验）
 * @param {number} [opts.maxImages] 最多取几张拼图（默认 2 —— 每张都进模型，都花钱）
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @returns {Promise<null|{grid:{x:number,y:number,cellW:number,cellH:number},
 *   images:Buffer[], index:number[], times:Array<{cell:number,sec:number}>}>}
 */
export async function fetchVideoShots(opts = {}) {
  const log = opts.log ?? (() => {})
  const bvid = String(opts.bvid ?? '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) return null

  let j
  try {
    const res = await fetch(
      `https://api.bilibili.com/x/player/videoshot?bvid=${bvid}&index=1`,
      {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
      },
    )
    j = await res.json()
  } catch (e) {
    log('warn', `videoshot：${bvid} 请求失败 — ${String(e?.message ?? e).slice(0, 60)}`)
    return null
  }

  if (j?.code !== 0) {
    log('warn', `videoshot：${bvid} code=${j?.code} ${j?.message ?? ''}`)
    return null
  }
  const d = j.data ?? {}
  const urls = Array.isArray(d.image) ? d.image : []
  if (!urls.length) {
    /*
     * ⚠️ 坑 ④：`code=0` 但 `image` 为空 —— **直接跳过视觉层**。
     *    不要"没图就猜"，那比不给画面更糟。
     */
    log('info', `videoshot：${bvid} 没给拼图（跳过视觉层，不猜）`)
    return null
  }

  const grid = {
    x: Number(d.img_x_len) || 10,
    y: Number(d.img_y_len) || 10,
    cellW: Number(d.img_x_size) || 480,
    cellH: Number(d.img_y_size) || 270,
  }
  const index = Array.isArray(d.index) ? d.index.map(Number) : []

  // ── ★ 坑 ①：单位校验（秒 vs 毫秒）──────────────────────────
  const duration = Number(opts.duration) || 0
  if (duration > 0 && index.length) {
    const tail = index[index.length - 1]
    const ratio = tail / duration
    if (ratio > 100) {
      /*
       * 尾值 ÷ 时长 > 100 → 几乎肯定是**毫秒**。
       * 实测这里恒为 ~1（秒）；真遇上毫秒就按毫秒换算，别硬当秒用。
       */
      log('warn', `videoshot：${bvid} index 疑似毫秒（尾值 ${tail} / 时长 ${duration}）→ 按毫秒换算`)
      for (let i = 0; i < index.length; i++) index[i] = Math.round(index[i] / 1000)
    }
  }

  // 每格对应的时间（前 index.length 格有，其余空着）
  const times = index.map((sec, i) => ({ cell: i + 1, sec }))

  // ── 下载拼图（最多 maxImages 张）────────────────────────────
  const maxImages = Math.max(1, Number(opts.maxImages) || 2)
  const images = []
  for (const raw of urls.slice(0, maxImages)) {
    const url = String(raw).startsWith('//') ? 'https:' + raw : String(raw)
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
        signal: AbortSignal.timeout(opts.imageTimeoutMs ?? 20000),
      })
      if (!r.ok) { log('warn', `videoshot：${bvid} 拼图 HTTP ${r.status}`); continue }
      const len = Number(r.headers.get('content-length')) || 0
      if (len > MAX_IMAGE_BYTES) { log('warn', `videoshot：${bvid} 拼图太大 ${Math.round(len / 1024)}KB`); continue }
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.length > MAX_IMAGE_BYTES) { log('warn', `videoshot：${bvid} 拼图太大`); continue }
      images.push(buf)
    } catch (e) {
      log('warn', `videoshot：${bvid} 拼图下载失败 — ${String(e?.message ?? e).slice(0, 60)}`)
    }
  }
  if (!images.length) {
    log('info', `videoshot：${bvid} 拼图一张都没下下来（跳过视觉层）`)
    return null
  }

  log('info', `videoshot：${bvid} 拿到 ${images.length} 张拼图 / ${times.length} 格时间点（${grid.x}×${grid.y}，每格 ${grid.cellW}×${grid.cellH}）`)
  return { grid, images, index, times }
}

/**
 * 把分镜图变成**喂给模型的文字说明**（图片本身由调用方附上）。
 *
 * ⚠️ 措辞上三件事必须说清：
 * ```
 * ① 这是**网格**，第 N 格 = 第 N 个时间点（不是"第 N 秒"）
 * ② **只填了前 index.length 格**，后面的格子是空的（不是漏抓）
 * ③ **图上的小字大概率读不出来**（4800×2700 会被降采样）
 * ```
 * @param {object} shots `fetchVideoShots` 的返回值
 */
export function formatShotsNote(shots) {
  if (!shots?.times?.length) return ''
  const { grid, times, images } = shots
  const cells = grid.x * grid.y
  const head = `## 画面（${images.length} 张分镜图）`
  const lines = [
    head,
    `· 每张图是 **${grid.x}×${grid.y} 网格**（共 ${cells} 格），**按从左到右、从上到下**数格`,
    `· 这一张**只填了前 ${times.length} 格**（其余格子是空的，**不是漏抓**）`,
  ]
  /*
   * 时间点：列前 16 个就够（列全了白占 prompt）。
   *
   * ⚠️ **连续相同的秒数要合并** —— B 站给的 `index` 前面常常是 `[0, 0, 8, 14, …]`，
   *    直接列会变成「第1格=0:00 / 第2格=0:00」这种重复，白占字数。
   */
  const dedup = []
  for (const t of times) {
    const prev = dedup[dedup.length - 1]
    if (prev && prev.sec === t.sec) { prev.cells.push(t.cell); continue }
    dedup.push({ sec: t.sec, cells: [t.cell] })
  }
  const shown = dedup
    .slice(0, 16)
    .map((d) => (d.cells.length === 1
      ? `第${d.cells[0]}格=${fmtSec(d.sec)}`
      : `第${d.cells[0]}~${d.cells[d.cells.length - 1]}格=${fmtSec(d.sec)}`))
    .join(' / ')
  lines.push(`· 时间：${shown}${times.length > 16 ? ` …（共 ${times.length} 格）` : ''}`)
  lines.push(
    '⚠️ **图上的小字（弹幕、字幕贴纸）大概率看不清** —— 被缩过了。'
    + '看**画面在发生什么**（人物、场景、动作、界面），别去抠字。',
  )
  return lines.join('\n')
}

function fmtSec(s) {
  const n = Math.max(0, Math.round(Number(s) || 0))
  const m = Math.floor(n / 60)
  const sec = n % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}