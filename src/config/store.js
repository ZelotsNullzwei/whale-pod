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

  /**
   * 随 DSH 启动时自动拉起 WhalePod。
   *
   * ⚠️ 这个字段放在 **WhalePod 自己的 config.json** 里，不是插件的
   *    cordis.patch.yml —— 因为设置页（`/api/whale-pod/config`）改的是
   *    前者。插件那边也有一个同名 `autoStart`（插件 config），
   *    两个都生效时按「**任一为 false 就手动**」处理，见 plugin/index.js。
   *
   * 为什么要这个开关：WhalePod 是 detached 进程，会一直占着 QQ 在线、
   * 内存和端口。有人希望它跟着 DSH 生命走（DSH 不开就不跑），
   * 有人希望它常驻（QQ 机器人本来就要 24 小时在线）。两种都合理。
   *
   * true  → DSH 启动时自动拉起（默认，和以前一样）
   * false → 什么都不做，只在侧栏点「一键启动」时才起
   */
  autoStart: true,

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
    /**
     * 决策方式：rule | model | jev | custom | auto
     *
     *   rule  —— 内置规则 + 概率打分（零成本、零延迟，但僵硬）
     *   model —— **让模型自己判断**该不该接（每次多一次 LLM 调用）
     *            它看最近十几条对话，回答 reply / wait / stop。
     *            比 rule 自然得多，代价是延迟 +1~3 秒、多一次调用。
     *   jev / custom —— 见各自配置段
     *   auto  —— model → jev → custom → rule 依次尝试
     *
     * ⚠️ 无论选哪个，**永远以 rule 收尾** —— 模型挂了也有零成本安全网。
     *
     * 为什么要有 model：实测（2026-10-25）rule 有两个架构性缺陷 ——
     *   ① 冷却把真实对话吃掉：用户连发 5 条，一条都没回
     *   ② p=0.04 却发言：掷骰子落在 4% 里，观感是「莫名其妙插一句」
     * 这两件都不是参数问题，是「打分器不知道语境」。
     */
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
    /**
     * 模型自主判断模式的参数。
     *
     * 什么时候该用：觉得「该回的时候不回、不该回的时候乱插」——
     * 那是概率打分器的固有缺陷，调 rule 的参数治不好。
     */
    model: {
      /**
       * 拿哪个模型做判断，形如 `magpie/auto/deepseek-v4.1-flash`。
       *
       * 留空 = 用调用方的默认模型（即 qq.model）。
       * 建议填一个**便宜、快**的 —— 判断「该不该说话」是简单任务，
       * 不需要强模型，而它每条消息都会调一次。
       */
      model: '',
      /** 给模型看多少条上下文。太多费 token，太少看不懂语境 */
      maxMessages: 15,
      /** 超时（ms）。判断不该拖太久，超时就降级到 rule */
      timeoutMs: 8000,
      /**
       * 输出上限。**这个值很敏感，两头都不能过。**
       *
       * 太小（8）：推理模型（deepseek-v4.1-flash）先写一大段
       *   reasoning_content，8 个 token 全被草稿吃光、正文一个字没输出 ——
       *   流里只有 reasoning-delta，拼出来是空字符串，次次判定失败降级。
       *
       * 太大（512）：模型有了发挥空间，**开始扮演角色跟你聊天**。
       *   实测同一个提示词、同一个问题：
       *     maxTokens=512 → 输出「五张」（在回答用户问的"几张图"）
       *     maxTokens=32  → 输出「reply」（正确判断）
       *   日志表现为大量 badParse，模型吐「哼」「瞅瞅」「那当然」这类词。
       *
       * 实测扫描（2026-10-25，三组用例）：
       *     16 / 24 / 32 → 全部正确
       *     48 / 64      → 开始答非所问
       *
       * 32 是「够推理草稿、不够展开聊天」的平衡点。
       * 改这个值前先跑 tests/_probe-verdict.mjs 复验。
       */
      maxTokens: 64,
      /** 温度。判断要稳定，给 0 */
      temperature: 0,
      /** 解析不出 verdict 时重试几次 */
      retryOnBad: 1,
    },
    /** 内置 rule 提供者的参数 */
    rule: {
      /** 距上次发言少于这个时间就别说（防刷屏，ms） */
      cooldownMs: 15000,
      /**
       * 连续发言轮数上限。
       *
       * ⚠️ 2026-10-27 从 3 提到 8。
       *
       * 原因：群聊里来回接话本来就是连着说的（用户原话「连发更像人」）。
       * 3 轮太紧 —— 一旦触发，后续消息（包括别人发的图片）都会判沉默，
       * 实测出现过「发了张图它一声不吭」正是这个引起的。
       *
       * 8 轮足够容纳一段正常的多来回了，又不至于真变成刷屏机。
       * 想彻底关掉可以设成很大的数（比如 999）。
       */
      maxConsecutiveTurns: 8,
      /** 被 @ 时几乎必回 */
      mentionProbability: 0.95,
      /** 群里随机插话概率（低，像真人） */
      idleChatterProbability: 0.04,
      /** 消息越短越可能只是闲聊，回复意愿越低 */
      shortMessagePenalty: 0.25,
      /**
       * 群友发**纯表情/纯图片**时，回一个表情的概率。
       *
       * ⚠️ 2026-10-24 新增（修「每发一个表情包它就回话」）。
       *
       * 为什么是「回表情」而不是「回话」：
       *   · 回文字 = 插嘴，还要调模型烧 token
       *   · 回表情 = 附和，和真人刷梗图一样，零成本
       *
       * 为什么要有概率而不是每张都回：
       *   不然它就成了群里最爱发表情的人。0.25 = 大约每四张回一次，
       *   既不冷场，也不刷屏。
       *
       * 设为 0 可完全关闭（表情包一律不回应）。
       */
      mediaEmojiProbability: 0.12,
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


  /**
   * 主动发言（空闲时自己开口）。
   *
   * ## 为什么需要
   *
   * 原来只有「收到消息 → 判断该不该回」这一条路径。群里安静下来
   * 之后它永远不会说话 —— 用户看到的是一条只会应答、不会主动找话
   * 的机器人，观感比真人差很远。
   *
   * ## 默认关闭
   *
   * 主动发言是**最容易招人烦**的功能：时间没选好就是刷屏。所以
   * 默认 `enabled: false`，要的人自己开。
   */
  proactive: {
    enabled: false,
    /**
     * 多久没说话才主动开口（分钟）。
     *
     * 太短（< 20）像催命；太长（> 180）用户根本碰不到。
     * 默认 45 分钟 —— 一个下午的安静之后冒个泡。
     */
    idleMinutes: 45,
    /**
     * 两次主动发言之间至少隔多久（分钟）。
     *
     * 和 idleMinutes 是两个概念：idle 管「群里安静了多久」，
     * 这个管「我上次主动说话是什么时候」—— 防止一群人在不同群里
     * 轮番安静、它每个群都开口。
     */
    cooldownMinutes: 180,
    /** 每天最多主动说几次。默认 3 —— 再多就是骚扰。 */
    maxPerDay: 3,
    /**
     * 只在这些时段说话（24 小时制，本地时区）。
     *
     * 默认 8:00-23:00：半夜冒泡会把人吓醒。
     * 留空数组 = 不限时段。
     */
    hours: [8, 23],
    /**
     * 群聊 / 私聊分别开不开。
     *
     * 私聊默认关 —— 主动找私聊对象说话更容易被认为越界。
     */
    inGroups: true,
    inPrivate: false,
  },
  /**
   * 自动讨钱（余额低时主动要饭）。
   *
   * ## 为什么独立于搜索
   *
   * 原来「查余额 → 讨钱」是挂在**搜索成功**后面的：不搜索就永远
   * 不查余额，余额再低也不会开口。而且 `_maybeBeg` 只在回复里
   * 附带一句，她不回复时同样不触发。
   *
   * 现在交给独立的定时任务：按 `checkIntervalMinutes` 定期查余额，
   * 低了就主动发一条 —— 跟有没有人在说话无关。
   */
  beg: {
    enabled: true,
    /** 多久查一次余额（分钟）。默认 60 —— 余额不会一分钟内突变。 */
    checkIntervalMinutes: 60,
    /** 每天最多讨几次。 */
    maxPerDay: 3,
    /** 只在群里讨（私聊讨钱更容易被判骚扰）。 */
    groupsOnly: true,
  },

  /** 记忆层（可选） */
  memory: {
    /**
     * 记忆文件放哪。
     *
     * 空字符串 = 跟着数据目录（`<DSH>/whale-pod`），也就是默认行为。
     * 填了就写到该目录下的 `memory-long.json`。
     *
     * 用途：想把记忆放到别的盘 / 同步盘（OneDrive、坚果云）时不必搬整个
     * 数据目录（config、日志、附件都在那儿，搬起来麻烦）。
     *
     * ⚠️ 只影响**长期记忆**的落盘位置。短期记忆是纯内存的，
     *    不落盘，也就没有"位置"可言。
     */
    dir: '',
    short: {
      /** 每个会话保留多少条上下文 */
      maxMessages: 30,
    },
    long: {
      /**
       * ⚠️ 默认 **开启**（2026-10-23 改，原来 false）。
       *
       * 长期记忆是「群聊能记住之前发生过什么」的唯一机制。
       * 默认关着意味着：短期窗口（30 条）一滚，之前聊过什么全忘 ——
       * 用户看到的就是「记忆没生效」。
       *
       * 实测（真实 QQ 私聊）：默认 false 时 `memory-long.json` 从未生成过。
       */
      enabled: true,
      /**
       * 触发摘要的消息数。
       *
       * ⚠️ **必须小于 `short.maxMessages`**，否则永远不会触发
       * （判断的是「距上次摘要新增了多少条」，而窗口长度就是上限）。
       *
       * 原来是 200 —— 而窗口只有 30，条件恒不成立。现在降到 20，
       * 留出 10 条的余量让上下文平滑滚动。
       */
      summarizeAfter: 20,
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
