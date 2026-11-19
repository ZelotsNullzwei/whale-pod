/**
 * 带「代理失败自动直连」的 fetch。
 *
 * ## 为什么需要
 *
 * 本机装了代理软件（FlClash / Clash 等）时，它会把
 * `HTTP_PROXY` / `HTTPS_PROXY` 写进用户环境变量。Node 的 fetch
 * （undici）会**自动读取**这些变量。
 *
 * 问题：代理软件关掉之后，环境变量还在。于是所有出站请求都去连
 * `127.0.0.1:7890` —— 那里已经没人在听，直接 `ECONNREFUSED`。
 *
 * 症状（2026-10-25 实测）：
 *   · QQ 图片下载失败 — ECONNREFUSED
 *   · 联网搜索失败 — fetch failed
 *   而 QQ 连接正常（走 ws://127.0.0.1:3001，命中 NO_PROXY）
 *
 * 用户在群里看到的是「机器人看不见图」「不会联网」，完全想不到
 * 是代理残留。
 *
 * ## 怎么做
 *
 * 第一次按环境变量（可能走代理）请求。如果失败原因是**连接本机代理被拒**
 * （ECONNREFUSED / ECONNRESET 指向 127.0.0.1），就用一个绕开代理的
 * dispatcher 重试一次。
 *
 * 只对「代理不可用」这一种情况重试 —— 网络真断了、域名解析不了，
 * 重试也没意义，反而拖慢失败。
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

/**
 * 判断错误是不是「连不上代理」。
 * @param {any} e
 * @returns {boolean}
 */
export function isProxyFailure(e) {
  const code = e?.cause?.code ?? e?.code ?? ''
  const msg = String(e?.cause?.message ?? e?.message ?? '')
  if (!/ECONNREFUSED|ECONNRESET|EPROTO|EHOSTUNREACH/i.test(String(code))) {
    // 有些平台把原因塞在 message 里
    if (!/proxy|ECONNREFUSED/i.test(msg)) return false
  }
  // 指向本机代理端口才算 —— 远程服务器拒绝不代表代理问题
  return /127\.0\.0\.1|localhost|::1/.test(msg) || /7890|7891|7897|1080|10809/.test(msg)
}

/**
 * 造一个**不走代理**的 fetch。
 *
 * 做法：用 node:http/https 自己发请求，交给 undici 的 buildConnector
 * 太绕；这里直接用原生模块，够用且零依赖。
 *
 * 只支持 GET（图片下载和搜索索引都是 GET），够当前用途。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, status:number, headers:object, body:Buffer}>}
 */
export function fetchDirect(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? 15000)
  const u = new URL(url)
  const mod = u.protocol === 'https:' ? https : http

  // ⚠️⚠️ 关键：`agent: false` 还不够 —— Node 24 里 undici 的全局 dispatcher
  //      会接管 http/https 请求并**照读 HTTP_PROXY**。实测（2026-10-25）：
  //      即使清掉 module-level 的 fetch，`http.request` 依然报
  //      `connect ECONNREFUSED 127.0.0.1:7890`。
  //
  //      所以这里必须显式造一个**全新 Agent**，不继承任何全局配置。
  const agent = u.protocol === 'https:'
    ? new https.Agent({ keepAlive: false })
    : new http.Agent({ keepAlive: false })

  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
        res.on('error', reject)
      },
    )
    // ⚠️ 必须写 body —— POST 请求（搜索、摘要、余额查询）都要带。
    //    漏掉这一步的后果：请求发出去是空 body，上游报 401/400。
    if (opts.body !== undefined && opts.body !== null) {
      if (typeof opts.body === 'string' || Buffer.isBuffer(opts.body)) {
        req.write(opts.body)
      } else {
        // URLSearchParams / Uint8Array 之类
        req.write(Buffer.from(opts.body))
      }
    }
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 增强版 fetch：先用标准 fetch（跟随环境变量），
 * 若因「代理不可用」失败则直连重试。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<Response|{ok,status,headers,body}>}
 */
export async function fetchWithProxyFallback(url, opts = {}) {
  const log = opts.log ?? (() => {})
  const timeoutMs = Number(opts.timeoutMs ?? 15000)

  // ⚠️ 必须把 method / headers / body 原样透传下去。
  //
  // 2026-10-25 实测踩到：第一版只传了 signal：
  //     fetch(url, { signal: AbortSignal.timeout(...) })
  // 结果 POST 变成 GET、Authorization 头丢失、body 为空 ——
  // 搜索接口直接回 401 "Authentication Fails (missing key)"。
  //
  // 症状极具误导性：看着像「key 失效了」，实际是**请求根本没带 key**。
  // check-search 因此从 20/0 变成 15/5。
  const init = {
    method: opts.method ?? 'GET',
    headers: opts.headers ?? {},
    signal: AbortSignal.timeout(timeoutMs),
  }
  if (opts.body !== undefined) init.body = opts.body
  if (opts.redirect) init.redirect = opts.redirect

  try {
    return await fetch(url, init)
  } catch (e) {
    if (!isProxyFailure(e)) throw e
    log(`检测到代理不可用（${e?.cause?.code ?? e?.message}），改直连重试`)
    const parsed = await fetchDirect(url, opts)
    /*
     * ★ **兜底也必须返回真正的 Response**（2026-11-10）。
     *
     * 原来直接 `return fetchDirect(...)`，返回的是 `{ok,status,headers,body:Buffer}` 包装对象。
     * 调用方习惯写 `await resp.json()` / `resp.arrayBuffer()` → 代理一挂就报
     * 「res.json is not a function / resp.arrayBuffer is not a function」。
     * 现场两个：check-search 的 15/5 失败、生成图下载后裁不掉。
     * 这里包成标准 Response，所有调用方无需改动。
     */
    try {
      /*
       * ⚠️ 包装成 Response 时**别让 body 处于 locked 状态**（2026-11-19 修）。
       *
       * 现场：表情标签那批图全部「图片响应体读不出来（类型不支持）」，
       * 诊断打印 `res=Response body=ReadableStream bodyUsed=true locked=true`。
       * 根因：`fetchDirect` 的 body 是 **Node Readable 流**，
       * `new Response(流)` 构造时就把这个流锁住/消费掉了，
       * 下游 `res.arrayBuffer()` 和 `getReader()` 全都读不到东西。
       *
       * 兜底通道的数据本来就已经完整在内存里，所以先**把流读成 Buffer**，
       * 再返回一个带 `arrayBuffer()/text()/json()` 的普通对象，
       * 下游按 Buffer 那条路走，不经过任何流。
       */
      let body = parsed?.body
      if (body && typeof body.on === 'function' && !Buffer.isBuffer(body)) {
        body = await new Promise((resolve, reject) => {
          const parts = []
          body.on('data', (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
          body.on('end', () => resolve(Buffer.concat(parts)))
          body.on('error', reject)
        })
      }
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
        return {
          ok: parsed.status >= 200 && parsed.status < 300,
          status: parsed.status,
          headers: new Headers(parsed.headers ?? {}),
          body: buf,
          bodyUsed: false,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          text: async () => buf.toString('utf8'),
          json: async () => JSON.parse(buf.toString('utf8')),
        }
      }
      return new Response(body, { status: parsed.status, headers: parsed.headers })
    } catch {
      return parsed
    }
  }
}

/**
 * 环境自检：代理变量指向的端口是不是真的在听。
 * 给启动日志用 —— 让用户一眼看出「开着代理但代理没跑」。
 *
 * @returns {Promise<{ok:boolean, proxy:string|null, detail:string}>}
 */
export async function checkProxyHealth() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || null
  if (!proxy) return { ok: true, proxy: null, detail: '没有配置代理' }

  let host = ''
  let port = 0
  try {
    const u = new URL(proxy)
    host = u.hostname
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
  } catch {
    return { ok: false, proxy, detail: `代理地址无法解析：${proxy}` }
  }

  const alive = await new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (v) => { try { sock.destroy() } catch {} ; resolve(v) }
    sock.setTimeout(1200, () => done(false))
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
    try { sock.connect(port, host) } catch { done(false) }
  })

  return alive
    ? { ok: true, proxy, detail: `代理可用（${host}:${port}）` }
    : { ok: false, proxy, detail: `代理不可用：${host}:${port} 没人监听（关了代理软件但环境变量还在？）` }
}
