/**
 * 转发里的多张图 → 拼成一张网格 → 交给视觉模型（2026-11-06）。
 *
 * 用户原话：「或者用我们现在看 b 站视频的机制」「做拼贴」「然后再交给模型」。
 *
 * 也就是复用车牌内页那套：**零依赖 canvas 拼图**（`src/gateway/browser.js`
 * 的 `page.stitchGrid`）—— whale-pod 没有 sharp / canvas 库，
 * 但图本来就在浏览器页面里，所以在页面上下文用 canvas 拼，不用引任何东西。
 *
 * ## 为什么拼成**近似方阵**而不是竖排
 * 一张图的 token 是固定的，所以要把格子摆成接近方形：
 *   竖排 6 屏 = 339 × 2736（1:8 窄长条）→ 缩得更狠，每屏只剩一条 ✗
 *   网格 3×2  = 1017 × 912（≈1:1）      → 缩得最少，每格还能看出在干嘛 ✓
 * 跟 B 站分镜图（10×10 网格）是同一个道理。
 *
 * ## 纪律
 * ① **只取前 `maxImages` 张**（默认 4）—— 87 张全看是真花钱，也没人等。
 *    超出部分要在正文里说清（"还有 N 张没看"），别假装全看了。
 * ② 拼图失败 → **退回原图**，一张都不少（宁可多花点 token，也别少看）。
 * ③ 浏览器起不来 → 退回原图（最坏情况就是多几次 ImageBlock）。
 * ④ 一张或零张不拼（多一次编解码没意义）。
 *
 * @param {object} o
 * @param {string[]} o.refs        图片引用（url / file / file_id）
 * @param {Function} o.fetchImage  下载器（`onebot.fetchImage`）
 * @param {Function} o.makeImageBlock 入库器（`gateway.makeImageBlock`）
 * @param {object}   [o.log]
 * @param {number}   [o.maxImages=4]
 * @param {number}   [o.maxBytes]  单张下载上限
 * @param {number}   [o.timeoutMs]
 * @returns {Promise<{blocks:Array, stitched:boolean, used:number, omitted:number, note:string}>}
 */
export async function stitchForwardImages(o = {}) {
  const log = o.log ?? {}
  const refs = (Array.isArray(o.refs) ? o.refs : []).filter(Boolean)
  const maxImages = Math.max(0, Number(o.maxImages ?? 4))
  const take = refs.slice(0, maxImages)
  const omitted = Math.max(0, refs.length - take.length)
  const out = { blocks: [], stitched: false, used: 0, omitted, note: '' }
  if (take.length === 0) return out

  // ── ① 先把图下下来（base64），失败的单张跳过 ─────────────
  const bufs = []
  for (const ref of take) {
    try {
      const img = await o.fetchImage(ref, { maxBytes: o.maxBytes })
      const m = /^data:([^;]+);base64,(.*)$/s.exec(String(img?.dataUrl ?? ''))
      if (!m) continue
      bufs.push({ mediaType: m[1], base64: m[2] })
    } catch (e) {
      log.warn?.(`bridge：转发图片下载失败 — ${String(e?.message ?? e).slice(0, 60)}`)
    }
  }
  if (bufs.length === 0) return out

  // ── ② 两张以上就拼（一张没必要）────────────────────────
  let parts = bufs
  if (bufs.length > 1) {
    let bot = null
    let page = null
    try {
      const { openBrowser, newPage, closePage } = await import('../gateway/browser.js')
      bot = await openBrowser({
        log: (lv, msg) => log[lv]?.(msg),
        startTimeoutMs: Number(o.timeoutMs) || 20_000,
      })
      if (bot) {
        page = await newPage(bot.cdp, 'about:blank')
        const stitched = await page.stitchGrid(bufs.map((b) => b.base64), { timeoutMs: 60_000 })
        if (stitched) {
          parts = [{ mediaType: 'image/jpeg', base64: stitched }]
          out.stitched = true
          log.info?.(`bridge：转发里 ${bufs.length} 张图已拼成 1 张（省 ${bufs.length - 1} 次视觉调用）`)
        } else {
          log.warn?.('bridge：拼图返回空 → 退回原图')
        }
      } else {
        log.warn?.('bridge：浏览器起不来 → 转发图不拼，直接逐张给模型')
      }
    } catch (e) {
      log.warn?.(`bridge：拼图失败（退回原图）— ${String(e?.message ?? e).slice(0, 60)}`)
    } finally {
      /*
       * ⚠️⚠️ **页面和浏览器都要关**（2026-11-06 实测踩到）。
       *
       * 原来只 `closePage(bot.cdp, page)` —— 浏览器子进程一直活着，
       * 而它是 `spawn(..., detached:false)` 的**前台子进程**：
       * Node 会等它退出才允许进程结束 → 整个脚本挂住，
       * 线上表现就是**这条回复永远发不出去**（实测挂 3 分钟没返回）。
       *
       * 所以：先关页面（干净），再 `bot.close()` 杀掉浏览器进程树。
       * 两个都要，顺序不能反（浏览器关了就没法再关页面）。
       */
      if (page && bot?.cdp) {
        try { await closePage(bot.cdp, page) } catch { /* 关不掉无所谓 */ }
      }
      if (bot?.close) {
        try { await bot.close() } catch { /* 同上 */ }
      }
    }
  }

  // ── ③ 入库成 ImageBlock ────────────────────────────────
  for (const [i, p] of parts.entries()) {
    try {
      const blk = await o.makeImageBlock({
        base64: p.base64,
        mediaType: p.mediaType,
        name: out.stitched ? 'forward-grid' : `forward-image-${i + 1}`,
      })
      if (blk) out.blocks.push(blk)
    } catch (e) {
      log.warn?.(`bridge：转发图片入库失败 — ${String(e?.message ?? e).slice(0, 60)}`)
    }
  }
  out.used = bufs.length
  out.note = omitted > 0 ? `（转发里共 ${refs.length} 张图，只看了前 ${take.length} 张）` : ''

  /*
   * ── ④ **单独调视觉模型转成文字**（2026-11-06，用户：「用看 b 站视频的路径」）──
   *
   * ## 为什么必须单独调，而不是把图塞给主模型
   * 主模型（`deepseek-v4.1-flash-sg`）**没有视觉能力** ——
   * 日志里那句「若模型不支持视觉，图等于没传」是实话：
   * 图块进了上下文，但模型看不见，于是她只能说「一张都没显出来」。
   *
   * 而 Magpie 里**已经配了识图模型**（`settings.json` 的 `"vision": "auto/…"`），
   * 那个字段之前只被读、**从来没被用**。这里就是它该用的地方：
   * 用视觉模型看一遍 → 变成文字 → 拼进正文 → 主模型读文字就行。
   *
   * 这跟 B 站视频那条路一模一样：**画面先转成文字**（分镜说明 / 转写），
   * 主模型永远只吃文字。
   *
   * ⚠️ 失败一律吞掉：视觉调用挂了就当没看，正文保持原文（不编）。
   */
  if (out.blocks.length > 0 && typeof o.describe === 'function') {
    try {
      const desc = await o.describe(out.blocks, { stitched: out.stitched })
      if (desc && String(desc).trim()) {
        out.description = String(desc).trim()
        log.info?.(`bridge：转发图已转成文字（${out.description.length} 字）`)
      }
    } catch (e) {
      log.warn?.(`bridge：转发图转文字失败（按没看处理）— ${String(e?.message ?? e).slice(0, 60)}`)
    }
  }
  return out
}