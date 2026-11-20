/**
 * QQ 空间「回评论」（2026-11-19）
 *
 * ## 用户口径
 * 「先在自己的空间下面试」—— 所以这一版**只回她自己说说下的评论**，
 * 不碰好友的说说。好友那条等这套跑稳、删除接口找到之后再谈。
 *
 * ## 端点（实测通了的，抄 Maizone 的参数）
 *   POST emotion_cgi_re_feeds?g_tk=<bkn>
 *   topicId=<uin>_<tid>__1  uin  hostUin  feedsType=100
 *   plat=qzone  source=ic  platformid=52  format=fs  ref=feeds  content
 * ⚠️ 不是 addcomment_v6 + format=json —— 那条路全是 HTTP 500，试过十来种组合。
 * 实测 `re_feeds` + `format=fs` 返回 code:0，评论真的出现在说说下面。
 *
 * ## 已知限制
 * **删除评论的接口没找到**（delcomment_v6 各种 host 都 500，re_feeds op=del 也无效）。
 * 所以这里必须比点赞更保守：默认关闭、默认 dryRun、每天最多 1 条。
 *
 * ## 四道闸
 *   ① 只回自己说说（owner === selfUin）
 *   ② 只回**别人**发的评论（自己刚发的测试评论不自己回自己）
 *   ③ 频率：每天上限 + 两次之间随机间隔 + 只在 9–23 点
 *   ④ 内容：长度/重复/敏感词检查，不合格就不发
 *
 * 配置：qq.qzoneComment = { enabled, dryRun, dailyMax, minGapMs, windowStart, windowEnd, maxPerPost }
 */
import fs from 'node:fs'
import path from 'node:path'
import { fetchWithProxyFallback } from '../net.js'

const DEFAULTS = {
  enabled: false,
  /** 只记录「本来会回什么」，不发出去。建议先跑几天看内容。 */
  dryRun: true,
  dailyMax: 1,
  minGapMs: 45 * 60_000,
  windowStart: 9,
  windowEnd: 23,
  /** 同一条说说下最多回几次 */
  maxPerPost: 2,
}

/** QZone 的写接口回的是「HTML 里包一个 frameElement.callback({...})」。 */
function parseCallback (text) {
  const s = String(text ?? '')
  const i = s.indexOf('frameElement.callback(')
  if (i < 0) return null
  const start = i + 'frameElement.callback('.length
  const end = s.lastIndexOf(');')
  if (end <= start) return null
  try { return JSON.parse(s.slice(start, end)) } catch { return null }
}

function unwrapJsonp (text) {
  const s = String(text ?? '').trim()
  const m = /^[_(A-Za-z0-9$.]*\s*\(([\s\S]*)\)\s*;?\s*$/.exec(s)
  const body = m ? m[1] : s
  try { return JSON.parse(body) } catch { return null }
}

/** 评论内容体检。返回 '' 表示合格，否则返回不合格原因。 */
export function checkCommentText (text, recent = []) {
  const s = String(text ?? '').trim()
  if (!s) return '空'
  if (s.length < 4) return '太短（<4 字）'
  if (s.length > 40) return '太长（>40 字）'
  /* 2026-11-20 实测：她真发出去过「（往被子里缩了缩）那赖到几点赖到几点⏎⏎你总不能一直躺着吧」——
   * 评论区不是聊天，动作旁白和分段都不该出现，看着就是 AI 写的。 */
  if (/[\r\n]/.test(s)) return '多行（评论区只能一行）'
  if (/[（(【\[][^）)】\]]{0,30}[）)】\]]/.test(s)) return '含括注/动作旁白'
  if (/https?:\/\/|www\.|@\S+/.test(s)) return '含链接/@'
  if (/[A-Za-z0-9]{8,}/.test(s) && /(qq|vx|微信|号)/i.test(s)) return '疑似联系方式'
  if (/^(哈+|呵+|嗯+|哦+|啊+)[。.!！~～]*$/.test(s)) return '纯语气词'
  if (/^(\[|【).*(\]|】)$/.test(s)) return '纯标记'
  if (/(机器人|人工智能|AI|模型|大模型|bot)/i.test(s)) return '自我暴露'
  if (/(加我|私聊|扫码|进群|关注)/.test(s)) return '营销词'
  if (recent.some((r) => String(r).trim() === s)) return '和最近发过的重复'
  return ''
}

export function startQzoneComment (bridge, opts = {}) {
  try {
    if (!bridge || bridge._qzoneCommentTimer) return bridge?._qzoneCommentTimer ?? null
    const home = opts.home ?? null
    if (!home) { bridge.log?.info?.('qzone-comment：没有 home，跳过挂载'); return null }
    const cfg = () => ({ ...DEFAULTS, ...(bridge.cfg?.qzoneComment ?? bridge.cfg?.qq?.qzoneComment ?? {}) })
    const stateFile = path.join(home, 'qzone-commented.json')

    let state = { day: '', count: 0, lastAt: 0, replied: {}, recent: [] }
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (raw && typeof raw === 'object') state = { ...state, ...raw }
    } catch { /* 首次 */ }
    const writeState = () => {
      try { fs.writeFileSync(stateFile, JSON.stringify(state)) } catch { /* ignore */ }
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

    const headers = (auth, uin) => {
      const h = {
        'User-Agent': ['Mozilla', '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'].join('/'),
        Referer: 'https://user.qzone.qq.com/' + uin,
        Origin: 'https://user.qzone.qq.com',
      }
      h['Cookie'] = auth.cookies
      return h
    }

    /** 拉自己最近的说说（含评论数）。 */
    const fetchMyPosts = async (uin, auth, num = 5) => {
      const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6'
        + '?uin=' + encodeURIComponent(uin) + '&ftype=0&sort=0&pos=0&num=' + num
        + '&g_tk=' + encodeURIComponent(auth.bkn) + '&code=2&format=json'
      const resp = await fetchWithProxyFallback(url, { timeoutMs: 15000, headers: headers(auth, uin) })
      if (!resp?.ok) throw new Error('msglist HTTP ' + String(resp?.status ?? '?'))
      const j = unwrapJsonp(await resp.text())
      if (!j || Number(j.code) !== 0) throw new Error('msglist code=' + String(j?.code ?? '?'))
      return (j.msglist ?? []).map((m) => ({
        tid: String(m.tid ?? ''),
        content: String(m.content ?? '').slice(0, 200),
        comments: Number(m.cmtnum ?? 0),
      }))
    }

    /** 拉某条说说的评论列表。 */
    const fetchComments = async (uin, tid, auth) => {
      const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6'
        + '?uin=' + encodeURIComponent(uin) + '&tid=' + encodeURIComponent(tid)
        + '&not_trunc_con=1&g_tk=' + encodeURIComponent(auth.bkn) + '&format=json'
      const resp = await fetchWithProxyFallback(url, { timeoutMs: 15000, headers: headers(auth, uin) })
      if (!resp?.ok) throw new Error('detail HTTP ' + String(resp?.status ?? '?'))
      const j = unwrapJsonp(await resp.text())
      if (!j || Number(j.code) !== 0) throw new Error('detail code=' + String(j?.code ?? '?'))
      return (j.commentlist ?? []).map((c) => ({
        id: String(c.tid ?? ''),
        uin: String(c.uin ?? ''),
        name: String(c.name ?? ''),
        content: String(c.content ?? ''),
        at: Number(c.create_time ?? 0),
        canDelete: Number(c.abledel ?? 0) === 1,
      }))
    }

    /** 发一条评论（实测可用的那条路）。 */
    const postComment = async (uin, tid, content, auth) => {
      const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds'
        + '?g_tk=' + encodeURIComponent(auth.bkn)
      const body = new URLSearchParams({
        topicId: uin + '_' + tid + '__1',
        uin,
        hostUin: uin,
        feedsType: '100',
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        plat: 'qzone',
        source: 'ic',
        platformid: '52',
        format: 'fs',
        ref: 'feeds',
        content,
      }).toString()
      const resp = await fetchWithProxyFallback(url, {
        method: 'POST',
        timeoutMs: 20000,
        headers: { ...headers(auth, uin), 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      const text = String(await resp.text())
      const j = parseCallback(text)
      const ok = Number(j?.code ?? -1) === 0
      return { ok, code: j?.code ?? null, message: String(j?.msg ?? text.slice(0, 80)) }
    }

    /** 从 qzone-read 的缓存里找这条说说的配图描述（qzoneRead 已经识过图了，别重复花钱）。 */
    const readCachedImageDesc = (tid) => {
      try {
        const p = path.join(home, 'qzone-read.json')
        const j = JSON.parse(fs.readFileSync(p, 'utf8'))
        const hit = (j?.posts ?? []).find((x) => String(x?.tid ?? '') === String(tid ?? ''))
        return String(hit?.imageDesc ?? '').trim()
      } catch { return '' }
    }

    /** 让她说一句回复（走 bridge 的生成层，带上下文）。 */
    const composeReply = async (uin, scope, post, comment) => {
      const imageDesc = readCachedImageDesc(post.tid)
      const hint = [
        '## 有人在你的说说下面留言了',
        '（这不是聊天，是 QQ 空间的评论区 —— 回复会**公开挂在你的说说下面**，好友都看得见）',
        '',
        '你这条说说：「' + String(post.content ?? '').slice(0, 80) + '」',
        imageDesc ? '（这条说说配的图：' + imageDesc.slice(0, 160) + '）' : '',
        '',
        '留言的人：' + (comment.name || '某人'),
        '他说：「' + String(comment.content).slice(0, 100) + '」',
        '',
        '要求：',
        '· **只要一行**，4–30 字，口语，像随手回一句',
        '· **不许换行**，**不许用括号写动作或神态**（不要「（笑了笑）」「（往被子里缩）」这种）',
        '· **不要**提发图/拍照，不要用感叹号，不要 @ 人，不要表情包标记',
        '· 不要问「你是谁」这类客套话',
        '· 不想回就输出 [SILENT]',
        '· 直接输出回复正文，不要任何前缀或引号',
      ].join('\n')
      const mem = (() => { try { return bridge._memOf?.(scope) ?? bridge.memory?.get?.(scope) ?? null } catch { return null } })()
      let scene = null
      try { scene = await bridge.sceneOf?.({ scope, kind: 'private' }) } catch { scene = null }
      const gen = await bridge._generate(
        {
          scope,
          kind: 'private',
          userId: uin,
          groupId: null,
          sender: uin,
          senderName: '',
          text: '',
          speakHint: hint,
          isMe: false,
          at: Date.now(),
          __qzoneComment: true,
        },
        mem, scene, { id: bridge.selfId, name: bridge.selfName },
      )
      return String(gen?.text ?? '').trim()
    }

    let busy = false
    const runOnce = async () => {
      const c = cfg()
      if (c.enabled !== true) return
      if (busy) return
      busy = true
      try {
        ensureDay()
        const hour = new Date().getHours()
        if (hour < Number(c.windowStart) || hour >= Number(c.windowEnd)) return
        if (Number(state.count ?? 0) >= Number(c.dailyMax ?? 0)) return
        if (state.lastAt && Date.now() - Number(state.lastAt) < Number(c.minGapMs ?? 0)) return

        const uin = String(bridge.selfId ?? '').trim()
        if (!uin) return
        const scope = (() => {
          const byScope = bridge.cfg?.persona?.activeByScope ?? {}
          const pinned = Object.keys(byScope).filter((k) => String(k).startsWith('private:'))
          return pinned[0] ?? 'private:' + uin
        })()

        const auth = await getAuth()
        const posts = await fetchMyPosts(uin, auth, 5)
        const withComments = posts.filter((p) => p.comments > 0)
        if (!withComments.length) {
          bridge.log?.info?.('qzone-comment：自己的说说下没有新评论')
          return
        }

        for (const post of withComments) {
          const comments = await fetchComments(uin, post.tid, auth)
          /* 只回**别人**发的，且没回过的 */
          const pending = comments.filter((cm) => {
            if (!cm.content) return false
            if (cm.uin === uin) return false                 // 自己发的不回
            const key = post.tid + ':' + cm.id
            if (state.replied?.[key]) return false            // 回过的跳过
            return true
          })
          if (!pending.length) continue
          const target = pending[pending.length - 1]         // 只回最新那条

          const text = await composeReply(uin, scope, post, target)
          if (!text || text.includes('[SILENT]')) {
            bridge.log?.info?.('qzone-comment：她选择不回这条')
            continue
          }
          const bad = checkCommentText(text, state.recent ?? [])
          if (bad) {
            bridge.log?.warn?.('qzone-comment：内容不合格（' + bad + '）→ 不发：「' + text.slice(0, 30) + '」')
            continue
          }

          if (c.dryRun === true) {
            bridge.log?.info?.('[dryRun] qzone-comment：本来会回「' + text + '」给 ' + (target.name || target.uin))
            continue
          }

          const res = await postComment(uin, post.tid, text, auth)
          if (res.ok) {
            const key = post.tid + ':' + target.id
            state.replied = { ...(state.replied ?? {}), [key]: Date.now() }
            state.recent = [...(state.recent ?? []), text].slice(-20)
            state.lastAt = Date.now()
            state.count = Number(state.count ?? 0) + 1
            writeState()
            bridge.log?.info?.('qzone-comment：回了 ' + (target.name || target.uin) + ' 一句「' + text.slice(0, 30) + '」（今天第 ' + state.count + ' 条）')
          } else {
            bridge.log?.warn?.('qzone-comment：发评论失败 code=' + String(res.code) + ' ' + res.message)
          }
          break    // 一轮只处理一条，别连发
        }
      } catch (e) {
        bridge.log?.warn?.('qzone-comment：这一轮失败 — ' + String(e?.message ?? e).slice(0, 80))
      } finally {
        busy = false
      }
    }

    bridge._qzoneCommentRunOnce = runOnce
    const timer = setInterval(() => { void runOnce() }, 15 * 60_000)
    timer.unref?.()
    bridge._qzoneCommentTimer = timer

    bridge.log?.info?.(
      'qzone-comment：已挂载' + (cfg().enabled === true ? '' : '（未启用：qq.qzoneComment.enabled=false）')
      + (cfg().dryRun === true ? ' · dryRun（只记不发）' : '')
      + ' · 每天最多 ' + cfg().dailyMax + ' 条',
    )
    return timer
  } catch (e) {
    bridge?.log?.warn?.('qzone-comment：启动失败 — ' + String(e?.message ?? e).slice(0, 80))
    return null
  }
}
