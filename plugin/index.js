/**
 * dsh-whale-pod —— 插件入口（Host 半身）。
 *
 * ## 架构：薄控制面
 *
 * WhalePod 本体是**独立进程**（daemon.js 拉起，detached，DSH 重启不掉线），
 * 它服务全部业务 API（37 个路由）和旧版 9 页管理界面。本插件只做三件事：
 *
 *   1. 确保守护进程活着（daemon.ensureRunning，崩溃自动重启）
 *   2. 把 /api/whale-pod/* **透传**到 WhalePod 的 http://127.0.0.1:18898/*
 *   3. 向渲染器注入 client.js（侧栏仪表盘 + 设置页，鲸鱼挂件同款通路）
 *
 * 为什么是独立进程而不是宿主内插件：WhalePod 有常驻状态（QQ 连接、NapCat
 * 子进程），必须独立于 DSH 生命周期；且宿主 webServer API 每个内核版本都
 * 在变（server.on / ctx.inject / 组合管线各踩过一遍），进程边界让这些坑
 * 全部消失。
 *
 * 前端无感知：client.js 本来就请求 /api/whale-pod/*，透传后 API 形状不变。
 *
 * @module index.js
 */

import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ensureRunning, isAlive, stopDaemon, killDaemonSync, listProcesses, WHALE_POD_WEB_PORT } from './daemon.js'

export const name = 'dsh-whale-pod'

/**
 * ⚠️ 不要导出对象级 `inject`。
 *
 * 对象级 inject 会把整个 apply() **推迟到服务就绪之后**，而桌面端的
 * 注入表（index.html 里那些 <script> 行）是**宿主启动时一次性收集**的：
 *     dsh-desktop-host: collectIndexInjections() → IPC → 渲染层
 * 订阅一旦晚于那次收集，这一行就永远进不了表 —— 表现是
 * **侧栏和设置里完全看不到这个插件**，而后端 daemon 仍在正常跑
 * （独立进程，所以 QQ 还能发言）。
 *
 * 实测踩过：原来这里写着 `export const inject = ['webServer']`，
 * 重启后 DSH 日志里连一条 [whale-pod] 都没有，apply() 压根没被调用。
 *
 * 现在改成：apply() 立刻执行，第一件事注册注入行；真正需要 webServer
 * 的 HTTP API 部分再用**局部** `ctx.inject(['webServer'], ...)` 等待。
 * 这与 dsh-whale-widget 处理 issue #154 的方式一致。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, 'client.js')

/** WhalePod 数据目录：<dshHome>/whale-pod。 */
function resolveHome(ctx) {
  try {
    const pc = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
    if (pc?.home) return path.join(pc.home, 'whale-pod')
  } catch { /* 走兜底 */ }
  const fromEnv = process.env.DSH_HOME
  return path.join(fromEnv && fromEnv.trim() ? fromEnv.trim() : path.join(process.env.USERPROFILE ?? '', '.dsh'), 'whale-pod')
}

/** 轻量信任栅栏：回环 Host + 拒跨站 + Origin/Referer 同源。 */
/**
 * @param {object} req
 * @param {object} [conn] 宿主的 connection 服务；有 requestRejection 时委托它。
 *   桌面端的所有 HTTP 请求都要过宿主的会话认证，插件自己判回环是不够的 ——
 *   只判回环会被宿主层再拦一次 403，表现就是侧栏和设置页全空。
 */
function trustCheck(req, conn) {
  const LOOPBACK = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])
  const authorityOf = (v, dflt = 'http') => {
    if (typeof v !== 'string' || !v.trim()) return null
    try {
      const u = new URL(v.includes('://') ? v.trim() : `${dflt}://${v.trim()}`)
      const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port
      return { scheme: u.protocol.replace(':', ''), hostname: u.hostname.toLowerCase(), port }
    } catch { return null }
  }
  const host = authorityOf(req.headers.host)
  if (host === null || !LOOPBACK.has(host.hostname)) {
    console.warn('[whale-pod/trust] reject host=', JSON.stringify(req.headers.host), 'parsed=', JSON.stringify(host))
    return 403
  }
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    console.warn('[whale-pod/trust] reject sec-fetch-site=cross-site')
    return 403
  }
  for (const h of ['origin', 'referer']) {
    const raw = req.headers[h]
    if (typeof raw !== 'string' || !raw.trim()) continue
    const a = authorityOf(raw.trim())
    if (a === null) return 403
    if (a.scheme !== host.scheme || a.hostname !== host.hostname || a.port !== host.port) {
      console.warn('[whale-pod/trust] reject header=' + h, JSON.stringify(raw), 'vs host=', JSON.stringify(host))
      return 403
    }
  }
  // 自校验过了还不够 —— 宿主的会话认证必须一起过。
  // 委托它（不重写它的语义），它抛异常按拒绝处理（fail-closed）。
  if (conn && typeof conn.requestRejection === 'function') {
    try {
      const code = conn.requestRejection(req)
      if (code !== undefined && code !== null && code !== false) return code
    } catch (error) {
      return 403
    }
  }
  return undefined
}

/**
 * 转发请求到 WhalePod 并**收集响应体**（不写 res）。
 *
 * 用途：/qq/stop 需要先让 WhalePod 优雅停机（它要清理桥接、NapCat、
 * 写配置），拿到结果之后再杀进程。直接 `proxyToWhalePod` 会把响应
 * 直接写到 res 上，之后就没法再追加"进程已停止"的信息了。
 *
 * @returns {Promise<{status:number, headers:object, body:string}>}
 */
function proxyAndCollect(target, req, token, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: `127.0.0.1:${WHALE_POD_WEB_PORT}` }
    if (token) headers.authorization = `Bearer ${token}`
    const upstream = http.request({ ...target, method: req.method, headers }, (up) => {
      const chunks = []
      up.on('data', (c) => chunks.push(c))
      up.on('end', () => {
        resolve({ status: up.statusCode ?? 502, headers: up.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    const timer = setTimeout(() => {
      try { upstream.destroy() } catch { /* ignore */ }
      reject(new Error(`转发超时（${timeoutMs}ms）`))
    }, timeoutMs)
    upstream.on('error', (error) => { clearTimeout(timer); reject(error) })
    upstream.on('close', () => clearTimeout(timer))
    req.pipe(upstream)
  })
}

/** 安全地解析 JSON 字符串；失败返回 null，绝不抛。 */
function safeJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

/** 把请求转发到 WhalePod 进程。token 从 WhalePod 的 config.json 读出并以 Bearer 注入。 */
function proxyToWhalePod(target, req, res, token, timeoutMs = 20_000) {
  const headers = { ...req.headers, host: `127.0.0.1:${WHALE_POD_WEB_PORT}` }
  if (token) headers.authorization = `Bearer ${token}`
  // node:http.request(options[, callback]) 只接受两个参数；之前误传成
  // http.request(target, options, callback)，Node 把 options 对象当 listener，
  // 抛 ERR_INVALID_ARG_TYPE，前端只看到 HTTP 400/一片白。
  // ⚠️ timer 必须**先声明**再进 request 回调。
  //
  //    原来写成 `const upstream = http.request(..., (up) => { clearTimeout(timer) })`
  //    然后才 `const timer = setTimeout(...)` —— 回调里引用的是 TDZ 里的 timer。
  //    上游响应够快时（本地转发几乎总是快），回调在 `const timer` 求值前就跑了，
  //    抛 ReferenceError: Cannot access 'timer' before initialization，
  //    前端只能看到 HTTP 400 / 状态一直"未运行"并反复闪。
  let timer
  const upstream = http.request({
    ...target,
    method: req.method,
    headers,
  }, (up) => {
    clearTimeout(timer)
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.pipe(res)
  })
  timer = setTimeout(() => {
    try { upstream.destroy(new Error(`转发超时（${timeoutMs}ms）`)) } catch { /* ignore */ }
  }, timeoutMs)
  upstream.on('error', (error) => {
    clearTimeout(timer)
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `WhalePod 进程不可达：${String(error?.message ?? error)}` }))
    } else {
      try { res.end() } catch { /* ignore */ }
    }
  })
  upstream.on('close', () => clearTimeout(timer))
  req.pipe(upstream)
}

/**
 * 插件装配。
 * @param {object} ctx      cordis 上下文
 * @param {object} config   来自 cordis.patch.yml 的配置
 */
export function apply(ctx, config = {}) {
  const log = {
    info: (m) => { try { ctx.logger?.info?.(`[whale-pod] ${m}`) } catch { /* ignore */ } },
    warn: (m) => { try { ctx.logger?.warn?.(`[whale-pod] ${m}`) } catch { /* ignore */ } },
    error: (m) => { try { ctx.logger?.error?.(`[whale-pod] ${m}`) } catch { /* ignore */ } },
  }
  const home = resolveHome(ctx)
  log.info(`装配开始（WhalePod 数据目录: ${home}）`)
  // ── 浏览器半身由 package.json 的 dsh.client 声明加载 ──────────────
  //
  // 不要把注入行写在这里 —— 那条路（webserver/index-inject）在这个项目里
  // 反复出问题：apply() 的执行时机、webServer 服务就绪顺序、桌面壳的注入表
  // 收集时机，任何一环变动都会让 UI 静默消失，而且日志里看不出原因。
  //
  // 官方通路 dsh.client 由 DSH 的 client-modules 直接管理，不依赖以上任何时序：
  //   "dsh": { "client": { "platform": "web", "immediately": true, "inject": [] } }
  // OFM 用的就是这条，运行正常。
  //
  // ⚠️ 代价：client.js 会被 client-modules 加载一次，所以**必须删掉手动注入**，
  //    否则同一个 factory 注册两次 → duplicate factory registration → 前端崩溃。

  /**
   * 读 WhalePod 的 Web token。
   *
   * WhalePod 后端在 18898 上要求 Bearer 认证，插件透传时必须带上。
   * token 存在它的 config.json 里；进程没起或文件读不到时返回 null，
   * 上游会回 401，前端会走"后端未就绪"的分支 —— 这是预期行为。
   *
   * ⚠️ 这个函数曾经被误删过（删注入块时连带删掉了），
   *    结果所有透传请求都抛 ReferenceError: readWhalePodToken is not defined。
   */
  const readWhalePodToken = () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
      return cfg.web?.token ?? null
    } catch { return null }
  }

  /**
   * 读 WhalePod 自己的 `autoStart`（是否随 DSH 启动自动拉起）。
   *
   * ## 为什么读 config.json 而不是只用插件 config
   *
   * 插件 config（cordis.patch.yml 里那段）用户改起来很麻烦 ——
   * 要手改 YAML、还容易改坏。设置页（`/api/whale-pod/config`）改的是
   * WhalePod 自己的 `config.json`，那才是用户能点到的入口。
   *
   * ## 两个来源怎么合并
   *
   * **任一为 false 就手动**。理由：
   *   · 插件 config 是部署者的意图（「这台机器上默认别自启」）
   *   · config.json 是使用者的意图（「我现在不想让它自己跑」）
   *   任何一方说「别自启」，都应该听 —— 否则用户点了开关却关不掉，
   *   会以为坏了。
   *
   * 读不到文件（还没初始化）时返回 undefined，交给调用方按默认处理。
   *
   * @returns {boolean|undefined}
   */
  const readAutoStart = () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))
      if (typeof cfg.autoStart === 'boolean') return cfg.autoStart
      return undefined
    } catch { return undefined }
  }

  /**
   * client.js 的绝对路径。
   *
   * ⚠️ 这行也曾被误删过（同一次删注入块），导致 /dsh-whale-pod/widget.js
   *    和图标路由都抛 ReferenceError，前端加载不到浏览器半身。
   *    同 clientPath 一样指向包内的 client.js。
   */
  const clientPathResolved = clientPath

  // WhalePod 后端的地址。透传和收集两条路径都用它。
  //
  // ⚠️ 这行曾经被误删过（删注入块时连带删掉了），结果所有 /api/whale-pod/*
  //    请求都抛 ReferenceError: target is not defined，前端只看到 HTTP 400，
  //    侧栏和设置页全空。删代码块时一定要确认边界。
  const target = { host: '127.0.0.1', port: WHALE_POD_WEB_PORT }

  // webServer 缺席只是少 API，不该让装配崩掉 —— 因此 inject 也包一层防御
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer', 'connection'], (scoped) => {
      const server = scoped?.webServer
      const conn = scoped?.connection
      if (server === undefined || typeof server.register !== 'function') {
        log.warn('webServer 服务不可用（缺少 register）—— 跳过 HTTP API')
        return
      }
      const onDispose = typeof scoped.effect === 'function'
        ? (fn, label) => scoped.effect(fn, label)
        : () => {}

      // ── 透传：/api/whale-pod/* → WhalePod 18898/* ─────────────────
      onDispose(() => server.register({
        kind: 'prefix',
        path: '/api/whale-pod',
        handler: async (req, res) => {
          const rejection = trustCheck(req, conn)
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized' : 'forbidden' }))
            return
          }

          // ── 先拦截「启停」类请求，由插件自己处理 ────────────────
          //
          // ⚠️ 这里要分清**两层启动**，它们的语义完全不同：
          //
          //   ① 进程层：WhalePod 这个 node 进程是否在跑（18898 是否监听）
          //   ② 业务层：QQ 桥接 + NapCat 是否已启用（qq.enabled）
          //
          // 侧栏的「一键启动」按钮发的是 **/qq/start**，它属于第 ② 层 ——
          // 本该透传给 WhalePod 去执行 startQqBridge()。
          //
          // 但第 ② 层依赖第 ① 层：WhalePod 进程没起来时，透传直接
          // ECONNREFUSED，按钮就永远点不动（实测就是这么坏的）。
          //
          // 所以 /qq/start 的正确处理是**两段式**：
          //   a. 先确保 WhalePod 进程存在（ensureRunning，幂等）
          //   b. 再把请求**透传**过去，由 WhalePod 真正启动 QQ 桥接
          //
          // 之前我只做了 a 就 return 了 —— 结果 WhalePod 已在跑时，
          // 点击变成"什么都不做"（因为 ensureRunning 返回 already），
          // QQ 桥接永远起不来。这是个真实 bug，不是猜测。
          const urlPath = (req.url ?? '/').split('?')[0]
          const isDaemonStart = urlPath === '/api/whale-pod/daemon/start'
          const isDaemonStop = urlPath === '/api/whale-pod/daemon/stop'
          const isDaemonLive = urlPath === '/api/whale-pod/daemon/alive'
          const isQqStart = urlPath === '/api/whale-pod/qq/start'
          const isQqStop = urlPath === '/api/whale-pod/qq/stop'

          // 纯进程层：只拉起/停止 WhalePod 本身，不碰 QQ 桥接
          if (isDaemonLive) {
            // 顺带把后端相关进程一起返回 —— 侧栏的「后端进程」窗口用它。
            // 放在 alive 里而不是单独路由：两者永远一起看（"活着吗 + 有哪些进程"）。
            const alive = await isAlive(1200)
            const procs = await listProcesses()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, alive, processes: procs }))
            return
          }
          if (isDaemonStart && req.method !== 'GET') {
            try {
              const r = await ensureRunning({ home, log })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, started: r.started, already: r.already, pid: r.pid }))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
            }
            return
          }
          if (isDaemonStop && req.method !== 'GET') {
            try {
              const r = await stopDaemon({ log })
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: true, ...r }))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
            }
            return
          }

          // 业务层启动：先确保进程在，然后继续走下面的透传
          // ── /qq/stop：**完全关闭**（桥接 + NapCat + WhalePod 进程）──
          //
          // 侧栏那个「完全关闭」按钮的语义就是"全关掉，不留后台进程"。
          // 但 /qq/stop 原本只透传给 WhalePod，由它停掉桥接和 NapCat ——
          // **WhalePod 进程自己还活着**，18898 继续监听，
          // 用户看到"关了但进程还在"，和按钮文案不符。
          //
          // 这里改成两段式：
          //   a. 先透传给 WhalePod，让它优雅地停桥接 + NapCat（有状态清理）
          //   b. 等它回完，再把 WhalePod 进程本身也结束
          //
          // 顺序不能反：先杀进程的话，桥接和 NapCat 就没机会优雅停止，
          // NapCat 可能变成孤儿进程占着 3001。
          if (isQqStop && req.method !== 'GET') {
            let inner = null
            try {
              // 前缀两端一致，直接原样转发
              inner = await proxyAndCollect(target, req, readWhalePodToken(), 20_000)
            } catch (error) {
              // WhalePod 已经挂了也没关系 —— 下面照样清理残留进程
              log.warn?.(`qq/stop 透传失败（继续清理进程）：${String(error?.message ?? error)}`)
            }
            try {
              const r = await stopDaemon({ log })
              const payload = { ok: true, connected: false, stopped: true, inner: inner ? safeJson(inner) : null, daemon: r }
              if (!res.headersSent) {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify(payload))
              }
            } catch (error) {
              if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: `停止 WhalePod 进程失败：${String(error?.message ?? error)}` }))
              }
            }
            return
          }

          if (isQqStart && req.method !== 'GET') {
            try {
              const r = await ensureRunning({ home, log })
              if (r.started) log.info?.(`已为 qq/start 预先拉起 WhalePod（pid ${r.pid}）`)
            } catch (error) {
              // 拉不起来就没法转发，直接回错误（比让前端收到 ECONNREFUSED 更清楚）
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: `WhalePod 进程启动失败：${String(error?.message ?? error)}` }))
              return
            }
            // 落到下面：透传给 WhalePod，由它执行 startQqBridge()
          }

          // 两端都使用 /api/whale-pod/*，直接原样透传。
          // 历史上两端前缀不一致时需要在这里做映射；现在再改写反而会引入 bug。
          proxyToWhalePod({ ...target, path: req.url ?? '/' }, req, res, readWhalePodToken())
        },
      }), 'dsh-whale-pod: /api/whale-pod 透传 + 启停本地处理')

      // ── client.js 直供（鲸鱼挂件同款通路）────────────────────────
      onDispose(() => server.register({
        kind: 'exact',
        path: '/dsh-whale-pod/widget.js',
        handler: (req, res) => {
          try {
            const rejection = trustCheck(req, conn)
            if (rejection !== undefined) {
              res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('forbidden')
              return
            }
            res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
            res.end(fs.readFileSync(clientPathResolved))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(String(error?.message ?? error))
          }
        },
      }), 'dsh-whale-pod: /dsh-whale-pod/widget.js')

      // ── 图标（设置页 / 面板标题用）────────────────────────────────
      //
      // 为什么单独开一条路由而不是内联 data URI：
      //   图标 34 KB（128px），base64 后会变成 ~46 KB 塞进 client.js，
      //   而 client.js 是**每次页面加载都读盘**的（no-cache）——
      //   等于每次都多传 46 KB。独立路由能被浏览器缓存。
      //
      // 只放行两个固定文件名，不接受任意路径（避免路径穿越）。
      const ICON_FILES = {
        '/dsh-whale-pod/icon.png': 'assets/whale-pod-128.png',
        '/dsh-whale-pod/icon@2x.png': 'assets/whale-pod-256.png',
      }
      for (const [route, rel] of Object.entries(ICON_FILES)) {
        onDispose(() => server.register({
          kind: 'exact',
          path: route,
          handler: (req, res) => {
            try {
              const rejection = trustCheck(req, conn)
              if (rejection !== undefined) {
                res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
                res.end('forbidden')
                return
              }
              const file = path.join(path.dirname(clientPathResolved), rel)
              res.writeHead(200, {
                'content-type': 'image/png',
                // 图标不会变，允许长缓存；换图时改文件名即可
                'cache-control': 'public, max-age=86400',
              })
              res.end(fs.readFileSync(file))
            } catch (error) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(String(error?.message ?? error))
            }
          },
        }), `dsh-whale-pod: ${route}`)
      }

      // ── NapCat 面板入口：WhalePod 的 webInfo 已含 token，由透传 API 提供 ──

      log.info('控制面已挂载：/api/whale-pod/* 透传')

      // ── 确保守护进程活着（按配置：自动启动 / 纯手动）────────────────
      //
      // 两个来源，**任一为 false 就手动**：
      //   · 插件 config（cordis.patch.yml）—— 部署者意图
      //   · WhalePod 自己的 config.json 的 autoStart —— 使用者意图（设置页那个开关）
      //
      // 为什么两个都要看：设置页改的是 config.json，用户点完开关必须真的生效；
      // 而部署者在 YAML 里写死 false 时，也不该被默认值覆盖。
      //
      // 为什么要有这个开关：WhalePod 是 detached 进程，会一直占着 QQ 在线、
      // 内存和端口。有人希望它跟着 DSH 生命走（DSH 不开就不跑），
      // 有人希望它常驻（QQ 机器人本来就要 24 小时在线）。两种都合理，
      // 所以做成可选项而不是写死。
      const cfgAutoStart = readAutoStart()
      const autoStart = config?.autoStart !== false && cfgAutoStart !== false
      if (autoStart) {
        void ensureRunning({ home, log }).catch((error) => {
          log.error(`WhalePod 守护进程启动失败：${String(error?.message ?? error)}`)
        })
      } else {
        log.info('已禁用自动启动（autoStart=false）—— 需要时在侧栏点「一键启动」')
      }
    })
  } else {
    log.warn('宿主 ctx 无 inject 方法 —— 跳过控制面（核心功能不受影响）')
  }

  // ── 生命周期：DSH 退出时是否连带关闭 WhalePod ──────────────────────
  //
  // stopOnExit（默认 true）：DSH 关闭时把 WhalePod 一起停掉 ——
  //   「DSH 退了机器人就该停」是更符合直觉的默认。以前是 detached 常驻，
  //   用户关了 DSH 发现 QQ 还在线、后台还挂着进程，很容易困惑。
  //
  // 设 stopOnExit: false 则保持老行为（WhalePod 独立常驻，QQ 不下线），
  // 适合"机器人要 24 小时在线，DSH 只是管理面板"的场景。
  //
  // ## ⚠️ 为什么这里必须用**同步**清理
  //
  // 早期实现是 `void stopDaemon({...}).then(...)` —— 看起来没问题，实际
  // 一次都没成功过：stopDaemon 内部是 `await import(...)` + `await isAlive(...)`，
  // 全是异步；而宿主退出时进程**立刻结束**，这些 Promise 根本排不上队。
  // 日志里连「已请求停止」这行都没出现过，就是证据。
  //
  // 所以退出路径改用 killDaemonSync()：只做同步的系统调用
  // （taskkill / kill），不 await 任何东西。慢一点没关系，能杀掉才有用。
  ctx.effect(() => () => {
    if (config?.stopOnExit === false) {
      log.info('DSH 卸载 —— WhalePod 独立进程继续运行（stopOnExit=false）')
      return
    }
    try {
      const r = killDaemonSync({ log })
      log.info(`DSH 卸载 —— 已停止 WhalePod（${r.killed} 个进程）`)
    } catch (error) {
      log.warn(`DSH 卸载 —— 停止 WhalePod 失败：${String(error?.message ?? error)}`)
    }
  }, 'dsh-whale-pod: 随 DSH 退出停止')
}

export { ensureRunning, isAlive, stopDaemon }
