/**
 * 管理 Web 服务：状态、配置、日志、决策调试。
 *
 * 设计：**HTML 内嵌**，不依赖构建工具，也不用 node_modules 里的前端库。
 * 这样 `node src/index.js` 就能跑，不需要 webpack/vite 那一套。
 *
 * 前端资源（CSS/JS）在 `./assets.js` —— 那个文件只管「长什么样」，
 * 这个文件只管 HTTP 与 API。
 *
 * 鉴权：`?token=` 查询参数或 `Authorization: Bearer`。只绑回环地址。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CLIENT_CSS, CLIENT_JS } from './assets.js'
import { ICONS } from './icons.js'
import * as fallbackMod from '../gateway/fallback.js'
import { resolveCandidates, openFirstAvailable, applyFreeOrder, PROVIDER_MODEL_HINTS } from '../gateway/router.js'
// 决策层热更新要用（改 decision.provider 后不必重启）
import { createDecisionLayer } from '../decision/index.js'

/** 常量时间比较，避免时序侧信道。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store',
  })
  res.end(s)
}

/** 读 JSON 请求体（带上限，防止误发大包把内存吃光）。 */
async function readJson(req, limit = 2 * 1024 * 1024) {
  const bufs = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new Error('请求体过大')
    bufs.push(c)
  }
  if (!bufs.length) return {}
  const text = Buffer.concat(bufs).toString('utf8')
  try { return JSON.parse(text) } catch (e) { throw new Error('请求体不是合法 JSON：' + e.message) }
}

/**
 * @param {object} opts
 * @param {object} opts.web          web 配置（host/port/token）
 * @param {ConfigStore} opts.store
 * @param {Logger} opts.logger
 * @param {object} opts.llm
 * @param {object} opts.decision
 * @param {Credentials} opts.credentials
 * @param {object} [opts.memory]
 * @param {object} [opts.persona]
 * @param {object} [opts.longMemory]
 * @param {object} [opts.bridge]
 * @param {object} opts.state        运行期状态（index.js 维护）
 * @param {object} opts.log
 */
export function createWebServer(opts) {
  const {
    web, store, logger, llm, decision, credentials,
    memory, persona, longMemory, bridge, state, log,
    protocols, runtime, modes,
  } = opts

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'))
    const p = url.pathname

    try {
      // ── 首页与静态资源 ────────────────────────────────────
      //
      // ⚠️ 为什么 app.js 要**带头注入 token**：
      //
      // WhalePod 常被嵌在别的页面里看（比如 DSH 的侧栏 iframe）。跨源
      // iframe 里 `localStorage` 会直接抛 "Access is denied"，所以
      // "把 token 存本地、从地址栏抹掉" 那套在那里是失效的 ——
      // 用户点开侧栏就只剩「未授权，请重填 token」。
      //
      // 解决办法：页面本身自带凭据。浏览器加载 /app.js 时会带上
      // Referer（或我们主动带上 query），服务端据此把 token 作为
      // **首行常量**注进脚本。这样无论 localStorage 能不能用、
      // 地址栏是否干净，页面都能自己认证。
      //
      // 安全性：这与直接放在 URL 里等价（同源读取），但不会出现在
      // 地址栏、历史记录和截图里；只绑回环地址，不对外暴露。
      if (p === '/' || p === '/index.html') {
        const given = url.searchParams.get('token') ?? bearer(req) ?? cookieToken(req)
        const ok = !web.token || safeEqual(given ?? '', web.token)
        // 拿到合法 token 就种 Cookie（方便跨源 iframe 复用）
        if (ok && web.token && given && !cookieToken(req)) {
          res.setHeader('set-cookie', `whale_pod_token=${encodeURIComponent(given)}; Path=/; SameSite=Lax; Max-Age=2592000`)
        }
        // ⭐ 回环访问时把 token 直接写进页面：这样哪怕在跨源 iframe 里
        //    （localStorage 被拒、Cookie 不通、地址栏干净）也能直接用。
        //
        //    安全性：WhalePod 只绑 127.0.0.1，而**跨源 JS 读不到本页内容**
        //    （同源策略 + CORS 都挡着）。所以把 token 放进 HTML 不会
        //    给网页攻击者任何额外能力 —— 他们本来就拿不到这些字节。
        //    能读到本机的程序，本来也能读 ~/.whale-pod/config.json。
        const embed = isLoopback(req) && web.token ? web.token : ''
        return html(res, 200, renderPage({
          authed: ok || Boolean(embed),
          tokenNeeded: Boolean(web.token),
          embedToken: embed,
        }))
      }
      if (p === '/app.js') return sendJs(res, injectIcons(injectToken(CLIENT_JS, req, url, web.token)))
      if (p === '/app.css') return sendCss(res, CLIENT_CSS)
      if (p === '/favicon.ico' || p === '/icon.png') return sendIcon(res, opts.assetsDir)
      if (p === '/__icon_src') return sendIconSource(res, opts.assetsDir)
      // 多尺寸图标：让浏览器按用途挑（标签页用 16/32，书签/桌面用 128+）。
      // 不给的话浏览器只能拿 256px 自己缩，标签页上会明显发糊。
      if (p.startsWith('/icon-')) return sendSizedIcon(res, opts.assetsDir, p)

      // ── 以下都要鉴权 ──────────────────────────────────────
      if (!authorized(req, url, web.token)) {
        return json(res, 401, { error: 'unauthorized' })
      }

      if (p === '/api/status' && req.method === 'GET') {
        return json(res, 200, buildStatus({ store, llm, decision, credentials, memory, persona, longMemory, bridge, state }))
      }

      // ── QQ ────────────────────────────────────────────────
      //
      // ⚠️ 必须读 **state.bridge**，不能读闭包里的 `bridge`。
      //
      //    闭包里的 `bridge` 是 createWebServer() 调用时传进来的**快照**；
      //    而侧栏「一键启动」是**运行时**才创建桥接并挂到 state.bridge 上。
      //    于是闭包那个永远是 null，`/api/qq` 一直回「QQ 未启用」——
      //    用户看到的是"启动成功了但状态还是关的、消息也收不到"。
      //    （2026-10-19 实测踩到，正是本次"不会消息"的根因之一）
      if (p === '/api/qq' && req.method === 'GET') {
        const qqOn = store.get().qq?.enabled === true
        const liveBridge = qqOn ? state.bridge : undefined
        return json(res, 200, liveBridge?.statsSnapshot?.() ?? {
          enabled: qqOn,
          connected: false,
          reason: qqOn ? 'QQ 已启用但桥接未就绪' : 'QQ 未启用（qq.enabled = false）',
        })
      }
      if (p === '/api/qq/pause' && req.method === 'POST') {
        const liveBridge = store.get().qq?.enabled === true ? state.bridge : undefined
        if (!liveBridge) return json(res, 400, { error: 'QQ 未启用' })
        const body = await readJson(req)
        liveBridge.paused = body?.paused === true
        log.info('Web：QQ ' + (liveBridge.paused ? '已暂停' : '已恢复'))
        return json(res, 200, { ok: true, paused: liveBridge.paused })
      }

      // ── 组件（协议端 / 框架）─────────────────────────────────
      if (p === '/api/backends' && req.method === 'GET') {
        return json(res, 200, await backendsSnapshot({ store, state, protocols }))
      }

      if (p === '/api/backends/install' && req.method === 'POST') {
        if (!protocols) return json(res, 400, { error: '组件管理未启用' })
        const body = await readJson(req)
        const id = String(body?.id ?? '')
        const b = protocols.BACKENDS[id]
        if (!b) return json(res, 404, { error: '未知组件：' + id })
        // 许可确认是强制的 —— 不确认就不下载（合规要求）
        if (body?.acceptLicense !== true) {
          return json(res, 400, {
            error: '需要先确认许可',
            license: b.license,
            hint: '把 acceptLicense 设为 true 表示你已阅读该项目的许可与《QQ 用户协议》。',
          })
        }
        if (state.installing) {
          return json(res, 409, { error: '已有安装任务在进行：' + state.installing })
        }
        // 后台跑，立刻返回（下载可能几十秒到几分钟）
        state.installing = id
        state.installLog = []
        const pushLog = (m) => {
          const line = String(m)
          state.installLog.push({ at: Date.now(), text: line })
          if (state.installLog.length > 300) state.installLog.shift()
          log.info(`[安装 ${id}] ${line}`)
        }
        protocols.installBackend({
          backendId: id,
          home: store.home,
          proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined,
          githubToken: body?.githubToken,
          onProgress: pushLog,
        }).then((r) => {
          state.installResult = r
          pushLog('安装完成')
        }).catch((e) => {
          state.installError = String(e?.message ?? e)
          pushLog('安装失败：' + state.installError)
        }).finally(() => {
          state.installing = null
        })
        return json(res, 202, { ok: true, started: id })
      }

      if (p === '/api/backends/progress' && req.method === 'GET') {
        return json(res, 200, {
          installing: state.installing ?? null,
          log: (state.installLog ?? []).slice(-80),
          result: state.installResult ?? null,
          error: state.installError ?? null,
        })
      }

      if (p === '/api/backends/start' && req.method === 'POST') {
        if (!protocols) return json(res, 400, { error: '组件管理未启用' })
        const body = await readJson(req)
        try {
          const r = state.supervisor.start(String(body?.id ?? ''), { args: body?.args })
          return json(res, 200, r)
        } catch (e) { return json(res, 400, { error: String(e?.message ?? e) }) }
      }

      if (p === '/api/backends/stop' && req.method === 'POST') {
        if (!protocols) return json(res, 400, { error: '组件管理未启用' })
        const body = await readJson(req)
        const id = String(body?.id ?? '')
        const r = await state.supervisor.stop(id).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
        // 没停掉时**如实回 409**（而不是 200 + ok:false）——
        // 这样即使前端没检查 ok，HTTP 层也会暴露问题，不会"静默失败"。
        if (r && r.ok === false) {
          log.warn(`Web：停止组件失败（${id}）— ${r.reason || r.error || '未知原因'}`)
          return json(res, 409, r)
        }
        return json(res, 200, r)
      }

      if (p === '/api/backends/logs' && req.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const n = Number(url.searchParams.get('n') ?? 150)
        const lines = state.supervisor?.logs(id, n) ?? []
        // 没日志时要说清原因 —— 否则用户看到"暂无日志"会以为组件没输出。
        // 最常见的情况：组件是**用户自己启动的**（或上一次 WhalePod 退出后
        // 没被接管），我们没接住它的 stdout，自然收不到任何行。
        let note = null
        if (lines.length === 0) {
          const running = state.supervisor?.running?.(id)
          note = running
            ? '这个组件当前没在日志中输出。它可能是你手动启动的（或由上一个 WhalePod 进程启动），我们没接到它的标准输出。'
            : '组件没有运行，所以没有输出。点「启动」后这里会实时显示它的控制台输出。'
        }
        return json(res, 200, { id, lines, note })
      }

      // 模型性能统计（按 渠道/模型 汇总真实调用）
      // 纯观测数据，不做任何自动限制 —— 见 gateway/usage.js 的 modelStats()
      if (p === '/api/models/stats' && req.method === 'GET') {
        const snap = state.usage?.snapshot?.() ?? null
        return json(res, 200, {
          stats: snap?.modelStats ?? [],
          calls: snap?.calls ?? 0,
          uptimeMs: snap?.uptimeMs ?? 0,
        })
      }

      if (p === '/api/runtime' && req.method === 'GET') {
        if (!runtime) return json(res, 400, { error: '运行时管理未启用' })
        return json(res, 200, await runtime.uvStatus(store.home))
      }

      // ── 自备渠道（不依赖 DSH 的 LLM 来源）────────────────────
      if (p === '/api/channels' && req.method === 'GET') {
        const chans = store.get().gateway?.channels ?? []
        const providers = llm?.providers ?? []
        return json(res, 200, {
          channels: chans.map((c) => ({
            ...c,
            apiKey: redactKey(c.apiKey),
            hasKey: Boolean(c.apiKey),
            active: providers.includes(c.id),
          })),
          presets: fallbackMod.PRESET_ENDPOINTS,
          dshAvailable: Boolean(state.dshAppDir),
          providers,
        })
      }

      if (p === '/api/channels/test' && req.method === 'POST') {
        const body = await readJson(req)
        // 允许测「表单里还没保存的」配置 —— 直接传 baseUrl/apiKey
        const ch = body?.channel ?? {}
        const r = await fallbackMod.testChannel({
          id: ch.id ?? 'test',
          baseUrl: ch.baseUrl,
          apiKey: ch.apiKey,
          model: ch.model,
          models: ch.models,
          headers: ch.headers,
        }, { timeoutMs: 20000 })
        return json(res, 200, r)
      }

      if (p === '/api/channels/upsert' && req.method === 'POST') {
        const body = await readJson(req)
        const ch = body?.channel ?? {}
        if (!ch.id) return json(res, 400, { error: '缺少 id' })
        if (!ch.baseUrl) return json(res, 400, { error: '缺少 baseUrl' })
        const cfg = store.get()
        const list = (cfg.gateway?.channels ?? []).slice()
        const i = list.findIndex((c) => c.id === ch.id)
        const prev = i >= 0 ? list[i] : {}
        // apiKey 若回传的是脱敏占位，保留原值（避免把真 key 覆盖成 ★★★）
        const apiKey = ch.apiKey && !String(ch.apiKey).includes('…') ? ch.apiKey : (prev.apiKey ?? '')
        const next = {
          id: String(ch.id).replace(/[^A-Za-z0-9_-]/g, '-'),
          label: ch.label ?? ch.id,
          preset: ch.preset ?? 'custom',
          baseUrl: String(ch.baseUrl).replace(/\/+$/, ''),
          apiKey,
          model: ch.model ?? '',
          models: Array.isArray(ch.models) ? ch.models : [],
          enabled: ch.enabled !== false,
        }
        if (i >= 0) list[i] = next
        else list.push(next)
        store.update({ gateway: { channels: list } })
        log.info(`Web：${i >= 0 ? '更新' : '新增'}自备渠道 ${next.id}（重启后生效）`)
        return json(res, 200, { ok: true, id: next.id, needRestart: true })
      }

      if (p === '/api/channels/remove' && req.method === 'POST') {
        const body = await readJson(req)
        const id = String(body?.id ?? '')
        const cfg = store.get()
        const list = (cfg.gateway?.channels ?? []).filter((c) => c.id !== id)
        store.update({ gateway: { channels: list } })
        log.info(`Web：删除自备渠道 ${id}（重启后生效）`)
        return json(res, 200, { ok: true, removed: id, needRestart: true })
      }

      if (p === '/api/llm/health' && req.method === 'GET') {
        const providers = llm?.providers ?? []
        // ⚠️ 用**启动时**装载的自备渠道 id，而不是当前配置里的。
        //    因为配置改了要重启才生效：若按当前配置算，刚删掉的渠道
        //    会被当成"DSH 渠道"混进免费渠道列表里（实测踩到）。
        const selfIds = state.selfChannelIds ?? []
        const dshProviders = providers.filter((p) => !selfIds.includes(p))
        const selfLoaded = providers.filter((p) => selfIds.includes(p))
        let mode = 'none'
        if (dshProviders.length > 0 && selfLoaded.length > 0) mode = 'mixed'
        else if (dshProviders.length > 0) mode = 'dsh'
        else if (selfLoaded.length > 0) mode = 'self-only'

        // 配置里已改但尚未生效的渠道（提示用户重启）
        const configuredIds = (store.get().gateway?.channels ?? []).map((c) => c.id)
        const pendingChange =
          configuredIds.slice().sort().join(',') !== selfIds.slice().sort().join(',')

        return json(res, 200, {
          dsh: {
            appDir: state.dshAppDir ?? null,
            profile: state.profile ?? null,
            available: Boolean(state.dshAppDir),
            channelPack: state.dshPack?.profile ?? null,
          },
          providers,
          dshProviders,
          selfLoaded,
          selfChannelIds: selfIds,
          configuredIds,
          pendingChange,
          selfLoaded,
          catalogCount: llm?.catalog?.length ?? 0,
          mode,
        })
      }

      // 后台批量身份核验状态：开始后可查询进度；失败项记录错误继续跑。
      if (p === '/api/models/audit' && req.method === 'GET') {
        return json(res, 200, { audit: state.modelAudit ?? null })
      }

      if (p === '/api/models/audit' && req.method === 'POST') {
        if (state.modelAudit?.running) {
          return json(res, 409, { error: '身份核验已在运行', audit: state.modelAudit })
        }
        const body = await readJson(req)
        const disabled = store.get().gateway?.disabledProviders ?? []
        const catalog = (llm?.catalog ?? []).filter((m) =>
          m.id && m.provider && m.provider !== 'cline' && !disabled.includes(m.provider)
        )
        const limit = Math.max(1, Math.min(80, Number(body?.limit) || 30))
        const buckets = new Map()
        for (const m of catalog) {
          const model = m.id ?? m.model
          const key = `${m.provider}/${model}`
          if (!buckets.has(m.provider)) buckets.set(m.provider, [])
          if (!buckets.get(m.provider).some((x) => x.model === model)) {
            buckets.get(m.provider).push({ provider: m.provider, model })
          }
        }
        // 分批顺序：先按 provider 轮询过模型，再把这一维压平，
        // limit=30 时尽量覆盖全部渠道，而不是只测 catalog 排前面的渠道。
        const interleaved = []
        for (let round = 0; ; round++) {
          let added = false
          for (const provider of buckets.keys()) {
            const item = buckets.get(provider)[round]
            if (item) { interleaved.push(item); added = true }
          }
          if (!added) break
        }
        const previous = state.modelAudit
        const offset = Math.max(0, Math.min(interleaved.length,
          Number.isInteger(Number(body?.offset)) ? Number(body.offset) : (previous?.nextOffset ?? 0)))
        if (offset >= interleaved.length) {
          return json(res, 200, {
            done: true,
            message: '目录里的模型都已核验完。',
            audit: previous ?? null,
            catalogTotal: interleaved.length,
          })
        }
        const queue = interleaved.slice(offset, Math.min(offset + limit, interleaved.length))
        const previousResults = previous?.results ?? []
        const audit = state.modelAudit = {
          id: crypto.randomBytes(8).toString('hex'), running: true,
          batch: (previous?.batch ?? 0) + 1,
          offset,
          nextOffset: offset + queue.length,
          catalogTotal: interleaved.length,
          total: queue.length,
          done: 0,
          ok: previousResults.filter((x) => x.match === true).length,
          mismatch: previousResults.filter((x) => x.match === false).length,
          unknown: previousResults.filter((x) => x.match == null && !x.error).length,
          failed: previousResults.filter((x) => Boolean(x.error)).length,
          concurrency: Math.min(3, queue.length), timeoutMs: IDENTITY_AUDIT_TIMEOUT_MS,
          startedAt: Date.now(), results: previousResults.slice(),
        }

        // 单条工作项：精确命中 catalog 指定的 provider/model，不经过 auto fallback。
        // 必须把 open + 消费整个 stream 都放进超时范围；只给首 chunk 设超时
        // 仍会在模型思考/生成时永久挂住。
        const runOne = async (item) => {
          const cacheKey = `${item.provider}/${item.model}`
          const cached = identityCache.get(cacheKey)
          if (cached && Date.now() - cached.at < IDENTITY_CACHE_TTL) {
            return { ...item, ...cached.value, cached: true }
          }

          const controller = new AbortController()
          const task = (async () => {
            // 固定打 catalog 中这一条 provider/model；不经 resolveCandidates，
            // 因为模型 ID 自己也可能含斜杠（如 cline-free/step-5-preview）。
            const candidate = {
              provider: item.provider,
              model: item.model,
              kind: 'free',
              why: 'exact catalog entry identity audit',
            }
            const opened = await openFirstAvailable({
              llm,
              candidates: [candidate],
              request: {
                messages: [{ role: 'user', content: [{
                  type: 'text',
                  text: 'Reply with ONLY your model name and vendor. Example: "GPT-4 / OpenAI". No explanation.',
                }] }],
                maxTokens: 80,
                signal: controller.signal,
              },
            })
            let raw = ''
            let chunks = 0
            for await (const c of opened.stream) {
              if (c.type === 'text-delta') raw += c.text
              if (c.type === 'finish' && c.reason?.kind === 'error') {
                throw new Error(c.reason.failure?.message ?? '上游返回错误')
              }
              if (raw.length >= 160 || ++chunks >= 30) break
            }
            const identity = checkIdentity(cacheKey, raw.trim())
            return { ...item, ...identity, actualProvider: opened.picked?.provider ?? item.provider, error: null, cached: false }
          })()

          try {
            const value = await withTimeout(task, IDENTITY_AUDIT_TIMEOUT_MS, cacheKey)
            identityCache.set(cacheKey, { at: Date.now(), value })
            return value
          } catch (e) {
            controller.abort()
            throw e
          }
        }

        // 后台跑，最多 3 个并行。串行核验 30 个要几分钟；无上限并发又会
        // 触发 provider rate-limit。小并发加单项超时，失败后继续下一项。
        ;(async () => {
          let next = 0
          const worker = async () => {
            while (next < queue.length) {
              const item = queue[next++]
              try {
                const value = await runOne(item)
                audit.results.push(value)
                if (value.match === true) audit.ok++
                else if (value.match === false) audit.mismatch++
                else audit.unknown++
              } catch (e) {
                audit.results.push({
                  ...item,
                  match: null,
                  asked: detectFamily(item.model),
                  said: null,
                  saidRaw: '',
                  note: '核验失败',
                  error: String(e?.message ?? e),
                  actualProvider: item.provider,
                  cached: false,
                })
                audit.failed++
              } finally {
                audit.done++
              }
            }
          }
          await Promise.all(Array.from({ length: audit.concurrency }, () => worker()))
          audit.running = false
          audit.finishedAt = Date.now()
        })().catch((e) => {
          audit.running = false
          audit.error = String(e?.message ?? e)
        })
        return json(res, 202, { audit })
      }


      // ── 模型（查看 + 调参 + 试跑）────────────────────────────
      //
      // 这一组接口解决"模型只能看不能调"：列出全部可用模型、
      // 改路由策略/优先级/默认模型/token 上限、以及对单个模型试跑。
      if (p === '/api/models' && req.method === 'GET') {
        const cfg = store.get()
        const providers = llm?.providers ?? []
        const selfIds = state.selfChannelIds ?? []

        // 目录是懒加载的：首次要逐个渠道打网络，可能只拉到一部分
        // （某个渠道超时就少一批）。所以：
        //   · 目录为空      → 现刷一次
        //   · ?refresh=1    → 强制重刷（用户在 UI 上点「刷新目录」时用）
        let catalog = llm?.catalog ?? []
        const wantRefresh = url.searchParams.get('refresh') === '1'
        if ((catalog.length === 0 || wantRefresh) && typeof llm?.refreshCatalog === 'function') {
          catalog = await llm.refreshCatalog(wantRefresh ? { ttlMs: 0 } : undefined).catch(() => catalog)
        }

        // 首次打开模型页时**自动测一次延迟** —— 用户不用手动点。
        // 只测一次：测完结果留在内存里，之后再打开直接读（不重复占用上游额度）。
        // 用 fire-and-forget，不 await —— 否则打开页面要白等十几秒。
        //
        // ⚠️ 首次自动探测**不自动关渠道**（autoDisable:false）——
        //    用户刚打开页面就被悄悄改配置，很容易让人以为"开关坏了"。
        //    自动关闭只在用户主动点「测延迟」时发生（那是显式动作）。
        if ((state.latency ?? []).length === 0 && catalog.length > 0 && !state.latencyProbe?.running) {
          startLatencyProbe({ llm, store, log, state, autoDisable: false })
        }

        const models = (catalog ?? []).map((m) => {
          // 视觉能力（能不能看图）。
          //
          // ⚠️ 这个字段以前被丢掉了，于是界面上 LLM 和 VLM 混在一起 ——
          //    用户选了不支持图片的模型，发图必然失败，却看不出原因。
          //    上游 dsh-llm 的 LlmModelInfo.inputModalities 里有这个信息，
          //    渠道包会按模型目录的 architecture.input_modalities 上报
          //    （见 adapter.js: entry.vision ? ['text','image'] : ['text']）。
          //
          // 三种情况要分清：
          //   'yes'  明确上报了 image
          //   'no'   明确上报了模态但没有 image
          //   'unknown' 渠道压根没上报 → 不能断言它不支持
          const mods = m.raw?.inputModalities
          let vision = 'unknown'
          if (Array.isArray(mods) && mods.length > 0) vision = mods.includes('image') ? 'yes' : 'no'
          return {
            id: m.id ?? m.model,
            provider: m.provider,
            label: m.name ?? m.label ?? null,
            // 属于免费渠道还是自备渠道，UI 分色用
            kind: selfIds.includes(m.provider) ? 'self' : 'free',
            /** 'yes' | 'no' | 'unknown' —— 能不能接收图片 */
            vision,
            /** 分类：与渠道界面一致（免费 / EAC / 白嫖接入 / 白嫖渠道） */
            group: modelGroupOf(m),
          }
        })

        // 推理等级：按渠道批量取一次（见 effortsByProvider 的说明）
        const effortMap = await effortsByProvider(llm, [...new Set(models.map((m) => m.provider))])
        for (const m of models) {
          const hit = effortMap[m.provider]
          m.efforts = hit?.efforts ?? []
          m.effortDefault = hit?.effortDefault ?? null
        }

        // 真正会生效的顺序：配置 > 内置默认顺序 > 注册顺序。
        // 界面必须显示这个，否则用户看到的和实际走的不一致（曾经就是）。
        // ⚠️ 顺序里**必须包含自备渠道**。之前只用 registered（排除了自备）——
        //    结果用户新加的渠道在「渠道优先级」里根本不出现，既没法排序，
        //    也看不出它在尝试顺序里排第几。自备渠道同样参与路由
        //    （免费优先、自备在后），理应能被排序和看到。
        const freeRegistered = providers.filter((x) => !selfIds.includes(x))
        const selfRegistered = providers.filter((x) => selfIds.includes(x))
        const configured = cfg.gateway?.freeProviders ?? []
        const disabled = cfg.gateway?.disabledProviders ?? []
        // 免费渠道按配置排序，自备渠道追加在其后 —— 与 router 实际行为一致。
        // 若用户在配置里点名了某个自备渠道，则按点名的位置插进去。
        let effectiveOrder
        const mentionedSelf = configured.filter((p) => selfRegistered.includes(p))
        if (mentionedSelf.length > 0) {
          const out = []
          for (const p of configured) {
            if (freeRegistered.includes(p) || selfRegistered.includes(p)) out.push(p)
          }
          for (const p of freeRegistered) if (!out.includes(p)) out.push(p)
          for (const p of selfRegistered) if (!out.includes(p)) out.push(p)
          effectiveOrder = out
        } else {
          effectiveOrder = applyFreeOrder(freeRegistered, configured).concat(selfRegistered)
        }

        // ── 可用的排在前面 ──────────────────────────────────────
        //
        // 关掉不可用的渠道后，把它们留在原来的位置会让列表变成
        // "buddy / [空] / [空] / lobsterai / …"，用户得在一堆灰行里
        // 找还能用的。所以做一次**稳定分区**：启用中的全部上移，
        // 被关闭的下沉到底部 —— 组内各自保持用户原有顺序。
        //
        // 注意这**只影响展示顺序**，不写回配置：
        // 用户重开某个渠道时，它会回到原来那个位置（因为配置没动）。
        const enabledFirst = [
          ...effectiveOrder.filter((p) => !disabled.includes(p)),
          ...effectiveOrder.filter((p) => disabled.includes(p)),
        ]
        effectiveOrder = enabledFirst

        // 哪些渠道"没有已知模型"—— auto 模式下会被跳过。
        // 不标出来的话，用户会以为排在前面就会先试，实际是空转。
        //
        // ⚠️ 必须和 router 的 firstModelOf() 用**完全相同的三个来源**，
        //    否则会误报。踩过的坑：这里一开始只查了 PROVIDER_MODEL_HINTS，
        //    漏了 catalog —— 于是 buddy 等其实有模型（目录里查得到）的渠道
        //    也被标成"会跳过"，和实际行为不符。
        //    来源：① 内置提示 ② 自备渠道默认模型 ③ 模型目录
        const known = new Set([
          ...Object.keys(PROVIDER_MODEL_HINTS).filter((k) => (PROVIDER_MODEL_HINTS[k] ?? []).length > 0),
          ...Object.keys(llm?.defaultModels?.() ?? {}),
          ...((catalog ?? []).map((m) => m.provider).filter(Boolean)),
        ])
        const orderDetail = effectiveOrder.map((p) => ({
          provider: p,
          usable: known.has(p),
          enabled: !disabled.includes(p),
          reason: known.has(p) ? null : '该渠道没有已知模型名，auto 模式会跳过',
          // 需要代理的渠道：UI 上标出来，别让用户对着 20 秒超时发懵
          needsProxy: NEEDS_PROXY[p] ?? null,
        }))

        return json(res, 200, {
          models,
          count: models.length,
          providers,
          // 当前生效的设置
          settings: {
            strategy: cfg.gateway?.strategy ?? 'free-first',
            freeOrder: configured,
            disabledProviders: disabled,
            qqModel: cfg.qq?.model ?? 'auto',
            maxTokens: cfg.qq?.maxTokens ?? 1024,
            threshold: cfg.decision?.threshold ?? 0.5,
            fallback: cfg.gateway?.fallback ?? null,
          },
          // 实际生效的顺序（已应用配置）＋ 每个渠道是否真的可用 / 是否被禁用
          defaultOrder: effectiveOrder,
          orderDetail,
          // 各渠道最近一次延迟探测结果（界面显示用）
          latency: state.latency ?? [],
          latencyProbe: state.latencyProbe ?? null,
          enabledCount: orderDetail.filter((d) => d.enabled).length,
        })
      }

      if (p === '/api/models/settings' && req.method === 'POST') {
        const body = await readJson(req)
        const patch = {}
        if (typeof body.strategy === 'string') patch.gateway = { ...(patch.gateway ?? {}), strategy: body.strategy }
        if (Array.isArray(body.freeOrder)) patch.gateway = { ...(patch.gateway ?? {}), freeProviders: body.freeOrder.map(String) }
        // 渠道开关：整批覆盖（前端每次提交完整列表，语义更清晰）
        if (Array.isArray(body.disabledProviders)) {
          const next = body.disabledProviders.map(String)
          // 记下"用户这次手动打开的"渠道 —— 自动关闭逻辑会跳过它们，
          // 避免"我手动开了它、一次探测失败又被自己关掉"。
          const prev = store.get().gateway?.disabledProviders ?? []
          const opened = prev.filter((p) => !next.includes(p))
          if (opened.length > 0) {
            if (!state.userEnabled) state.userEnabled = new Set()
            for (const p of opened) state.userEnabled.add(p)
          }
          // 用户手动关掉的则从"手动开过"名单里移除（他改主意了）
          for (const p of next) state.userEnabled?.delete(p)
          patch.gateway = { ...(patch.gateway ?? {}), disabledProviders: next }
        }
        if (typeof body.qqModel === 'string') patch.qq = { ...(patch.qq ?? {}), model: body.qqModel }
        // maxTokens：**0 = 不限制**（默认）。
        // 不要用 Math.max(64, …) 兜底 —— 把 0 抬成 64 会让"无限"变成"只能回 64 token"，
        // 推理模型直接就空回复了。只对正数做范围钳制。
        if (Number.isFinite(body.maxTokens)) {
          const v = Math.round(body.maxTokens)
          patch.qq = { ...(patch.qq ?? {}), maxTokens: v > 0 ? Math.min(32768, Math.max(64, v)) : 0 }
        }
        if (Number.isFinite(body.threshold)) patch.decision = { threshold: Math.max(0, Math.min(1, body.threshold)) }
        if (Object.keys(patch).length === 0) return json(res, 400, { error: '没有可更新的字段' })
        store.update(patch)
        log.info('Web：模型设置已更新 ' + JSON.stringify(patch))
        // 路由策略与优先级是每次请求现读的，改完立刻生效；
        // qq.model / maxTokens 由 bridge 每次生成时读，也立即生效。
        return json(res, 200, { ok: true, applied: Object.keys(patch), needRestart: false })
      }

      // ── 渠道延迟探测 ────────────────────────────────────────
      //
      // 我们只关心**渠道级**延迟 —— 用户要判断的是"把哪家排前面"，
      // 而不是"某个具体模型慢多少毫秒"。所以每个渠道**只测一个代表模型**：
      //   挑名字最短的那个（通常是最基础、最稳、最能代表该渠道速度的）。
      // 一次请求的首字节时间就足以说明渠道快慢，逐个模型测既慢又没意义。
      //
      // 结果按渠道缓存（state.latency 里每项含 provider/model/ms），
      // 界面上每行只读该渠道那一条来显示徽标。
      if (p === '/api/models/latency' && req.method === 'GET') {
        return json(res, 200, { latency: state.latency ?? [], probe: state.latencyProbe ?? null })
      }

      if (p === '/api/models/latency' && req.method === 'POST') {
        const body = await readJson(req)
        return json(res, 202, startLatencyProbe({
          llm, store, log, state,
          only: body?.provider ? [String(body.provider)] : null,
        }))
      }

      if (p === '/api/models/test' && req.method === 'POST') {
        const body = await readJson(req)
        const model = String(body?.model ?? 'auto')
        const prompt = String(body?.prompt ?? '说一句简短的话证明你能工作')
        const t0 = Date.now()
        const disabledNow = store.get().gateway?.disabledProviders ?? []
        // 失败时统一带上"建议换哪个模型"，前端可以直接点着试。
        const fail = (detail, extra) => {
          const attempts = extra?.attempts ?? []
          // 试着挂掉里有没有"需要代理 + 网络类错误"的 —— 这是最常见、
          // 也最容易被误判成"服务坏了"的情况，单独点出来。
          const proxyBlocked = attempts
            .filter((a) => !a.ok && NEEDS_PROXY[a.provider] && looksLikeNetworkError(a.error))
            .map((a) => ({ provider: a.provider, why: NEEDS_PROXY[a.provider] }))
          // 'auto' 之类的名字认不出家族时，提示也没意义
          const base = Object.assign({
            ok: false,
            detail,
            ms: Date.now() - t0,
            suggestions: buildSuggestions(model, llm?.catalog ?? [], disabledNow),
            proxyBlocked: proxyBlocked.length > 0 ? proxyBlocked : null,
          }, extra || {})
          return json(res, 200, base)
        }
        try {
          const candidates = resolveCandidates(model, {
            freeProviders: llm?.providers ?? [],
            freeOrder: store.get().gateway?.freeProviders ?? [],
            disabledProviders: disabledNow,
            catalog: llm?.catalog ?? [],
            selfModels: llm?.defaultModels?.() ?? {},
            fallback: store.get().gateway?.fallback,
          })
          if (candidates.length === 0) {
            return fail('没有解析出候选渠道')
          }
          const opened = await openFirstAvailable({
            llm,
            candidates,
            request: {
              messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
              maxTokens: 256,
            },
          })
          let text = ''
          let usage = null
          for await (const c of opened.stream) {
            if (c.type === 'text-delta') text += c.text
            else if (c.type === 'usage') usage = c.usage
            else if (c.type === 'finish' && c.reason?.kind === 'error') {
              return fail(c.reason.failure?.message ?? '上游报错', {
                picked: opened.picked,
                attempts: opened.attempts,
              })
            }
            if (text.length > 600) break   // 试跑不需要长篇
          }
          // ⚠️ "内容为空"也算失败 —— 而且**必须走 fail()**才能带上建议模型。
          //    之前这里直接返回 ok:false 却没给 suggestions，
          //    用户看到"返回内容为空"完全不知道下一步干什么。
          //    常见原因：推理模型把 token 预算吃光了（maxTokens 给小了）。
          if (!text) {
            return fail('返回内容为空 —— 可能是模型把 token 都花在推理上了，' +
              '或者这个模型不支持当前提示词', {
              picked: opened.picked,
              attempts: opened.attempts,
              usage,
            })
          }

          // 身份核对：用**刚刚成功的那个渠道**再问一句"你是谁"。
          // 不复用整个候选链 —— 那会把失败的渠道再试一遍，白等。
          // 只问一次、只要一两句话，通常 1-3 秒。
          let identity = null
          if (body?.verify === true && opened.picked) {
            try {
              const again = await openFirstAvailable({
                llm,
                candidates: [opened.picked],
                request: {
                  messages: [{
                    role: 'user',
                    content: [{
                      type: 'text',
                      text: 'Reply with ONLY your model name and vendor. ' +
                        'Example: "GPT-4 / OpenAI". No explanation, no punctuation beyond that.',
                    }],
                  }],
                  maxTokens: 80,
                },
              })
              let idText = ''
              for await (const c of again.stream) {
                if (c.type === 'text-delta') idText += c.text
                if (idText.length > 200) break
              }
              identity = checkIdentity(
                // auto 模式没有具体模型名 —— 用**实际路由到的那个**去核对，
                // 否则 detectFamily('auto') 认不出任何家族，核对等于白做。
                (model === 'auto' && opened.picked ? opened.picked.model : model),
                idText.trim(),
              )
            } catch (e) {
              identity = { asked: null, said: null, saidRaw: '', match: null, note: '核对失败：' + String(e?.message ?? e) }
            }
          }

          return json(res, 200, {
            ok: true,
            text: text.slice(0, 600),
            detail: '正常返回',
            picked: opened.picked,
            attempts: opened.attempts,
            usage,
            identity,
            ms: Date.now() - t0,
          })
        } catch (e) {
          return fail(String(e?.message ?? e))
        }
      }

      // ── 模式 ──────────────────────────────────────────────
      if (p === '/api/modes' && req.method === 'GET') {
        const cur = store.get().qq?.mode ?? 'whale-pod'
        return json(res, 200, {
          current: cur,
          modes: modes.listModes(),
          readiness: modes.checkModeReadiness(cur, {
            astrbotInstalled: Boolean(state.backends?.astrbot?.installed),
            protocolInstalled: Boolean(state.backends?.napcat?.installed),
          }),
          gatewayHint: modes.astrbotGatewayHint(store.get().gateway),
        })
      }

      if (p === '/api/modes/switch' && req.method === 'POST') {
        const body = await readJson(req)
        const to = String(body?.mode ?? '')
        const cur = store.get().qq?.mode ?? 'whale-pod'
        const plan = modes.planModeSwitch({
          from: cur,
          to,
          bridgeRunning: Boolean(bridge && !bridge.paused),
          astrbotRunning: Boolean(state.supervisor?.running('astrbot')),
        })
        if (!plan.ok) return json(res, 400, plan)
        if (body?.confirm !== true) return json(res, 200, { ...plan, needConfirm: true })

        // 执行切换：先停当前占着 OneBot 的一方
        const done = []
        try {
          if (cur === 'whale-pod' && state.onebot) {
            state.onebot.close()
            done.push('已断开 WhalePod 桥接')
          }
          if (cur === 'astrbot' && state.supervisor?.running('astrbot')) {
            await state.supervisor.stop('astrbot')
            done.push('已停止 AstrBot')
          }
          store.update({ qq: { mode: to } })
          done.push(`配置已切换为 ${to}`)
          const restartHint = to === 'astrbot'
            ? `请在 AstrBot 里把 API Base 填为 ${modes.astrbotGatewayHint(store.get().gateway).apiBase}`
            : 'WhalePod 将在下次启动时接 OneBot'
          log.info(`Web：运行模式 ${cur} → ${to}`)
          return json(res, 200, { ok: true, done, restartHint, needRestart: true })
        } catch (e) {
          return json(res, 500, { error: String(e?.message ?? e), done })
        }
      }

      // ── 人格 ──────────────────────────────────────────────
      if (p === '/api/persona' && req.method === 'GET') {
        if (!persona) return json(res, 400, { error: '人格层未启用' })
        const name = url.searchParams.get('name') ?? persona.active
        return json(res, 200, { ...persona.stats(), current: name, content: persona.read(name) })
      }
      if (p === '/api/persona' && req.method === 'POST') {
        if (!persona) return json(res, 400, { error: '人格层未启用' })
        const body = await readJson(req)
        if (body.name && body.content !== undefined) {
          persona.write(body.name, body.content)
          log.info('Web：已保存角色 ' + body.name)
          return json(res, 200, { ok: true, name: body.name })
        }
        if (body.active) {
          persona.setActive(body.active)
          store.update({ persona: { active: body.active } })
          log.info('Web：当前角色切换为 ' + body.active)
          return json(res, 200, { ok: true, active: body.active })
        }
        return json(res, 400, { error: '需要 name+content 或 active' })
      }

      // ── 记忆 ──────────────────────────────────────────────
      if (p === '/api/memory' && req.method === 'GET') {
        return json(res, 200, {
          short: memory?.stats?.() ?? null,
          long: longMemory?.stats?.() ?? null,
          scopes: memory?.scopes?.() ?? [],
        })
      }
      if (p === '/api/memory' && req.method === 'DELETE') {
        const scope = url.searchParams.get('scope')
        memory?.clear?.(scope ?? undefined)
        longMemory?.clear?.(scope ?? undefined)
        log.info('Web：已清空记忆' + (scope ? '（' + scope + '）' : '（全部）'))
        return json(res, 200, { ok: true, scope: scope ?? 'all' })
      }
      if (p === '/api/memory/scope' && req.method === 'GET') {
        const scope = url.searchParams.get('scope')
        if (!scope || !memory) return json(res, 400, { error: '需要 scope 参数' })
        const m = memory.get(scope)
        return json(res, 200, {
          scope,
          messages: m.recent(),
          consecutiveTurns: m.consecutiveTurns,
          sinceMyLastMs: Number.isFinite(m.sinceMyLast()) ? m.sinceMyLast() : null,
          summary: longMemory?.get(scope)?.summary ?? '',
        })
      }

      // ── 决策 ──────────────────────────────────────────────
      if (p === '/api/decision/probe' && req.method === 'GET') {
        return json(res, 200, await decision.probeAll())
      }
      if (p === '/api/decision/test' && req.method === 'POST') {
        const input = await readJson(req)
        const t0 = Date.now()
        const d = await decision.shouldReply(normalizeDecisionInput(input))
        return json(res, 200, { ...d, ms: Date.now() - t0, explain: decision.explain(d) })
      }

      // ── 日志 ──────────────────────────────────────────────
      if (p === '/api/logs' && req.method === 'GET') {
        const n = Number(url.searchParams.get('n') ?? 300)
        return json(res, 200, { entries: logger.recent(Math.min(Math.max(n, 1), 2000)) })
      }
      if (p === '/api/logs/stream' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        for (const e of logger.recent(200)) res.write('data: ' + JSON.stringify(e) + '\n\n')
        const unsub = logger.subscribe((e) => {
          try { res.write('data: ' + JSON.stringify(e) + '\n\n') } catch { /* 客户端已走 */ }
        })
        const keep = setInterval(() => {
          try { res.write(': ping\n\n') } catch { /* ignore */ }
        }, 15000)
        req.on('close', () => { unsub(); clearInterval(keep) })
        return
      }

      // ── 凭据 / 配置 ───────────────────────────────────────
      if (p === '/api/credentials' && req.method === 'GET') {
        return json(res, 200, {
          file: credentials.file,
          mode: credentials.mode,
          overlayFile: credentials.overlay.file,
          refs: credentials.listRefs(),
        })
      }
      if (p === '/api/config' && req.method === 'GET') {
        const cfg = store.get()
        return json(res, 200, {
          ...cfg,
          gateway: { ...cfg.gateway, key: redactKey(cfg.gateway.key) },
          web: { ...cfg.web, token: redactKey(cfg.web.token) },
        })
      }
      if (p === '/api/config' && req.method === 'POST') {
        const patch = await readJson(req)
        // 禁止通过 API 改密钥（防止被意外清空）
        if (patch.gateway) delete patch.gateway.key
        if (patch.web) delete patch.web.token
        store.update(patch)
        log.info('Web：配置已更新')

        // ⚠️ bridge 的 cfg 是**启动时快照**，改了配置它不会自己知道。
        //    白名单尤其明显：界面保存成功、但机器人仍然按旧名单丢消息，
        //    用户会以为"保存没生效"。这里把运行时可热更新的几项推给它。
        if (patch.qq && bridge) {
          const q = store.get().qq ?? {}
          if (q.allow) bridge.cfg.allow = { ...bridge.cfg.allow, ...q.allow }
          if (q.model !== undefined) bridge.cfg.model = q.model
          if (q.maxTokens !== undefined) bridge.cfg.maxTokens = q.maxTokens
          if (q.effort !== undefined) bridge.cfg.effort = q.effort
          if (q.reply) bridge.cfg.reply = { ...bridge.cfg.reply, ...q.reply }
          if (q.allow?.groups) {
            log.info(`Web：QQ 白名单已更新（私聊 ${(q.allow.private ?? []).length} 个、群 ${q.allow.groups.length} 个）`)
          }
        }
        return json(res, 200, { ok: true })
      }

      // ── dsh-whale-pod 插件兼容层（/api/whale-pod/*）────────────────
      //
      // DSH 的 dsh-whale-pod 插件把这些路由透传给浏览器（它的设置页与
      // 侧栏仪表盘）。形状与插件的 client.js 契约完全一致。
      // 放在 404 之前 —— 前缀匹配，最具体的先判。
      if (p.startsWith('/api/whale-pod/')) {
        const sub = p.slice('/api/whale-pod'.length) || '/'
        const sub_ = sub === '/' ? '' : sub
        return whalePodCompat({
          sub: sub_, method: req.method, url, req, res, json, readJson,
          store, memory, persona, longMemory, bridge, decision, state, log, logger, protocols,
          // llm 供 /models 用：要读 providers / catalog / defaultModels
          llm,
          // creds 供 /qq/start 动态建桥接时读凭据（联网搜索用）
          creds: credentials,
          // usage 是 state 上挂的统计器（不是本函数作用域里的变量）
          usage: state.usage,
        })
      }

      return json(res, 404, { error: 'not found: ' + p })
    } catch (err) {
      log.warn('Web：' + String(err?.message ?? err))
      if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) })
      else { try { res.end() } catch { /* ignore */ } }
    }
  })

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(web.port, web.host, () => {
          log.info('Web：监听 http://' + web.host + ':' + web.port)
          resolve()
        })
      })
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

// ── 鉴权 ──────────────────────────────────────────────────────

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? '').trim())
  return m?.[1]
}

/**
 * 把图标库注进客户端脚本。
 *
 * 为什么走注入而不是让浏览器再请求一次 /icons.js：
 *   图标数据只有几 KB，多一次请求不值得；而且这样客户端可以直接用
 *   同步的 ICONS 常量，渲染时不需要 await。
 */
function injectIcons(js) {
  return `;(function(){ try { window.__WHALE_POD_ICONS__ = ${JSON.stringify(ICONS)} } catch(_){} })();\n` + js
}

/** 请求是否来自回环地址（决定要不要把 token 嵌进页面）。 */
function isLoopback(req) {
  const ip = req.socket?.remoteAddress ?? ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
}

/** 从 Cookie 里读 token（跨源 iframe 里不能用 localStorage，只能靠 Cookie）。 */
function cookieToken(req) {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k === 'whale_pod_token') {
      try { return decodeURIComponent(part.slice(i + 1).trim()) } catch { return part.slice(i + 1).trim() }
    }
  }
  return null
}

/**
 * 把 token 作为常量注进客户端脚本。
 *
 * 优先级：URL 里的 ?token= > Referer 里带的 token > 无。
 *
 * 为什么用 Referer：从侧栏 iframe 打开时，浏览器会带上外层页面的
 * Referer（含它自己的 ?token=）。这样用户只要在外层 URL 带过一次
 * token，内嵌的页面就能自动继承，不必再填。
 */
function injectToken(js, req, url, serverToken) {
  if (!serverToken) return js
  let tok = url.searchParams.get('token') ?? bearer(req) ?? cookieToken(req) ?? ''
  if (!tok) {
    const ref = req.headers.referer ?? ''
    const m = /[?&]token=([^&#]+)/.exec(ref)
    if (m) { try { tok = decodeURIComponent(m[1]) } catch { tok = m[1] } }
  }
  if (!tok) return js   // 没拿到就照原样发，页面会走「未授权」提示
  const safe = JSON.stringify(String(tok))
  return `;(function(){ try { window.__WHALE_POD_TOKEN__ = ${safe} } catch(_){} })();\n` + js
}

function authorized(req, url, token) {
  if (!token) return true
  const given = url.searchParams.get('token') ?? bearer(req) ?? cookieToken(req)
  return given ? safeEqual(given, token) : false
}

function redactKey(k) {
  const s = String(k ?? '')
  return s.length <= 8 ? '***' : s.slice(0, 8) + '…'
}

// ── 状态快照 ──────────────────────────────────────────────────

function buildStatus(ctx) {
  const { store, llm, decision, credentials, memory, persona, longMemory, bridge, state } = ctx
  const cfg = store.get()

  // ⚠️ 总览页的数字必须和「模型与渠道」页**同一口径** —— 否则两页各说各话：
  //    总览说"14 个渠道 / 670 个模型"，模型页说"12/14 渠道 / 182 个模型"。
  //    用户看到会以为数据不对（实际是总览在报"注册了多少"，而没扣掉
  //    被关掉的渠道）。
  //
  //    统一规则：**只算启用中的渠道**，再把模型按渠道过滤。
  const disabled = new Set(cfg.gateway?.disabledProviders ?? [])
  const allProviders = llm?.providers ?? []
  const enabledProviders = allProviders.filter((p) => !disabled.has(p))
  const catalog = llm?.catalog ?? []
  const usableModels = catalog.filter((m) => !disabled.has(m.provider))
  // 视觉模型：只有明确上报了 image 模态的才算（见 /api/models 的 vision 字段）
  const visionModels = usableModels.filter((m) => {
    const mods = m.raw?.inputModalities
    return Array.isArray(mods) && mods.includes('image')
  })

  return {
    ok: true,
    uptimeMs: Date.now() - state.startedAt,
    gateway: {
      enabled: cfg.gateway.enabled,
      url: 'http://' + cfg.gateway.host + ':' + cfg.gateway.port + '/v1',
      keyPrefix: redactKey(cfg.gateway.key),
      strategy: cfg.gateway.strategy,
      counters: state.gateway?.counters ?? null,
    },
    providers: {
      count: enabledProviders.length,
      total: allProviders.length,
      list: allProviders,
      enabled: enabledProviders,
      disabled: [...disabled],
    },
    catalog: { count: usableModels.length, total: catalog.length, vision: visionModels.length },
    // 用量：token 与估算费用（QQ + 网关两条路都汇总在这里）。
    // state.usage 缺失时给个零值快照，UI 不用做空判断。
    usage: state.usage?.snapshot?.() ?? null,
    decision: { order: decision.order, threshold: decision.threshold, stats: decision.stats },
    credentials: {
      file: credentials.file,
      mode: credentials.mode,
      count: credentials.listRefs().length,
      overlayCount: credentials.overlay.names().length,
    },
    qq: bridge?.statsSnapshot?.() ?? { enabled: cfg.qq?.enabled === true, connected: false },
    memory: memory?.stats?.() ?? null,
    longMemory: longMemory?.stats?.() ?? null,
    persona: persona?.stats?.() ?? null,
    dsh: { appDir: state.dshAppDir ?? null, profile: state.profile ?? null },
  }
}

/**
 * 组件（协议端 / 框架）状态快照。
 *
 * 每个组件都带上许可信息 —— 因为 UI 要强制用户先读许可再下载。
 */
async function backendsSnapshot({ store, state, protocols }) {
  if (!protocols) return { backends: [], note: '组件管理未启用' }
  const installed = protocols.detectInstalled(store.home)
  const running = state.supervisor?.status?.() ?? {}
  const list = protocols.listBackends().map((b) => {
    const info = running[b.id] ?? {}
    // ⚠️ 进程不是我们启动的时（用户手动开的 / 上一轮留下的），
    //    supervisor 里没有 entry → pid/startedAt 全是空。
    //    界面于是显示"运行中"但什么细节都没有，用户觉得"后台情况看不见"。
    //    这里补上**从端口/进程反查到的实况**。
    let procs = []
    if (info.running && !info.pid) {
      try { procs = protocols.listProcesses?.(store.home, b.id) ?? [] } catch { procs = [] }
    }
    const totalMem = procs.reduce((n, p) => n + (p.memBytes || 0), 0)
    return {
      ...b,
      installed: Boolean(installed[b.id]?.installed),
      version: installed[b.id]?.version ?? null,
      exe: installed[b.id]?.exe ?? null,
      running: Boolean(info.running),
      pid: info.pid ?? (procs[0]?.pid ?? null),
      startedAt: info.startedAt ?? (procs.length ? Math.min(...procs.map((p) => p.startedAt || Date.now())) : null),
      lastExit: info.lastExit ?? null,
      licenseAccepted: (state.licensesAccepted ?? {})[b.id] === true,
      // 它自己的管理界面（地址 + 登录 token）—— 日志里抓不到 token
      // （启动器注入完就退，stdout 未必接得住），所以直接读它的配置文件。
      web: protocols?.webInfo?.(store.home, b.id) ?? null,
      /** 进程实况（不是我们启动的时用来兜底展示） */
      processCount: procs.length || (info.pid ? 1 : 0),
      /** 只有"反查到的"进程才给明细，避免和 supervisor 的数据打架 */
      processes: info.pid ? [] : procs,
      memBytes: info.pid ? null : (totalMem || null),
      /** 谁启动的 —— 用户据此知道点「停止」能不能停掉 */
      managed: Boolean(info.pid),
    }
  })
  return {
    backends: list,
    installing: state.installing ?? null,
    currentMode: store.get().qq?.mode ?? 'whale-pod',
  }
}

/** 把外部传入的简化输入补齐成 DecisionInput。 */
function normalizeDecisionInput(input = {}) {
  const now = Date.now()
  const msgs = Array.isArray(input.messages) && input.messages.length > 0
    ? input.messages.map((m, i) => ({
      id: m.id ?? String(i),
      sender: m.sender ?? m.senderName ?? 'unknown',
      senderName: m.senderName ?? m.sender ?? '群友',
      text: String(m.text ?? ''),
      at: m.at ?? now,
      mentionsMe: Boolean(m.mentionsMe),
      isMe: Boolean(m.isMe),
    }))
    : [{
      id: '0', sender: 'u1', senderName: '测试用户', text: input.text ?? '你好',
      at: now, mentionsMe: Boolean(input.mentionsMe), isMe: false,
    }]

  return {
    messages: msgs,
    self: input.self ?? { qq: '0', nickname: 'WhalePod' },
    scene: input.scene ?? { kind: 'group', groupId: '0' },
    sinceMyLastMessage: typeof input.sinceMyLastMessage === 'number' ? input.sinceMyLastMessage : Infinity,
    consecutiveTurns: typeof input.consecutiveTurns === 'number' ? input.consecutiveTurns : 0,
  }
}

// ── 静态资源 ───────────────────────────────────────────────────

function html(res, code, body) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sendJs(res, body) {
  const buf = Buffer.from(body, 'utf8')
  res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
  res.end(buf)
}

function sendCss(res, body) {
  const buf = Buffer.from(body, 'utf8')
  res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
  res.end(buf)
}

/** 图标目录（默认项目下的 assets/）。 */
function resolveAssetsDir(explicit) {
  if (explicit) return explicit
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets')
}

function sendIcon(res, assetsDir) {
  const dir = resolveAssetsDir(assetsDir)
  for (const [name, type] of [['icon.png', 'image/png'], ['icon-256.png', 'image/png'], ['icon.jpg', 'image/jpeg']]) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file)
      res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600', 'content-length': buf.length })
      res.end(buf)
      return
    }
  }
  res.writeHead(404); res.end('no icon')
}

function sendIconSource(res, assetsDir) {
  const dir = resolveAssetsDir(assetsDir)
  for (const [name, type] of [['icon.png', 'image/png'], ['icon.jpg', 'image/jpeg']]) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file)
      res.writeHead(200, { 'content-type': type, 'content-length': buf.length })
      res.end(buf)
      return
    }
  }
  res.writeHead(404); res.end('no icon')
}

/**
 * 按尺寸返回图标：`/icon-16.png`、`/icon-128.png` …
 *
 * 只允许白名单里的尺寸与文件名，避免路径穿越（`/icon-../../etc/passwd`）。
 */
const ICON_SIZE_RE = /^\/icon-(16|24|32|48|64|128|256)\.png$/
function sendSizedIcon(res, assetsDir, pathname) {
  const m = ICON_SIZE_RE.exec(pathname)
  if (!m) { res.writeHead(404); res.end('no icon'); return }
  const dir = resolveAssetsDir(assetsDir)
  const file = path.join(dir, `icon-${m[1]}.png`)
  if (!fs.existsSync(file)) {
    // 该尺寸没生成过就退回主图，至少不是 404
    return sendIcon(res, assetsDir)
  }
  const buf = fs.readFileSync(file)
  res.writeHead(200, {
    'content-type': 'image/png',
    // 图标内容固定，长缓存
    'cache-control': 'public, max-age=86400',
    'content-length': buf.length,
  })
  res.end(buf)
}

/**
 * 页面骨架。样式与脚本走外链，浏览器可缓存，也便于调试。
 *
 * `embedToken` 只在**回环请求**时非空 —— 把 token 作为 meta 标签写进
 * HTML，让页面在任何环境（含 localStorage 不可用的跨源 iframe）都能
 * 自证身份，用户不必手填。同源策略保证外部站点读不到这些字节。
 */
function renderPage({ authed, tokenNeeded, embedToken = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#3b6ef5">
<meta name="whale-pod-token" content="${escapeAttr(embedToken)}">
<meta name="whale-pod-authed" content="${authed ? '1' : '0'}">
<title>WhalePod 控制台</title>
<!-- 多尺寸 favicon：浏览器会按用途挑合适的，标签页才不会发糊 -->
<link rel="icon" type="image/png" sizes="16x16" href="/icon-16.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
<link rel="icon" type="image/png" sizes="48x48" href="/icon-48.png">
<link rel="icon" type="image/png" sizes="128x128" href="/icon-128.png">
<link rel="icon" type="image/png" sizes="256x256" href="/icon.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-128.png">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root" data-authed="${authed}" data-token-needed="${tokenNeeded}"></div>
<script src="/app.js"></script>
</body>
</html>`
}

/** 属性值转义（token 只含 URL 安全字符，但严谨点好）。 */
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/**
 * 自检：CLIENT_JS 必须是**语法合法**的浏览器脚本。
 *
 * 为什么需要：CLIENT_JS 来自模板字符串，里面的 `\n` 会被求值成真实换行。
 * 若它落在字符串字面量中间（例如 `'...\n' +`），生成到浏览器的代码就变成
 * 「单引号字符串里有裸换行」→ SyntaxError → **整页黑屏**（脚本整体不执行，
 * 连报错都只在 devtools 里看得到）。
 *
 * 这个坑踩过一次，所以这里在模块加载时验一遍：有语法错误直接抛，
 * 绝不让坏脚本发到浏览器。
 */
/**
 * 需要"能访问境外服务"的渠道（国内一般要挂代理）。
 *
 * 为什么要单独标出来：gemini 连不上时要等**连接超时**（默认 20 秒左右）
 * 才失败，然后才轮到下一个渠道。用户看到的是"试跑莫名其妙要 20 秒"，
 * 或者"auto 老是慢一拍"，根本想不到是 Google 不通。
 */
const NEEDS_PROXY = {
  gemini: 'Google 服务，国内网络需要代理才能连上',
  // 这些渠道的端点在中国大陆直连不稳定，实测需要代理（或经常超时）：
  cline: 'Cline 官方端点，国内直连常超时',
  opencode: 'OpenCode 端点，国内直连不稳定',
  lobsterai: '有道端点，境外节点可能不通',
  raccoon: '商汤端点，境外访问受限',
  trae: 'Trae 端点，国内访问不稳定',
  loomy: 'Loomy 端点，国内直连不稳定',
  zcode: 'ZCode 端点，国内直连不稳定',
}

/**
 * DSH 内置渠道 —— **不走账号池**。
 *
 * `deepseek-official` 用 API Key、`deepseek-account` 用 OAuth，两者都不在
 * channel-pack 的 accountPool 里。若把它们当成"0 个账号"隐藏掉，
 * 付费兜底就会从侧栏消失，用户再也看不到/调不到它。
 */
const BUILTIN_PROVIDERS = new Set(['deepseek-official', 'deepseek-account'])

/**
 * 内置渠道的凭据是否已配置。
 *
 * `deepseek-official` 走 API Key（ref `DEEPSEEK_API_KEY`），
 * `deepseek-account` 走 OAuth（WhalePod 没挂 deepseekAccount 服务，本来就用不了）。
 *
 * @param {string} provider
 * @param {object} [creds] WhalePod 的 Credentials 实例
 * @returns {boolean}
 */
function builtinCredentialReady(provider, creds) {
  if (provider !== 'deepseek-official') return false
  try {
    const raw = creds?.getRaw?.('DEEPSEEK_API_KEY')
    return typeof raw === 'string' && raw.trim().length > 0
  } catch { return false }
}

/**
 * 把模型归到渠道界面上的同一套分类里。
 *
 * ## 依据（依据渠道包自己的模型目录结构）
 *
 *   entry.channel === 'eac'   → EAC 模型（协同付费车道）
 *   entry.channel === 'kilo'  → 白嫖模型接入（Kilo 网关）
 *   其余                      → 免费模型（免费渠道池）
 *   白嫖渠道（codearts/buddy/workbuddy/…）→ 账号型渠道，渠道界面里是独立一页
 *
 * ## 为什么按 channel 而不是 provider
 *
 * 免费/EAC/Kilo 三类**共用同一个 provider**（都走 free-channel pack 的
 * 适配器），区分它们的唯一依据是条目上的 `channel` 字段。按 provider 分会把
 * 三类全混在一起，跟 渠道界面对不上。
 *
 * ## EAC / Kilo 在 WhalePod 里恒为空
 *
 * 这两类是渠道包自己的车道：EAC 走协同付费网关、Kilo 走它自己的网关，
 * 各有独立凭据与端点，不是 channel-pack 的 provider。WhalePod 只加载
 * channel-pack，所以永远拿不到它们 —— 前端因此不渲染这两个标签
 * （而不是显示两个恒为 0 的按钮让人以为坏了）。
 *
 * @param {{provider?:string, raw?:object}} m
 * @returns {'free'|'eac'|'kilo'|'channel'}
 */
function modelGroupOf(m) {
  const ch = m?.raw?.channel
  if (ch === 'eac') return 'eac'
  if (ch === 'kilo') return 'kilo'
  // 账号型白嫖渠道（codearts/buddy/workbuddy/...）：这些是渠道界面里
  // 「白嫖模型接入」那一页的渠道，走各产品自己的适配器。
  const PROVIDER_CHANNELS = new Set([
    'codearts', 'buddy', 'workbuddy', 'lobsterai', 'loomy', 'raccoon',
    'minimax', 'zcode', 'qoder', 'qodercn', 'trae', 'cline', 'opencode', 'gemini',
  ])
  if (PROVIDER_CHANNELS.has(m?.provider)) return 'channel'
  return 'free'
}

/**
 * 按渠道批量取推理等级。
 *
 * ## 为什么不是逐模型查
 *
 * 推理等级只在 `llm.resolveModelInfo(provider, model)` 里有，
 * 而 `listModels` 返回的条目**不带** reasoning 字段（实测：
 * 只有 provider/id/name/inputModalities）。
 *
 * 但逐模型调用会打 58 次上游（每个都要 resolve），侧栏 15 秒轮询根本扛不住。
 * 折中：**每个渠道只查一个代表模型** —— 同一渠道的模型通常共用同一套
 * effort 菜单（渠道包的模型目录里也是按 model 定义的，但同族一致）。
 * 查不到的渠道留空，前端就不显示推理等级，而不是编一个假的。
 *
 * @returns {Promise<Record<string, {efforts:string[], effortDefault:string|null}>>}
 */
async function effortsByProvider(llm, providers) {
  const out = {}
  if (typeof llm?.resolveModelInfo !== 'function') return out
  await Promise.all(providers.map(async (p) => {
    try {
      const models = await llm.listModels(p)
      const first = models?.[0]
      if (!first) return
      const info = await llm.resolveModelInfo(p, first.id ?? first.model)
      const r = info?.reasoning
      const efforts = Array.isArray(r?.efforts)
        ? r.efforts.map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean)
        : []
      if (efforts.length > 0) {
        out[p] = { efforts, effortDefault: r?.defaultEffort === undefined ? null : String(r.defaultEffort) }
      }
    } catch { /* 单渠道失败不影响整体 */ }
  }))
  return out
}

// 单模型试跑身份核对缓存：同一 (provider, model) 只需问一次，
// 可把批量核验总耗时从 N×网络延迟降为一次，且切页面不丢结果。
const identityCache = new Map()
const IDENTITY_CACHE_TTL = 7 * 24 * 60 * 60 * 1000
const IDENTITY_AUDIT_TIMEOUT_MS = 20_000

/** 给不遵守 request.signal 的适配器加一个软超时，防止后台审计永久卡住。 */
function withTimeout(promise, ms, label = '操作') {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒）`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** 判断一段报错是不是"网络不通"类（而不是模型/参数问题）。 */
function looksLikeNetworkError(text) {
  const t = String(text || '').toLowerCase()
  return [
    'timeout', 'timed out', 'econnrefused', 'econnreset', 'enotfound',
    'fetch failed', 'connect', 'network', 'socket', 'und_err',
    '代理', 'proxy', 'dns',
  ].some((kw) => t.includes(kw))
}

/**
 * 模型身份核对。
 *
 * 为什么需要：这些免费渠道（trae / lobsterai / qodercn …）的模型目录
 * 是**渠道自己编的标签**，和背后的真实模型经常对不上。实测：
 *   trae/deepseek-V3        → 自称 Doubao / ByteDance
 *   trae/DeepSeek-V4-Pro    → 自称 Claude / Anthropic
 *   lobsterai/deepseek-v4-flash → 自称 GPT-4 / OpenAI
 * 用户在「全部模型」里看到 658 个名字，会误以为真有 658 个不同模型。
 *
 * 这里通过"问它自己是谁"来交叉验证 —— 不完美（模型也可能报错身份），
 * 但足以把明显名不副实的标出来。
 */
const FAMILY_HINTS = {
  deepseek: ['deepseek', 'deep seek', '深度求索'],
  gpt: ['gpt', 'openai', 'chatgpt'],
  claude: ['claude', 'anthropic'],
  gemini: ['gemini', 'google', 'gemma'],
  qwen: ['qwen', '通义', 'alibaba', '阿里', 'tongyi'],
  doubao: ['doubao', '豆包', 'bytedance', '字节', 'seed'],
  glm: ['glm', 'chatglm', 'zhipu', '智谱'],
  kimi: ['kimi', 'moonshot', '月之暗面'],
  llama: ['llama', 'meta ai'],
  mistral: ['mistral', 'mixtral'],
  grok: ['grok', 'xai'],
  minimax: ['minimax', 'abab'],
  ernie: ['ernie', '文心', 'baidu', '百度'],
  hunyuan: ['hunyuan', '混元', 'tencent', '腾讯'],
  step: ['step', '阶跃'],
}

/** 从一段文字里猜出模型家族。命中多个时返回最长的那个（更具体）。 */
function detectFamily(text) {
  const t = String(text || '').toLowerCase()
  let best = null
  for (const fam of Object.keys(FAMILY_HINTS)) {
    for (const kw of FAMILY_HINTS[fam]) {
      if (t.includes(kw) && (!best || kw.length > best.kw.length)) best = { fam, kw }
    }
  }
  return best ? best.fam : null
}

/**
 * 核对请求的模型名与模型自称是否一致。
 * @returns {{asked:string|null, said:string|null, saidRaw:string, match:boolean|null, note:string}}
 */
function checkIdentity(requested, saidRaw) {
  // 请求名里带渠道前缀（provider/model）时只看模型名部分
  const askedName = String(requested || '').includes('/')
    ? String(requested).slice(String(requested).indexOf('/') + 1)
    : String(requested || '')
  const asked = detectFamily(askedName)
  const said = detectFamily(saidRaw)
  if (!asked || !said) {
    return {
      asked, said, saidRaw, match: null,
      note: !asked
        ? `"${askedName}" 不在已知模型家族里，无法判断`
        : '模型的回答里没提到可识别的模型名',
    }
  }
  return {
    asked,
    said,
    saidRaw,
    match: asked === said,
    note: asked === said ? '名字与自称一致' : `请求的是 ${asked}，它自称 ${said}`,
  }
}

/**
 * 取模型名的"系列"，用于推荐替代模型。
 * 和前端 modelSeries() 用同一套规则（斜杠前的厂商名优先）。
 */
function seriesOf(id) {
  const s = String(id || '')
  const slash = s.indexOf('/')
  if (slash > 0 && s.slice(0, slash).length >= 2) return s.slice(0, slash).toLowerCase()
  const m = s.match(/^[A-Za-z]+/)
  return m ? m[0].toLowerCase() : ''
}

/**
 * 试跑失败时，推荐几个"可能能用"的模型。
 *
 * 为什么需要：模型名打错、或者某家渠道抽风时，光甩一句
 * "渠道网络请求失败"用户只能干瞪眼 —— 不知道下一步该填什么。
 *
 * 推荐优先级：
 *   1. 同名模型在**其他启用渠道**也有 → 换个渠道就行（最省事）
 *   2. **同系列**的其他模型（deepseek-v4-pro 挂了就试 deepseek-v4-flash）
 *   3. 兜底：当前启用渠道里随便挑几个有模型的
 *
 * @param {string} failed               试跑用的模型名
 * @param {Array}  catalog              模型目录 [{provider, id}]
 * @param {string[]} disabled           被禁用的渠道
 * @returns {Array<{model:string, providers:string[], why:string}>}
 */
function buildSuggestions(failed, catalog, disabled) {
  const out = []
  const seen = new Set()
  const active = (m) => m && m.provider && !disabled.includes(m.provider)
  const push = (model, provs, why) => {
    // ⚠️ 不推荐模型自己。试跑内部已经把所有候选渠道都试过一遍了，
    //    再推荐同名模型只会让用户点了原地打转（点一次、失败一次、又推荐它）。
    if (!model || model === failed || seen.has(model)) return
    const list = [...new Set(provs)]
    if (list.length === 0) return
    seen.add(model)
    out.push({ model, providers: list, why })
  }

  const idOf = (m) => m.id ?? m.model

  // 1) 同系列的其他模型（最有用的建议）
  const ser = seriesOf(failed)
  if (ser) {
    const sib = {}
    for (const m of catalog) {
      if (!active(m)) continue
      const id = idOf(m)
      if (id === failed || seriesOf(id) !== ser) continue
      if (!sib[id]) sib[id] = []
      sib[id].push(m.provider)
    }
    Object.keys(sib).slice(0, 4).forEach((id) => push(id, sib[id], '同系列，可能更容易成功'))
  }

  // 3) 兜底：当前启用渠道里任意几个有模型的
  if (out.length < 3) {
    const any = {}
    for (const m of catalog) {
      if (!active(m)) continue
      const id = idOf(m)
      if (!any[id]) any[id] = []
      any[id].push(m.provider)
      if (Object.keys(any).length > 60) break
    }
    Object.keys(any).slice(0, 5).forEach((id) => push(id, any[id], '当前渠道可用的模型'))
  }

  return out.slice(0, 6)
}

/**
 * 启动一次渠道延迟探测。
 *
 * **只测渠道级延迟** —— 每个渠道挑一个代表模型（名字最短的，通常最基础最稳），
 * 测它的首字节时间。逐个模型测既慢又没意义：用户要判断的是"把哪家排前面"。
 *
 * 并发 3：太大会触发上游限流，太小一轮要等十几秒。
 * 已在跑就直接返回，不重复启动（避免用户连点按钮把上游打爆）。
 *
 * @param {object} o
 * @param {object} o.llm     LLM 网关
 * @param {object} o.store   配置
 * @param {object} o.state   运行状态（结果与进度都挂在上面，供接口读取）
 * @param {string[]} [o.only] 只测这些渠道
 * @returns {{running:boolean,total:number,latency:Array}}
 */
function startLatencyProbe({ llm, store, log, state, only = null, autoDisable = true }) {
  if (state.latencyProbe?.running) {
    return { running: true, latency: state.latency ?? [], probe: state.latencyProbe }
  }
  const disabled = store.get().gateway?.disabledProviders ?? []
  const catalog = llm?.catalog ?? []

  const pick = new Map()
  for (const m of catalog) {
    if (!m.provider || disabled.includes(m.provider)) continue
    if (only && !only.includes(m.provider)) continue
    const id = m.id ?? m.model
    if (!id) continue
    const cur = pick.get(m.provider)
    if (!cur || id.length < cur.length) pick.set(m.provider, id)
  }
  const targets = [...pick.entries()].map(([provider, model]) => ({ provider, model }))
  const probe = state.latencyProbe = {
    running: true, total: targets.length, done: 0, startedAt: Date.now(),
    note: '每个渠道只测一个代表模型的首字节延迟',
  }
  const results = state.latency = state.latency ?? []

  ;(async () => {
    let next = 0
    const runOne = async ({ provider, model }) => {
      const t0 = Date.now()
      let ms = null, error = null, ok = false
      try {
        const opened = await withTimeout(openFirstAvailable({
          llm,
          candidates: [{ provider, model, kind: 'free', why: 'latency probe' }],
          request: {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            maxTokens: 4,
          },
        }), 15_000, `${provider}/${model}`)
        // 读到第一个 chunk 就算数 —— 这才是用户感知的"首字节时间"
        for await (const c of opened.stream) {
          if (c.type === 'text-delta' || c.type === 'reasoning-delta') break
          if (c.type === 'finish' && c.reason?.kind === 'error') {
            error = c.reason.failure?.message ?? '上游报错'
            break
          }
        }
        ms = Date.now() - t0
        ok = !error
      } catch (e) {
        ms = null
        error = String(e?.message ?? e)
      }
      const rec = { provider, model, ms: ok ? ms : null, rawMs: ms, error, at: Date.now() }
      const i = results.findIndex((x) => x.provider === provider)
      if (i >= 0) results[i] = rec
      else results.push(rec)
      probe.done++
    }
    const worker = async () => {
      while (next < targets.length) await runOne(targets[next++])
    }
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker))
    probe.running = false
    probe.finishedAt = Date.now()
    const okN = results.filter((x) => x.ms != null).length
    log?.info?.(`延迟探测完成：${okN}/${results.length} 个渠道可用`)

    // ── 自动关闭探测不通的渠道 ────────────────────────────────
    //
    // 探测失败的渠道（凭据过期、额度耗尽、需要代理…）留在候选里只会
    // 让每次 auto 请求白等一轮超时。所以测完就自动关掉它们。
    //
    // ⚠️ 三条边界，缺一条就会造成"开关自己乱动"的观感：
    //   1. **只在用户主动点「测延迟」时**才自动关
    //      （首次打开页面的自动探测传 autoDisable:false）——
    //      否则刚打开页面配置就被改了，用户会以为开关坏了。
    //   2. **不动用户手动关过的**：已经在 disabled 里的不再重复写入。
    //   3. **不动用户手动开过的**：用户显式打开某渠道 = "我要用它"，
    //      不能因为一次探测失败就再次关掉 —— 那会变成"我开了它又自己关"。
    //      在手动开启时把它的 id 记进 state.userEnabled，这里跳过。
    if (autoDisable !== false) {
      try {
        const current = store.get().gateway?.disabledProviders ?? []
        const userEnabled = state.userEnabled ?? new Set()
        const failed = results
          .filter((x) => x.ms == null && x.error)
          .map((x) => x.provider)
          .filter((p) => !current.includes(p) && !userEnabled.has(p))
        if (failed.length > 0) {
          store.update({ gateway: { disabledProviders: [...current, ...failed] } })
          probe.autoDisabled = failed
          log?.info?.(`延迟探测：已自动关闭不通的渠道 ${failed.join(', ')}`)
        }
      } catch (e) {
        log?.warn?.(`自动关闭渠道失败：${String(e?.message ?? e)}`)
      }
    }
  })().catch((e) => {
    probe.running = false
    probe.error = String(e?.message ?? e)
  })

  return { running: true, total: targets.length, latency: results, probe }
}

function validateClientJs() {
  // 主动搜反引号 —— 比等语法错误再猜有用得多。
  // CLIENT_CSS / CLIENT_JS 都是模板字符串，里面一旦出现反引号，
  // 模板会从那里被截断，报出来的却是毫不相干的 "Unexpected identifier"。
  for (const [name, text] of [['CLIENT_CSS', CLIENT_CSS], ['CLIENT_JS', CLIENT_JS]]) {
    const at = text.indexOf('`')
    if (at >= 0) {
      const around = text.slice(Math.max(0, at - 60), at + 30).replace(/\n/g, ' ⏎ ')
      throw new Error(
        `${name} 里出现了反引号（第 ${at} 个字符附近）：\n  …${around}…\n` +
        'CLIENT_CSS / CLIENT_JS 本身是模板字符串，内部不能有反引号 —— ' +
        '注释里也不行（这条踩过三次）。改用双引号或直接删掉。',
      )
    }
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(CLIENT_JS)
  } catch (err) {
    throw new Error(
      'web/assets.js 的 CLIENT_JS 有语法错误（浏览器会整页黑屏）：' + err.message + '\n' +
      '常见原因：模板字符串里的换行写成了 \\n，应该写成 \\\\n（双反斜杠）或直接换行。',
    )
  }
}

// ═══════════════════════════════════════════════════════════════════
// dsh-whale-pod 插件兼容层
// ═══════════════════════════════════════════════════════════════════

/**
 * DSH 的 dsh-whale-pod 插件透传的兼容 API。
 *
 * 路由形状与插件的 client.js 契约一一对应；实现优先复用本文件
 * 已有的对象（store/memory/persona/bridge/decision），不重复状态。
 *
 * @param {object} o
 * @param {string} o.sub        去掉 /api/whale-pod 前缀后的子路径（'' 表示根）
 * @param {string} o.method
 * @param {URL} o.url
 * @param {object} o.store      ConfigStore
 * @param {object} o.memory     MemoryStore
 * @param {object} o.persona    PersonaStore
 * @param {object} o.longMemory LongTermStore
 * @param {object} o.bridge     QQBridge | null
 * @param {object} o.decision   决策层
 * @param {object} o.state      运行状态（含 usage）
 * @param {object} o.log
 * @param {Function} o.json     本文件的 JSON 响应器
 * @param {Function} o.readJson
 */
// ── QQ 桥接的动态启停 ─────────────────────────────────────────
//
// 桥接原本只在**进程启动时**按 qq.enabled 创建一次（index.js 第 459 行起），
// 运行期没有任何启停入口。侧栏的「一键开始/停止」因此只能是个装饰 ——
// 点了不生效，用户以为坏了（实测反馈）。
//
// 下面两个函数把"启动"变成可重复执行的动作：
//   1. 写 qq.enabled 到配置（重启后行为一致）
//   2. 没有实例就建一个，并真正连上 OneBot
// 停止则反过来：先断开、再拆实例，但**不删 qq.enabled 之外的配置**
// （模型/白名单/回复设置都留着，下次启动即恢复）。

/**
 * 启动 QQ 桥接（幂等：已在运行则直接返回）。
 * @returns {Promise<{ok:boolean, connected:boolean, already?:boolean, error?:string}>}
 */
/**
 * 完全启动：协议端（NapCat）+ 桥接，两个都起来才算成功。
 *
 * ## 为什么要连协议端一起管
 *
 * 只启桥接不启 NapCat，桥接会一直对着 3001 端口重连失败，日志刷满
 * "连接出错"——用户看到的是"开了但没反应"。反过来只停桥接不停 NapCat，
 * QQ 进程还挂着占内存、占端口，下次启动还可能撞端口。
 *
 * 所以「一键」就是**真的全部**：start = NapCat + 桥接，stop = 两个都关。
 *
 * @returns {Promise<{ok:boolean, connected:boolean, napcat?:boolean, error?:string}>}
 */
async function startQqBridge({ store, state, log, decision, memory, longMemory, persona, usage, llm, creds }) {
  try {
    store.update({ qq: { enabled: true } })
    const cfg = store.get()
    if (cfg.qq?.mode === 'astrbot') {
      return { ok: false, connected: false, error: 'astrbot 模式下 WhalePod 不接 OneBot，请让 AstrBot 自己连协议端' }
    }

    // ── 1. 先确保协议端在跑 ──────────────────────────────────
    // supervisor.start 是幂等的：已在运行会返回已有 pid。
    let napcat = false
    try {
      const sup = state.supervisor
      if (sup?.start) {
        const r = await sup.start('napcat')
        napcat = r?.pid !== undefined || sup.running?.('napcat') === true
        if (napcat) log.info?.('QQ：协议端已就绪')
      }
    } catch (error) {
      log.warn?.(`QQ：启动协议端失败 — ${String(error?.message ?? error)}`)
    }

    // ── 2. 已有桥接实例：只补连接 ────────────────────────────
    if (state.bridge && state.onebot) {
      try { state.onebot.connect() } catch { /* 已连接时会抛，忽略 */ }
      const snap = state.bridge.statsSnapshot?.() ?? {}
      return { ok: true, connected: snap.connected === true, napcat, already: true }
    }

    // 动态 import：避免顶层循环依赖（index.js 也 import 本模块）
    const { OneBotClient } = await import('../qq/onebot.js')
    const { QQBridge } = await import('../qq/bridge.js')

    const onebot = new OneBotClient(cfg.qq.onebot ?? {}, { log })
    const b = new QQBridge({
      cfg: {
        ...cfg.qq,
        fallback: cfg.gateway?.fallback,
        freeOrder: cfg.gateway?.freeProviders ?? [],
        disabledProviders: cfg.gateway?.disabledProviders ?? [],
        decisionAliases: cfg.decision?.aliases,
      },
      onebot,
      gateway: llm,
      decision,
      memory,
      longMemory,
      persona,
      usage,
      searchKey: (() => {
        try { return creds?.get?.('DEEPSEEK_API_KEY') ?? null } catch { return null }
      })(),
      log,
    })
    b.attach()
    onebot.connect()
    state.onebot = onebot
    state.bridge = b
    log.info?.('QQ：已通过侧栏按钮启动（协议端 + 桥接）')
    return { ok: true, connected: true, napcat, started: true }
  } catch (error) {
    log.warn?.(`QQ 启动失败：${String(error?.message ?? error)}`)
    return { ok: false, connected: false, error: String(error?.message ?? error) }
  }
}

/**
 * 完全停止：桥接 + 协议端（NapCat）都关掉，不留后台进程。
 *
 * 配置（模型/白名单/回复设置）全部保留，下次启动即恢复。
 *
 * @returns {Promise<{ok:boolean, connected:boolean, napcat?:boolean}>}
 */
async function stopQqBridge({ store, state, log }) {
  try {
    store.update({ qq: { enabled: false } })
    // QQBridge.attach() 只是往 onebot 上挂监听器，没有 detach；
    // 关掉 onebot 连接即可 —— 监听器随实例一起被丢弃，不会再收到事件。
    try { state.onebot?.close?.() } catch { /* 忽略 */ }
    state.bridge = undefined
    state.onebot = undefined

    // 协议端也要停 —— 否则 QQ 进程还挂着占内存/端口。
    let napcatStopped = false
    try {
      const sup = state.supervisor
      if (sup?.stop) {
        await sup.stop('napcat')
        napcatStopped = sup.running?.('napcat') !== true
        log.info?.('QQ：协议端已停止')
      }
    } catch (error) {
      log.warn?.(`QQ：停止协议端失败 — ${String(error?.message ?? error)}`)
    }

    log.info?.('QQ：已通过侧栏按钮完全停止（协议端 + 桥接）')
    return { ok: true, connected: false, napcat: napcatStopped, stopped: true }
  } catch (error) {
    log.warn?.(`QQ 停止失败：${String(error?.message ?? error)}`)
    return { ok: false, connected: true, error: String(error?.message ?? error) }
  }
}

async function whalePodCompat(o) {  const { sub, method, url, req, res, json, readJson, store, memory, persona, longMemory, bridge, decision, state, log, logger, protocols, llm, creds, usage } = o

  try {
    // ── 状态总览 ─────────────────────────────────────────────────
    if (sub === '/status' && method === 'GET') {
      const cfg = store.get()
      // ⚠️ 不能用 `state.bridge ?? bridge` 回退。
      //
      //    `state.bridge` 是**唯一真相**：侧栏「完全关闭」会把它置空。
      //    一旦写成 `?? bridge`，置空之后就回退到「进程启动时那次的快照」，
      //    于是关了以后 bridge 永远显示 true —— 界面据此认为"还在运行"，
      //    按钮永远停在「完全关闭」上，看起来就是"点不动"（实测反复出现）。
      //
      //    正确做法：只有 qq.enabled 为真时才认 state.bridge。
      const qqEnabled = cfg.qq?.enabled === true
      const liveBridge = qqEnabled ? state.bridge : undefined
      const stats = liveBridge?.statsSnapshot?.() ?? null
      const disabled = new Set(cfg.gateway?.disabledProviders ?? [])
      const allProviders = state.llm?.providers ?? []
      return json(res, 200, {
        ok: true,
        home: store.home,
        dataDir: store.home,
        providers: allProviders.filter((p) => !disabled.has(p)),
        qq: {
          enabled: cfg.qq?.enabled === true,
          mode: 'whale-pod',
          backend: 'napcat',
          installed: state.backends?.napcat?.installed === true ? ['napcat'] : [],
          // ⚠️ running 必须问 supervisor **进程是否活着**，不能写成
          //    "已安装"。之前是 `installed === true` —— 那是常量 true，
          //    于是「完全关闭」后界面仍显示"运行中"，按钮状态永远错乱，
          //    看起来就像"点了没反应"（实测踩过）。
          running: state.supervisor?.running?.('napcat') === true,
          bridge: Boolean(liveBridge),
          stats,
        },
        decision: { order: decision?.order ?? [], threshold: decision?.threshold ?? 0.5 },
        memory: memory?.stats?.() ?? null,
        persona: { active: persona?.active ?? null, list: persona?.list?.() ?? [] },
        gateway: {
          enabled: cfg.gateway?.enabled !== false,
          strategy: cfg.gateway?.strategy ?? 'free-first',
          host: cfg.gateway?.host ?? '127.0.0.1',
          port: cfg.gateway?.port ?? 18899,
        },
      })
    }

    // ── 配置 ─────────────────────────────────────────────────────
    if (sub === '/config' && method === 'GET') {
      const cfg = store.get()
      const clone = structuredClone(cfg)
      if (clone.gateway) clone.gateway.key = ''
      if (clone.web) clone.web.token = ''
      if (clone.qq?.onebot) clone.qq.onebot.accessToken = clone.qq.onebot.accessToken ? '***' : ''
      return json(res, 200, { ok: true, config: clone })
    }
    if (sub === '/config' && method === 'POST') {
      const patch = await readJson(req)
      // 复用主 /api/config 的热更新逻辑：写盘 + 推给 bridge
      if (patch.gateway) delete patch.gateway.key
      if (patch.web) delete patch.web.token
      // 插件契约是点分键 { 'qq.enabled': true } → 展开成嵌套
      const nested = {}
      for (const [k, v] of Object.entries(patch)) {
        const parts = k.split('.')
        let node = nested
        for (let i = 0; i < parts.length - 1; i++) {
          if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {}
          node = node[parts[i]]
        }
        node[parts[parts.length - 1]] = v
      }
      store.update(nested)
      // 同 /status：只认 state.bridge，且要求 qq.enabled 为真。
      // 已关闭时把配置推给一个死掉的旧实例毫无意义。
      const liveBridge = store.get().qq?.enabled === true ? state.bridge : undefined
      if (liveBridge && (nested.qq || nested.search)) {
        const q = store.get().qq ?? {}
        if (nested.qq) {
          if (q.allow) liveBridge.cfg.allow = { ...liveBridge.cfg.allow, ...q.allow }
          if (q.model !== undefined) liveBridge.cfg.model = q.model
          if (q.maxTokens !== undefined) liveBridge.cfg.maxTokens = q.maxTokens
          if (q.effort !== undefined) liveBridge.cfg.effort = q.effort
          if (q.reply) liveBridge.cfg.reply = { ...liveBridge.cfg.reply, ...q.reply }
        }
        // ⚠️ search.* 也必须推。
        //
        //    原来这个分支只判 `nested.qq`，于是侧栏里改「启用联网搜索」
        //    写进了配置文件但**不推给运行中的 bridge** —— 界面上开关拨了，
        //    实际还在搜（或反过来）。必须重启才生效，而用户根本不知道
        //    要重启。
        if (nested.search) {
          liveBridge.cfg.search = { ...(liveBridge.cfg.search ?? {}), ...store.get().search }
        }
      }

      // ── 决策层热更新 ──────────────────────────────────────────────
      //
      // ⚠️ 2026-10-25 补：原来改 `decision.provider` 之类**必须重启**才生效 ——
      //    设置页保存成功、提示「已保存」，行为却一点没变，用户以为坏了。
      //
      //    决策层是 createDecisionLayer() 一次性造出来的对象，挂在
      //    state.decision 上，bridge 通过它做判断。所以这里重建一个、
      //    换掉 state.decision，并让正在运行的 bridge 指向新实例。
      //
      //    为什么不重建整个 bridge：那会断 QQ 连接、丢 NapCat 子进程，
      //    只为了换个判断逻辑不值得。换引用就够了。
      if (nested.decision && decision) {
        try {
          const rebuilt = createDecisionLayer(store.get().decision ?? {}, {
            credentials: creds,
            log,
            llm,
          })
          state.decision = rebuilt
          // bridge 里保存的是同一个对象引用；直接换字段让它看到新层
          if (state.bridge) state.bridge.decision = rebuilt
          log.info(`[whale-pod] 决策层已热更新：order = [${rebuilt.order.join(' → ')}]`)
        } catch (e) {
          // 换失败不能让配置保存失败 —— 旧决策层还能用
          log.warn?.(`[whale-pod] 决策层热更新失败（继续用旧的）：${String(e?.message ?? e)}`)
        }
      }

      log.info(`[whale-pod 兼容层] 配置已更新（${Object.keys(patch).join(', ')}）`)
      return json(res, 200, { ok: true, changed: Object.keys(patch) })
    }

    // ── QQ ───────────────────────────────────────────────────────
    //
    // ⚠️ 读 **state.bridge**，不要读闭包里的 `bridge`。
    //    闭包那个是**启动时**赋值的快照：侧栏按钮把 state.bridge 清掉/重建后，
    //    闭包变量还指着旧实例 —— 于是"点了停止，状态灯还是在线"（实测踩过）。
    //    动态启停之后，state 才是唯一真相。
    if (sub === '/qq' && method === 'GET') {
      // 同 /status：只认 state.bridge，且 qq.enabled 为真。
      // 回退到闭包 bridge 会让"已关闭"的机器人一直显示在线。
      const qqOn = store.get().qq?.enabled === true
      const live = qqOn ? state.bridge : undefined
      return json(res, 200, {
        ok: true,
        enabled: qqOn,
        connected: Boolean(live) && live.statsSnapshot?.()?.connected !== false,
        stats: live?.statsSnapshot?.() ?? null,
        recent: live?.recent?.slice(-20) ?? [],
      })
    }
    if (sub === '/qq/start' && method === 'POST') {
      // 真正启动：写 qq.enabled=true，然后按需建桥接。
      //
      // ⚠️ 以前这里是**空壳**（只回 {ok:true}），点了什么都不会发生 ——
      //    用户看到的"按钮没用"就是这个原因。启停必须落到状态上：
      //      · qq.enabled 写盘（下次重启也保持）
      //      · 桥接实例真正创建 + OneBot 真正连接
      const started = await startQqBridge({ store, state, log, decision, memory, longMemory, persona, usage, llm, creds })
      return json(res, started.ok ? 200 : 500, started)
    }
    if (sub === '/qq/stop' && method === 'POST') {
      const stopped = await stopQqBridge({ store, state, log })
      return json(res, stopped.ok ? 200 : 500, stopped)
    }
    if (sub === '/qq/pause' && method === 'POST') {
      const body = await readJson(req)
      // 同 /status：只认 state.bridge（关了就是关了，不回退旧实例）
      const qqOn = store.get().qq?.enabled === true
      const live = qqOn ? state.bridge : undefined
      if (!live) return json(res, 409, { error: 'QQ 桥接未启动' })
      live.paused = body.paused === true
      return json(res, 200, { ok: true, paused: live.paused })
    }

    // ── 协议端（NapCat）──────────────────────────────────────────
    if (sub === '/backends' && method === 'GET') {
      const installedMap = state.backends ?? {}
      const info = installedMap.napcat ?? {}
      // webui 信息（token 从 webui.json 读 —— 复用 protocols.webInfo）
      let webui = null
      try {
        const { webInfo } = await import('../qq/protocol.js')
        const w = webInfo(store.home, 'napcat')
        if (w) {
          webui = {
            url: w.url,
            hasToken: w.token !== null,
            autoLoginUrl: w.token === null ? null : `${w.url}${w.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(w.token)}`,
          }
        }
      } catch { /* ignore */ }
      return json(res, 200, {
        ok: true,
        installed: info.installed === true ? ['napcat'] : [],
        status: state.supervisor?.status?.() ?? {},
        running: state.supervisor?.running?.('napcat') === true,
        installing: state.installing ?? null,
        webui,
      })
    }
    if (sub === '/backends/start' && method === 'POST') {
      if (!state.supervisor) return json(res, 400, { error: '协议端控制不可用' })
      // 启动前把最新 OneBot 配置同步给托管器：用户可能在设置页改了 ws
      // 地址/端口，而 supervisor 里那份是装配时的快照。
      try { state.supervisor.oneBot = store.get().qq?.onebot ?? {} } catch { /* ignore */ }
      const r = state.supervisor.start('napcat')
      log.info(`[whale-pod 兼容层] NapCat 已启动（pid ${r?.pid ?? '?'}）`)
      return json(res, 200, { ok: true, result: r })
    }
    if (sub === '/backends/stop' && method === 'POST') {
      if (!state.supervisor) return json(res, 400, { error: '协议端控制不可用' })
      await state.supervisor.stop('napcat')
      return json(res, 200, { ok: true })
    }
    if (sub === '/backends/logs' && method === 'GET') {
      const n = Math.min(500, Math.max(1, Number(url.searchParams.get('n') ?? 200) || 200))
      return json(res, 200, { ok: true, lines: state.supervisor?.logs?.('napcat', n) ?? [] })
    }
    if (sub === '/backends/install' && method === 'POST') {
      const body = await readJson(req)
      // 许可确认由 DSH 插件侧完成（它有确认弹窗），这里直接执行。
      if (state.installing) return json(res, 409, { error: `已有安装任务在进行：${state.installing}` })
      state.installing = 'napcat'
      state.installLog = state.installLog ?? []
      const pushLog = (m) => {
        state.installLog.push({ at: Date.now(), text: String(m) })
        if (state.installLog.length > 300) state.installLog.shift()
        log.info(`[whale-pod 兼容层][安装 napcat] ${m}`)
      }
      const { installBackend } = await import('../qq/protocol.js')
      installBackend({ backendId: 'napcat', home: store.home, onProgress: pushLog })
        .then((r) => {
          state.installResult = r
          state.backends = protocols.detectInstalled(store.home)
          pushLog('安装完成')
        })
        .catch((e) => {
          state.installError = String(e?.message ?? e)
          pushLog(`安装失败：${state.installError}`)
        })
        .finally(() => { state.installing = null })
      return json(res, 202, { ok: true, started: 'napcat' })
    }
    if (sub === '/backends/progress' && method === 'GET') {
      return json(res, 200, {
        installing: state.installing ?? null,
        log: (state.installLog ?? []).slice(-80),
        result: state.installResult ?? null,
        error: state.installError ?? null,
      })
    }
    if (sub === '/backends/webui' && method === 'GET') {
      const { webInfo } = await import('../qq/protocol.js')
      const w = webInfo(store.home, 'napcat')
      if (!w) return json(res, 404, { error: '该协议端没有管理面板' })
      return json(res, 200, {
        ok: true,
        url: w.url,
        token: w.token,
        autoLoginUrl: w.token === null ? null : `${w.url}${w.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(w.token)}`,
      })
    }

    // ── 记忆 ─────────────────────────────────────────────────────
    if (sub === '/memory' && method === 'GET') {
      // ⚠️ 2026-10-25 修：原来只回 `scopes`（字符串数组），
      //    但前端 MemorySection 读的是 `row.scope` / `row.messages` ——
      //    对字符串取 `.scope` 得到 undefined，界面显示「undefined 条消息」，
      //    看着像记忆功能没生效（实际 2 个会话 17 条消息都在）。
      //
      //    现在回 `scopeDetails`（对象数组，带消息数）。
      //    `scopes` 保留原样 —— 别的地方可能还在用，别破坏兼容。
      const details = memory?.scopeDetails?.() ?? null
      return json(res, 200, {
        ok: true,
        stats: memory?.stats?.() ?? null,
        scopes: memory?.scopes?.() ?? [],
        // 前端用这个渲染列表（带每条会话的消息数）
        scopeDetails: details ?? (memory?.scopes?.() ?? []).map((s) => ({ scope: s, messages: 0 })),
        longMemory: longMemory?.stats?.() ?? null,
        // 长期摘要的会话列表（前端 longs 读这个）
        longScopes: longMemory?.listScopes?.() ?? [],
      })
    }
    if (sub === '/memory' && method === 'DELETE') {
      const scope = url.searchParams.get('scope') ?? undefined
      memory?.clear?.(scope)
      if (scope === undefined) longMemory?.clear?.()
      else longMemory?.clear?.(scope)
      return json(res, 200, { ok: true, cleared: scope ?? 'all' })
    }
    if (sub === '/memory/summary' && method === 'GET') {
      const scope = url.searchParams.get('scope') ?? ''
      if (!scope) return json(res, 400, { error: '缺少 scope' })
      const mem = longMemory?.get?.(scope)
      return json(res, 200, { ok: true, scope, summary: mem?.summary ?? null, summarizedCount: mem?.summarizedCount ?? 0, updatedAt: mem?.updatedAt ?? null })
    }

    // ── 人格 ─────────────────────────────────────────────────────
    if (sub === '/persona' && method === 'GET') {
      const name = url.searchParams.get('name') ?? undefined
      return json(res, 200, {
        ok: true,
        active: persona?.active ?? null,
        list: persona?.list?.() ?? [],
        // detailed 带中文展示名、是否内置、是否被用户改过 ——
        // UI 用人话列角色，而不是把 default/quiet/plain 这些 id 直接摆出来
        detailed: persona?.listDetailed?.() ?? [],
        content: persona?.read?.(name ?? undefined) ?? null,
      })
    }
    if (sub === '/persona' && method === 'POST') {
      const body = await readJson(req)
      const action = String(body.action ?? 'activate')
      const list = persona?.list?.() ?? []
      if (action === 'create' || action === 'save') {
        const name = String(body.name ?? '').trim()
        if (!name || /\s|[/\\]/.test(name)) return json(res, 400, { error: '名字不能为空，且不能含空格或路径分隔符' })
        if (action === 'create' && list.includes(name)) return json(res, 400, { error: `人格已存在：${name}` })
        if (action === 'save' && !list.includes(name)) return json(res, 400, { error: `人格不存在：${name}` })
        persona?.write?.(name, String(body.content ?? ''))
        log.info(`[whale-pod 兼容层] 人格已${action === 'create' ? '创建' : '保存'} ${name}`)
        return json(res, 200, { ok: true })
      }
      if (action === 'restore') {
        // 把被改过的内置角色恢复成出厂内容
        const name = String(body.name ?? '').trim()
        if (!name) return json(res, 400, { error: '缺少 name' })
        try {
          persona?.restore?.(name)
          log.info(`[whale-pod 兼容层] 人格已恢复内置版 ${name}`)
          return json(res, 200, { ok: true })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      }
      if (action === 'remove') {
        const name = String(body.name ?? '').trim()
        if (name === 'default') return json(res, 400, { error: 'default 人格不能删除' })
        if (name === persona?.active) return json(res, 400, { error: '不能删除当前使用中的人格' })
        persona?.remove?.(name)
        return json(res, 200, { ok: true })
      }
      const name = String(body.active ?? '')
      if (!name || !list.includes(name)) return json(res, 400, { error: `人格不存在：${name}` })
      persona?.setActive?.(name)
      store.update({ persona: { active: name } })
      return json(res, 200, { ok: true, active: name })
    }

    // ── 决策 ─────────────────────────────────────────────────────
    if (sub === '/decision/probe' && method === 'GET') {
      if (typeof decision?.probeAll !== 'function') return json(res, 200, { ok: true, providers: [] })
      const result = await decision.probeAll()
      return json(res, 200, { ok: true, providers: result?.providers ?? [] })
    }

    // ── 用量 ─────────────────────────────────────────────────────
    if (sub === '/usage' && method === 'GET') {
      const usage = state.usage?.snapshot?.() ?? null
      return json(res, 200, { ok: true, usage })
    }

    // ── 模型与渠道优先级（侧栏模型卡片）────────────────────────────
    //
    // 与 /api/models 返回**同一份形状**，只是省掉了逐个模型的目录
    // （侧栏只需要"渠道 + 顺序 + 是否可用"，不需要模型清单 —— 那份
    //  可能有上百条，4 秒轮询一次太重）。
    //
    // 顺序算法与 /api/models 完全一致（applyFreeOrder + 启用优先分区），
    // 否则侧栏显示的顺序会和实际路由不一致 —— 那是最容易误导人的 bug。
    if (sub === '/models' && method === 'GET') {
      const cfg = store.get()
      const providers = llm?.providers ?? []
      const selfIds = state.selfChannelIds ?? []
      const freeRegistered = providers.filter((x) => !selfIds.includes(x))
      const selfRegistered = providers.filter((x) => selfIds.includes(x))
      const configured = cfg.gateway?.freeProviders ?? []
      const disabled = cfg.gateway?.disabledProviders ?? []

      let effectiveOrder
      const mentionedSelf = configured.filter((p) => selfRegistered.includes(p))
      if (mentionedSelf.length > 0) {
        const out = []
        for (const p of configured) {
          if (freeRegistered.includes(p) || selfRegistered.includes(p)) out.push(p)
        }
        for (const p of freeRegistered) if (!out.includes(p)) out.push(p)
        for (const p of selfRegistered) if (!out.includes(p)) out.push(p)
        effectiveOrder = out
      } else {
        effectiveOrder = applyFreeOrder(freeRegistered, configured).concat(selfRegistered)
      }
      // 启用中的上移、被关闭的下沉（仅展示顺序，不写回配置）
      effectiveOrder = [
        ...effectiveOrder.filter((p) => !disabled.includes(p)),
        ...effectiveOrder.filter((p) => disabled.includes(p)),
      ]

      // 「没有已知模型」的渠道在 auto 下会被跳过 —— 与 router 的
      // firstModelOf() 用完全相同的三个来源，否则会误报。
      const known = new Set([
        ...Object.keys(PROVIDER_MODEL_HINTS).filter((k) => (PROVIDER_MODEL_HINTS[k] ?? []).length > 0),
        ...Object.keys(llm?.defaultModels?.() ?? {}),
        ...((llm?.catalog ?? []).map((m) => m.provider).filter(Boolean)),
      ])

      // 账号数：0 个账号的渠道在 auto 下**必然失败**（没有凭据可发请求）。
      //
      // 渠道卡片上标的「未接入」就是这个意思，但侧栏以前不显示，
      // 于是列表里混着一堆点了也白搭的渠道，用户以为能切过去。
      // 这里把真实账号数带出来，前端默认只显示有账号的。
      //
      // ⚠️ 只读本地账号池，**不**触发网络探测 —— 侧栏每 15 秒拉一次，
      //    不能让它去打十几个上游。
      const accountCount = {}
      try {
        // accountPool 由 channel-pack 用 ctx.provide('accountPool') 挂上，
        // 不是 state 的字段 —— 从 llm.ctx 取（llm-core 返回的 llm 带 ctx 引用时）
        // 或退回 state（若将来改成挂 state）。
        const pool = state.accountPool ?? llm?.accountPool ?? llm?.ctx?.accountPool
        if (pool?.listAccounts) {
          for (const p of effectiveOrder) {
            // ⚠️ 内置渠道（deepseek-official / deepseek-account）**不走账号池** ——
            //    它们用 API Key 或 OAuth，账号池里当然查不到。查不到时 listAccounts
            //    返回空数组，若当成"0 个账号"就会被隐藏掉，兜底渠道凭空消失。
            //    这类渠道标记成 undefined（未知），让前端保留它们。
            if (BUILTIN_PROVIDERS.has(p)) { accountCount[p] = undefined; continue }
            try {
              const list = await pool.listAccounts(p)
              accountCount[p] = Array.isArray(list) ? list.length : 0
            } catch { accountCount[p] = -1 }  // -1 = 查不到，别当成 0
          }
        }
      } catch { /* 账号池不可用就不填，前端按"未知"处理 */ }

      const orderDetail = effectiveOrder.map((p) => ({
        provider: p,
        usable: known.has(p),
        enabled: !disabled.includes(p),
        // 该渠道有几个账号；undefined 表示查不到（自备渠道/内置渠道）
        accounts: accountCount[p],
        /**
         * 渠道种类，UI 用来区分显示：
         *   builtin —— DSH 内置（deepseek-official 走 API Key、deepseek-account 走 OAuth）
         *   channel —— channel-pack 的账号型白嫖渠道
         */
        kind: BUILTIN_PROVIDERS.has(p) ? 'builtin' : 'channel',
        /**
         * 内置渠道用的凭据 ref 是否已配置。
         * deepseek-official 不查账号池（它没有"账号"），所以必须单独看
         * DEEPSEEK_API_KEY 有没有值 —— 否则界面上它跟已就绪的渠道长得一样，
         * 点下去才发现"未配置凭据"。
         */
        credentialReady: BUILTIN_PROVIDERS.has(p) ? builtinCredentialReady(p, creds) : undefined,
        reason: known.has(p) ? null : '该渠道没有已知模型名，auto 模式会跳过',
        needsProxy: NEEDS_PROXY[p] ?? null,
      }))

      // 每个渠道的模型清单（供侧栏的下拉框用）。
      //
      // 只给**有账号或账号数未知**的渠道 —— 没账号的渠道选了也必然失败，
      // 列出来只会让人误以为能切过去。
      // 模型来源：优先内置 hints（静态、不依赖网络），再补 catalog。
      const modelsByProvider = {}
      const catalog = llm?.catalog ?? []
      for (const p of effectiveOrder) {
        const n = accountCount[p]
        if (n === 0) continue   // 明确没有账号 → 不列
        const fromHint = PROVIDER_MODEL_HINTS[p] ?? []
        const fromCatalog = catalog.filter((m) => m.provider === p).map((m) => m.id ?? m.model).filter(Boolean)
        const list = [...new Set([...fromHint, ...fromCatalog])]
        if (list.length > 0) modelsByProvider[p] = list
      }

      // 模型清单：前端按 `group` 分标签、按 `label` 显示渠道给的名称、
      // 按 `efforts` 渲染推理等级下拉。
      //
      // ⚠️ 这里必须返回**完整条目**，不能只给 modelsByProvider（那只是
      //    渠道→名字的映射，缺 group/label/efforts，前端标签页会全是空的）。
      //    与主路由 /api/models 保持同一形状，只是不带 vision 等侧栏用不到的字段。
      const models = []
      for (const p of effectiveOrder) {
        const n = accountCount[p]
        if (n === 0) continue           // 没账号 → 选了必失败，不列
        let list = []
        try { list = await llm?.listModels?.(p) ?? [] } catch { list = [] }
        // 目录不可用时退回内置 hints（冷启动那几秒）
        if (list.length === 0) {
          list = (PROVIDER_MODEL_HINTS[p] ?? []).map((id) => ({ id, name: id }))
        }
        for (const m of list) {
          // 视觉能力：判定方式与主路由 /api/models 完全一致
          // （LlmModelInfo.inputModalities 里有没有 'image'）。
          // 'yes' 明确支持 / 'no' 明确不支持 / 'unknown' 渠道没上报。
          const mods = m.inputModalities ?? m.raw?.inputModalities
          let vision = 'unknown'
          if (Array.isArray(mods) && mods.length > 0) vision = mods.includes('image') ? 'yes' : 'no'
          models.push({
            id: m.id ?? m.model,
            provider: p,
            label: m.name ?? m.label ?? null,
            group: modelGroupOf({ provider: p, raw: m }),
            vision,
            efforts: [],
            effortDefault: null,
          })
        }
      }

      // 推理等级：按渠道批量取（见 effortsByProvider 的说明）
      const effortMap = await effortsByProvider(llm, [...new Set(models.map((m) => m.provider))])
      for (const m of models) {
        const hit = effortMap[m.provider]
        m.efforts = hit?.efforts ?? []
        m.effortDefault = hit?.effortDefault ?? null
      }

      return json(res, 200, {
        ok: true,
        settings: {
          strategy: cfg.gateway?.strategy ?? 'free-first',
          freeOrder: configured,
          disabledProviders: disabled,
          qqModel: cfg.qq?.model ?? 'auto',
          maxTokens: cfg.qq?.maxTokens ?? 0,
          effort: cfg.qq?.effort ?? '',
        },
        defaultOrder: effectiveOrder,
        orderDetail,
        models,
        count: models.length,
        modelsByProvider,
        latency: state.latency ?? [],
        enabledCount: orderDetail.filter((d) => d.enabled).length,
      })
    }

    // ── 修改模型设置（侧栏的排序 / 开关 / 换模型）──────────────────
    if (sub === '/models/settings' && method === 'POST') {
      const body = await readJson(req)
      const patch = {}
      if (Array.isArray(body.freeOrder)) {
        patch.gateway = { ...(patch.gateway ?? {}), freeProviders: body.freeOrder.map(String) }
      }
      if (Array.isArray(body.disabledProviders)) {
        const next = body.disabledProviders.map(String)
        const prev = store.get().gateway?.disabledProviders ?? []
        const opened = prev.filter((p) => !next.includes(p))
        if (opened.length > 0) {
          if (!state.userEnabled) state.userEnabled = new Set()
          for (const p of opened) state.userEnabled.add(p)
        }
        for (const p of next) state.userEnabled?.delete(p)
        patch.gateway = { ...(patch.gateway ?? {}), disabledProviders: next }
      }
      if (typeof body.qqModel === 'string') {
        patch.qq = { ...(patch.qq ?? {}), model: body.qqModel }
      }
      // 推理等级：空串表示"用模型默认"，此时清掉字段而不是存空串
      // （bridge 读 effort 时按 undefined 走默认逻辑）。
      if (typeof body.effort === 'string') {
        patch.qq = { ...(patch.qq ?? {}), effort: body.effort === '' ? undefined : body.effort }
      }
      if (typeof body.strategy === 'string') {
        patch.gateway = { ...(patch.gateway ?? {}), strategy: body.strategy }
      }
      if (Object.keys(patch).length === 0) return json(res, 400, { error: '没有可更新的字段' })
      store.update(patch)
      log.info?.('Web（兼容层）：模型设置已更新 ' + JSON.stringify(patch))
      // 路由策略与顺序每次请求现读，qq.model 由 bridge 每次生成时读 —— 都立即生效
      return json(res, 200, { ok: true, applied: Object.keys(patch), needRestart: false })
    }

    // ── 日志 ─────────────────────────────────────────────────────
    if (sub === '/logs' && method === 'GET') {
      // logger 是旧版 Logger 实例（ring 缓冲），recent(n) 返回 [{t,level,msg}]
      const raw = logger?.recent?.(200) ?? []
      return json(res, 200, {
        ok: true,
        lines: raw.map((e) => ({ at: e.t ?? Date.now(), level: e.level ?? 'info', message: e.msg ?? String(e) })),
      })
    }

    return json(res, 404, { error: `whale-pod 兼容层未知路由：${method} ${sub}` })
  } catch (err) {
    log.warn?.(`[whale-pod 兼容层] ${method} ${sub} 失败 — ${String(err?.message ?? err)}`)
    if (!res.headersSent) json(res, 400, { error: String(err?.message ?? err) })
  }
}

validateClientJs()
