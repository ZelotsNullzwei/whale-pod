/**
 * 配置存储：单一真相源。
 *
 * 设计要点：
 *   - 原子写（临时文件 + rename），避免半写坏文件。
 *   - 与 DSH 的 settings.json 同风格（人类可读 JSON，2 空格缩进）。
 *   - 默认值内置，文件不存在也能跑起来。
 *   - 密钥不落在这里 —— 走 credentials 层（见 credentials.js）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 默认数据目录：~/.whale-pod */
export function defaultHome() {
  return process.env.WHALE_POD_HOME || path.join(os.homedir(), '.whale-pod')
}

/** 内置默认配置。任何字段缺省时都从这里取。 */
export const DEFAULTS = {
  version: 1,

  /** LLM 网关（对外 OpenAI 兼容） */
  gateway: {
    enabled: true,
    host: '127.0.0.1',
    port: 18899,
    /**
     * 访问本网关的 key。留空 = 首次启动自动生成。
     * 与常见本地网关切法同一思路：本地回环，key 只是防止同机其它进程误用。
     */
    key: '',
    /** 路由策略：free-first = 免费渠道优先，失败/超时再走付费兜底 */
    strategy: 'free-first',
    /** 免费渠道优先顺序（provider id 列表，空 = 全部） */
    freeProviders: [],
    /**
     * 被**禁用**的渠道（不参与路由）。
     *
     * 为什么用"禁用列表"而不是给每个渠道加 enabled 字段：
     *   freeProviders 是纯数组、只表达顺序；把开关状态混进去会让
     *   "顺序"与"启用"两种关注点纠缠，读写都容易出错。
     *   单开一个列表后：顺序只管顺序，开关只管开关。
     *
     * 禁用的渠道不会出现在候选里（既不试也不报错）。
     */
    disabledProviders: [],
    /** 付费兜底（用户自己的 key，见 credentials） */
    fallback: {
      enabled: true,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    },
    /**
     * 自备渠道 —— 不依赖 DSH 的 LLM 来源。
     *
     * 为什么需要：默认渠道来自宿主已装的渠道包，
     * 而那是 DSH 插件。**没有 DSH 的用户靠这个列表也能跑起来。**
     *
     * 每项形状：
     *   {
     *     id: 'ollama',                    // 唯一 id，会作为 provider 名
     *     label: '本地 Ollama',
     *     preset: 'ollama',                // 可选：openai/deepseek/ollama/…
     *     baseUrl: 'http://127.0.0.1:11434/v1',
     *     apiKey: '',
     *     models: ['qwen2.5:7b'],
     *     model: 'qwen2.5:7b',             // 默认模型
     *     enabled: true,
     *   }
     *
     * 有 DSH 时这些渠道会**叠加**在免费渠道之后（免费优先，省钱）。
     */
    channels: [],
    /** 单次请求超时（ms） */
    timeoutMs: 120000,
  },

  /**
   * 决策层（活人感）。
   * 默认 rule = 内置零成本状态机；jev 是可选增强，接口已留好。
   */
  decision: {
    /** rule | jev | custom */
    provider: 'rule',
    /** 任一实现报错时是否降级到 rule */
    fallbackOnError: true,
    /** 概率阈值：decide() 返回的 probability 高于它才说话 */
    threshold: 0.5,
    /** 像人一样别秒回：基础延迟区间（ms） */
    delay: {
      min: 800,
      max: 3500,
    },
    /** 内置 rule 提供者的参数 */
    rule: {
      /** 距上次发言少于这个时间就别说（防刷屏，ms） */
      cooldownMs: 15000,
      /** 连续发言轮数上限 */
      maxConsecutiveTurns: 3,
      /** 被 @ 时几乎必回 */
      mentionProbability: 0.95,
      /** 群里随机插话概率（低，像真人） */
      idleChatterProbability: 0.04,
      /** 消息越短越可能只是闲聊，回复意愿越低 */
      shortMessagePenalty: 0.25,
      /**
       * 别名 —— 群里不提昵称、只用简称叫它时也算"在叫它"。
       *
       * 判据见 decision/rule.js 的 mentionsSelf：多字别名直接包含即命中，
       * 单字别名（「鱼」）要求独立成词，避免「摸鱼」「咸鱼」误伤。
       */
      aliases: ['蓝色大肥鱼', '肥鱼', '鲸鱼', '白饭', '鱼'],
    },
    /** Jev（TypeSafe AI）—— 可选，需 TYPESAFE_API_KEY */
    jev: {
      enabled: false,
      baseUrl: 'https://api.typesafe.ai',
      /** 凭据引用名（在 ~/.dsh/.credentials.yaml 里） */
      credentialRef: 'TYPESAFE_API_KEY',
      timeoutMs: 8000,
    },
    /** 自定义决策服务：WhalePod 会 POST 一个 JSON 过去 */
    custom: {
      enabled: false,
      url: '',
      token: '',
      timeoutMs: 8000,
    },
  },

  /** QQ 侧 */
  qq: {
    enabled: false,
    /**
     * 运行模式 —— 决定「谁当机器人框架」。
     *
     *   whale-pod —— WhalePod 自己接 OneBot（内置人格/记忆/决策，零额外运行时）
     *   astrbot  —— AstrBot 接 OneBot，WhalePod 退为纯 LLM 网关（换它的插件生态）
     *
     * ⚠️ 两者不能同时接同一个 OneBot 端点（会抢事件），所以二选一。
     * 切换时 WhalePod 会停掉自己这边的桥接。
     */
    mode: 'whale-pod',
    /** OneBot v11 连接 */
    onebot: {
      /**
       * 连接方向：
       *   forward —— 我们连协议端（填 wsUrl）
       *   reverse —— 协议端连我们（监听 reversePort）
       *   both    —— 两者都开，谁先连上就用谁
       */
      mode: 'forward',
      wsUrl: 'ws://127.0.0.1:3001',
      httpUrl: 'http://127.0.0.1:3000',
      accessToken: '',
      /** reverse 模式：我们监听的地址（协议端要填这个） */
      reverseHost: '127.0.0.1',
      reversePort: 6199,
      reversePath: '/onebot/v11/ws',
    },
    /**
     * 协议端托管（NapCat / SnowLuma）—— 只探测与启停，不自动下载。
     *
     * ⚠️ enabled 默认 **true**：只要 qq.enabled=true，协议端就是必需的 ——
     *    否则机器人连不上 QQ，用户还得自己去组件页点一次「启动」。
     *    实测踩过：默认 false 时每次重启 WhalePod，NapCat 都是死的，
     *    日志里只有一堆"连接出错"，看不出是"协议端压根没启动"。
     *    想自己手动管协议端（比如用 SnowLuma 的 GUI）就显式设 false。
     */
    supervisor: {
      enabled: true,
      /** 用户自己安装的协议端目录 */
      homeDir: '',
      /** napcat | snowluma | custom */
      kind: 'napcat',
      autoRestart: true,
    },
    /** 白名单：留空且 allowAllWhenEmpty=false 时不响应任何消息（fail-closed） */
    allow: {
      private: [],
      groups: [],
      allowAllWhenEmpty: false,
    },

    /**
     * 被戳一戳时的反应。
     *
     * 群里"戳一戳"是个互动动作，别人戳它最自然的反应是**戳回去**，
     * 而不是回一句话。所以默认戳回去，并按概率偶尔配句话 ——
     * 保留"真人有时懒得理"的感觉。
     */
    poke: {
      /** 总开关 */
      enabled: true,
      /** 理会的概率（不是每次都理） */
      chance: 0.75,
      /** 除戳回去之外，再补一句话的概率 */
      textChance: 0.25,
      /** 补话的内容池（留空用内置的几句） */
      lines: [],
      /** 设为 false 就只戳回去、不说话 */
      text: true,
    },

    /** 回复样式 */
    reply: {
      /**
       * 拆分多条消息（像人一样分句发）。
       *
       * ⚠️ 2026-10-19 从 false 改成 true。
       *
       * 原来默认 false，表现是"一整段塞进一条消息"—— 而真人聊天是
       * 断断续续的：「行吧」＋「等我先吃完这碗饭」是两条。群里看到
       * 一大段完整句子，反而一眼就是机器人在朗读。
       *
       * 分段规则（见 bridge.js 的 splitMessage）：
       *   · 空行 = 显式分段意图，一定拆成两条
       *   · 超过 maxChars 的长段按句末标点拆
       */
      segment: true,
      /** 单条最长字符，超出按句拆分 */
      maxChars: 500,
      /** 是否引用回复 */
      quote: false,
      /** 把收到的图片送给多模态模型（关掉可省钱） */
      imagesEnabled: true,
      /**
       * 最多附几张图。
       *
       * 原来 2 张。群里连续发几张图问「这几张哪个好看」很常见，
       * 2 张会漏掉后面的；4 张基本够用，再多 token 就涨得明显了。
       */
      maxImages: 4,
      /** 单张图大小上限（超过就跳过） */
      maxImageBytes: 4194304,
    },
    /**
     * 联网搜索。
     *
     * 触发判断在 gateway/search.js 的 needsFreshInfo()：明确要求搜索、
     * 时效性问题、具体人名/作品名，这些情况才查（一次 5~15 秒，
     * 群里绝大多数是闲聊，不能每条都搜）。
     *
     * 需要 DEEPSEEK_API_KEY（从 DSH 凭据里读）；没有 key 时自动跳过，
     * 不影响其它功能。
     */
    search: {
      /** 关掉就完全不联网 */
      enabled: true,
      /** 搜到结果后顺手抓一张封面图，接在回复最后发出去 */
      images: true,
      /** 单次最多搜几个来源 */
      maxUses: 3,
      /** 搜索超时 */
      timeoutMs: 20000,
      /**
       * 余额低于这个数（人民币）就让大肥鱼念叨一句。
       *
       * 搜索走 DeepSeek 官方付费 API，余额见底就搜不了了 —— 而那个账户
       * 平时没人看。默认 2 元：按 ¥0.02/次算还能搜 100 次，够撑到充值。
       */
      lowBalanceCny: 2,
    },
    /**
     * 自动收藏别人发的表情包。
     *
     * 判据是 NapCat 给的 `sub_type === 1`（或 summary 含「动画表情」），
     * 与图片内容无关 —— 带文字的表情、静态表情同样能认出来。
     * 收到就悄悄存进账号收藏，之后模型可以用 `[表情包]` 发出去。
     */
    autoCollectStickers: true,
    /** 收藏上限，到了就停止自动收藏（避免把账号塞满） */
    maxCollectedStickers: 200,
    /** 对话用的模型（'auto' = 按网关策略自动选） */
    model: 'auto',
    /** 发给模型的最大 token（带推理的模型要给够，否则全被推理吃掉） */
    /**
     * 单条回复的 token 上限。
     *
     * ⚠️ **0 = 不限制**（默认），这是实测出来的最佳值，别改成具体数字。
     *
     * 实测同一道群聊题（都只该回 20 来字）：
     *   maxTokens=4096    68s   推理 8469 字   正文  0 字   ← 被推理吃光
     *   maxTokens=100000  32s   推理 4019 字   正文 24 字
     *   不传（无限）      34s   推理 3997 字   正文 24 字
     *
     * 推理模型的思考**没有天然终点** —— 给一个"中等"上限，它会把预算
     * 一路顶到极限，反而一个字正文都不剩（表现为"机器人不回话"）。
     * 不限制时它推理完自然收口（finish=stop），又快又有正文。
     */
    maxTokens: 0,
  },

  /** 记忆层（可选） */
  memory: {
    short: {
      /** 每个会话保留多少条上下文 */
      maxMessages: 30,
    },
    long: {
      enabled: false,
      /** 触发摘要的消息数 */
      summarizeAfter: 200,
    },
  },

  /** 人格层（可选） */
  persona: {
    /** 当前角色名（对应 persona/roles/<name>.md） */
    active: 'default',
  },

  /** 管理 Web UI */
  web: {
    enabled: true,
    host: '127.0.0.1',
    port: 18898,
    /** 访问令牌，留空 = 首次启动生成 */
    token: '',
  },

  /** 日志 */
  log: {
    level: 'info',
    /** 保留最近多少行（内存环形缓冲 + 落盘） */
    ringSize: 2000,
  },
}

/** 深合并：用 patch 覆盖 base，只处理普通对象。 */
function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(base) || Array.isArray(patch)) return patch
  if (typeof base !== 'object' || typeof patch !== 'object') return patch
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : v
  }
  return out
}

export class ConfigStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] 数据目录
   * @param {string} [opts.fileName] 配置文件名
   */
  constructor(opts = {}) {
    this.home = opts.home ?? defaultHome()
    this.file = path.join(this.home, opts.fileName ?? 'config.json')
    this.value = structuredClone(DEFAULTS)
    this._watchers = new Set()
    this._loaded = false
  }

  /** 从磁盘加载；不存在则用默认值并落盘。 */
  load() {
    fs.mkdirSync(this.home, { recursive: true })
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, 'utf8')
        // ⚠️ 必须剥掉 UTF-8 BOM 再解析。
        //
        //    实测踩过（2026-10-19）：用 PowerShell 的 ConvertTo-Json 写配置，
        //    Set-Content 默认带 BOM（EF BB BF），JSON.parse 直接抛
        //    "Unexpected token ''"。而这个 catch 会把**整份配置重置成默认值** ——
        //    表现就是"我明明开了 QQ，重启后又变成关闭"，而且日志只说
        //    "qq.enabled = false"，完全看不出是文件坏了。
        //
        //    目录里留了一堆 config.json.corrupt-* 就是那几次的现场。
        const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw
        const parsed = JSON.parse(text)
        this.value = deepMerge(structuredClone(DEFAULTS), parsed)
      } catch (err) {
        // 坏文件不致命：备份后回默认值，避免用户彻底起不来。
        const bak = `${this.file}.corrupt-${Date.now()}`
        try { fs.copyFileSync(this.file, bak) } catch { /* ignore */ }
        this.value = structuredClone(DEFAULTS)
        this._corrupt = { file: this.file, backup: bak, error: String(err?.message ?? err) }
      }
    }
    this._loaded = true
    this.save()
    return this.value
  }

  /** 原子写盘。 */
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    // 明确写 UTF-8 无 BOM（Node 默认行为），别让下游再踩一次
    fs.writeFileSync(tmp, JSON.stringify(this.value, undefined, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  get() {
    if (!this._loaded) this.load()
    return this.value
  }

  /** 深合并写入并落盘；返回新值。 */
  update(patch) {
    this.value = deepMerge(this.value, patch)
    this.save()
    for (const fn of this._watchers) {
      try { fn(this.value) } catch { /* ignore */ }
    }
    return this.value
  }

  /** 订阅变更。 */
  watch(fn) {
    this._watchers.add(fn)
    return () => this._watchers.delete(fn)
  }

  /** 首次启动时生成缺失的密钥（网关 key / Web token）。 */
  ensureSecrets(mint) {
    let changed = false
    if (!this.value.gateway.key) { this.value.gateway.key = mint(); changed = true }
    if (!this.value.web.token) { this.value.web.token = mint(); changed = true }
    if (changed) this.save()
    return changed
  }
}

export { deepMerge }
