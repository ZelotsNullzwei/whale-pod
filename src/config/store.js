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
    /**
     * 像人一样别秒回：**按这条消息有多难**分三档（2026-10-30 改）。
     *
     * 用户的原话：
     *   · 「真人回消息不会每次都一样的时间」
     *   · 「简单的就快速回，稍微难一点的就思考一点」
     *
     * 原来只有一个 `{min, max}` 区间，均匀随机 —— 实测 60 次
     * 「决策→发出」全挤在 2~10 秒，**一次 <2 秒都没有**，
     * 这就是"每次都差不多"的来源。
     *
     * ⚠️ 这只是"回得多快"的一半。另一半是 `reply.mergeWindowMs`
     *    （先等对方把话打完）—— 两者配合才对：
     *    等他打完 → 简单的马上接、难的想一下。
     *    只加快不给等待，反而会让人觉得"打字跟不上"。
     *
     * `min`/`max` 是 **normal** 档（也是老配置的回退值，向后兼容）。
     */
    delay: {
      /** 普通档（老 config 里只有这两个字段） */
      min: 800,
      max: 3500,
      /** 简单档：短消息、纯表情、单纯招呼 —— 快点接话 */
      easy: { min: 400, max: 1500 },
      /** 难档：要解释、要展开、多问号 —— 真的"想一下" */
      hard: { min: 2000, max: 7000 },
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
       * 输出上限。**这个值必须够推理模型把草稿写完。**
       *
       * ⚠️ 2026-10-28 重定（用户报「为什么回沉默」）。
       *
       * 原来写 64，而注释里还留着更早的结论「32 是平衡点」—— 两者本就矛盾。
       * 实测（真实决策提示词，上下文取上限 15 条）：
       *
       *   max_tokens=64   → **4 次里空 3 次**（推理把预算吃光，正文一个字没有）
       *   max_tokens=256  → 4 次里空 1 次
       *   max_tokens=1024 → **6 次全对**，reasoning 长度 0~1041 字
       *   max_tokens=2048 → 6 次全对，reasoning 最长 2200 字
       *
       * 关键数字：推理长度能到 **2200 字**，而 64 token 大约只装得下
       * 64~100 个汉字 —— **草稿自己就把预算吃光了**。
       *
       * 正文为空时 `DecisionRegistry` 拿不到 verdict → 降级 rule →
       * 群聊里「没 @ 我」的规则直接判沉默。用户看到的就是
       * **它莫名其妙不说话**。日志里表现为大量
       * `decision/model：解析不出 verdict（原始=""）`（当天 551 次）。
       *
       * 副作用检查：以前担心「给多了它会跑去回答用户的问题」
       * （旧注释记过 maxTokens=512 → 输出「五张」）。
       * 2026-10-28 用当前提示词重跑 1024/2048 各 6 次，
       * **输出的全是干净的一个词**，没有复现「答非所问」。
       *
       * 改这个值前先跑一遍真实提示词的对照（见 tests/check-decision-budget.mjs）。
       */
      maxTokens: 1024,
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
       * 「对方连发几条短句 = 一个意思」的**合并窗口**（毫秒，2026-10-30 加）。
       *
       * 用户的原话：
       *   · 「我现在发消息习惯发几条短句表达一个意思」
       *   · 「回复太快了我打字跟不上」
       *
       * 实测症状（22:43，他连发）：
       *   还早吧 / 11点过再睡 / 嗯 / 嗯 / 鱼鱼晚安
       * → **每一条都走了一次完整决策 + 一次回复**，他还在打字，它已经回了。
       *
       * 现在：同一个人在这个窗口内连发的消息会**攒起来**，
       * 静默这么久之后合并成一条处理（只回一次）。
       *
       * ⚠️ **设成 0 就关掉**（回到"每条各自处理"的旧行为）。
       * ⚠️ 别设太大：对方只发一条的时候，你也要等这么久才回。
       *    1500ms 是"还在打字"和"说完了"的近似分界。
       */
      mergeWindowMs: 1500,
      /**
       * 攒够这么多条**立即**处理，不再等静默。
       * 防止对方刷一串短句把它一直拖住（他发第 7 条时窗口就该关了）。
       */
      mergeMaxCount: 6,
      /**
       * 从**第一条**算起的总等待上限（毫秒）。
       * 对方一直发也不能无限等 —— 超过这个就必须处理了。
       */
      mergeMaxWaitMs: 4500,
      /**
       * 被 @ 时用的窗口（毫秒，比 `mergeWindowMs` 短）。
       * 人被叫会先看，但也不该完全不等 —— 他可能 @ 完接着补一句。
       */
      mergeAtWindowMs: 600,
      /**
       * **连发时的窗口**（毫秒，2026-10-30 加，自适应）。
       *
       * 第一条用 `mergeWindowMs`（1.5s，不耽误单条）；**第二条一来**
       * 就说明他在连发，改用这个（默认 8s）等他打完。
       *
       * 为什么需要：实测他的间隔**中位 6 秒** —— 1.5s 窗口一次都抓不到，
       * 直接调到 6s 又让"只发一条"也干等 6 秒。自适应不用猜。
       *
       * ⚠️ 这只是**兜底**：主信号是 `typingHoldMs`（协议端推 input_status）。
       *    有些客户端/协议实现不推那个通知，就靠这个窗口。
       */
      mergeBurstWindowMs: 8000,
      /**
       * 「他还在打字就继续等」的**停手判定**（毫秒，2026-10-30 加）。
       *
       * 协议端推 `notify/input_status`（实测每秒 1~2 次，一晚 1894 次），
       * 但 QQ **没有"停止输入"事件** —— 所以靠 TTL 推断：
       * 最后一次推送过了这么久还没再来，就当他停下了。
       *
       * ⚠️ 他打完字后最多还要等这么久才回（再叠加延迟档位）。
       *    调小 → 反应快但可能又插嘴；调大 → 更稳但更慢。
       * ⚠️ 设成 0 = 关掉这个判据（退回只看固定窗口）。
       */
      typingHoldMs: 4000,
      /**
       * 等打字的**硬上限**（毫秒）。
       *
       * 对方可能打一分钟的长文 —— 不能一直等，到点就照常回。
       */
      typingMaxWaitMs: 20000,
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
       * 允不允许模型用 `[找图:关键词]` 联网找图。
       *
       * 一次找图 ≈ 半分钱（Search ¥0.005 + 抓页面免费），
       * 由 DeepSeek 的 key 支持，不需要额外的图片搜索服务。
       *
       * 关掉之后：模型仍会输出标记，但不执行找图，标记也会被剥掉
       * （不会把 `[找图:...]` 原样发到群里）。
       */
      findImage: true,
      /**
       * 提问就要答（2026-10-28）。
       *
       * 决策层把一条**明确的提问**判成「跟我无关」→ 沉默时，
       * 这里再兜一层：只要是 `needsFreshInfo` 认得的问题（已排除寒暄与
       * 反问），就强制回答并去查资料 —— 用户原话「问要回啊，这都没回」。
       *
       * 关掉 → 完全尊重决策层的沉默，退回旧行为。
       */
      questionGate: true,
      /**
       * 群管理能力。
       *
       * 目前**只开禁言**（用户明确要求「就禁言」）。
       *
       * ⚠️ 没开的能力都别顺手加：
       *    · 踢人 / 退群 —— 不可逆，一退机器人就没了
       *    · 建群 / 发红包 / 转账 —— NapCat 没暴露这些 API
       *    · 读别人私聊 —— QQ 协议层收不到，不是权限问题
       *
       * 禁言本身也有硬限制（见 groupAdmin.js）：不能禁群主/管理员/自己，
       * ≤10 分钟，同人每小时 1 次、全群每天 10 次。
       */
      groupAdmin: {
        /** 允许模型用 `[禁言:QQ号:分钟]` */
        ban: true,
        /**
         * 允许模型用 `[改昵称:新名字]` 改**自己的 QQ 昵称**。
         *
         * ⚠️ 是全局昵称（所有群/好友都看到），不是群名片。
         *    限制更紧：≤12 字、每小时 ≤3 次、不许纯符号。
         *    关掉之后标记照样会被剥掉，只是不执行。
         */
        nickname: true,
        /**
         * 收到好友申请时自动同意。
         *
         * 用户要求：「不主动加人，只被动被加」——
         * 这也正好符合 OneBot 的能力边界：QQ **没有**主动加好友的 API，
         * 只有「处理别人发来的申请」。
         *
         * ⚠️ 加群邀请**不**自动同意（那等于随便进群，是另一件事）。
         */
        friendRequest: true,
        /** 同意好友申请后发一句招呼（关掉就静默通过） */
        friendGreeting: true,
      },
      /**
       * 最多附几张图。
       *
       * 原来 2 张。群里连续发几张图问「这几张哪个好看」很常见，
       * 2 张会漏掉后面的；4 张基本够用，再多 token 就涨得明显了。
       */
      maxImages: 4,
      /**
       * 单张图大小上限（超过就跳过）。
       *
       * ⚠️ 原来 4MB（4194304）。2026-10-28 实测翻车：群主发了张游戏截图
       * **4.7MB**，直接超限没下载 → 模型只拿到「（对方发了一张图）」
       * 却看不到图 → 按人格「答不上来就说看不清」回了句
       * 「这图是啥，看不清诶」。观感就是「它怎么连图都看不了」。
       *
       * 现代游戏/手机截图 4~8MB 很常见，4MB 太紧。提到 8MB。
       *
       * ⚠️ 注意 base64 会膨胀 ~33%：8MB 的图变成请求体约 10.7MB。
       *    如果上游渠道因此报错（body too large），就把这里调回 4~6MB。
       */
      maxImageBytes: 16 * 1024 * 1024,
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
      /**
       * 搜到结果后要不要顺手抓一张封面图。
       *
       * ⚠️ 2026-10-27 默认改成 **false**（用户明确要求「不要了」）。
       *
       * 原来的设想是「聊到具体作品/产品时配张图更像人」，实现是从来源页的
       * og:image / twitter:image 里抓。但实际效果不好：
       *
       *   · **抓到的图跟话题经常无关** —— 搜「你不是才吃过吗」抓到一张
       *     微信公众号的头图（一个捂肚子坐沙发的男人），发出去非常怪
       *   · 搜索引擎给的来源页大多有 og:image，命中率太高，变成「每次
       *     联网都甩一张图」，反而像机器人
       *
       * 需要时把这一项设成 true 可以恢复。
       */
      images: false,
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
   * ⚠️ **0 = 不限制**（默认），别改成"中等"的具体数字。
   *
   * 实测同一道群聊题（都只该回 20 来字）：
   *   maxTokens=4096    68s   推理 8469 字   正文  0 字   ← 被推理吃光
   *   maxTokens=100000  32s   推理 4019 字   正文 24 字
   *   不传（无限）      34s   推理 3997 字   正文 24 字
   *
   * 推理模型的思考**没有天然终点** —— 给一个"中等"上限，它会把预算
   * 一路顶到极限，反而一个字正文都不剩（表现为"机器人不回话"）。
   *
   * ⚠️ **2026-10-30 改的是实现，不是语义**：0 原来表示"不传这个字段"，
   * 那会**完全依赖上游默认值**。magpie 慷慨，但**别的渠道可能默认 512** ——
   * 推理一吃就空。现在 0 → 显式发一个"大到等于不限"的值（16000），
   * 行为等价，但不靠上游施舍。
   * 带图实测（各 2 次）：不传 153/80 字、16000 146/145 字、100000 100/89 字
   * —— 三者等价。
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
      /**
       * 摘要的**存储上限**（字符）。超了才淘汰（先砍最旧的人、再截话题）。
       *
       * ⚠️ 2026-10-30 从写死的 3000 提到 **12000** 并开放配置。
       *
       * 原来 3000 一个数管两件事（存多少 + 每轮带多少），后果是
       * **超了就永久裁掉** —— 用户感受到的就是「它忘事」。
       * B 站有评论直接说「3000 太小了」。
       *
       * 参考同生态的 dsh-qqchat（群/成员记忆各 2000 字符**注入**预算，
       * 但数据仍存 SQLite、不因预算被删）和 MaiBot（库不限、`top_k` 控注入）：
       * 两家都是**存储给足、注入给预算**。
       */
      maxChars: 12000,
      /**
       * 每轮**注入 prompt** 的预算（字符）。默认 3000 —— 跟以前一样，不涨成本。
       *
       * 超了按段裁剪（`clipForPrompt`）：
       *   · 【人】【我】【梗】**全带** —— 长期资产，砍了就真没了
       *   · 【事】**从头部砍，保留最新的** —— 话题是消耗品
       *
       * 想让记得更多就调大（每轮多花 token），想省钱就调小 ——
       * **都不影响存了多少**。
       *
       * ⚠️ 一般 `injectChars <= maxChars`。设反了不会报错，只是存储那边
       * 永远填不满注入预算。
       */
      injectChars: 3000,
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

/**
 * 把**点号路径**展开成嵌套对象：`{'a.b.c': 1}` → `{a:{b:{c:1}}}`。
 *
 * ## ⚠️ 为什么需要（2026-10-30 修，一个潜伏很久的 bug）
 *
 * `deepMerge` 是**按字面 key** 合并的，不认点号。于是面板提交
 * `{'memory.dir': 'D:/mem'}` 时，配置里会多出一个**顶层键**
 * 字面叫 `"memory.dir"`，而真正的 `memory.dir` **一动不动**：
 *
 * ```
 * 结果 {"memory":{"dir":""}, "memory.dir":"D:/mem"}
 *      → 顶层键: memory, memory.dir
 *      → memory.dir 还是 ""     ❌
 * ```
 *
 * 实测受影响的功能：
 * · 面板「记忆目录」—— **从 0.3.x 起就没生效过**（留空=跟数据目录，
 *   看起来"能用"，所以一直没人发现）
 * · 面板「记忆上限 存多少 / 每轮带多少」—— 0.3.5 新加的，同样只存了个假键
 *
 * ## 为什么在这里修，而不是改调用方
 * 点号路径是**调用方已经在用的约定**（`client.js` 一路这么发），
 * 而且 `{ 'qq.model': x }` 这种写法更省事。在入口统一展开，
 * 既修了两处存量 bug，也不让以后新加的表单再踩。
 *
 * 混合写法（`{memory:{...}, 'memory.dir':x}`）也能正确处理 ——
 * 每个 key 独立展开后再 `deepMerge`，冲突按后者覆盖。
 *
 * @param {*} patch
 * @returns {*}
 */
function expandDots(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch
  let out = {}
  for (const [k, v] of Object.entries(patch)) {
    const val = expandDots(v)
    if (!k.includes('.')) {
      out = deepMerge(out, { [k]: val })
      continue
    }
    // a.b.c → {a:{b:{c:val}}}
    const parts = k.split('.')
    let nest = val
    for (let i = parts.length - 1; i >= 0; i--) nest = { [parts[i]]: nest }
    out = deepMerge(out, nest)
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

  /**
   * 深合并写入并落盘；返回新值。
   *
   * ⚠️ **先 `expandDots` 再合并**（2026-10-30 修）。
   * 不展开的话 `{'memory.dir': x}` 会变成一个**字面量顶层键**，
   * 真正的 `memory.dir` 一动不动 —— 面板的「记忆目录」和
   * 「记忆上限」两处表单因此都保存不了（详见 `expandDots` 的注释）。
   */
  update(patch) {
    this.value = deepMerge(this.value, expandDots(patch))
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

export { deepMerge, expandDots }
