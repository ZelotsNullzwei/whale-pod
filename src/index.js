/**
 * WhalePod 主入口：组装所有层并启动。
 *
 * 启动顺序（有依赖关系，不能乱）：
 *   1. 配置       ← 其它层都读它
 *   2. 日志       ← 配置里有 level
 *   3. 凭据       ← 网关和决策层都要
 *   4. LLM 网关核心 ← 自备渠道（手填 / DSH 发现 / 内置官方凭证）
 *                      ⚠️ 2026-11-02 之前这里还装 DSH 的 channel-pack
 *                      （14 个免费渠道），已按用户决定整个拆掉
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
import { findDshResources } from './gateway/dsh-appdir.js'
import { resolveImportableDshDir } from './gateway/dsh-modules.js'
import { createGatewayServer, mintKey } from './gateway/server.js'
import { UsageTracker } from './gateway/usage.js'
import { ActivityTracker } from './gateway/activity.js'
import { resolveCandidates, openFirstAvailable } from './gateway/router.js'
import { createDecisionLayer } from './decision/index.js'
import { createWebServer } from './web/server.js'
import { MemoryStore } from './memory/short.js'
import { LongTermStore } from './memory/long.js'
import { EventStore, EXTRACT_PROMPT } from './memory/events.js'
import { DayPlanStore } from './memory/dayPlan.js'
// 衣柜可编辑层（2026-11-06）：数据目录的 wardrobe.json 覆盖内置预设
import { configureWardrobe } from './memory/wardrobe.js'
import { HotTopicStore } from './qq/hot-topics.js'
import { SearchQuota } from './gateway/search.js'
// 峰谷节奏：峰期收紧搜索（"峰谷"按 DeepSeek 官网口径算，见该文件头）
import { SearchPacing } from './gateway/pacing.js'
import { PeopleStore } from './memory/person.js'
import { StickerTagStore } from './qq/sticker-tags.js'
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
  --profile <name>   使用哪个 DSH profile 的设置（读里面的模型提供商）
  -h, --help         显示本帮助
`.trim()

export async function main(argv = process.argv.slice(2)) {
  /*
   * ★★ **第一件事：让国内站点绕过系统代理**（2026-11-02）。
   *
   * ## 必须放在最前面
   * Node 的 fetch 会在**第一次调用时**建好 dispatcher（`EnvHttpProxyAgent`），
   * 建好之后**再改环境变量就无效了** —— 实测：进程跑起来再删 `https_proxy`，
   * 照样 ECONNREFUSED。所以只能在这儿、在任何网络请求之前做。
   *
   * ## 治的是什么
   * 本机装了代理软件（Clash 之类），关掉之后 `HTTP_PROXY=127.0.0.1:7890`
   * 还留在环境变量里。于是**所有 fetch 都往一个死端口上撞**：
   * ```
   * 贴吧订阅：明日方舟 取失败 — fetch failed
   * 热点：取失败 — tieba: fetch failed / bilibili: fetch failed
   * B 站：短链 b23.tv 解不出 BV 号 → 「本鱼这边放不出来」
   * ```
   * 而**裸 TCP 连 bilibili.com:443 是通的** —— 国内站根本不需要代理。
   *
   * 修法：把国内域名追加进 `no_proxy`（undici 认这个），代理挂了也不连带它们。
   * 外网（需要翻墙的）照旧走代理，不受影响。
   *
   * ⚠️ NapCat 那边是另一条路 —— 它是子进程，继承同一份环境变量，
   *    所以在 `protocol.js` spawn 时**剔除**代理变量（见那里的注释）。
   *    两处都做了，这一整类故障才算堵住。
   */
  try {
    const { applyDomesticBypass, probeProxy } = await import('./net/proxy.js')
    const r = applyDomesticBypass()
    if (r.applied) {
      // 探一下代理活没活 —— 挂了就在日志里吼一声，别让人再靠猜
      const p = await probeProxy()
      if (p.configured && p.ok === false) {
        console.warn(`[启动] ⚠️ 代理 ${p.target} 连不上（关了代理软件但环境变量还在？）`
          + ` —— 国内站点已改直连，需要翻墙的功能会失败`)
      }
    }
  } catch { /* 代理兜底失败不该拦住启动 */ }

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
    // 不给就用 Logger 的默认（5MB / 保留 5 份）。0 = 关掉轮转。
    maxBytes: cfg.log?.maxBytes,
    keep: cfg.log?.keep,
  })
  const log = logger.api
  /*
   * ⚠️ 启动行带上 **pid**。
   *
   * 那条日志**不轮转**（今天之前）也不按时间排 —— 同一条 `T16:11:42`
   * 可能是半年前的记录，我为此**误报过一次"有第二个机器人在抢连接"**。
   * 带上 pid 之后，"这几行是不是同一次运行写的"一眼可辨，不用再靠猜时间戳。
   */
  log.info(`WhalePod 启动（pid ${process.pid}，数据目录 ${store.home}）`)

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
      log.warn('未找到 DSH 凭据文件 —— 内置官方渠道（DEEPSEEK_API_KEY）会挂不上')
    }

    // ── 4. LLM 网关核心 ───────────────────────────────────────
    //
    // 两条来源，可叠加：
    //
    //   ★ 2026-11-02：**只剩②了**。①（DSH 的 channel-pack，那 14 个免费渠道）
    //     已按用户决定整个拆掉 ——「不用了，现在就用 magpie，算是自备渠道」。
    //     现在渠道只有三种来源，都在下面 `allChannels` 里：
    //       手填 gateway.channels / DSH 设置自动发现 / 内置官方凭证
    //
    // 一个渠道都没有时才报错（那时确实没法回话）。
    /*
     * ★ 2026-11-02：改成找 **resources**（两种布局都认）。
     *
     * 旧版只找 `<安装>/resources/app/`（普通目录）。DSH 升级后变成了
     * `<安装>/resources/app.asar`（一个 190MB 的包）→ 返回 null →
     * **图片支持整段被跳过、一个字都不打**。
     *
     * 现在 `findDshResources()` 同时给出 `appDir`（旧布局）和 `asar`（新布局）。
     */
    const dshRes = findDshResources(args.dshApp)
    const appDir = dshRes.appDir
    if (dshRes.asar) log.info(`DSH：检测到 asar 布局（${dshRes.asar}）—— 需要 import 的包会按需提取`)
    state.dshAppDir = appDir ?? dshRes.resources ?? null
    state.dshAsar = dshRes.asar ?? null
    const selfChannels = (cfg.gateway?.channels ?? []).filter((c) => c && c.enabled !== false && c.baseUrl)

    /*
     * ── 内置官方渠道（DeepSeek 官方 API Key）────────────────────
     *
     * 用户要求：「初始渠道只留官方默认的那条 api key」。
     *
     * ## 为什么必须在这里补一条
     * `deepseek-official` 原来**只由 `createLlmGateway()` 挂载**
     * （见 `gateway/llm-core.js` 的「4b. 装 DSH 内置渠道」），
     * 而那条路要求 `appDir && pack` —— **没装 channel-pack 的机器走不到**。
     *
     * 实测本机（2026-11-02）：`findChannelPack()` 返回 `null`，
     * 启动日志只有「可用渠道：DSH 自动发现 1 个（magpie）」，
     * 官方那条**不在任何渠道列表里** → "只留官方默认"等于**一个渠道都没有**。
     *
     * 所以这里直接从凭据取 `DEEPSEEK_API_KEY` 拼成一条标准 OpenAI 兼容渠道，
     * 交给下面的 `createFallbackLlm`。**没有 key 就不加** ——
     * 不制造"渠道在列表里但永远用不了"的假象。
     *
     * ## 为什么排最后
     * 它是**付费**通道，原来的定位就是"付费兜底"（llm-core.js 原话）。
     * 排前面会把你现在用的免费渠道挤掉，等于悄悄涨价。
     * 顺序：手填 > DSH 自动发现 > 内置官方。
     */
    const officialChannels = []
    if (!selfChannels.some((c) => c.id === 'deepseek-official')) {
      const officialKey = resolveChannelKey({ apiKeyEnv: 'DEEPSEEK_API_KEY' }, creds)
      if (officialKey) {
        officialChannels.push({
          id: 'deepseek-official',
          label: 'DeepSeek 官方（内置凭证）',
          kind: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: officialKey,
          /*
           * ⚠️ **模型名必须用这个端点真实存在的**（2026-11-02 实测）。
           * `/v1/models` 只返回两个：
           *   deepseek-flash     DeepSeek-V4.1-Flash   ctx=1048576
           *   deepseek-v4-pro    DeepSeek-V4-Pro       ctx=1048576
           * 原来这里写 `deepseek-chat`（那是老 DeepSeek 开放平台的 id）——
           * 写错了这个渠道就是废的：每次调用 404，而列表里看着"有渠道"。
           */
          models: ['deepseek-flash', 'deepseek-v4-pro'],
          model: 'deepseek-flash',
          // 界面据此显示「内置」标签、并且不给删（删了 key 还在，没意义）
          builtin: true,
        })
      }
    }

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
    const allChannels = [...selfChannels, ...autoChannels, ...officialChannels]
    // 记到 state，Web UI 的渠道页要显示「这个渠道是怎么来的」
    state.autoChannels = autoChannels.map((c) => c.id)
    state.officialChannels = officialChannels.map((c) => c.id)
    /*
     * ★ **完整对象也存一份**（2026-11-02）。
     *
     * 只存 id 不够 —— 渠道页要能把**三类渠道平铺成一张表**：
     *   手填（可编辑可删）/ DSH 自动发现 / 内置官方
     * 用户的原话：「magpie 其实算自定义渠道吧」—— 对，
     * 它就是一条 OpenAI 兼容渠道，只是来源是自动发现。
     * 所以界面上不该分成两套概念，只有 `source` 不同。
     */
    state.selfChannelList = selfChannels
    state.autoChannelList = autoChannels
    state.officialChannelList = officialChannels
    // 渠道总数（不含关掉的）—— 总览页「可用渠道」那张卡用它
    state.channelCount = allChannels.length

    const fallbackLlm = allChannels.length > 0
      ? createFallbackLlm({
        channels: allChannels,
        log: (lv, msg) => log[lv]?.(msg),
      })
      : null

    // 渠道包已拆（2026-11-02），这里只说清「能用什么」，
    // 不暗示用户去装别的东西。
    if (appDir) log.info(`DSH：${appDir}`)
    log.info('LLM：使用内置 DeepSeek 账户凭证 + 自定义供应商')
    if (allChannels.length > 0) {
      const parts = []
      if (selfChannels.length > 0) parts.push(`手填 ${selfChannels.length} 个（${selfChannels.map((c) => c.id).join(', ')}）`)
      if (autoChannels.length > 0) parts.push(`DSH 自动发现 ${autoChannels.length} 个（${autoChannels.map((c) => c.id).join(', ')}）`)
      if (officialChannels.length > 0) parts.push(`内置官方 ${officialChannels.length} 个（${officialChannels.map((c) => c.id).join(', ')}）`)
      log.warn(`可用渠道：${parts.join(' + ')}`)
    } else {
      log.warn(
        '还没有可用的渠道。两种方式任选其一：\n'
        + '  1. 在「配置」页填入 DeepSeek 官方 API Key（会自动挂成 deepseek-official）\n'
        + '  2. 在「模型」页添加一个渠道 —— 任何 OpenAI 兼容端点都行，'
        + '本地模型选 Ollama 预置（http://127.0.0.1:11434/v1，不用 key）',
      )
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
    /*
     * ★ **只有一条路了：自备渠道**（2026-11-02 拆掉 channel-pack）。
     *
     * 原来这里是个 `if (appDir && pack)` 分支：
     *   · 装了 DSH 渠道包 → `createLlmGateway()`（那 14 个免费渠道）
     *   · 没装 → 自备渠道
     *
     * 用户的决定：「**不用了，现在就用 magpie，算是自备渠道**」
     * （那 14 个渠道本身也是基于外部东西堆起来的）。
     *
     * 所以 pack 分支整个删掉。现在渠道只有三种来源，全在 `allChannels` 里：
     *   手填 `gateway.channels` / DSH 设置自动发现 / 内置官方凭证
     *
     * ⚠️ 被删掉的还有 `mergeLlm(core, fallbackLlm)` —— 那是"DSH 渠道 +
     *    自备渠道"两条路都要，现在只剩一条，不需要合并。
     */
    if (!fallbackLlm) {
      throw new Error(
        '没有可用的 LLM 渠道。两种方式任选其一：\n' +
        '  1. 在「配置」页填入你自己的 DeepSeek API Key（会自动挂成 deepseek-official）\n' +
        '  2. 在「模型」页添加一个渠道 —— 任何 OpenAI 兼容端点都行，'
        + '本地模型选 Ollama 预置（http://127.0.0.1:11434/v1，不用 key）',
      )
    }
    llm = fallbackLlm
    log.info(`LLM：仅用自备渠道（${selfChannels.map((c) => c.id).join(', ')}）`)

    {
      // ── 多模态：给自备渠道挂上 attachment ──────────────────────
      //
      // ⚠️ 2026-10-25 修。原来 makeImageBlock 只在 createLlmGateway()
      //    里定义，而那个函数只有**找到 channel-pack** 时才调用
      //    （原来的 if (appDir && pack) 分支，2026-11-02 已删）。
      //    于是走自备渠道的人（比如 magpie）完全用不了图片，日志只说
      //    「attachment 服务不可用，图片降级为文字」—— 看着像 DSH 装坏了。
      //
      //    实际上 attachmentStore 只依赖 appDir + dshHome，
      //    跟 channel-pack 毫无关系。所以这里独立挂一份。
      /*
       * ★ **拿到一个能 import 的目录**（2026-11-02）。
       *
       * 旧布局（`resources/app/` 普通目录）→ 直接用。
       * 新布局（`app.asar`）→ 按依赖闭包**提取**到 `<home>/dsh-modules/`
       * 再用（asar 对普通 Node 就是个普通文件，读不了；详见 gateway/asar.js）。
       *
       * ⚠️ 闭包是**算出来的**（从三个种子包 BFS），不是写死的清单 ——
       *    DSH 升级后依赖变了会自动跟上。实测只有 10 个包 / 556 KB。
       */
      const importable = resolveImportableDshDir({
        dshAppDir: appDir,
        dshAsar: dshRes.asar,
        cacheRoot: store.home,
        log: (lv, msg) => log[lv]?.(msg),
      })
      if (!importable.dir) {
        log.warn(
          'LLM：没找到可 import 的 DSH 模块目录 → **图片会降级成文字**（她看不见图）。\n'
          + '     找的是 <安装>/resources/app/node_modules/@deepseek-ai/cordis（旧布局）\n'
          + '     或 <安装>/resources/app.asar（新布局，会按需提取）。\n'
          + '     都没有的话可以用 --dsh-app <目录> 显式指定。',
        )
      }
      if (importable.dir && typeof llm.makeImageBlock !== 'function') {
        try {
          const att = await createAttachmentSupport({
            // ⚠️ 用**能 import 的那个目录**（asar 布局下是提取出来的，
            //    不是原始的 asar 路径 —— 那个读不了）
            appDir: importable.dir,
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
      /*
       * ⚠️ 无 DSH 时，配置里那条默认付费兜底（deepseek-official）**曾经**是幽灵：
       *    它排在自备渠道后面却被当成有效候选，失败信息还会盖住真正的原因。
       *
       * ## 2026-11-02 改判据：看**凭据**，不看 appDir
       * 原来的判据是"`appDir` 为空 ⇒ 官方那条不可用"。但那是因为当时
       * `deepseek-official` 只由 DSH 的渠道包挂载。
       * 现在它由 **凭据里的 `DEEPSEEK_API_KEY`** 直接挂成一条普通渠道
       * （实测 `https://api.deepseek.com/v1` 返回 200），跟 appDir 无关 ——
       * **继续用 appDir 判会把它误判成幽灵、白关一个能用的兜底。**
       *
       * ⚠️ 而且这段会**改写用户的配置**（`store.update`）——
       *    实测 `fallback.enabled` 老是自己变回 false 就是这个干的。
       *    现在只在**真的没有 key** 时才关，而且日志讲清楚原因。
       */
      if (cfg.gateway?.fallback?.enabled) {
        const hasOfficialKey = Boolean(resolveChannelKey({ apiKeyEnv: 'DEEPSEEK_API_KEY' }, creds))
        if (!hasOfficialKey) {
          store.update({ gateway: { fallback: { ...cfg.gateway.fallback, enabled: false } } })
          log.warn('已自动禁用付费兜底：凭据里没有 DEEPSEEK_API_KEY，官方那条用不了')
          cfg.gateway.fallback.enabled = false
        }
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
    /*
     * ★ **「4b. 免费渠道优先顺序」整段删了**（2026-11-02）。
     *
     * 原来这里在首次启动时把 `DEFAULT_FREE_ORDER` 那 14 个渠道
     * **写进 config.json 的 `freeProviders`**（理由：不填的话顺序就等于
     * channel-pack 的注册顺序，前面十几个没配 model 的渠道会白转）。
     *
     * 渠道包一拆，这段就成了**纯污染源**：
     *   · 它往配置里塞 14 个本机根本不存在的渠道
     *   · 实测后果：`tests/.test-home/config.json` 里一直留着那 14 个
     *     （很久以前某次跑测试时写进去的），于是"用当前默认值"的假设失效，
     *     check-boot 的 `/v1/models` 返回 0 个、那条断言常年红
     *
     * 现在 `freeProviders` 保持空数组，没人再往里写东西。
     */
    shutdown.push(() => llm.close?.())

    // ── 5. 决策层 ─────────────────────────────────────────────
    /*
     * ⚠️ 「跟随模型选择」（2026-10-30 修，一次真实事故）。
     *
     * 面板上把 `decision.model.model` **留空**的语义是「跟模型选择器走」。
     * 但 `ModelDecisionProvider._ask()` 是这么写的：
     *
     *   const model = this.cfg.model || undefined
     *   const providerId = ... (model 为空 → undefined)
     *   this.llm.stream({ provider: undefined, model: undefined, ... })
     *
     * → `fallback.js` 的 `byId.get(undefined)` 拿不到渠道 →
     *   吐一个 `未配置的渠道：undefined` 的 error chunk →
     *   决策层拼出来是**空字符串** → 「解析不出 verdict（原始=""）」→
     *   降级到 rule → **群聊「没 @ 我」一律沉默**。
     *
     * 实测：今天 10 点到 20 点，`解析不出 verdict` **1037 次**，
     * 15~20 点每小时 65~105 次 —— 用户看到的就是「它又沉默了」。
     *
     * 所以在这里把空模型**补成 qq 那边选的模型**，让 provider 能推出来。
     */
    const decisionCfg = { ...(cfg.decision ?? {}) }
    if (!decisionCfg.model?.model) {
      const follow = String(cfg.qq?.model ?? '').trim()
      if (follow) {
        decisionCfg.model = { ...(decisionCfg.model ?? {}), model: follow }
        log.info(`决策层：未指定模型 → 跟随模型选择（${follow}）`)
      } else {
        log.warn('决策层：未指定模型，qq.model 也是空的 —— 会降级到 rule')
      }
    }
    const decision = createDecisionLayer(decisionCfg, {
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
    /*
     * ★ 衣柜的**可编辑层**（2026-11-06。用户：「衣柜要能改吧，
     *   毕竟现在这个只是我们的预设，不代表别人喜欢」）。
     *
     * 数据目录下放 `wardrobe.json`，某类存在且非空就整类替换内置预设；
     * 按 mtime 热加载 —— 改完下一轮生效，不用重启。
     */
    configureWardrobe({ home: memoryDir })
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
      // 群/私聊可以指定不同角色，见 PersonaStore#pickActive
      activeByScope: cfg.persona?.activeByScope ?? {},
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
        const { SUMMARY_PROMPT, parsePersonLines, parsePersonFacts, stripFactsSection } =
          await import('./memory/long.js')
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
        const out = text.trim()

        /*
         * ── 把【人】段落同步进**跨会话人物档案**（2026-10-29 补接线）──
         *
         * 这是 `PeopleStore` 存在的全部意义：`index.js` 里那句注释写着
         * 「一个人会出现在多个群和私聊里，但『他是谁』跨会话只有一个答案」。
         *
         * 但在这个 sync 之前，`setImpression()` **全项目零调用方** ——
         * 于是 `impression` 永远是空串 →
         * `toPromptLine()` 走 `if (parts.length === 0) return ''`（person.js:158）
         * → `toPrompt()` 里 `lines.filter(Boolean)` 全被滤掉 → **返回空串**
         * → `bridge.js` 的 `memory: [memoryText, peopleText].filter(Boolean)`
         *   里 peopleText 恒为空。
         *
         * 也就是说：人物档案那条链**一直是死的**，线上实测
         * `people.json` 里只有「见过 23 次」，一句印象都没有。
         *
         * 摘要的【人】段本来就产出 `QQ号 | 昵称 | 一句话印象`，
         * 这里按 QQ 号写进去 —— 群和私聊提炼到的印象会**汇总到同一个人**身上。
         *
         * 失败**不能影响摘要本身**（摘要是主线，档案是附加），所以整段吞错。
         * 用 `people?` 是因为它在本函数后面才构造（闭包，调用时已就绪）。
         */
        try {
          if (out && people) {
            for (const p of parsePersonLines(out)) {
              if (p?.id) people.setImpression(p.id, p.impression, p.name)
            }
            /*
             * ⚠️ **【事实】段 → 人物档案的 facts**（2026-10-31 补接线）。
             *
             * 在这之前 `people.json` 里 5 个人 `facts` 全是空数组 ——
             * `PersonProfile.addFact()` 写好了却**零调用**。
             * 于是"记住一个人"只剩一句性格标签，具体的事一件都留不下。
             *
             * 事实的真相源是 `people.json`（跨会话、累积、去重、上限 12 条），
             * **不在摘要里存第二份**（下面 `stripFactsSection` 会摘掉）。
             */
            for (const f of parsePersonFacts(out)) {
              if (f?.id && f.fact) people.addFact(f.id, f.fact)
            }
          }
        } catch (e) {
          log.warn?.(`人物档案同步失败（不影响摘要）：${String(e?.message ?? e)}`)
        }

        /*
         * 摘掉【事实】段再返回 —— 它已经进 `people.json` 了。
         * 留着会：① 重复占注入预算 ② `renderPeople()` 重建摘要时不带它，
         * 下次裁剪就神秘消失（更糊涂）。
         */
        return stripFactsSection(out)
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

    /*
     * ★ **事件记忆层**（2026-11-04）。
     *
     * 短期 30 条 / 长期滚动摘要之间原本是空的：「他这周要交毕设」
     * 「我答应留一碗饭」这种**一件一件的事**两头都留不住。
     * 这一层记具体的事，并且会淡忘（见 `memory/events.js` 的文件头）。
     *
     * ## 抽取为什么走网关、为什么节流
     * 抽取本身是一次 LLM 调用 —— 每条消息都抽等于把余额交给记忆层。
     * `EventStore#maybeExtract` 按 `extractAfter`（默认 6 条）节流，
     * 并且**失败也推进游标**，避免一次故障后每条消息重试、把余额打穿。
     *
     * ⚠️ 用 `auto` 档（跟摘要同一个渠道池），**不传 maxTokens** ——
     *    推理模型会先把 token 花在 reasoning 上，限了 max_tokens 就只剩空正文
     *    （这个坑在摘要那里已经踩过，见上面 `summarize` 的长注释）。
     */
    const memoryEvents = new EventStore({
      cfg: cfg.memory?.events ?? {},
      dir: cfg.memory?.dir,
      home: store.home,
      log,
      extract: async ({ messages, scene, known }) => {
        const prompt = EXTRACT_PROMPT
          /*
           * ⚠️ 用**函数式替换**，不用字符串替换（2026-11-04）。
           * `String#replace(pattern, string)` 会把替换串里的 `$&`、`$'`
           * 当成特殊记号 —— 聊天记录里只要出现一个 `$`，整段提示词就可能
           * 被替换成别的东西（而且不报错）。函数式替换没有这个语义。
           */
          .replace('{known}', () => known || '（无）')
          .replace('{messages}', () => messages.map((m) => (
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
          request: { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] },
          onAttempt: () => { },
        })
        let text = ''
        for await (const chunk of opened.stream) {
          // 草稿不是答案：reasoning 一律不收（跟摘要/日程同一套规矩）
          if (chunk?.type === 'reasoning-delta' || chunk?.type === 'reasoning') continue
          if (typeof chunk?.text === 'string') text += chunk.text
        }
        return text.trim()
      },
    })
    memoryEvents.load()
    state.memoryEvents = memoryEvents
    shutdown.push(() => memoryEvents.flush())

    // 人物档案：按 QQ 号认人。跨会话共享。
    // 带上 log —— 落盘失败要能看见（以前 `catch {}` 全吞，people.json
    // 从没写出来都没人发现）。
    const people = new PeopleStore({ home: store.home, log })
    state.people = people
    /*
     * 收藏表情的标签库（2026-10-31）。
     *
     * `fetch_custom_face` 只给 URL，没有名字/描述 —— 所以机器人发表情是闭眼随机。
     * 这张表存「URL(去签名) → 标签」，由 `_tagStickerBatch()` 用视觉模型分批打。
     */
    const stickerTags = new StickerTagStore({ home: store.home, log })
    state.stickerTags = stickerTags

    /*
     * 免费热点源（2026-10-29）。
     *
     * 用公开接口而不是付费搜索：贴吧热议实测 103ms / 30 条，而且
     * 那次刚好命中群里在聊的「影之刃零」。B站作备用（会限流）。
     *
     * ⚠️ 定位是「接话的料」，不是「开口的理由」——只有跟本群近期话题
     *    挂得上钩的才进提示词，挂不上就什么都不注入。
     */
    const hotTopics = new HotTopicStore({ home: store.home, log })

    /*
     * **每天搜索次数的限额**（2026-11-01 加）。
     *
     * ⚠️ 用户问「每天限额搜索是不是没有生效」—— 答案是**根本没这个功能**：
     * 原来的 `maxUses` 只出现在 JSDoc 里，零处实现（传进去没人读）。
     * 而一次搜索实际约 ¥0.02，没有上限 = 账单没有上限。
     *
     * 计数落 `<home>/search-usage.json`，**跨天自动归零**。
     * ⚠️ 必须写盘：开发期一天重启几十次，内存计数等于没限额。
     */
    const searchQuota = new SearchQuota({ home: store.home, log })

    /*
     * ★ 峰谷搜索节奏（2026-11-03）。
     *
     * 峰期（**照 DeepSeek 官网口径**：北京时间周一~周五 9:00-12:00、14:00-18:00）
     * 把"这一小时最多搜几次"压到很低；**谷期完全不干预**。
     *
     * ⚠️ 省的不是搜索费 —— `Search` 是固定价（¥0.005/次），**不分峰谷**。
     *    省的是**处理搜索结果的那些 token**（占一次搜索的大头，且分峰谷）。
     *    详见 `src/gateway/pacing.js` 的文件头。
     *
     * ⚠️ 内存态：**不需要落盘**。它是"这一小时"的短期节流，
     *    重启后从头计 —— 而每日总量由 `searchQuota` 落盘兜着，这里漏不掉。
     */
    const searchPacing = new SearchPacing({ log })

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

    /*
     * 短期记忆兜底落盘（2026-10-29 加）。
     *
     * 它只有 2 秒防抖（`short.js touch()`），关闭时不 flush 的话，
     * 最后那批 `totalPushed` 增量会永久丢失 —— 而那是长期记忆判断
     * "该不该摘要"的基准。丢了之后 `unsummarized` 变负数 →
     * 触发「计数回退」→ 基线归零 → 同一批内容被再摘要一遍。
     *
     * 实测：41 分钟里摘要跑了两次（23:14:44 一次、23:15:55 又一次）。
     */
    shutdown.push(() => memory.flush())

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
       * ⚠️ 必须**跳过推理草稿**（2026-10-28 修，用户报「看看消息，这是发言问题还是啥」）。
       *
       * 原来写的是「统一读 `chunk.text`，不猜 type」—— 但 `fallback.js` 产出的
       * `reasoning-delta` **也有 `.text`**：
       *
       *   { type: 'reasoning-delta', text: '我们需要回答用户，要求给…' }
       *   { type: 'text-delta',      text: '{"morning":…}' }
       *
       * 于是草稿被拼进 `out`，正文 JSON 被埋在后面 → `parseDayPlan` 解析失败，
       * 日志里贴出来的「原始输出」全是**推理内容**：
       *
       *   日程生成：模型输出无法解析 — 我们需要回答用户，要求给「蓝色大肥鱼」编一份…
       *
       * 后果不只是报错：`_ensureDayPlan` 会**反复重试**，每次都白花一次模型调用。
       *
       * `model.js`（`只收 text-delta`）和 `bridge.js`（分 type 收）都明确排除了
       * reasoning-delta，只有这里漏了。规则就是那一条：**草稿不是答案**。
       */
      for await (const chunk of opened.stream) {
        if (typeof chunk === 'string') { out += chunk; continue }
        const kind = chunk?.type
        if (kind === 'reasoning-delta' || kind === 'reasoning') continue
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
          /*
           * ★ **路由策略**（2026-11-02 补）。
           *
           * 这个值以前**从来没传到这里** —— 面板上那个「路由策略」下拉
           * 写进配置就没人读了，点了什么都不会变（详见 gateway/strategy.js 的说明）。
           * 现在传进来，由 `deriveRouting()` 翻译成两个真开关：
           * fallback 开不开、哪些渠道排除。
           */
          strategy: cfg.gateway?.strategy,
          /*
           * ★ 数据目录（2026-11-02 补）。
           *
           * bridge 里要落盘一个小缓存：**禁漫当前可用的域名**
           * （`jm-host.json`，见 gateway/jm.js）。那个站域名一直换，
           * 每次启动重新趟一遍死域名是 **6 次超时** —— 用户等的是回复，
           * 不该浪费在这上面。实测：缓存命中 1124ms，首次趟域名 3991ms。
           */
          home: args.home,
          /*
           * ★ 车牌内页那套（2026-11-02）。
           *
           * `enabled / maxShots / followUpMaxAgeMs` 三个都在这里给到 bridge ——
           * 别处也踩过"配置写了但没人读"的坑（路由策略那次），所以显式带上。
           */
          jmRead: cfg.jmRead,
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
        // 事件记忆层（2026-11-04）：注入 + 回复后强化 + 异步抽取
        events: memoryEvents,
        dayPlan,
        generateDayPlan,
        hotTopics,
        searchQuota,
        // 每小时限次（防某个小时连搜）—— 跟 searchQuota 是两个不同层级的闸
        searchPacing,
        persona,
        people,
    // 收藏表情的标签（让 `[表情包:哭]` 能真的挑到"哭"）
    stickerTags,
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
        // ★ 设置页「外部调用自动联网」开关：每请求现读配置，改完立刻生效
        getAutoSearch: () => store.get().gateway?.autoSearch !== false,
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
        // 事件记忆（2026-11-04）：面板的 /api/memory 要能看到条数/冻结情况
        events: memoryEvents,
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
      /*
       * ⚠️ **别硬编码 0**（2026-11-02 修正）。
       *
       * 原来写的是 `process.exit(0)` —— 于是**任何人都没法让正常关闭
       * 带一个非零退出码**，哪怕他自己显式设了 `process.exitCode = 1`。
       *
       * 实测后果：`tests/check-boot.mjs` 的收尾是
       * ```js
       * await r.shutdown('测试结束')          // ← 这里直接 exit(0)
       * console.log(`通过 ${pass} / 失败 ${fail}`)  // ← 执行不到
       * process.exit(fail === 0 ? 0 : 1)      // ← 执行不到
       * ```
       * 它**打印了 2 个 ❌ 却永远退出 0** —— 全量跑显示"80/80 全过"，
       * 那两条失败其实一直在，只是从来没传出来过。
       *
       * 改成尊重只读的 `process.exitCode`：正常运行时它是 undefined → 0，
       * 行为和以前一样；调用方显式设过就用它的值。
       */
      process.exit(process.exitCode ?? 0)
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
