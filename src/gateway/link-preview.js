/**
 * 链接预览 —— 别人分享链接时，真去把那页**看点东西回来**。
 *
 * ## 为什么需要
 * 原来只有 **B 站**会真去抓（`src/qq/bilibili.js`）。别的站：
 *   · 分享卡片**带标题** → 她只读到消息里那行文字（那行是腾讯加的，不是网页）
 *   · **裸链接**         → 什么都看不到
 * 用户原话：「现在分享一个链接…她能去看吗」—— 答案是**除了 B 站都不行**。
 *
 * ## 抓什么
 * 按**性价比**排序，够模型"知道这是什么"就行，不追求全文：
 *   ① `og:title` / `<title>`         —— 标题
 *   ② `og:description` / `description` —— 描述
 *   ③ `og:site_name`                 —— 站点名（"小黑盒"/"知乎"）
 *   ④ 正文里的头几百字（兜底）         —— 有些站没有 og 标签
 *
 * ## 三条硬约束
 * ① **不许拖慢回复**：超时 3.5 秒，到点就放弃（`AbortController`）。
 *    用户明确不喜欢额外延迟，所以这里宁可拿不到，也不让回复卡住。
 * ② **只读前 400KB**：og 标签一定在 `<head>` 里；正文摘要在前面几百字内。
 *    整页可能有几 MB（图片 base64、内联脚本），下完纯属浪费。
 * ③ **失败一律返回 null，绝不抛错**：这是个锦上添花的功能。
 *    任何一个站的反爬、超时、乱码都不该影响回复。
 *
 * ## 抓不到就别装懂
 * 返回 null 时调用方**不能编**「我看了」—— 要让模型知道"打不开"，
 * 而不是拿标题硬猜内容（历史上踩过：它编过"点开想学修电脑"）。
 */

import { fetchWithProxyFallback } from '../net.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** 从文本里挑出第一个**看起来能抓**的 http(s) 链接。 */
export function extractLink(text) {
  const m = String(text ?? '').match(/https?:\/\/[^\s，。、）)】\]]+/i)
  if (!m) return null
  const url = m[0].replace(/[.,;:!?]+$/, '')
  // 明显不是网页的（图片/视频直链）跳过 —— 那些走媒体那条路
  if (/\.(png|jpe?g|gif|webp|mp4|mp3|m4a|wav|zip|pdf)(\?|$)/i.test(url)) return null
  return url
}

/** HTML 实体解码（够用就行，不引依赖）。 */
function decodeEntities(s) {
  const MAP = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
  }
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)) } catch { return '' } })
    .replace(/&([a-z]+);/gi, (m0, name) => MAP[name.toLowerCase()] ?? m0)
}

/** 取一个 meta 标签的 content（property / name 两种写法都认）。 */
function meta(html, key) {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const re of [
    new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${k}["']`, 'i'),
  ]) {
    const m = re.exec(html)
    if (m && m[1].trim()) return decodeEntities(m[1].trim())
  }
  return ''
}

/** 去掉标签、压掉空白，截到 max 字。 */
function textOf(html, max) {
  const t = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(t).replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * **纯函数**：从一段 HTML 里解析出预览信息。
 *
 * ⚠️ 单独导出是为了**能测**：抓取要联网（测试里会 flaky、还会拖慢全量），
 *    而解析逻辑（og 标签、实体解码、正文兜底）才是最容易写错的部分。
 *    实测踩过：`og:image` 那种 `<meta property=... content=...>` 的
 *    **属性顺序会反**（有些站写成 content 在前），只认一种必然漏。
 *
 * @param {string} html
 * @param {string} url
 * @param {object} [opts]
 * @returns {{title:string, description:string, siteName:string, body:string}}
 */
export function parseLinkPreview(html, url, opts = {}) {
  const bodyChars = opts.bodyChars ?? 400
  const title = meta(html, 'og:title') || meta(html, 'twitter:title')
    || decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim())
  const description = meta(html, 'og:description') || meta(html, 'twitter:description')
    || meta(html, 'description')
  const siteName = meta(html, 'og:site_name')

  /*
   * 正文兜底：有些站（尤其小站 / 论坛）**没有 og 标签**，
   * 但 `<title>` 之外还有正文。取 `body` 去标签后的头几百字。
   * ⚠️ 只在**连描述都没有**时才用 —— 有描述时正文反而更长更散，
   *    塞进提示词会挤掉别的上下文。
   */
  let body = ''
  if (!description) {
    const bodyHtml = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    body = textOf(bodyHtml, bodyChars)
    // 正文开头常常就是站点导航，跟标题重复的部分切掉
    if (title && body.startsWith(title)) body = body.slice(title.length).trim()
  }
  return { title, description, siteName, body }
}

/**
 * 抓一个链接的预览信息。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=3500]
 * @param {number} [opts.bodyChars=400]  正文摘要最多取多少字
 * @returns {Promise<{url:string, finalUrl:string, title:string, description:string, siteName:string, body:string}|null>}
 */
export async function fetchLinkPreview(url, opts = {}) {
  if (!/^https?:\/\//i.test(String(url ?? ''))) return null
  const timeoutMs = opts.timeoutMs ?? 3500
  const bodyChars = opts.bodyChars ?? 400

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchWithProxyFallback(url, {
      signal: ctrl.signal,
      // ⚠️ 两个超时都给：`timeoutMs` 是 fetchWithProxyFallback **自己**那层
      //    （它内部要管代理重试，必须有），`signal` 是这里这层。
      //    只给 signal 的话，第一跳失败后它内部重试可能不受这里控制。
      timeoutMs,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!res.ok) return null
    const ct = String(res.headers?.get?.('content-type') ?? '')
    // 不是网页（图片/PDF/二进制）就别当网页解析
    if (ct && !/text\/html|application\/xhtml|text\/plain/i.test(ct)) return null

    const buf = await res.arrayBuffer()
    const html = Buffer.from(buf.slice(0, 400_000)).toString('utf8')

    const parsed = parseLinkPreview(html, url, { bodyChars })
    const { title, description, siteName, body } = parsed
    if (!title && !description && !body) return null
    return { url, finalUrl: String(res.url ?? url), title, description, siteName, body }
  } catch {
    // 超时 / DNS / 反爬 / 编码炸 —— 一律当"抓不到"
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把预览变成**喂给模型的注记**。
 *
 * ⚠️ 措辞上刻意区分「抓到了」和「没抓到」——
 *    抓不到时**必须明说**，否则模型会拿标题硬猜内容
 *    （历史上踩过：它编过"点开想学修电脑"）。
 */
export function formatLinkContext(preview, opts = {}) {
  if (!preview) {
    return '〔提示：这条消息里的链接**我打不开**（超时或被挡）。'
      + '只能说"我这边打不开"，**不许猜网页里讲了什么**。〕'
  }
  const lines = []
  const name = preview.siteName ? `（${preview.siteName}）` : ''
  if (preview.title) lines.push(`标题：${preview.title}${name}`)
  if (preview.description) lines.push(`简介：${preview.description.slice(0, opts.descChars ?? 200)}`)
  if (preview.body) lines.push(`正文开头：${preview.body.slice(0, opts.bodyChars ?? 200)}`)
  /*
   * ⚠️ 标题里**不能再写「（我打开看了）」**（2026-11-03 改）。
   *
   * ## 原措辞惹的祸
   * 「我打开看了」本意只是跟上面"打不开"那条**区分开**（别让它抓成功还说打不开），
   * 但它同时告诉模型「我是个会点网页的人」。实测后果（群里 21:22）：
   * ```
   * 21:21:43 我「我哪来的码，我又不开房 / 你们开好了喊我」
   * 21:22:46 群友「https://game.misyra.com/?room=APXZ Null_」
   * 21:22:47 链接预览 ✅ 卫戍协议：盟约 · STRONGHOLD PROTOCOL
   * 21:22:50 我「来了来了，这就进」        ← 她根本进不去
   * ```
   * 用户原话：「**进不去就不该那么说**」。
   *
   * 改成「我读到了这些**文字**」：仍然是"抓到了"的意思（和"打不开"照样区分得开），
   * 但把话说准 —— 她手上只有文本，**没有浏览器，点不动、进不去**。
   * 后面再补一句 〔提示：…〕，把"要登录/扫码/进房间一起玩"的场子明确划出去。
   *
   * ⚠️ 为什么这句必须写在这里、而不是只写进人格：事故就发生在**链接旁边** ——
   *    指令贴在使用现场才拦得住（同 jm-read、以及上面那条"打不开"的做法）。
   */
  return `## 对方分享的链接（我读到了这些文字）\n${lines.join('\n')}\n`
    + '〔提示：上面是**页面的文字**，我读到这儿为止 —— 网页本身我**点不动**：'
    + '要登录、扫码、进房间、跟人一起玩的那些，**我参加不了**。'
    + '别回「来了来了这就进」「带我一把」这种话；想凑热闹就聊它、问战况、起哄。〕'
}