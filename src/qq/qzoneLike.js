/**
 * QQ 空间「给别人点赞」（2026-11-19）
 *
 * ## 用户口径
 * 「别人的只点赞，不评论」—— 所以这个文件**只有点赞**，一行评论代码都没有。
 *
 * ## 怎么绕过遗产版 NapCat
 * 不用它的 action 表，只用 `get_cookies` 拿登录态（cookie + bkn），
 * 自己打 QZone 的 CGI：
 *   · feeds3_html_more      → 好友动态列表（要 `\xNN` 反转义，否则匹配不到）
 *   · internal_dolike_app   → 点赞（实测 code:0）
 *
 * ## 实测记录（2026-11-19）
 *   feeds3 原样返回是 JSON 里再套一层转义 HTML，`data-tid="…"` 全变成
 *   `data-tid=\\x22…\\x22` —— **必须先反转义再正则**，否则一条都抓不到
 *   （第一次探测就是 0 条，踩过）。
 *   点赞成功后 feeds3 里那条的 `data-islike` 变成 1。
 *
 * ## 克制的理由
 * 点赞是**公开社交动作**：太密会被风控，也会显得不像人。
 * 所以有三道闸：每次最多 N 条、两条之间最小间隔、每天总量上限，
 * 外加「同一个 tid 永不重复点」。
 *
 * 配置：`qq.qzoneLike = { enabled, maxPerRun, minGapMs, dailyMax, maxAgeHours, skipOwn }`
 */
import fs from 'node:fs'
import path from 'node:path'
import { fetchWithProxyFallback } from '../net.js'

const DEFAULTS = {
  enabled: false,
  /** 一轮最多点几个（别一次点一排，太像机器人） */
  maxPerRun: 2,
  /** 两次点赞之间的最小间隔（毫秒） */
  minGapMs: 90_000,
  /** 每天最多点几个 */
  dailyMax: 10,
  /** 只看最近多少小时内的动态（老帖子突然点赞很怪） */
  maxAgeHours: 72,
  /** 跳过自己发的 */
  skipOwn: true,
}

/** feeds3 返回的是「JSON 里套着 \xNN 转义的 HTML」，必须反转义。 */
function unescapeFeedText (s) {
  return String(s ?? '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
}

/**
 * 从 feeds3 HTML 里抓出「可以点赞的帖子」。
 * 只取 feed_data 里那几个属性 —— 正文不解析（点赞用不到）。
 */
export function parseFeedPosts (html, selfUin) {
  const out = []
  const re = /<div[^>]*class="f-item[^"]*"[^>]*id="feed_(\d+)_(\d+)_(\d+)_(\d+)_\d+_\d+"[\s\S]*?name="feed_data"([^>]*)>/g
  let m
  while ((m = re.exec(html)) !== null) {
    const owner = m[1]
    const attrs = m[5]
    const pick = (n) => {
      const r = new RegExp('data-' + n + '="([^"]*)"').exec(attrs)
      return r ? r[1] : ''
    }
    const tid = pick('tid')
    if (!tid) continue
    if (String(selfUin) && owner === String(selfUin)) continue
    out.push({
      owner,
      tid,
      abstime: Number(pick('abstime') || m[4] || 0),
      appid: m[2] || '311',
      typeid: m[3] || '0',
      key: pick('fkey') || tid,
    })
  }
  return out
}

export function startQzoneLike (bridge, opts = {}) {
  try {
    if (!bridge || bridge._qzoneLikeTimer) return bridge?._qzoneLikeTimer ?? null
    const home = opts.home ?? null
    if (!home) { bridge.log?.info?.('qzone-like：没有 home，跳过挂载'); return null }
    const cfg = () => ({ ...DEFAULTS, ...(bridge.cfg?.qzoneLike ?? bridge.cfg?.qq?.qzoneLike ?? {}) })
    const stateFile = path.join(home, 'qzone-liked.json')

    let state = { liked: {}, lastAt: 0, day: '', count: 0 }
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (raw && typeof raw === 'object') state = { ...state, ...raw }
    } catch { /* 首次 */ }
    const writeState = () => {
      try {
        /* 只留最近 500 条 tid，别让文件无限长 */
        const keys = Object.keys(state.liked ?? {})
        if (keys.length > 500) {
          const keep = keys.slice(-500)
          const next = {}
          for (const k of keep) next[k] = state.liked[k]
          state.liked = next
        }
        fs.writeFileSync(stateFile, JSON.stringify(state))
      } catch { /* ignore */ }
    }
    const today = () => new Date().toLocaleDateString('sv-SE')
    const ensureDay = () => { if (state.day !== today()) { state.day = today(); state.count = 0 } }

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

    /** 统一的请求头（Cookie 由 auth 现取，不写死）。 */
    const buildHeaders = (auth, uin) => ({
      'User-Agent': ['Mozilla', '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'].join('/'),
      Referer: 'https://user.qzone.qq.com/' + uin,
      Cookie: auth.cookies
    })
    const fetchFeedPosts = async (uin, auth) => {
      const url = 'https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more'
        + '?uin=' + encodeURIComponent(uin) + '&scope=0&view=1&filter=all&flag=1&applist=all'
        + '&fupdate=1&refresh=0&styledm=user.qzone.qq.com&g_tk=' + encodeURIComponent(auth.bkn)
        + '&format=json&pagenum=1'
      const resp = await fetchWithProxyFallback(url, {
        timeoutMs: 20000,
        headers: buildHeaders(auth, uin),
      })
      if (!resp?.ok) throw new Error('feeds3 HTTP ' + String(resp?.status ?? '?'))
      const html = unescapeFeedText(await resp.text())
      return parseFeedPosts(html, uin)
    }

    const doLike = async (uin, auth, post) => {
      const unikey = 'http://user.qzone.qq.com/' + post.owner + '/mood/' + post.tid
      const body = new URLSearchParams({
        qzreferrer: 'https://user.qzone.qq.com/' + uin + '/main',
        opuin: uin,
        unikey,
        curkey: unikey,
        appid: post.appid,
        typeid: post.typeid,
        fid: post.tid,
        from: '1',
        active: '0',
        fupdate: '1',
        abstime: String(post.abstime || Math.floor(Date.now() / 1000)),
        format: 'json',
      }).toString()
      const url = 'https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app'
        + '?g_tk=' + encodeURIComponent(auth.bkn)
      const resp = await fetchWithProxyFallback(url, {
        method: 'POST',
        timeoutMs: 15000,
        headers: { ...buildHeaders(auth, uin),
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body,
      })
      const text = String(await resp.text())
      let j = null
      try { j = JSON.parse(text) } catch { /* 可能不是 JSON */ }
      const ok = Number(j?.code ?? -1) === 0 || Number(j?.ret ?? -1) === 0
      return { ok, code: j?.code ?? null, message: String(j?.message ?? text.slice(0, 60)) }
    }

    let busy = false
    const runOnce = async () => {
      const c = cfg()
      if (c.enabled !== true) return
      if (busy) return
      busy = true
      try {
        ensureDay()
        if (Number(state.count ?? 0) >= Number(c.dailyMax ?? 0)) return
        if (state.lastAt && Date.now() - Number(state.lastAt) < Number(c.minGapMs ?? 0)) return

        const uin = String(bridge.selfId ?? '').trim()
        if (!uin) return
        const auth = await getAuth()
        const posts = await fetchFeedPosts(uin, auth)
        if (!posts.length) { bridge.log?.info?.('qzone-like：好友动态里没有可点的帖子'); return }

        const cutoff = Date.now() / 1000 - Number(c.maxAgeHours ?? 72) * 3600
        const fresh = posts.filter((p) => !state.liked?.[p.tid] && (!p.abstime || p.abstime >= cutoff))
        if (!fresh.length) { bridge.log?.info?.('qzone-like：没有新的可点帖子（都点过了或太旧）'); return }

        let done = 0
        for (const p of fresh) {
          if (done >= Number(c.maxPerRun ?? 1)) break
          if (Number(state.count ?? 0) >= Number(c.dailyMax ?? 0)) break
          if (done > 0 && Number(c.minGapMs ?? 0) > 0) {
            await new Promise((r) => setTimeout(r, Number(c.minGapMs)))
          }
          const res = await doLike(uin, auth, p)
          if (res.ok) {
            state.liked = { ...(state.liked ?? {}), [p.tid]: Date.now() }
            state.lastAt = Date.now()
            state.count = Number(state.count ?? 0) + 1
            writeState()
            done++
            bridge.log?.info?.('qzone-like：给 ' + p.owner + ' 的说说点了赞（今天第 ' + state.count + ' 个）')
          } else {
            bridge.log?.warn?.('qzone-like：点赞失败 ' + String(res.code) + ' ' + res.message)
            /* 失败就停，别硬刷（大概率是被限流了） */
            break
          }
        }
      } catch (e) {
        bridge.log?.warn?.('qzone-like：这一轮失败 — ' + String(e?.message ?? e).slice(0, 80))
      } finally {
        busy = false
      }
    }

    bridge._qzoneLikeRunOnce = runOnce
    /* 每 10 分钟看一次；真正的节奏由 minGapMs / dailyMax 控制 */
    const timer = setInterval(() => { void runOnce() }, 10 * 60_000)
    timer.unref?.()
    bridge._qzoneLikeTimer = timer

    bridge.log?.info?.(
      'qzone-like：已挂载' + (cfg().enabled === true ? '' : '（未启用：qq.qzoneLike.enabled=false）')
      + ' · 每轮最多 ' + cfg().maxPerRun + ' 个 · 间隔 ' + Math.round(Number(cfg().minGapMs) / 1000) + 's'
      + ' · 每天最多 ' + cfg().dailyMax + ' 个',
    )
    return timer
  } catch (e) {
    bridge?.log?.warn?.('qzone-like：启动失败 — ' + String(e?.message ?? e).slice(0, 80))
    return null
  }
}
