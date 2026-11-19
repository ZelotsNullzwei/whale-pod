/**
 * QQ 空间「好友动态」只读（2026-11-19）
 *
 * ## 用户要的
 * 「好友的说说图片能看见吗 —— 就比如说我这个」
 * 她自己的说说配图已经能看了（qzoneRead），这里补**好友**这一侧。
 *
 * ## 数据来源（实测）
 * feeds3_html_more 返回的是**转义过的 HTML**（\\xNN），先反转义再正则：
 *   · 正文   <div class="f-info">上游没了，我有fork啊…</div>
 *   · 作者   data-uin="2129024700" + link="nameCard_x">昵称</a>
 *   · 图片   <img src="https://photogzmaz.photo.store.qq.com/...">
 *            （要排除 qlogo*.store.qq.com 的头像）
 *
 * ## 识图
 * 只识**最新一条**、最多 2 张 —— 识图要花钱也慢，不做全量。
 * 走 bridge.gateway.makeImageBlock + _describeForwardImages，和聊天看图同一条链路。
 *
 * 配置：qq.qzoneFriends = { enabled, pollMs, maxPosts, ttlMs, imageDesc }
 */
import fs from 'node:fs'
import path from 'node:path'
import { fetchWithProxyFallback } from '../net.js'

const DEFAULTS = {
  enabled: true,
  pollMs: 15 * 60_000,
  maxPosts: 5,
  ttlMs: 15 * 60_000,
  /** 要不要识图（关掉就只拿文字） */
  imageDesc: true,
}

function unescapeFeedText (s) {
  return String(s ?? '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/** 从 feeds3 HTML 里解析出好友的说说（正文 + 图）。 */
export function parseFriendPosts (html, selfUin) {
  const out = []
  const blocks = String(html ?? '').split('<div class="f-item')
  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i]
    const tid = (/data-tid="([0-9a-f]+)"/.exec(b) ?? [])[1] || ''
    const owner = (/data-uin="(\d+)"/.exec(b) ?? [])[1] || ''
    if (!tid || !owner || owner === String(selfUin)) continue
    const info = /class="f-info"[^>]*>([\s\S]*?)<\/div>/.exec(b)
    const text = stripTags(info ? info[1] : '').slice(0, 200)
    if (!text) continue
    const nick = (/link="nameCard_\d+"[^>]*>([^<]+)<\/a>/.exec(b) ?? [])[1] || ''
    const imgs = [...new Set(
      [...b.matchAll(/<img[^>]+src="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((u) => /photo\.store\.qq\.com|photogzmaz|qpic\.cn/.test(u) && !/qlogo/i.test(u)),
    )].slice(0, 4)
    const abstime = Number((/data-abstime="(\d+)"/.exec(b) ?? [])[1] || 0)
    out.push({ tid, owner, nick: stripTags(nick), text, imgs, abstime })
  }
  /* 同一 tid 去重（feeds3 里可能重复出现） */
  const seen = new Set()
  return out.filter((p) => (seen.has(p.tid) ? false : (seen.add(p.tid), true)))
}

export function startQzoneFriends (bridge, opts = {}) {
  try {
    if (!bridge || bridge._qzoneFriendsTimer) return bridge?._qzoneFriendsTimer ?? null
    const home = opts.home ?? null
    if (!home) { bridge.log?.info?.('qzone-friends：没有 home，跳过挂载'); return null }
    const cfg = () => ({ ...DEFAULTS, ...(bridge.cfg?.qzoneFriends ?? bridge.cfg?.qq?.qzoneFriends ?? {}) })
    const cacheFile = path.join(home, 'qzone-friends.json')

    let cache = { at: 0, posts: [], error: '' }
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (raw && typeof raw === 'object') cache = { ...cache, ...raw }
    } catch { /* 首次 */ }
    const writeCache = () => { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)) } catch { /* ignore */ } }

    const send = (a, p) => (bridge.onebot?._sendPreferHttp
      ? bridge.onebot._sendPreferHttp(a, p)
      : bridge.onebot?.call?.(a, p))

    const getAuth = async () => {
      const r = await send('get_cookies', { domain: 'qzone.qq.com' })
      const cookies = String(r?.data?.cookies ?? '')
      const bkn = String(r?.data?.bkn ?? '')
      if (!cookies || !bkn) throw new Error('拿不到 qzone 登录态')
      return { cookies, bkn }
    }

    const refresh = async () => {
      const c = cfg()
      if (c.enabled === false) return
      try {
        const uin = String(bridge.selfId ?? '').trim()
        if (!uin) throw new Error('bridge.selfId 为空')
        const auth = await getAuth()
        const url = 'https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more'
          + '?uin=' + encodeURIComponent(uin) + '&scope=0&view=1&filter=all&flag=1&applist=all'
          + '&fupdate=1&refresh=0&styledm=user.qzone.qq.com&g_tk=' + encodeURIComponent(auth.bkn)
          + '&format=json&pagenum=1'
        const resp = await fetchWithProxyFallback(url, {
          timeoutMs: 20000,
          headers: (() => { const h = {
            'User-Agent': ['Mozilla', '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36'].join('/'),
            Referer: 'https://user.qzone.qq.com/' + uin,
          }
          h['Cookie'] = auth.cookies
          return h })(),
        })
        if (!resp?.ok) throw new Error('feeds3 HTTP ' + String(resp?.status ?? '?'))
        const html = unescapeFeedText(await resp.text())
        const posts = parseFriendPosts(html, uin).slice(0, Number(c.maxPosts ?? 5))

        /* 只识最新一条的图（最多 2 张） */
        if (c.imageDesc !== false && posts.length) {
          const p0 = posts[0]
          if ((p0.imgs ?? []).length && typeof bridge.gateway?.makeImageBlock === 'function' && typeof bridge._describeForwardImages === 'function') {
            try {
              const blocks = []
              for (const u of p0.imgs.slice(0, 2)) {
                const ir = await fetchWithProxyFallback(u, { timeoutMs: 20000, headers: { Referer: 'https://user.qzone.qq.com/' } })
                if (!ir?.ok) continue
                const buf = Buffer.from(await ir.arrayBuffer())
                if (buf.length > 6 * 1024 * 1024) continue
                const mt = /\.png$/i.test(u) ? 'image/png' : 'image/jpeg'
                const blk = await bridge.gateway.makeImageBlock({ base64: buf.toString('base64'), mediaType: mt, name: 'friend' })
                if (blk) blocks.push(blk)
              }
              if (blocks.length) {
                p0.imageDesc = String(await bridge._describeForwardImages(blocks) || '').slice(0, 300)
              }
            } catch (e) {
              bridge.log?.warn?.('qzone-friends：识图失败 — ' + String(e?.message ?? e).slice(0, 60))
            }
          }
        }

        cache = { at: Date.now(), posts, error: '' }
        writeCache()
        const withImg = posts.filter((p) => (p.imgs ?? []).length).length
        bridge.log?.info?.('qzone-friends：拉到 ' + posts.length + ' 条好友说说（' + withImg + ' 条带图）')
      } catch (e) {
        cache = { ...cache, at: Date.now(), error: String(e?.message ?? e).slice(0, 120) }
        writeCache()
        bridge.log?.warn?.('qzone-friends：拉取失败 — ' + String(e?.message ?? e).slice(0, 80))
      }
    }

    /** 给提示词：朋友们最近发了什么（含最新一条的配图内容）。 */
    const digest = () => {
      try {
        const c = cfg()
        if (c.enabled === false) return ''
        if (!cache?.posts?.length) return ''
        if (Date.now() - Number(cache.at ?? 0) > Number(c.ttlMs ?? DEFAULTS.ttlMs)) return ''
        const lines = ['## 朋友们最近发的空间（真实数据，别编）']
        for (const p of cache.posts.slice(0, 4)) {
          let line = '- ' + (p.nick || p.owner) + '：「' + String(p.text).slice(0, 60) + '」'
          if ((p.imgs ?? []).length) line += '（' + p.imgs.length + ' 张图）'
          lines.push(line)
          if (p.imageDesc) lines.push('  · 图里是：' + String(p.imageDesc).slice(0, 150))
        }
        lines.push('（这些是真实存在的动态。他没问就不用主动提；要提就用自己的话说，别照念。）')
        return lines.join('\n')
      } catch { return '' }
    }

    bridge._qzoneFriendsDigest = digest
    bridge._qzoneFriendsRefresh = refresh

    const timer = setInterval(() => { void refresh() }, Number(cfg().pollMs ?? DEFAULTS.pollMs))
    timer.unref?.()
    bridge._qzoneFriendsTimer = timer
    try { setTimeout(() => { void refresh() }, 100_000).unref?.() } catch { /* ignore */ }

    bridge.log?.info?.('qzone-friends：好友动态已挂载（每 ' + Math.round(Number(cfg().pollMs) / 60_000) + ' 分钟 · 只读' + (cfg().imageDesc !== false ? ' · 含识图' : '') + '）')
    return timer
  } catch (e) {
    bridge?.log?.warn?.('qzone-friends：启动失败 — ' + String(e?.message ?? e).slice(0, 80))
    return null
  }
}
