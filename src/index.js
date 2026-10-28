/**
 * WhalePod 主入口：组装所有层并启动。
 *
 * 启动顺序（有依赖关系，不能乱）：
 *   1. 配置       ← 其它层都读它
 *   2. 日志       ← 配置里有 level
 *   3. 凭据       ← 网关和决策层都要
 *   4. LLM 网关核心 ← 装载 channel-pack（14 渠道）
 *   5. 决策层     ← 独立于 LLM，但共享凭据与日志
 *   6. HTTP 服务  ← 暴露 OpenAI 兼容端点
 *   7. Web UI     ← 管理界面
 *   8. 托盘       ← 可选；失败不影响核心功能
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { ConfigStore } from './config/store.js'
import { Credentials } from './config/credentials.js'
import { Logger } from './logger.js'
import { findDshAppDir, findChannelPack, linkDshModules, createLlmGateway } from './gateway/llm-core.js'
import { createGatewayServer, mintKey } from './gateway/server.js'
import { UsageTracker } from './gateway/usage.js'
import { ActivityTracker } from './gateway/activity.js'
import { resolveCandidates, openFirstAvailable, DEFAULT_FREE_ORDER } from './gateway/router.js'
import { createDecisionLayer } from './decision/index.js'
import { createWebServer } from './web/server.js'
import { MemoryStore } from './memory/short.js'
import { LongTermStore } from './memory/long.js'
import { DayPlanStore } from './memory/dayPlan.js'
import { PeopleStore } from './memory/person.js'
import { PersonaStore } from './persona/store.js'
import { OneBotClient } from './qq/onebot.js'
import { QQBridge } from './qq/bridge.js'
import * as protocols from './qq/protocol.js'
import { ProtocolSupervisor, detectInstalled } from './qq/protocol.js'
import * as runtime from './qq/runtime.js'
import * as modes from './qq/modes.js'
import { MODES, astrbotGatewayHint } from './qq/modes.js'
import { createFallbackLlm } from './gateway/fallback.js'
import { createAttachmentSupport } from './gateway/attachment.js'
import { discoverDshProviders, resolveChannelKey } from './gateway/dsh-providers.js'

/**
 * 把「DSH 渠道」和「自备渠道」合成一个 llm 对象。
 *
 * 为什么要合：router 只看 `llm.stream()` 与 `llm.listProviders()`。
 * 只要这两个方法能同时覆盖两边的 provider，上层（网关 / QQ / 决策）
 * 就完全不用改 —— 融合发生在这一个点上。
 *
 * 优先级：DSH 免费渠道优先（省钱），自备渠道作为候补与兜底。
 * `stream()` 按 provider 归属派发，所以同名也不会串。
 */
function mergeLlm(core, extra, log) {
  const coreProviders = () => {
    try { return (core.providers ?? []).slice() } catch { return [] }
  }
  const extraProviders = () => extra.listProviders()

  return {
    __merged: true,
    /** 暴露原始对象，便于调试与状态页展示。 */
    __core: core,
    __extra: extra,

    get providers() {
      return [...coreProviders(), ...extraProviders()]
    },

    /** provider → 默认模型（router 的 auto 模式需要它认识自备渠道）。 */
    defaultModels() {
      return { ...(core.defaultModels?.() ?? {}), ...(extra.defaultModels?.() ?? {}) }
    },

    get catalog() {
      return core.catalog ?? []
    },

    listProviders() {
      return this.providers
    },

    listModels(o = {}) {
      const p = o?.provider
      if (p && extraProviders().includes(p)) return extra.listModels(o)
      return core.llm?.listModels?.(o) ?? []
    },

    refreshCatalog(o) {
      return core.refreshCatalog?.(o) ?? Promise.resolve([])
    },

    /**
     * 按 provider 归属派发流。
     *
     * 注意：必须**原样返回**底层迭代器（不能包一层 async generator），
     * 因为 router 的 takeFirst() 会手动调 it.return() 来放弃失败的候选 ——
     * 中间多一层会让那个清理动作落不到真正的流上。
     */
    stream(o = {}) {
      const p = o?.provider
      if (p && extraProviders().includes(p)) return extra.stream(o)
      if (!core.llm?.stream) {
        // DSH 侧不可用时的兜底（例如 core 起来了但 llm 服务缺失）
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'DSH 渠道不可用' } } }
        })()
      }
      return core.llm.stream(o)
    },

    close() {
      try { core.close?.() } catch { /* ignore */ }
    },
  }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

/**
 * 等 OneBot 端点就绪再连接。
 *
 * 为什么需要：NapCat 刚被拉起来时，它的 OneBot 端口要几秒才监听。
 * 立刻 connect() 会失败一轮、打出一堆"连接出错"警告，看起来像坏了。
 * 这里只做**一次**等待（不是轮询重连 —— 那由 OneBotClient 自己负责）。
 *
 * @param {object} onebotCfg
 * @param {object} log
 * @param {number} [timeoutMs]
 */
async function waitForOneBot(onebotCfg, log, timeoutMs = 20000) {
  const mode = onebotCfg.mode ?? 'forward'
  if (mode !== 'forward' && mode !== 'both') return     // 反向模式是我们自己监听，不用等
  const wsUrl = onebotCfg.wsUrl
  if (!wsUrl) return

  let port = 0
  try { port = Number(new URL(wsUrl).port) || (wsUrl.startsWith('wss') ? 443 : 80) } catch { return }
  const host = (() => { try { return new URL(wsUrl).hostname } catch { return '127.0.0.1' } })()

  const net = await import('node:net')
  const deadline = Date.now() + timeoutMs
  let waited = false
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ host, port })
      const done = (v) => { try { sock.destroy() } catch { /* ignore */ } resolve(v) }
      sock.setTimeout(1200, () => done(false))
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
    })
    if (ok) {
      if (waited) log.info(`QQ：协议端已就绪（${host}:${port}）`)
      return
    }
    if (!waited) { log.info(`QQ：等待协议端就绪（${host}:${port}）…`); waited = true }
    await new Promise((r) => setTimeout(r, 700))
  }
  log.warn(`QQ：等协议端超时（${host}:${port} 一直没监听）—— 仍尝试连接，会自动重连`)
}


/** 解析命令行参数（只做必要的最小集合）。 */
function parseArgs(argv) {
  const out = { home: undefined, port: undefined, webPort: undefined, noWeb: false, noTray: false, dshApp: undefined, profile: undefined, daemon: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--home') out.home = next()
    else if (a === '--port') out.port = Number(next())
    else if (a === '--web-port') out.webPort = Number(next())
    else if (a === '--no-web') out.noWeb = true
    else if (a === '--no-tray') out.noTray = true
    else if (a === '--dsh-app') out.dshApp = next()
    else if (a === '--profile') out.profile = next()
    else if (a === '--daemon') out.daemon = true
    // 由外部宿主托管（DSH 插件）。与 --daemon 的区别：
    // 不启用父进程监控 —— 宿主的 pid 会变，监控会误杀自己。
    else if (a === '--hosted') out.hosted = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const HELP = `
WhalePod —— QQ 机器人运行时 + 免费优先的 LLM 网关

用法： whale-pod [选项]

选项：
  --home <dir>       数据目录（默认 ~/.whale-pod）
  --port <n>         LLM 网关端口（默认 18899）
  --web-port <n>     管理界面端口（默认 18898）
  --no-web           不启动管理界面
  --no-tray          不创建托盘图标
  --dsh-app <dir>    DSH 安装目录（默认自动探测）
  --profile <name>   使用哪个 DSH profile 的 channel-pack
  -h, --help         显示本帮助
`.trim()

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) { console.log(HELP); return { code: 0 } }

  // ── 1. 配置 ─────────────────────────────────────────────────
  const store = new ConfigStore({ home: args.home })
  store.load()
  const overrides = {}
  if (args.port) overrides.gateway = { ...(overrides.gateway ?? {}), port: args.port }
  if (args.webPort) overrides.web = { ...(overrides.web ?? {}), port: args.webPort }
  if (Object.keys(overrides).length) store.update(overrides)

  // 首次启动生成密钥
  store.ensureSecrets(mintKey)
  const cfg = store.get()

  // ── 2. 日志 ─────────────────────────────────────────────────
  const logger = new Logger({
    level: cfg.log?.level ?? 'info',
    ringSize: cfg.log?.ringSize ?? 2000,
    file: path.join(store.home, 'whale-pod.log'),
  })
  const log = logger.api
  log.info(`WhalePod 启动（数据目录 ${store.home}）`)

  const shutdown = []
  const state = {
    startedAt: Date.now(),
    gateway: null,
    web: null,
    llm: null,
    decision: null,
    usage: null,
    people: null,
    tray: null,
    errors: [],
  }

  try {
    // ── 3. 凭据 ───────────────────────────────────────────────
    const creds = new Credentials({
      mode: cfg.credentials?.mode ?? 'overlay',
    })
    const refCount = creds.listRefs().length
    log.info(`凭据：${refCount} 个 ref（源 ${creds.file}，模式 ${creds.mode}）`)
    if (creds.load().dshMissing) {
      log.warn('未找到 DSH 凭据文件 —— 免费渠道可能全部不可用')
    }

    // ── 4. LLM 网关核心 ───────────────────────────────────────
    //
    // 两条来源，可叠加：
    //
    //   ① DSH 的 channel-pack —— 14 个免费渠道（有 DSH 才有）
    //   ② 自备渠道           —— 用户自己填的 OpenAI 兼容端点（Ollama/DeepSeek/…）
    //
    // 少了 ① 不该让程序起不来 —— 那样没有 DSH 的用户就完全用不了。
    // 所以这里把「找不到 DSH」降级成警告：能用自备渠道就继续跑，
    // 两个都没有才报错（因为那时确实没法回话）。
    const appDir = findDshAppDir(args.dshApp)
    const pack = appDir ? findChannelPack({ profile: args.profile }) : null
    // 记录到 state —— Web UI（渠道页 / 总览）靠这两个字段判断
    // "到底有没有 DSH"。漏掉会导致界面同时显示"14 个渠道"和"没检测到 DSH"。
    state.dshAppDir = appDir ?? null
    state.dshPack = pack ?? null
    state.profile = pack?.profile ?? null
    const selfChannels = (cfg.gateway?.channels ?? []).filter((c) => c && c.enabled !== false && c.baseUrl)

    // ── 自动发现 DSH 设置里的模型提供商 ─────────────────────────
    //
    // 用户在 DSH「设置 → 模型」里已经配好了 Magpie / DeepSeek 等提供商，
    // 这些配置落在 profiles/<name>/cordis.patch.yml 的 llm-pi-ai.providers。
    // 与其让他在 WhalePod 里再手抄一遍 baseUrl / apiKey / 模型列表，
    // 不如直接读过来 —— 「DSH 里配了什么，WhalePod 就能用什么」。
    //
    // ⚠️ 手填的 gateway.channels **优先**：用户显式配置的意图要尊重。
    //    自动发现的只在 id 不冲突时补进来，作为兜底。
    let discovered = []
    try {
      const r = await discoverDshProviders({
        dshHome: process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'),
        profile: args.profile ?? 'desktop',
        appDir,
        log: (lv, msg) => log[lv]?.(msg),
      })
      discovered = r.channels ?? []
      if (discovered.length > 0) {
        state.dshProvidersFile = r.file
        state.dshProvidersSource = r.source
        log.info(`从 DSH 设置发现 ${discovered.length} 个提供商（${discovered.map((c) => c.id).join(', ')}）`)
      }
    } catch (e) {
      // 读不到不是错误 —— DSH 没装 / 配置没写过都很正常
      log.warn(`读取 DSH 提供商配置失败（不影响手填渠道）：${String(e?.message ?? e)}`)
    }

    // 合并：手填优先，自动发现的补空位
    const seenIds = new Set(selfChannels.map((c) => c.id))
    const autoChannels = discovered
      .filter((c) => !seenIds.has(c.id))
      .map((c) => {
        // apiKeyEnv 只是变量名，真值要从凭据服务取
        const key = resolveChannelKey(c, creds)
        return key ? { ...c, apiKey: key } : c
      })
    const allChannels = [...selfChannels, ...autoChannels]
    // 记到 state，Web UI 的渠道页要显示「这个渠道是怎么来的」
    state.autoChannels = autoChannels.map((c) => c.id)

    const fallbackLlm = allChannels.length > 0
      ? createFallbackLlm({
        channels: allChannels,
        log: (lv, msg) => log[lv]?.(msg),
      })
      : null

    if (appDir && pack) {
      log.info(`DSH：${appDir}`)
      log.info(`channel-pack：${pack.profile} profile`)
    } else {
      // 找不到宿主渠道包不是错误 —— WhalePod 自己就能跑，只要用户配了供应商。
      // 这里只说清楚「能用什么」，不暗示用户去装别的东西。
      log.info('LLM：使用内置 DeepSeek 账户凭证 + 自定义供应商')
      if (allChannels.length > 0) {
        const parts = []
        if (selfChannels.length > 0) parts.push(`手填 ${selfChannels.length} 个（${selfChannels.map((c) => c.id).join(', ')}）`)
        if (autoChannels.length > 0) parts.push(`DSH 自动发现 ${autoChannels.length} 个（${autoChannels.map((c) => c.id).join(', ')}）`)
        log.warn(`可用渠道：${parts.join(' + ')}`)
      } else {
        log.warn('还没有配置供应商 → 请在「配置」页填入 DeepSeek API Key，或添加一个 OpenAI 兼容端点。')
      }
    }

    let llm
    // 用量统计：网关 HTTP 调用与 QQ 内部调用**都**记到这里，
    // 否则总览页的 token/费用永远是 0（QQ 才是真正烧 token 的地方）。
    //
    // ⚠️ 传 home 让它落盘到 <home>/usage.json —— 原来只用内存，
    //    每次重启归零，用户看到的是「昨天用了 24K，今天一开变 0」。
    const usage = new UsageTracker({ home: store.home })
    // 活跃天数：数「真正有消息往来的日子」，关机那几天不算。
    // 和 usage.startedAt（首次启动至今）是两回事。
    const activity = new ActivityTracker({ home: store.home })
    if (appDir && pack) {
      linkDshModules(appDir, projectRoot)
      const core = await createLlmGateway({ appDir, packFile: pack.file, credentials: creds, log })
      // 有自备渠道时叠加进去：让 router 能同时看到 DSH 渠道与自备渠道
      llm = fallbackLlm ? mergeLlm(core, fallbackLlm, log) : core
      // 账号池挂在 cordis ctx 上（channel-pack 用 ctx.provide('accountPool')）。
      // 存进 state 供 Web 层查「某渠道有几个账号」—— 侧栏用它隐藏未接入渠道。
      // 不放在 llm 上是因为 mergeLlm 只搬运 llm 相关字段，ctx 会被丢掉。
      state.accountPool = core.ctx?.accountPool ?? null
      // 后台刷新一次模型目录（不阻塞启动；失败不影响核心功能）
      core.refreshCatalog().then((cat) => {
        log.info(`模型目录：${cat.length} 个`)
      }).catch((e) => log.warn(`模型目录刷新失败：${String(e?.message ?? e)}`))
    } else {
      if (!fallbackLlm) {
        throw new Error(
          '没有可用的 LLM 渠道。两种方式任选其一：\n' +
          '  1. 使用内置的 DeepSeek 账户凭证（在「配置」页填入你自己的 DeepSeek API Key）\n' +
          '  2. 添加自定义供应商（任何 OpenAI 兼容端点，如 Ollama / DeepSeek / 自建服务）',
        )
      }
      llm = fallbackLlm
      log.info(`LLM：仅用自备渠道（${selfChannels.map((c) => c.id).join(', ')}）`)

      // ── 多模态：给自备渠道也挂上 attachment ──────────────────────
      //
      // ⚠️ 2026-10-25 修。原来 makeImageBlock 只在 createLlmGateway()
      //    里定义，而那个函数只有**找到 channel-pack** 时才调用
      //    （上面的 if (appDir && pack)）。于是走自备渠道的人
      //    （比如 magpie）完全用不了图片，日志只说
      //    「attachment 服务不可用，图片降级为文字」—— 看着像 DSH 装坏了。
      //
      //    实际上 attachmentStore 只依赖 appDir + dshHome，
      //    跟 channel-pack 毫无关系。所以这里独立挂一份。
      if (appDir && typeof llm.makeImageBlock !== 'function') {
        try {
          const att = await createAttachmentSupport({
            appDir,
            ctx: { },
            dshHome: process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'),
            log: (lv, msg) => log[lv]?.(msg),
          })
          if (att.makeImageBlock) {
            llm.makeImageBlock = att.makeImageBlock
            state.attachmentStore = att.attachmentStore
            log.info('LLM：自备渠道已支持图片（多模态）')
          }
        } catch (e) {
          log.warn?.(`LLM：挂载 attachment 失败（图片会降级成文字）：${String(e?.message ?? e)}`)
        }
      }
      // ⚠️ 无 DSH 时，配置里那条默认付费兜底（deepseek-official）是个幽灵：
      //    它排在自备渠道后面却被当成有效候选，失败信息还会盖住真正的原因。
      //    这里在启动时把它关掉，只用用户显式配置的渠道。
      if (cfg.gateway?.fallback?.enabled) {
        store.update({ gateway: { fallback: { ...cfg.gateway.fallback, enabled: false } } })
        log.warn('已自动禁用付费兜底（deepseek-official 需要 DSH 凭据，当前不可用）')
        cfg.gateway.fallback.enabled = false
      }
    }
    state.llm = llm
    state.usage = usage
    state.activity = activity
    // ⚠️ people 在下面才创建（LongTermStore 之后），所以这里不能直接用。
    // 赋值和定时器都挪到 people 定义之后了。
    // 记录**启动时**实际装载的自备渠道 id。Web UI 靠它区分"自备渠道"与
    // "DSH 免费渠道"—— 必须用快照而不是当前配置，否则配置改动后
    // （要重启才生效）会把已删的渠道误判成 DSH 渠道。
    state.selfChannelIds = selfChannels.map((c) => c.id)
    shutdown.push(() => llm.close?.())

    // ── 4b. 免费渠道优先顺序 ──────────────────────────────────
    //
    // 首次运行时配置里是空数组。如果不填，顺序就等于 channel-pack 的
    // **注册顺序**（codearts 打头，验证过最稳的 gemini 排到第 12）——
    // 实测这样会让前面十几个没配 model hint 的渠道白白空转。
    //
    // 所以首次启动把 DEFAULT_FREE_ORDER 落成显式配置：
    //   · 用户下次打开「模型」页就能看到真实顺序，可自行调整
    //   · 之后启动都按这份配置走，不会每次重算
    // 已有配置的用户不受影响（只在为空时写一次）。
    if (!cfg.gateway.freeProviders?.length) {
      const all = llm.providers ?? []
      const wanted = DEFAULT_FREE_ORDER.filter((p) => all.includes(p))
      if (wanted.length > 0) {
        store.update({ gateway: { freeProviders: wanted } })
        cfg.gateway.freeProviders = wanted
        log.info(`免费渠道优先级已初始化为默认顺序：${wanted.slice(0, 4).join(' → ')} …`)
      }
    }

    // ── 5. 决策层 ─────────────────────────────────────────────
    const decision = createDecisionLayer(cfg.decision ?? {}, {
      credentials: creds,
      log,
      // 模型自主判断要用它。没传的话 provider 会在 probe() 里报「没有 LLM」
      // 并降级到 rule，不会让启动失败。
      llm,
    })
    state.decision = decision
    log.info(`决策层：order = [${decision.order.join(' → ')}]，阈值 ${decision.threshold}`)
    // 启动时探一次可用性，把问题尽早暴露在日志里
    decision.probeAll().then((r) => {
      for (const p of r.providers) {
        log[p.ok ? 'info' : 'warn'](`决策提供者 ${p.id}：${p.ok ? '可用' : '不可用'} — ${p.detail}`)
      }
    }).catch(() => { })

    // ── 7. 记忆 + 人格 ────────────────────────────────────────
    /*
     * 短期记忆也落盘（memory-short.json）。
     *
     * 原来它是纯内存的，重启即清零 —— 调试期间重启频繁时，
     * 「我刚说了要去吃饭」这种当下状态会丢，用户体感就是断片。
     * `dir` 跟长期记忆用同一个配置（`memory.dir`），留空则跟 home。
     */
    const memoryDir = typeof cfg.memory?.dir === 'string' && cfg.memory.dir.trim()
      ? cfg.memory.dir.trim()
      : store.home
    const memory = new MemoryStore({
      ...(cfg.memory?.short ?? {}),
      dir: memoryDir,
      log,
    })
    memory.load()
    log.info(`短期记忆：${memory.file ? `落盘于 ${memory.file}` : '纯内存（未配置目录）'}`)
    const persona = new PersonaStore({
      home: store.home,
      active: cfg.persona?.active ?? 'default',
      log,
    })
    persona.init()
    log.info(`人格：当前角色 "${persona.active}"（可选 ${persona.list().join(', ')}）`)

    // 长期记忆：摘要用便宜模型做（复用网关）
    const longMemory = new LongTermStore({
      cfg: cfg.memory?.long ?? {},
      home: store.home,
      // 记忆可以单独放别处（memory.dir 为空时跟着 home）
      dir: cfg.memory?.dir,
      log,
      summarize: async ({ messages, previous, scene, self }) => {
        const { SUMMARY_PROMPT } = await import('./memory/long.js')
        /*
         * ⚠️ 每条消息必须带上**QQ 号**（2026-10-28 修，用户报「老是记小事」）。
         *
         * 原来只写 `昵称: 文本` —— 而 SUMMARY_PROMPT 要求【人】段按
         * `QQ号 | 昵称 | 一句话印象` 输出。模型**物理上拿不到 QQ 号**，
         * 于是干脆整段不写【人】。后果连锁：
         *   ① 人像机制整个失效（长期记忆里一条【人】都没有）
         *   ② merge() 见不到【人】→ 走「整段替换」→ 旧印象被冲掉
         *   ③ 于是「记住人」退化成「记最近聊了什么」→ 满屏琐事
         *
         * 昵称会变、也可能重名，**QQ 号才是稳定标识**（这也是 parsePeople
         * 靠 `match(/(\d{4,12})/)` 认人的原因）。
         */
        const prompt = SUMMARY_PROMPT
          .replace('{previous}', previous || '（无）')
          .replace('{messages}', messages.map((m) => (
            m.isMe
              ? `[我]${m.senderName ? `(${m.senderName})` : ''}: ${m.text}`
              : `${m.senderName}(${m.sender}): ${m.text}`
          )).join('\n'))

        const candidates = resolveCandidates('auto', {
          freeProviders: llm.providers,
          freeOrder: cfg.gateway?.freeProviders ?? [],
          disabledProviders: cfg.gateway?.disabledProviders ?? [],
          catalog: llm.catalog,
          selfModels: llm.defaultModels?.() ?? {},
          fallback: cfg.gateway?.fallback,
        })
        if (candidates.length === 0) return ''
        const opened = await openFirstAvailable({
          llm,
          candidates,
          /*
           * content 用数组块（与 bridge 保持一致）。纯文本时字符串也能跑，
           * 但一旦某条消息带图，上游会遍历所有消息调 content.some(...)，
           * 字符串会直接抛错 —— 统一用数组块就不用记这个坑。
           *
           * ⚠️ **不要传 maxTokens**（2026-10-28 实测，用户报「老是记小事」）。
           *
           * 原来写的是 `maxTokens: 512`，而当前模型（deepseek-v4.1-flash）
           * 是**推理模型**：它先输出一大段 reasoning，再写正文。512 token
           * 会被推理**吃光**，正文是空的，实测：
           *
           *   max_tokens=512  → finish_reason=stop，completion=512，
           *                     reasoning 1536 字，**content = null**
           *   max_tokens=2000 → reasoning 588 字，content 234 字，格式正常
           *
           * 正文为空会被 `maybeSummarize` 判成「没拿到摘要」直接丢掉 ——
           * 长期记忆于是长期不更新。
           *
           * 这也是 bridge.js 里早记下的经验：**maxTokens 不传 = 不限制，
           * 让上游用自己的上限，反而最快且正文正常。**
           */
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
          onAttempt: () => { },
        })
        let text = ''
        for await (const chunk of opened.stream) {
          if (chunk?.type === 'text-delta' || chunk?.type === 'text') text += chunk.text ?? ''
        }
        return text.trim()
      },
    })

  /*
   * 今日状态：每天一份日程（几点起、三餐、在干嘛、心情）。
   *
   * 抄自 X 上大肥鱼的做法 —— 作者说这是「活人感」最大来源。
   * 没有它时，别人问「在干嘛」模型只能现编，而且同一天里
   * 对不同的人会编出互相矛盾的答案（「刚吃完午饭」又说「还没吃」）。
   */
  const dayPlan = new DayPlanStore({ dir: memoryDir, log }).load()
    longMemory.load()

    // 人物档案：按 QQ 号认人。跨会话共享。
    const people = new PeopleStore({ home: store.home })
    state.people = people

    /*
     * 人物档案落盘。
     *
     * `touch()` 只改内存并标脏 —— 每条消息都写文件太浪费
     * （群聊一波能刷几十条）。这里 30 秒收一次，脏了才真写。
     *
     * ⚠️ 这个定时器必须放在 `people` 定义之后。放在前面会
     *    `Cannot access 'people' before initialization` —— 启动直接失败。
     */
    const peopleTimer = setInterval(() => people.flush(), 30_000)
    peopleTimer.unref?.()
    shutdown.push(() => {
      clearInterval(peopleTimer)
      people.save()
    })

    /**
     * ⚠️ 启动时校验长期记忆配置（2026-10-23 加）。
     *
     * `summarizeAfter` 必须**小于** `short.maxMessages`，否则摘要永远不会触发：
     * 判断依据是「距上次摘要新增了多少条」，而短期窗口本身有上限，
     * 攒不到阈值。原来是 `summarizeAfter: 200` + 窗口 `30`，
     * 结果 `memory-long.json` 从来没生成过，用户只觉得「记忆没生效」。
     *
     * 这类配置死锁**不会报错、只会静默失效**，所以必须在启动时喊出来。
     */
    if (longMemory.enabled) {
      const win = Number(cfg.memory?.short?.maxMessages ?? 30)
      const after = Number(longMemory.summarizeAfter)
      if (after >= win) {
        log.warn(
          `记忆：长期记忆的 summarizeAfter=${after} 不小于短期窗口 maxMessages=${win}，` +
          `摘要将**永远不会触发**。建议把 summarizeAfter 调到 ${Math.max(1, Math.floor(win * 0.6))} 左右。`,
        )
      } else {
        log.info(`记忆：长期记忆已启用（每 ${after} 条摘要一次，窗口 ${win} 条）`)
      }
    } else {
      log.info('记忆：长期记忆未启用 —— 超出短期窗口（30 条）的对话不会被记住')
    }

    state.memory = memory
    state.persona = persona
    state.longMemory = longMemory

    // ── 8. 协议端托管 + 运行模式 ──────────────────────────────
    //
    // 运行模式决定「谁当机器人框架」：
    //   whale-pod —— WhalePod 自己接 OneBot（下面第 9 步）
    //   astrbot  —— AstrBot 接 OneBot，WhalePod 退为纯 LLM 网关
    // 两者**不能同时**接同一个 OneBot 端点，否则会抢事件。
    const supervisor = new ProtocolSupervisor({
      home: store.home,
      log,
      // NapCat 的 OneBot 端点要按 WhalePod 的配置自动写进它的账号配置
      // （否则 NapCat 不监听 3001，桥接永远连不上 —— 见 protocol.js
      //   ensureOneBotServers 的说明）
      oneBot: cfg.qq?.onebot ?? {},
    })
    state.supervisor = supervisor
    state.backends = detectInstalled(store.home)
    shutdown.push(async () => { await supervisor.stopAll() })

    const mode = cfg.qq?.mode === 'astrbot' ? 'astrbot' : 'whale-pod'
    state.mode = mode
    log.info(`运行模式：${MODES[mode]?.name ?? mode}`)

    const installed = Object.entries(state.backends)
      .filter(([, v]) => v.installed)
      .map(([k]) => k)
    log.info(`已装组件：${installed.length ? installed.join(', ') : '(无)'}`)

    // ── 9. QQ 桥接（仅 whale-pod 模式）─────────────────────────
    //
    // ⚠️ 启动协议端要放在**接 OneBot 之前**，否则第一次连接必然失败、
    //    还要等重连（用户会看到几秒"连不上"的警告）。
    //
    // 之前这里只创建了 supervisor 却从不启动任何后端 —— 于是每次重启
    // WhalePod 后 NapCat 都是死的，必须手动去组件页点「启动」。
    // 现在按配置自动拉起（supervisor.enabled 默认视为开启）。
    if (mode === 'whale-pod' && cfg.qq?.enabled === true) {
      const supCfg = cfg.qq?.supervisor ?? {}
      const wantKind = supCfg.kind ?? 'napcat'
      const installedOk = state.backends?.[wantKind]?.installed === true
      // supervisor.enabled 显式为 false 才跳过（老配置里没有这个字段）
      if (supCfg.enabled !== false && installedOk && !supervisor.running(wantKind)) {
        try {
          const r = supervisor.start(wantKind)
          log.info(`协议端：已自动启动 ${wantKind}（pid ${r.pid}）`)
        } catch (e) {
          log.warn(`协议端：自动启动 ${wantKind} 失败 — ${String(e?.message ?? e)}`)
        }
      } else if (supCfg.enabled !== false && !installedOk) {
        log.info(`协议端：${wantKind} 未安装，跳过自动启动`)
      }
    }

    if (cfg.qq?.enabled === true && mode === 'astrbot') {
      log.info('QQ：astrbot 模式 —— WhalePod 不接 OneBot，请让 AstrBot 连协议端')
      const hint = astrbotGatewayHint(cfg.gateway)
      log.info(`QQ：把 AstrBot 的 API 地址指向 ${hint.apiBase}`)
    } else if (cfg.qq?.enabled === true) {
      const onebot = new OneBotClient(cfg.qq.onebot ?? {}, { log })
      /**
   * 生成「今天」的日程（JSON）。
   *
   * 抄自 X 上大肥鱼 —— 每天一次，要求平平常常、具体、有一两件小事，
   * 并参考前几天避免重样。结果存进 DayPlanStore，一整天都用它回答
   * 「在干嘛 / 吃了吗」。
   *
   * ⚠️ 失败返回 null（不影响聊天）—— 那天就没有今日状态，
   *    模型回到「现编」的老样子，但至少不会崩。
   */
  const generateDayPlan = async ({ recent = [] } = {}) => {
    try {
      const { buildDayPlanPrompt, parseDayPlan } = await import('./memory/dayPlan.js')
      const prompt = buildDayPlanPrompt({
        selfName: cfg.persona?.name ?? '蓝色大肥鱼',
        recent,
      })
      const candidates = resolveCandidates('auto', {
        freeProviders: llm.providers,
        freeOrder: cfg.gateway?.freeProviders ?? [],
        disabledProviders: cfg.gateway?.disabledProviders ?? [],
        catalog: llm.catalog,
        selfModels: llm.defaultModels?.() ?? {},
        fallback: cfg.gateway?.fallback,
      })
      if (candidates.length === 0) return null
      const opened = await openFirstAvailable({
        llm,
        candidates,
        request: { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
      })
      let out = ''
      /*
       * ⚠️ 消费方式和 summarize 保持一致（2026-10-27 修）。
       *
       * 原来这里分 type 取不同字段（'text' → chunk.text、'text-delta' →
       * chunk.textDelta），实测**拿到空串** —— 日志「日程生成：模型输出
       * 无法解析 — 」后面什么都没有。同一个网关，summarize 用
       * `chunk.text` 就好好的，说明 chunk 里的字段名和 type 不是一一对应。
       *
       * 所以统一读 `chunk.text`，不猜 type。
       */
      for await (const chunk of opened.stream) {
        if (typeof chunk === 'string') { out += chunk; continue }
        if (typeof chunk?.text === 'string') out += chunk.text
      }
      const plan = parseDayPlan(out)
      if (!plan) {
        log.warn?.('日程生成：模型输出无法解析 — ' + out.slice(0, 120))
        return null
      }
      return plan
    } catch (e) {
      log.warn?.('日程生成失败（今天没有今日状态）— ' + String(e?.message ?? e))
      return null
    }
  }
  const bridge = new QQBridge({
        cfg: {
          ...cfg.qq,
          /*
           * 主动行为的两块配置在**顶层**（不在 qq 里）——
           * 这里必须显式带上，否则 bridge.cfg.proactive 是 undefined，
           * 调度器 planSpeak 第一行就返回「发言未开启」，一次都不触发。
           */
          proactive: cfg.proactive,
          beg: cfg.beg,
          fallback: cfg.gateway?.fallback,
          // 免费渠道优先级与开关：bridge 的 auto 模式靠它们决定"先试哪个"
          freeOrder: cfg.gateway?.freeProviders ?? [],
          disabledProviders: cfg.gateway?.disabledProviders ?? [],
          // 别名（鱼/鲸鱼/白饭…）：群里叫它这些词也算在叫它
          decisionAliases: cfg.decision?.aliases,
        },
        onebot,
        gateway: llm,
        decision,
        memory,
        longMemory,
    dayPlan,
    generateDayPlan,
        persona,
        people,
        usage,
        activity,
        // 联网搜索用 DeepSeek 的 key（没有就自动跳过搜索，不影响其它功能）
        searchKey: (() => {
          try { return creds.get('DEEPSEEK_API_KEY') ?? null } catch { return null }
        })(),
        // 讨钱状态落盘：「每天最多 3 次」必须跨重启有效，
        // 否则重启一次就重置，等于没有限制。
        begFile: path.join(store.home, 'beg.json'),
        // 谁最近跟它说话最多 —— 讨钱要 @ 的人。开机时从磁盘恢复。
        interactions: (() => {
          try {
            const f = path.join(store.home, 'interactions.json')
            if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
          } catch { /* 读坏了就从空开始 */ }
          return []
        })(),
        log,
      })
      bridge.attach()
      // NapCat 是刚拉起来的，OneBot 端口要几秒才开。直接连会先失败一轮、
      // 打出一堆"连接出错"的警告，看起来像坏了。等端口就绪再连（最多 20s）。
      await waitForOneBot(cfg.qq.onebot ?? {}, log)
      onebot.connect()
      state.onebot = onebot
      state.bridge = bridge
      shutdown.push(async () => { onebot.close() })

      /*
       * 主动行为调度器（讨钱 + 空闲发言）。
       *
       * 两者各有独立开关：
       *   · `beg.enabled`       —— 定期查余额，低了主动讨
       *   · `proactive.enabled` —— 群安静够久就自己冒泡
       *
       * 关掉就完全不启动对应逻辑（调度器内部也会再判一次配置）。
       */
      try {
        bridge.startProactive({
          home: store.home,
          fs,
          memoryOf: (scope) => memory.get(scope),
          // 白名单为空（allowAllWhenEmpty）时，主动发言要靠「实际有记录的会话」
          // 来枚举可发言目标 —— 否则永远拿不到 scope，一次都不会触发。
          //
          // 两个来源合并：短期（内存，重启清零）+ 长期（落盘，重启仍在）。
          // 只靠短期的话，重启后一个会话都没有，主动发言永远不触发。
          scopesSource: () => {
            const out = new Set()
            try {
              for (const s of memory.scopes?.() ?? []) out.add(String(s))
            } catch { /* ignore */ }
            try {
              for (const s of longMemory.scopes?.() ?? []) out.add(String(s))
            } catch { /* ignore */ }
            return [...out]
          },
        })
        shutdown.push(() => bridge.stopProactive())
      } catch (e) {
        log.warn?.(`主动行为调度器启动失败（不影响其它功能）：${String(e?.message ?? e)}`)
      }
      // 保存「谁最近跟它说话最多」—— 不存的话每次重启都从零开始，
      // 讨钱就永远 @ 不到人（7 天窗口内攒的互动全丢了）。
      shutdown.push(() => {
        try {
          const f = path.join(store.home, 'interactions.json')
          fs.writeFileSync(f, JSON.stringify(bridge._interactions.toJSON(), null, 2), 'utf8')
        } catch (e) {
          log.warn?.(`保存互动统计失败（不影响退出）：${String(e?.message ?? e)}`)
        }
      })
      const dir = cfg.qq.onebot?.mode ?? 'forward'
      log.info(`QQ：已启用（${dir} 模式，${cfg.qq.onebot?.wsUrl || cfg.qq.onebot?.reversePort || '未配置地址'}）`)
      if (!cfg.qq.allow?.groups?.length && !cfg.qq.allow?.private?.length) {
        // ⚠️ 这里必须**真的读** allowAllWhenEmpty，不能想当然。
        //    老代码只要白名单为空就固定打 "allowAllWhenEmpty=false —— 不会响应
        //    任何消息"，而配置明明是 true —— 日志在撒谎，用户据此以为机器人
        //    坏了（实测被这条误导过）。实际拦截逻辑在 bridge.js，它读的是真值。
        if (cfg.qq.allow?.allowAllWhenEmpty === true) {
          log.warn('QQ：白名单为空，但 allowAllWhenEmpty=true —— 会响应所有人（如需收紧请在设置里加白名单）')
        } else {
          log.warn('QQ：白名单为空且 allowAllWhenEmpty=false —— 不会响应任何消息（这是 fail-closed 默认值）')
        }
      }
    } else {
      log.info('QQ：未启用（qq.enabled = false）')
    }

    // ── 10. LLM 网关 HTTP ─────────────────────────────────────
    if (cfg.gateway?.enabled !== false) {
      const gw = createGatewayServer({
        gateway: cfg.gateway, llm, log, usage,
        // 网关侧也支持联网（外部工具问时效性问题时用），与 QQ 侧同一套判断
        searchKey: (() => {
          try { return creds.get('DEEPSEEK_API_KEY') ?? null } catch { return null }
        })(),
      })
      await gw.listen()
      state.gateway = gw
      shutdown.push(() => gw.close())
      log.info(`LLM 网关：http://${cfg.gateway.host}:${cfg.gateway.port}/v1`)
      log.info(`网关 key：${cfg.gateway.key}`)
      if (mode === 'astrbot') {
        log.info(`→ AstrBot 里把 API Base 填：http://${cfg.gateway.host}:${cfg.gateway.port}/v1`)
      }
    } else {
      log.info('LLM 网关已禁用')
    }

    // ── 11. 管理 Web UI ───────────────────────────────────────
    if (!args.noWeb && cfg.web?.enabled !== false) {
      const web = createWebServer({
        web: cfg.web,
        store,
        logger,
        llm,
        decision,
        credentials: creds,
        memory,
        persona,
        longMemory,
        bridge: state.bridge,
        state,
        log,
        protocols,
        runtime,
        modes,
      })
      await web.listen()
      state.web = web
      shutdown.push(() => web.close())
      log.info(`管理界面：http://${cfg.web.host}:${cfg.web.port}?token=${cfg.web.token}`)
    }

    // ── 11. 托盘（可选）───────────────────────────────────────
    // --daemon 模式：被 dsh-whale-pod 插件的守护器拉起，无托盘、无独立窗口。
    // 管理 UI 保留（Web 端口照常服务）—— DSH 插件通过它透传全部功能。
    if (!args.noTray && !args.daemon) {
      try {
        const { createTray } = await import('./tray/index.js')
        state.tray = await createTray({
          log,
          onQuit: () => doShutdown('托盘退出'),
          onOpenWeb: () => {
            const url = `http://${cfg.web.host}:${cfg.web.port}?token=${cfg.web.token}`
            log.info(`请在浏览器打开：${url}`)
          },
          status: () => ({
            gateway: state.gateway ? `${cfg.gateway.host}:${cfg.gateway.port}` : null,
            web: state.web ? `${cfg.web.host}:${cfg.web.port}` : null,
            providers: state.llm?.providers?.length ?? 0,
            qq: state.bridge?.statsSnapshot?.()?.connected ? 'connected' : 'off',
          }),
        })
        if (state.tray) log.info('托盘图标已创建')
      } catch (e) {
        log.warn(`托盘不可用（不影响运行）：${String(e?.message ?? e)}`)
      }
    }

    log.info('WhalePod 就绪')

    // ── 优雅退出 ──────────────────────────────────────────────
    let shuttingDown = false
    async function doShutdown(reason) {
      if (shuttingDown) return
      shuttingDown = true
      log.info(`正在关闭（${reason}）…`)
      for (const fn of shutdown.reverse()) {
        try { await fn() } catch { /* ignore */ }
      }
      logger.close()
      process.exit(0)
    }

    process.on('SIGINT', () => doShutdown('SIGINT'))
    process.on('SIGTERM', () => doShutdown('SIGTERM'))
    if (process.platform === 'win32') {
      process.on('SIGBREAK', () => doShutdown('SIGBREAK'))
    }

    // ── 宿主存活监控（父进程没了就优雅关闭）──────────────────────
    //
    // ## 背景：为什么靠插件钩子不行
    //
    // 宿主（DSH Desktop）退出时**不保证**执行插件的 dispose —— 实测
    // 2026-10-18 连续多次重启，`ctx.effect` 注册的清理函数一次都没触发
    // （宿主日志里连一行都没有）。而宿主退出本身有 5s 超时强杀：
    //
    //     function createDesktopShutdown(dispose, exit, timeoutMs = 5e3) {
    //       timeout = setTimeout(() => exitOnce(failureCode), timeoutMs)
    //       pending = Promise.resolve().then(dispose).then(() => exitOnce(code))
    //     }
    //
    // ## 现在的主防线是 detached: false
    //
    // 插件侧已改成 `detached: false`（见 plugin/daemon.js），本进程是宿主的
    // **普通子进程**。宿主以任何方式退出，Windows 都会连带结束整棵进程树 ——
    // 这条路径不依赖任何代码，是最可靠的。
    //
    // ## 这段监控的作用是「双保险 + 体面退出」
    //
    // 进程树被系统直接杀掉时，我们是**没机会写日志、也没机会让 NapCat
    // 优雅停止**的（它会被一起 taskkill）。有了这段监控，在大多数情况下
    // （宿主正常退出、或子进程没被立刻清理时）我们能自己发现问题，
    // 走一遍 `doShutdown()` —— 那样日志里能看到「正在关闭」，
    // NapCat 也能按正常流程停下，而不是被强杀。
    //
    // ⚠️ 只在 `--daemon` 模式下启用：手动 `node src/index.js` 时父进程
    //    是终端，关掉终端不该顺带关掉机器人。
    //
    // ⚠️ `--hosted` 时**完全不启用**。这是给 DSH 插件用的模式。
    //
    //    实测踩过（2026-10-19，反复复现）：DSH 重启后，插件宿主是新的
    //    子进程；后端记录下的 `process.ppid` 指向那个宿主，而宿主在
    //    插件重载/DSH 重启时会被替换 —— 旧的 pid 消失，我们误判成
    //    "宿主退出了"，于是**自己杀掉自己**。
    //    表现：日志显示启动成功、已登录 QQ，2 秒后进程没了，
    //    而且**没有任何"正在关闭"的记录**（走的是 doShutdown，
    //    但日志已经来不及刷盘）；用户看到的是"刷新一下偶尔变成未启用"。
    //
    //    在 DSH 下这个监控本来也是多余的，已有两层保护：
    //      ① spawn 用 detached:false → DSH 真退出时 Windows 连带杀掉整棵树
    //      ② 插件 ctx.effect 清理钩子 → killDaemonSync() 同步收尾
    //    所以 --hosted 时直接跳过。
    //
    // ⚠️ 也可以用 WHALE_POD_NO_PARENT_WATCH=1 手动关（调试用）。
    const parentWatchDisabled =
      args.hosted === true ||
      process.env.WHALE_POD_NO_PARENT_WATCH === '1'
    if (args.daemon && process.ppid > 0 && !parentWatchDisabled) {
      const parentPid = process.ppid
      const intervalMs = 3000
      // 连续 3 次探测失败才动手 —— 避免瞬时抖动（比如宿主在做 GC、
      // 或者进程正在被替换）导致误杀自己。
      let missCount = 0
      log.info(`宿主监控：父进程 pid ${parentPid}，每 ${intervalMs / 1000}s 检查一次`)

      const parentAlive = () => {
        try {
          // 信号 0 不发送信号，只做存在性探测；进程不存在时抛 ESRCH
          process.kill(parentPid, 0)
          return true
        } catch (error) {
          // EPERM = 进程存在但没权限（不是真正的「已退出」）
          return error?.code === 'EPERM'
        }
      }

      const parentTimer = setInterval(() => {
        if (shuttingDown) { clearInterval(parentTimer); return }
        if (parentAlive()) { missCount = 0; return }
        // 连续 3 次探测不到才认「已退出」（约 9 秒）。
        // 实测踩过：单次探测失败就自杀太激进 —— 宿主在做 GC、
        // 或者进程正在被替换的瞬间都会读到 ESRCH，结果后端莫名其妙退出。
        missCount++
        if (missCount < 3) {
          log.warn?.(`宿主监控：父进程暂不可达（${missCount}/3），继续观察`)
          return
        }
        clearInterval(parentTimer)
        void doShutdown(`宿主进程 ${parentPid} 已退出`)
      }, intervalMs)
      // unref：这个定时器不该单方面把进程留住
      parentTimer.unref?.()
      shutdown.push(() => clearInterval(parentTimer))
    }

    return { store, logger, state, shutdown: doShutdown }
  } catch (err) {
    log.error(`启动失败：${String(err?.message ?? err)}`)
    if (err?.stack) log.debug(String(err.stack).split('\n').slice(1, 5).join('\n'))
    for (const fn of shutdown.reverse()) {
      try { await fn() } catch { /* ignore */ }
    }
    return { code: 1, error: err }
  }
}

// 直接运行时才执行（被 import 时不执行）
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('index.js')) {
  const r = await main()
  if (r?.code) process.exit(r.code)
  // 保持进程存活（HTTP 服务会让它活着）
}
