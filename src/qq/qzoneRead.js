/**
 * QQ 空间**只读**能力（2026-11-19）
 *
 * ## 为什么不用 NapCat 的新接口
 * 手上这份 NapCat 是改过的遗产版、上游已停更，不能升级。
 * 但当前版本已经暴露了 get_cookies / get_csrf_token —— 拿登录态
 * 自己去调 QZone 网页 CGI 就行（onebot-qzone 那套），**不动 NapCat**。
 *
 * 实测（2026-11-19）：
 *   · get_cookies(qzone.qq.com) → 含 skey / p_skey / p_uin，另有 bkn
 *   · emotion_cgi_msglist_v6    → 自己的说说列表，200 / 6 条
 *   · emotion_cgi_msgdetail_v6  → 单条详情（cmtnum）
 *   · feeds3_html_more          → 好友动态，code 0
 *
 * ## 边界（重要）
 * **只读**。不点赞、不评论、不转发 —— 那些是公开社交动作：
 * ① 立刻暴露"她是机器人"；② 触发 QQ 风控；③ 发出去收不回。
 *
 * 配置：qq.qzoneRead = { enabled, pollMs, maxPosts, ttlMs }
 */
import fs from 'node:fs'
import path from 'node:path'
import { fetchWithProxyFallback } from '../net.js'

const DEFAULTS = {
  enabled: true,
  pollMs: 10 * 60_000,
  maxPosts: 5,
  ttlMs: 10 * 60_000,
}

/** QZone 的 CGI 返回是 _Callback({...}); 这种 JSONP，剥壳。 */
function unwrapJsonp (text) {
  const s = String(text ?? '').trim()
  const m = /^[_(A-Za-z0-9$.]*\s*\(([\s\S]*)\)\s*;?\s*$/.exec(s)
  const body = m ? m[1] : s
  try { return JSON.parse(body) } catch { return null }
}

export function startQzoneRead (bridge, opts = {}) {
  try {
    if (!bridge || bridge._qzoneReadTimer) return bridge?._qzoneReadTimer ?? null
    const home = opts.home ?? null
    if (!home) { bridge.log?.info?.('qzone-read：没有 home，跳过挂载'); return null }
    const cfg = () => ({ ...DEFAULTS, ...(bridge.cfg?.qzoneRead ?? bridge.cfg?.qq?.qzoneRead ?? {}) })
    const cacheFile = path.join(home, 'qzone-read.json')

    let cache = { at: 0, uin: '', posts: [], error: '' }
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      if (raw && typeof raw === 'object') cache = { ...cache, ...raw }
    } catch { /* 首次没有就当空 */ }
    const writeCache = () => { try { fs.writeFileSync(cacheFile, JSON.stringify(cache)) } catch { /* ignore */ } }

    /** 拿 QQ 空间的登录态：cookie + bkn（g_tk）。 */
    const getAuth = async () => {
      const send = bridge.onebot?._sendPreferHttp
        ? (a, p) => bridge.onebot._sendPreferHttp(a, p)
        : (a, p) => bridge.onebot?.call?.(a, p)
      const r = await send('get_cookies', { domain: 'qzone.qq.com' })
      const cookies = String(r?.data?.cookies ?? '')
      const bkn = String(r?.data?.bkn ?? '')
      if (!cookies) throw new Error('get_cookies 没返回 cookie')
      if (!bkn) throw new Error('get_cookies 没返回 bkn')
      return { cookies, bkn }
    }

    const fetchCgi = async (url, auth) => {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        Referer: 'https://user.qzone.qq.com/',
      }
      headers['Cookie'] = auth.cookies
      const resp = await fetchWithProxyFallback(url, { timeoutMs: 15000, headers })
      if (!resp?.ok) throw new Error('HTTP ' + String(resp?.status ?? '?'))
      return unwrapJsonp(await resp.text())
    }

    const fetchMyPosts = async (uin, auth, num) => {
      const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6'
        + '?uin=' + encodeURIComponent(uin) + '&ftype=0&sort=0&pos=0&num=' + num
        + '&g_tk=' + encodeURIComponent(auth.bkn) + '&code=2&format=json'
      const j = await fetchCgi(url, auth)
      if (!j || Number(j.code) !== 0) throw new Error('msglist code=' + String(j?.code ?? '?'))
      return (j.msglist ?? []).map((m) => ({
        tid: String(m.tid ?? ''),
        content: String(m.content ?? '').slice(0, 200),
        createdTime: Number(m.created_time ?? 0),
        comments: Number(m.cmtnum ?? 0),
        forwards: Number(m.fwdnum ?? 0),
        conlist: (m.conlist ?? []).slice(0, 5).map((c) => ({
          con: String(c.con ?? '').slice(0, 120),
          name: String(c.name ?? ''),
          uin: String(c.uin ?? ''),
          time: Number(c.createTime ?? c.created_time ?? 0),
        })),
      }))
    }

    const refresh = async () => {
      const c = cfg()
      if (c.enabled === false) return
      try {
        const uin = String(bridge.selfId ?? '').trim()
        if (!uin) throw new Error('bridge.selfId 为空')
        const auth = await getAuth()
        const posts = await fetchMyPosts(uin, auth, Number(c.maxPosts ?? 5))
        cache = { at: Date.now(), uin, posts, error: '' }
        writeCache()
        const totalC = posts.reduce((n, p) => n + p.comments, 0)
        bridge.log?.info?.('qzone-read：拉到 ' + posts.length + ' 条说说（评论合计 ' + totalC + '）')
      } catch (e) {
        cache = { ...cache, at: Date.now(), error: String(e?.message ?? e).slice(0, 120) }
        writeCache()
        bridge.log?.warn?.('qzone-read：拉取失败 — ' + String(e?.message ?? e).slice(0, 80))
      }
    }

    /** 给提示词的一段：她自己的空间动态。缓存不新鲜就不给。 */
    const digest = () => {
      try {
        const c = cfg()
        if (c.enabled === false) return ''
        if (!cache?.posts?.length) return ''
        if (Date.now() - Number(cache.at ?? 0) > Number(c.ttlMs ?? DEFAULTS.ttlMs)) return ''
        const p = cache.posts[0]
        const lines = [
          '## 你自己的空间动态（真实数据，别编）',
          '你最近一条说说：「' + String(p.content).slice(0, 60) + '」（' + p.comments + ' 条评论、' + p.forwards + ' 次转发）',
        ]
        const cs = (p.conlist ?? []).filter((x) => x.con)
        if (cs.length) {
          lines.push('评论区：')
          for (const x of cs.slice(0, 5)) lines.push('- ' + (x.name || '某人') + '：' + x.con)
        }
        lines.push('（这些是空间里真实存在的评论，不是他说的。用你自己的话回应，别照念。）')
        return lines.join('\n')
      } catch { return '' }
    }

    bridge._qzoneReadDigest = digest
    bridge._qzoneReadRefresh = refresh

    const timer = setInterval(() => { void refresh() }, Number(cfg().pollMs ?? DEFAULTS.pollMs))
    timer.unref?.()
    bridge._qzoneReadTimer = timer
    try { setTimeout(() => { void refresh() }, 90_000).unref?.() } catch { /* ignore */ }

    bridge.log?.info?.('qzone-read：只读空间已挂载（每 ' + Math.round(Number(cfg().pollMs) / 60_000) + ' 分钟拉一次自己的说说）')
    return timer
  } catch (e) {
    bridge?.log?.warn?.('qzone-read：启动失败 — ' + String(e?.message ?? e).slice(0, 80))
    return null
  }
}
