/**
 * 桥接层：QQ 消息 → 决策 → LLM → 发回 QQ。
 *
 * 这是「活人感」真正落地的地方。流程：
 *
 *   1. 收到消息
 *   2. 白名单过滤（fail-closed：没配白名单就不响应）
 *   3. 存入短期记忆
 *   4. 决策层判断「该不该说话」（Jev / 规则 / 自定义）
 *   5. 决定说话 → 组装 prompt（人格 + 记忆 + 上下文）
 *   6. 调 LLM（免费渠道优先）
 *   7. 按人的方式发出（延迟、分句）
 *   8. （可选）更新长期记忆摘要
 *
 * 关键设计：
 *   - **决策与表达分离** —— 省钱的根源。判断很便宜，生成才贵。
 *   - **[SILENT] 约定** —— 模型也可以主动选择不说话。
 *   - **失败静默** —— 任何一层出问题都只记日志，不把异常抛给 QQ 侧。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeMessage } from '../memory/short.js'
import { resolveCandidates, openFirstAvailable, applyFreeOrder, PROVIDER_MODEL_HINTS } from '../gateway/router.js'
import { needsFreshInfo, webSearch, formatSearchContext, pickCoverImage, checkBalance } from '../gateway/search.js'
import FACE_TABLE from './faces.json' with { type: 'json' }

/** 模型表示"不说话"的标记。 */
export const SILENT = '[SILENT]'

/**
 * 把系统提示 + 历史，组装成 dsh-llm 认的 messages 数组。
 *
 * 抽成独立函数是为了**能被直接测试** —— 这里踩过两个导致"全渠道失败"的坑：
 *
 *  ① `system` 的 content 必须是**数组块**，不能是裸字符串。
 *     上游判"这条请求有没有图片"时会遍历所有消息调
 *     `content.some(b => b.type === 'image')` —— 字符串没有 .some，
 *     直接抛 "content.some is not a function"。纯文本时不走这个检查，
 *     所以只在**带图**时暴露（症状：一发图所有渠道全失败）。
 *
 *  ② `role:'assistant'` 的消息**必须带 source**。
 *     dsh-llm 的 forAdapter() 会读 `message.source.replayState`，
 *     source 为 undefined 就抛 "Cannot read properties of undefined
 *     (reading 'replayState')" —— 同样是全渠道失败。
 *     症状更迷惑：**只在多轮对话时崩**（历史里有自己的回复），
 *     单条消息测不出来，看起来像随机故障。
 *
 * @param {object} o
 * @param {string} o.system          系统提示（纯文本）
 * @param {Array}  o.history         记忆里的消息（makeMessage 结构）
 * @param {Map}    [o.imageCache]    图片 ref → ImageBlock
 * @param {object} [o.lastRoute]     本次路由 {provider,model}，兜底用
 * @returns {Array} messages
 */
export function buildChatMessages({ system, history = [], imageCache = new Map(), lastRoute = null }) {
  return [
    // ① system 用数组块（见上）
    { role: 'system', content: [{ type: 'text', text: String(system ?? '') }] },
    ...history.map((m) => {
      const mine = m.isMe
      const label = mine ? '' : `${m.senderName}: `
      const blocks = [{ type: 'text', text: label + describeMedia(m) }]
      for (const ref of (m.images ?? [])) {
        const blk = imageCache.get(ref)
        if (blk) blocks.push(blk)
      }
      if (!mine) return { role: 'user', content: blocks }
      // ② assistant 必须带 source（见上）。provider/model 用当时生成那条回复的渠道；
      //    拿不到就填占位值 —— 我们不设 replayState，上游会原样放行。
      return {
        role: 'assistant',
        content: blocks,
        source: {
          kind: 'model',
          provider: m.provider || lastRoute?.provider || 'whale-pod',
          model: m.model || lastRoute?.model || 'auto',
        },
      }
    }),
  ]
}

/**
 * 把消息正文里"媒体标记"改写成**给模型的说明**。
 *
 * ## 为什么不能直接用 `[表情包:猫猫]`
 *
 * 那个标记本来是给自己解析/记录用的，直接喂给模型会**诱导它去解说**：
 * 实测它收到猫的震惊表情后回「这猫是被吓到了还是被丑到了」——
 * 真人不会这么说话，对方当然知道图里是什么。
 *
 * 所以要把它换成一个明确的**行为指令**：
 *   - 表情包 → 「（对方发了一个表情包）」，并提示"回个表情就好，别描述它"
 *   - 图片   → 「（对方发了一张图）」，图片本体另外以 ImageBlock 附上
 *
 * 注意：**只在送给模型的副本里改**，记忆里存的还是原标记
 *（否则界面和日志会看不懂）。
 */
export function describeMedia(m) {
  let t = String(m?.text ?? '')
  // 表情包：换成一句话说明 + 明确的行为指引
  t = t.replace(/\[表情包(?::([^\]]*))?\]/g, (_all, name) => {
    const n = String(name ?? '').trim()
    return n ? `（对方发了一个表情包，关于「${n}」）` : '（对方发了一个表情包）'
  })
  // 系统小黄脸：保留 id（情绪信号），但说明它是表情
  t = t.replace(/\[表情:(\d+)\]/g, (_all, id) => `（对方发了个QQ表情，id=${id}）`)
  // 图片：说明是图，本体由 ImageBlock 承载
  t = t.replace(/\[图片\]/g, '（对方发了一张图）')
  return t
}

/**
 * 可 await 的 sleep。
 *
 * ⚠️ 不要给这个定时器加 `.unref()` —— unref 的定时器不阻止进程退出，
 * 但 `await` 它仍然要等它触发；而如果进程里没有其它活跃 handle，
 * Node 会在 await 期间直接退出（表现为测试里"unsettled top-level await"）。
 * 所以这里刻意保留 ref。
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 在 QQ 内置表情表里按名字找表情 —— 这就是"用 QQ 的表情库搜索"。
 *
 * ## 为什么是本地表而不是联网搜
 *
 * QQ **没有公开的表情搜索 API**（实测候选接口全 404，NapCat 也没暴露）。
 * 但 NapCat 内嵌了 QQ 完整的 face_config，我们导出成 faces.json
 * （见 scripts/extract-faces.mjs），于是能在本地完成"按关键词找表情"。
 *
 * ## 匹配策略（从精确到宽松）
 *
 *   ① 完全同名             「大笑」→ 「大笑」
 *   ② 表名含关键词 / 关键词含表名（按名字**从长到短**试，长匹配更准）
 *   ③ 单字兜底（仅关键词很短时）
 *
 * ⚠️ 第 ② 档必须从长到短：「大笑」要先命中「大笑」而不是「笑」。
 *    第 ③ 档很容易撞错，所以只在关键词 ≤2 字时才用。
 *
 * @param {string} key 模型给的感觉词（如「猫猫」「大笑」「无语」）
 * @returns {{name:string, kind:'face'|'mface', id?:number, ani?:number, pack?:number, by:'exact'|'fuzzy'}|null}
 */
export function lookupFace(key) {
  const k = String(key ?? '').trim()
  if (!k) return null
  const names = Object.keys(FACE_TABLE)

  // ① 完全同名
  if (FACE_TABLE[k] !== undefined) return packFace(k, 'exact')

  // 归一化：去掉常见修饰词，提高命中率（「超级大笑」→「大笑」）
  const stripped = k.replace(/^(超级|非常|特别|有点|好|很|超)/, '').replace(/(了|的|呀|啊|吧)$/, '')

  // ② 模糊匹配。按名字长度**从长到短**试 —— 长匹配更精确。
  const sorted = names.slice().sort((a, b) => b.length - a.length)
  for (const cand of [k, stripped].filter(Boolean)) {
    if (cand.length < 2) continue
    for (const n of sorted) {
      if (n.includes(cand) || cand.includes(n)) return packFace(n, 'fuzzy')
    }
  }

  // ③ 单字兜底：只在关键词本身很短时用（否则「笑」会乱撞）
  if (k.length <= 2) {
    for (const n of sorted) {
      if (n.length === 2 && (n.includes(k) || k.includes(n))) return packFace(n, 'fuzzy')
    }
  }
  return null
}

/** 把 faces.json 里的一条包装成统一结果。 */
function packFace(name, by) {
  const v = FACE_TABLE[name]
  if (typeof v === 'number') return { name, kind: 'face', id: v, by }
  if (v && typeof v === 'object') return { name, kind: 'mface', ani: v.ani, pack: v.pack, by }
  return null
}

/** 表情表里有多少个名字（给 UI/调试用）。 */
export function faceTableSize() {
  return Object.keys(FACE_TABLE).length
}

/**
 * 字符串 → 稳定的非负整数（djb2）。
 *
 * 用途：收藏表情不带名字，只能按模型给的名字做**确定性挑选** ——
 * 同一个名字每次发同一张，比"每次随机"更像有意图的选择。
 * 用 djb2 而不是简单的 h*31：后者对短中文串容易聚到同一档。
 */
function hashStr(s) {
  let h = 5381
  const t = String(s)
  for (let i = 0; i < t.length; i++) {
    h = ((h << 5) + h + t.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/**
 * 清掉模型输出里的"工具调用/特殊标记"残留。
 *
 * 为什么需要：这些免费渠道的模型常被微调成会输出**工具调用语法**
 * （DeepSeek 的 `<｜｜DSML｜｜ calls>` 等）。那本来是该被 harness 解析
 * 成 tool_call 的结构，但我们只是把它当纯文本收下来 —— 结果原样发给
 * 群友，看起来就是一堆乱码标签。实测出现过：
 *
 *   "？\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"get_weather\">…"
 *
 * 这里做两件事：
 *   1. 整段都是工具调用（清完没有实质内容）→ 返回空串，让上层按"没话说"处理
 *   2. 只有部分残留 → 只留下自然语言部分
 */
export function cleanModelText(raw) {
  let s = String(raw ?? '')

  // ① 成对的工具调用块（含各种全角竖线/尖括号变体）整块删掉
  //    形如 <｜｜DSML｜｜ calls> … </｜｜DSML｜｜ calls>
  s = s.replace(/<[｜|]{0,4}[^>]*?(?:DSML|tool_call|tool_calls|function_calls)[^>]*>[\s\S]*?<\/[｜|]{0,4}[^>]*?(?:DSML|tool_call|tool_calls|function_calls)[^>]*>/gi, '')
  // ② 未闭合的，删到行尾/结尾
  s = s.replace(/<[｜|]{0,4}[^>]*?(?:DSML|tool_call|tool_calls|function_calls)[^>]*>[\s\S]*$/gi, '')
  // ③ 裸的 invoke / parameter 标签
  s = s.replace(/<\/?[｜|]{0,4}[^>]*?(?:invoke|parameter|tool_use)[^>]*>/gi, '')
  // ④ 常规的特殊 token（如 <|end_of_sentence|>）
  s = s.replace(/<\|[^|>]{1,40}\|>/g, '')
  // ⑤ 全角竖线的同类残留
  s = s.replace(/<｜[^｜>]{1,40}｜>/g, '')

  // ⑥ 修补**被截断的表情标记**。
  //
  //    实测踩过：群里发了「[表情:」这一串字面文本 —— 因为生成被截断
  //    （流提前结束 / 上游把输出砍在标记中间），留下的残缺标记既不匹配
  //    发送时的正则，又被当普通文本发出去，用户看到的就是一串方括号。
  //
  //    能补的就补全，补不了（只有前缀、没有 id）就删掉：
  //      '[表情:4'        → '[表情:4]'
  //      '[表情包:猫猫'    → '[表情包:猫猫]'
  //      '[表情:'         → 删掉（没有 id，无法还原）
  s = repairTruncatedMarkers(s)

  // ⑦ 归一化 [SILENT]（大小写/全角括号/夹在中间的空白）。
  //
  //    模型有时写成 `[ silent ]`、`[Silent]`、`［SILENT］`（全角），
  //    下游按字面量比对就会漏判 —— 那就会把 "SILENT" 这几个字母
  //    当正文发到群里。统一成标准写法，由调用方判断"剥掉后还剩什么"。
  s = s.replace(/[\[［]\s*silent\s*[\]］]/gi, '[SILENT]')

  // ⑧ 剥掉「媒体描述」——**这是喂给模型看的内部标注，绝不能出现在回复里**。
  //
  //    实测踩过（2026-10-19，用户截图）：群里发了个表情，模型回：
  //      「那本鱼继续吃饭（对方发了个QQ表情，id=20）」
  //    括号里那串是 `describeMedia()` 给输入消息加的**说明**（见本文件
  //    第 101 行），目的是让模型知道"对方发的是表情而不是文字"。
  //    但模型有时会把它当正文复述出来 —— 群友看到的就是一句机械旁白。
  //
  //    这类描述只在**输入侧**有意义。输出侧必须一律剥掉：
  //      （对方发了个QQ表情，id=20）      → 删
  //      （对方发了一个表情包，关于「猫猫」）→ 删
  //      （对方发了一张图）                → 删
  //
  //    ⚠️ 用「对方发了」作为锚点而不是「括号内任意内容」——
  //       后者会误伤正常括号（「（笑）」「（认真脸）」）。
  s = s.replace(/[（(]\s*对方发了[^）)]*[）)]/g, '')

  return s.trim()
}

/**
 * 修补/清理**残缺的表情标记**。
 *
 * 只在**文本末尾**处理 —— 中间出现残缺说明模型本来就想写这个字面量，
 * 不该擅自改。末尾残缺才是"被截断"的典型特征。
 */
export function repairTruncatedMarkers(text) {
  let s = String(text ?? '')
  // 末尾的 [表情:<数字> 缺右括号 → 补上
  s = s.replace(/\[表情[:：]\s*(\d+)\s*$/, '[表情:$1]')
  // 末尾的 [表情包:<名字> 缺右括号 → 补上
  s = s.replace(/\[表情包[:：]\s*([^\[\]]+?)\s*$/, '[表情包:$1]')
  // 末尾只剩前缀（没有 id/名字）→ 整段删掉，别把方括号发给群友
  s = s.replace(/\[表情[:：]?\s*$/, '')
  s = s.replace(/\[表情包[:：]?\s*$/, '')
  // 单独一个半开的左括号也要清（如 "好的["）
  s = s.replace(/\[$/, '')
  return s
}

/**
 * 把文本按表情标记切段。
 *
 * 输入：'你好[表情:4]再见[表情包:猫猫]'
 * 输出：[{kind:'text',text:'你好'}, {kind:'face',id:'4'},
 *        {kind:'text',text:'再见'}, {kind:'mface',name:'猫猫'}]
 *
 * 这样发送时就能把标记换成真正的 QQ 表情段，而不是把 "[表情:4]"
 * 这七个字符原样发给群友。
 */
export function splitFaceMarkers(text) {
  const out = []
  const s = String(text ?? '')
  const re = /\[表情:(\d+)\]|\[表情包(?::([^\]]*))?\]/g
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: s.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ kind: 'face', id: m[1] })
    else out.push({ kind: 'mface', name: (m[2] ?? '').trim() })
    last = re.lastIndex
  }
  if (last < s.length) out.push({ kind: 'text', text: s.slice(last) })
  // 全是标记的情况（没有文本段）也要返回，不能丢
  if (out.length === 0) out.push({ kind: 'text', text: s })
  return out
}

export class QQBridge {
  /**
   * @param {object} opts
   * @param {object} opts.cfg         qq 配置
   * @param {object} opts.onebot      OneBotClient
   * @param {object} opts.llm         网关核心
   * @param {object} opts.decision    决策层
   * @param {object} opts.memory      MemoryStore
   * @param {object} opts.longMemory  LongTermStore
   * @param {object} opts.persona     PersonaStore
   * @param {object} opts.gatewayCfg  gateway 配置（取 fallback 等）
   * @param {object} opts.log
   */
  constructor(opts) {
    this.cfg = opts.cfg ?? {}
    this.onebot = opts.onebot
    this.gateway = opts.gateway ?? opts.llm
    this.decision = opts.decision
    this.memory = opts.memory
    this.longMemory = opts.longMemory
    this.persona = opts.persona
    this.log = opts.log ?? {}
    /** 用量统计（可空）—— 用于总览页的 token/费用 */
    this.usage = opts.usage ?? null
    /** DeepSeek API key —— 联网搜索用（没有就跳过搜索，不影响其它功能） */
    this.searchKey = opts.searchKey ?? null
    /** 最近一次联网搜索（给 UI 看） */
    this._lastSearch = null
    this.selfId = null
    this.selfName = 'WhalePod'
    /** 处理队列：保证同一会话串行，避免并发抢话 */
    this._queues = new Map()
    /** 最近一次回复（供 Web UI 展示） */
    this.recent = []
    this.stats = { received: 0, dropped: 0, considered: 0, replied: 0, failed: 0, silent: 0, deferred: 0 }
    /** 暂停开关（Web UI 可切） */
    this.paused = false
    /**
     * 冷却期内待补回的消息（按会话分组）。
     *
     * 同一个会话只留**最后一条** —— 冷却结束时用户想问的显然是
     * 最新那句话，把前面几条都排着回会让机器人像复读机。
     *
     * @type {Map<string, {msg:object, mem:object, scene:object, self:object, at:number, timer:any}>}
     */
    this._deferred = new Map()
  }

  /** 绑定 OneBot 事件。 */
  attach() {
    this.onebot.on('event', (ev) => { this.onEvent(ev).catch((e) => {
      this.stats.failed++
      this.log.warn?.(`bridge：处理事件失败 — ${String(e?.message ?? e)}`)
    }) })
    this.onebot.on('open', async () => {
      try {
        const info = await this.onebot.getLoginInfo()
        const d = info?.data ?? info
        this.selfId = String(d?.user_id ?? '')
        this.selfName = String(d?.nickname ?? 'WhalePod')
        this.log.info?.(`bridge：已登录为 ${this.selfName}(${this.selfId})`)
      } catch (e) {
        this.log.warn?.(`bridge：取登录信息失败 — ${String(e?.message ?? e)}`)
      }
    })
    return this
  }

  /**
   * 查询群名（带缓存）。
   *
   * 为什么要缓存：`get_group_info` 每次都要打协议端，而群名几乎不变。
   * 缓存 10 分钟，既让 prompt 里能带上群名（模型知道自己在哪个群，
   * 对判断语气有帮助），又不给协议端添压力。
   */
  async groupName(groupId) {
    if (!groupId) return undefined
    if (!this._groupNames) this._groupNames = new Map()
    const now = Date.now()
    const hit = this._groupNames.get(String(groupId))
    if (hit && now - hit.at < 600000) return hit.name

    try {
      const res = await this.onebot.call('get_group_info', { group_id: Number(groupId) }, 8000)
      const name = res?.data?.group_name
      if (name) {
        this._groupNames.set(String(groupId), { name, at: now })
        return name
      }
    } catch { /* 查不到不影响，用 undefined */ }
    this._groupNames.set(String(groupId), { name: undefined, at: now })
    return undefined
  }

  /** 白名单判断（fail-closed）。 */
  allowed(msg) {
    const allow = this.cfg.allow ?? {}
    const priv = allow.private ?? []
    const groups = allow.groups ?? []
    const empty = priv.length === 0 && groups.length === 0

    if (empty) return allow.allowAllWhenEmpty === true

    if (msg.kind === 'private') return priv.map(String).includes(String(msg.userId))
    return groups.map(String).includes(String(msg.groupId))
  }

  /** 处理一条消息事件。 */
  async onEvent(ev) {
    this.stats.received++
    if (this.paused) return

    // 通知事件（戳一戳 / 群成员变动等）单独走：它们没有消息体。
    // 放在 __normalized 检查之前，否则会被当"没有消息内容"直接丢掉。
    if (ev?.post_type === 'notice') return this._onNotice(ev)

    const msg = ev?.__normalized ?? null
    if (!msg) return

    if (!this.allowed(msg)) {
      this.stats.dropped++
      this.log.debug?.(`bridge：忽略 ${msg.scope}（不在白名单）`)
      return
    }

    // ⚠️ 重复事件去重（2026-10-23 补）
    //
    // 协议端在**重连、网络重试**时会把同一条消息再推一遍（OneBot 实现里很常见）。
    // 原来只在「写记忆」那一步用 messageId 判了重（`alreadyInMemory`），
    // 但那只是防止记忆里出现两条 —— **决策和发送照样会跑第二遍**，
    // 群里看到的就是机器人把同一句话回了两次。
    //
    // 所以去重必须放在**决策之前**：同一个 (scope, messageId) 只处理一次。
    // 用 TTL + 容量上限，避免长时间运行把内存吃光。
    if (this._isDuplicate(msg)) {
      this.stats.duplicate = (this.stats.duplicate ?? 0) + 1
      this.log.info?.(`bridge：重复事件已忽略（${msg.scope} messageId=${msg.messageId}）`)
      return
    }

    // ⚠️ 入站登记（2026-10-23 补，修复过时检测看不到排队消息的 bug）
    //
    // 为什么必须在**入队之前**登记，而不是等 `_handle` 里写记忆：
    //
    //   同会话是**串行**的（见下面的 `_queues`）。第一条消息在 sleep 或
    //   等 LLM 生成时，第二、三条只是**排在 Promise 链上**，它们的
    //   `_handle` 根本还没开始跑 —— 所以还没写进 mem。
    //   而 `_checkSuperseded` 原来读的是 `mem.recent()`，于是它永远
    //   看不到这些「已到但未处理」的消息，过时检测形同虚设。
    //
    //   实测确认（tests/_probe-concurrency.mjs）：第一条生成期间连发两条，
    //   mem 里只有 1 条，`_checkSuperseded` 返回 null，三条全部照发。
    //
    // 所以这里在**入口处**就登记一条独立记录（不依赖 mem、不受串行队列
    // 阻塞），并给每个 scope 一个单调递增的序号。
    const seq = this._recordInbound(msg)

    // 同会话串行，避免两条消息同时触发两条回复
    const prev = this._queues.get(msg.scope) ?? Promise.resolve()
    const next = prev.then(() => this._handle(msg, seq)).catch((e) => {
      this.log.warn?.(`bridge：${msg.scope} 处理失败 — ${String(e?.message ?? e)}`)
      this.stats.failed++
    })
    this._queues.set(msg.scope, next)
    await next
  }

  /**
   * 登记一条**入站**消息，返回它在所属 scope 里的单调序号。
   *
   * 这份记录和 `mem`（短期记忆）是**两个东西**，职责不同：
   *
   *   · `mem`        —— 给模型看的对话上下文，按处理顺序写入，受串行队列阻塞
   *   · `_inbound`   —— 给过时检测看的「到了哪些消息」，**入口即写**，不受阻塞
   *
   * 分开是必要的：合并成一个就会出现本次的 bug（排队中的消息对检测不可见）。
   *
   * @param {object} msg
   * @returns {number} 该 scope 内的单调递增序号（从 1 开始）
   */
  _recordInbound(msg) {
    const scope = String(msg.scope ?? 'unknown')
    if (!this._inbound) this._inbound = new Map()
    let rec = this._inbound.get(scope)
    if (!rec) {
      rec = { seq: 0, entries: [] }
      this._inbound.set(scope, rec)
    }
    const seq = ++rec.seq
    // ⚠️ mentionsMe 在规范化消息里**不是现成字段** —— 它是由
    //    `isAtMe(selfId)` 现算的（见 onebot.js normalizeEvent）。
    //    这里必须自己算一次：入口处拿不到 _handle 里那个
    //    `(isAtMe) || quotedMine` 的组合值，但「@ 我」这一半足够
    //    作为「有人在等我」的判据了。
    let mentionsMe = Boolean(msg.mentionsMe)
    if (!mentionsMe && this.selfId && typeof msg.isAtMe === 'function') {
      try { mentionsMe = Boolean(msg.isAtMe(this.selfId)) } catch { /* 算不出就当没提 */ }
    }
    rec.entries.push({
      seq,
      messageId: msg.messageId != null ? String(msg.messageId) : null,
      at: Number(msg.at ?? Date.now()),
      text: String(msg.text ?? ''),
      // 这两个字段是「有人在等我」的判据，入口处就要拿到 ——
      // 不能等 _handle 里算（那时已经太晚）。
      mentionsMe,
      replyTo: msg.replyTo != null ? String(msg.replyTo) : null,
      sender: String(msg.userId ?? ''),
    })

    // 只保留最近一段：过时检测只关心「我之后」的，留太多没意义。
    // 按条数裁剪，避免长期运行把内存吃光（大群一天几万条）。
    const cap = Number(this.cfg.inboundKeep ?? 50)
    if (rec.entries.length > cap) {
      rec.entries.splice(0, rec.entries.length - cap)
    }
    return seq
  }

  /**
   * 取某个 scope 里**序号大于 afterSeq** 的入站记录。
   *
   * @param {string} scope
   * @param {number} afterSeq
   * @returns {Array<object>}
   */
  _inboundAfter(scope, afterSeq) {
    const rec = this._inbound?.get(String(scope ?? 'unknown'))
    if (!rec) return []
    return rec.entries.filter((e) => e.seq > afterSeq)
  }

  /**
   * 这条消息是不是**已经处理过**的重复事件？
   *
   * 判据：同 scope 下相同 messageId。
   *
   * ⚠️ 必须带 scope：不同群的 messageId 是各自编号的，
   *    只按 id 判重会把另一个群里的正常消息误杀。
   *
   * @param {object} msg
   * @returns {boolean} true = 重复，应当直接丢弃
   */
  _isDuplicate(msg) {
    const id = msg?.messageId
    if (id === undefined || id === null || String(id) === '') {
      // 没有 messageId 的消息无法判重 —— 宁可放行也不要误杀
      return false
    }
    if (!this._seenIds) this._seenIds = new Map()

    const key = `${msg.scope}|${id}`
    const now = Date.now()
    const ttl = Number(this.cfg.dedupeTtlMs ?? 20 * 60_000)
    const cap = Number(this.cfg.dedupeMaxEntries ?? 5000)

    const hit = this._seenIds.get(key)
    if (hit !== undefined && now - hit < ttl) return true

    // 记下这一次
    this._seenIds.set(key, now)

    // 定期清理：超过容量就按时间淘汰最旧的一批
    if (this._seenIds.size > cap) {
      const sorted = [...this._seenIds.entries()].sort((a, b) => a[1] - b[1])
      const drop = sorted.slice(0, this._seenIds.size - cap)
      for (const [k] of drop) this._seenIds.delete(k)
    }
    return false
  }

  /**
   * 处理通知事件 —— 目前主要是**戳一戳**。
   *
   * NapCat 的结构（实测确认）：
   *   { post_type:'notice', notice_type:'notify', sub_type:'poke',
   *     group_id, user_id:<戳的人>, target_id:<被戳的人> }
   *
   * 别人戳它，最自然的反应就是**戳回去**（而不是回一句话）——
   * 群里戳一戳本来就是个互动动作，回文字反而突兀。
   * 所以默认戳回去，并按概率偶尔配一句话，保留"真人有时懒得理"的感觉。
   */
  async _onNotice(ev) {
    // 先把收到的**所有**通知记一条 —— 排查"为什么戳一戳没反应"时，
    // 第一件要知道的事就是"协议端到底有没有把通知推过来"。
    // 没有这条日志的话，只能靠猜（实测踩过：反复等也不确定是没推还是没处理）。
    const nt = ev?.notice_type ?? '?'
    const st = ev?.sub_type ?? ''
    this.log.info?.(`bridge：收到通知 ${nt}${st ? '/' + st : ''}` +
      `（群 ${ev?.group_id ?? '-'}，操作者 ${ev?.user_id ?? '-'}，目标 ${ev?.target_id ?? '-'}）`)

    if (nt !== 'notify' || st !== 'poke') return

    const targetId = String(ev.target_id ?? '')
    const fromId = String(ev.user_id ?? ev.sender_id ?? '')
    const groupId = ev.group_id != null ? String(ev.group_id) : null

    // 只理"戳我"的；别人互相戳不关我事
    if (!this.selfId || targetId !== String(this.selfId)) return
    // 不戳自己（有些客户端会回环）
    if (fromId === String(this.selfId)) return

    // 白名单：不在允许的群里就不理
    const fake = { scope: groupId ? `group:${groupId}` : `private:${fromId}`, kind: groupId ? 'group' : 'private', groupId, userId: fromId }
    if (!this.allowed(fake)) {
      this.stats.dropped++
      this.log.debug?.(`bridge：忽略来自 ${fake.scope} 的戳一戳（不在白名单）`)
      return
    }

    const cfg = this.cfg.poke ?? {}
    if (cfg.enabled === false) return
    this.stats.received++

    // 概率：不是每次戳都理 —— 真人也有懒得回的时候
    //
    // ⚠️ 2026-10-18 默认从 0.75 提到 0.95。
    //    实测：群里有人专门戳它，日志打出「本次随机不理」，
    //    用户看到的就是"戳了它没反应，是不是坏了"。
    //    戳一戳本身是**明确的定向互动**（比在群里说话强得多），
    //    只有 75% 回应等于四分之一概率装死。
    //    要更懒就改配置 qq.poke.chance。
    const chance = typeof cfg.chance === 'number' ? cfg.chance : 0.95
    if (Math.random() > chance) {
      this.stats.silent++
      this.log.info?.(`bridge：被 ${fromId} 戳了，本次随机不理（概率 ${Math.round(chance * 100)}%）`)
      this._recordPoke(groupId, fromId, null, 'poke-silent')
      return
    }

    // 延迟一下再戳回去，避免"秒回"的机械感
    const delay = 400 + Math.random() * 1200
    await sleep(delay)

    let ok = false
    try {
      ok = await this.pokeBack(groupId, fromId)
    } catch (e) {
      this.log.warn?.(`bridge：戳回去失败 — ${String(e?.message ?? e)}`)
    }

    // 有时再加一句话（默认 25%），纯戳回去更像是"懒得打字"
    const textChance = typeof cfg.textChance === 'number' ? cfg.textChance : 0.25
    let said = null
    if (cfg.text !== false && Math.random() < textChance) {
      const lines = Array.isArray(cfg.lines) && cfg.lines.length
        ? cfg.lines
        : ['别戳了别戳了', '干嘛', '戳我干嘛', '在的在的', '哎哟', '有事说事']
      said = lines[Math.floor(Math.random() * lines.length)]
      try {
        if (groupId) await this.onebot.sendGroup(groupId, said)
        else await this.onebot.sendPrivate(fromId, said)
      } catch (e) {
        this.log.warn?.(`bridge：戳一戳回话失败 — ${String(e?.message ?? e)}`)
      }
    }

    this.log.info?.(`bridge：被 ${fromId} 戳了 → 已戳回${said ? ' 并说「' + said + '」' : ''}`)
    this._recordPoke(groupId, fromId, said, ok ? 'poke-back' : 'poke-failed')
  }

  /**
   * 戳回去。
   *
   * OneBot 扩展接口 `send_poke`（NapCat）：
   *   群聊传 { group_id, target_id }
   *   私聊传 { user_id }
   *
   * ⚠️ 具体采用什么参数，取决于协议端；文档示例是 `{ group_id: "123456", user_id: "123456789" }`，
   *    但实现里读的是 `target_id ?? user_id`。这里**两个都传**，兼容两种读法。
   */
  async pokeBack(groupId, userId) {
    const params = groupId
      ? { group_id: Number(groupId), user_id: Number(userId), target_id: Number(userId) }
      : { user_id: Number(userId), target_id: Number(userId) }
    const res = await this.onebot.call('send_poke', params, 8000)
    if (res?.status === 'failed' || (typeof res?.retcode === 'number' && res.retcode !== 0)) {
      throw new Error(`send_poke 返回失败：${JSON.stringify(res).slice(0, 160)}`)
    }
    return true
  }

  /** 把戳一戳记进最近交互（Web 界面能看到）。 */
  _recordPoke(groupId, fromId, reply, outcome) {
    const back = outcome === 'poke-back'
    this.recent.unshift({
      at: Date.now(),
      scope: groupId ? `group:${groupId}` : `private:${fromId}`,
      senderName: String(fromId),
      text: '[戳一戳]',
      images: [],
      mentionsMe: true,
      decision: {
        reply: back,
        // ⚠️ 不要写死 1 —— 显示「概率 1」却说沉默，看着像坏了。
        //    这里给的是"本次是否理会"的**实际结果**，概率沿用配置值，
        //    用户一眼能对上是"撞上了那 25% 没理"。
        probability: back ? 1 : 0,
        reason: back ? '被戳了一下，戳回去' : '被戳了一下，本次随机不理',
        provider: 'poke',
      },
      reply: reply ?? null,
      outcome,
    })
    if (this.recent.length > 50) this.recent.length = 50
  }

  /**
   * @param {object} msg 规范化后的消息
   * @param {number} [seq] 本条在 scope 内的入站序号（由 onEvent 分配）
   */
  async _handle(msg, seq) {
    const mem = this.memory.get(msg.scope)
    const now = Date.now()

    // 0. 这条是不是**在回复我**？
    //
    // ⚠️ 不能只看 @。实测踩过：群里有人**直接引用机器人刚说的话**回
    //    「那还不是决策层叫你发的」—— 那明显是在跟它对话，但因为它只在
    //    "被 @"时才知道跟自己有关，这条被当普通闲聊掷骰子 → 一半概率沉默。
    //
    //    做法：拿到被引用消息的 id，去最近历史里找，看它是不是我发的。
    //    是 → 等价于"被 @"（决策层用同一个 mentionsMe 字段处理）。
    const quotedMine = Boolean(
      msg.replyTo && mem.recent(20).some((m) => m.isMe && String(m.id ?? '') === String(msg.replyTo)),
    )
    if (quotedMine) {
      this.log.info?.('bridge：这条是在引用我自己的消息 → 按"被叫"处理')
    }

      // 1. 存记忆
      //
      // ⚠️ 补回（defer 重试）时会再次走这里 —— 同一条消息不能存两遍，
      //    否则记忆里出现重复，模型看到"用户连说了两次一样的话"。
      //    用 messageId 判重（它在一轮里唯一）。
      const alreadyInMemory = msg.messageId !== undefined
        && mem.recent(20).some((m) => String(m.id ?? '') === String(msg.messageId))
      if (!alreadyInMemory) {
        mem.push(makeMessage({
          id: msg.messageId,
          sender: msg.userId,
          senderName: msg.senderName,
          text: msg.text,
          at: msg.at || now,
          mentionsMe: (this.selfId ? msg.isAtMe(this.selfId) : false) || quotedMine,
          isMe: false,
          images: msg.images,
          // 引用回复的对象 id —— 决策层靠它区分「在跟我说」和「在跟别人说」。
          // 之前这个信息只在 quotedMine 里用了一次就丢了，导致
          // 「小红：你今天怎么了？」（引用另一个群友）被判成在追问机器人。
          replyTo: msg.replyTo ?? null,
        }))
      }
      mem.tick(now, this.decision?.threshold ? 60000 : 60000)

    // 1b. 自动收藏别人发的表情包（异步，不阻塞回复）
    //
    // 放在存记忆之后、决策之前：收藏是"顺手做的事"，即使这条消息最终
    // 沉默也该收藏 —— 用户发个表情过来，机器人不理它但悄悄存下来，
    // 下次就能用。这也正是用户要的"偷偷收藏别人的表情包"。
    void this._autoCollectStickers(msg)

    // 2. 决策
    this.stats.considered++
    const scene = await this.sceneOf(msg)
    // aliases：群里实际怎么叫它（鱼 / 鲸鱼 / 白饭 …）。
    // 由配置 `decision.aliases` 提供；不给就用 rule.js 里的默认表。
    const self = {
      qq: this.selfId ?? '0',
      nickname: this.selfName,
      aliases: this.cfg.decisionAliases ?? this.cfg.aliases,
    }

    let d
    try {
      const input = mem.toDecisionInput(scene, self, now)
      // 已知群友名单：决策层用它判断「这句话是不是在跟别人说」——
      // 句中出现了别人的名字且没提我 → 不当作在追问我。
      // 直接从近期记忆里归纳（不需要额外配置，也不需要协议端接口）。
      input.peers = this._knownPeers(mem)
      d = await this.decision.shouldReply(input)
    } catch (e) {
      this.log.warn?.(`bridge：决策失败（跳过本条）— ${String(e?.message ?? e)}`)
      return
    }

    // ⚠️ 决策结果必须是 info —— 沉默是用户最关心的行为（"它为什么没回"），
    //    debug 级在日志里完全不可见，出问题只能瞎猜（实测踩过：用户反馈
    //    "沉默逻辑有问题"，日志里 0 条决策记录，什么都对不上）。
    //    附上消息摘要与图片标记，一条日志能同时回答"看到什么"和"为什么沉默"。
    const textBrief = String(msg.text ?? '').replace(/\s+/g, ' ').slice(0, 40)
    const imgBrief = (msg.images ?? []).length > 0 ? ` 图×${msg.images.length}` : ''
    this.log.info?.(`bridge：${msg.scope}「${textBrief}」${imgBrief} 决策 → ${this.decision.explain?.(d) ?? JSON.stringify(d)}`)

    if (!d.reply) {
      // ── 因冷却而沉默 → 排队，冷却结束后再回 ────────────────
      //
      // 决策层用 `defer` 区分两种"不回"：
      //   · 真的不想回（概率太低、连续发言太多）→ 丢弃
      //   · 冷却还没过 → **记下来，过一会儿补回**
      // 没有这一步的话，冷却期内问它的话就永久丢了，用户看到的是
      // "问了不理我"，而其实只是晚了十几秒。
      if (d.defer && Number.isFinite(d.defer.waitMs)) {
        this._enqueueDeferred(msg, mem, scene, self, d)
        this.stats.silent++
        this._record(msg, d, null, 'deferred')
        this._maybeSummarize(msg.scope, mem, scene)
        return
      }
      this.stats.silent++
      this._record(msg, d, null, 'silent')
      // 即使不说话，也可以趁机更新长期记忆
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }

    // 3. 按人的节奏延迟
    if (d.delayMs && d.delayMs > 0) {
      await sleep(d.delayMs)
    }

    // ⚠️ 3b. 延迟/生成期间群里可能又来了新消息（2026-10-23 补）
    //
    // 真人遇到这种情况会先看一眼新内容再开口；原来这边完全不管 ——
    // 延迟 5 秒、生成 30 秒，等真正发出去时话题可能早就翻篇了，
    // 群友看到的就是一句答非所问。
    //
    // 判据收得很紧，**只处理"明显过时"**，避免误伤正常的慢回复：
    //   · 这段时间里别人至少说了 2 条，**且**
    //   · 这些新消息里没有任何一条提到我（没人在等我这个答案）
    // 满足就放弃发送，交给后面的消息自己触发新一轮判断。
    const superseded = this._checkSuperseded(msg, mem, { afterSeq: seq })
    if (superseded) {
      this.stats.superseded = (this.stats.superseded ?? 0) + 1
      this.log.info?.(`bridge：等待期间群里又说了 ${superseded.count} 条且没叫我，放弃本条回复（避免答非所问）`)
      this._record(msg, d, null, 'superseded')
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }

    // 4. 生成回复
    let text
    let cover = null
    try {
      const gen = await this._generate(msg, mem, scene, self)
      // _generate 返回 { text, cover } —— cover 是搜索时顺手抓的封面图
      text = gen?.text ?? ''
      cover = gen?.cover ?? null
    } catch (e) {
      this.stats.failed++
      this.log.warn?.(`bridge：生成失败 — ${String(e?.message ?? e)}`)
      this._record(msg, d, null, 'error:' + String(e?.message ?? e))
      return
    }

    // ⚠️ 4b. 生成完了再确认一次：这条回复还跟得上吗？
    //
    // 生成往往是最慢的一步（推理模型几十秒）。这段时间里如果别人已经
    // 把话题岔开、或者**已经有人替它回答了**，再发就是刷屏。
    //
    // ⚠️ 阈值和延迟后那次**保持一致（都是 2）**，不能用更大的数：
    //    `_inboundAfter(seq)` 数的是「本条之后到达的全部消息」，
    //    不是「生成期间新增的」。两处用不同阈值会让「延迟期到 2 条、
    //    生成期 0 条」这种情况在最后一道闸被放过去 —— 实测就是这么漏的。
    //    这已经是发送前最后一道闸，口径统一才不会漏。
    const stale = this._checkSuperseded(msg, mem, { afterSeq: seq })
    if (stale) {
      this.stats.superseded = (this.stats.superseded ?? 0) + 1
      this.log.info?.(`bridge：生成期间群里又说了 ${stale.count} 条且没叫我，本条回复已过时，丢弃`)
      this._record(msg, d, text, 'stale')
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }

    // ⚠️ [SILENT] 只该在**整条就是它**时才算"不说话"。
    //
    //    原来写的是 `text.includes(SILENT)` —— 只要回复里任何位置出现
    //    这个标记就整条丢弃。而模型经常这样回：
    //        「[表情包][SILENT]」 或 「好了[SILENT]」
    //    于是**决定发言也被当成沉默**，一个字都发不出去。
    //    实测症状：界面上显示「发言 p=0.95」但 outcome 是 model-silent，
    //    计数里 replied 一直是 0。
    //
    //    正确做法：剥掉标记，**看剩下的还有没有实质内容**。
    const stripped = String(text ?? '').replace(/[\[［]\s*[SILENTsilent]{6}\s*[\]］]/g, '').trim()
    if (!stripped) {
      this.stats.silent++
      this._record(msg, d, null, 'model-silent')
      this._maybeSummarize(msg.scope, mem, scene)
      return
    }
    if (stripped !== text) {
      this.log.info?.(`bridge：回复里混了 [SILENT]，已剥掉后发出 — ${JSON.stringify(stripped.slice(0, 40))}`)
    }
    text = stripped

    // 5. 发送
    try {
      const sentIds = await this._send(msg, text, cover)
      this.stats.replied++
      mem.push(makeMessage({
        // ⚠️ 用自己的 message_id 记录这条回复。
        //    这样别人**引用我的话**回复时，能通过 replyTo 匹配到它，
        //    从而认出"这是在对我说"（见 _handle 的 quotedMine）。
        //    多段消息只记最后一条的 id —— 用户通常引用最后那条。
        id: sentIds.length ? sentIds[sentIds.length - 1] : undefined,
        sender: this.selfId ?? '0',
        senderName: this.selfName,
        text,
        at: Date.now(),
        isMe: true,
        // 记下这条回复是哪家渠道/哪个模型生成的 —— 往上送历史时
        // dsh-llm 要求 assistant 消息带 source，见 makeMessage 的注释
        provider: this._lastRoute?.provider ?? null,
        model: this._lastRoute?.model ?? null,
      }))
      this._record(msg, d, text, 'sent')
      // 记下自己发出的 message_id —— 过时检测要靠它认出
      // 「后续消息引用了我的回复」= 有人在追问我，不能判过时。
      this._rememberMyReplyIds(msg.scope, sentIds)
    } catch (e) {
      this.stats.failed++
      this.log.warn?.(`bridge：发送失败 — ${String(e?.message ?? e)}`)
      this._record(msg, d, text, 'send-error:' + String(e?.message ?? e))
    }

    this._maybeSummarize(msg.scope, mem, scene)
  }

  /**
   * 把消息里的图片抓成 **dsh-llm 的 ImageBlock**（多模态用）。
   *
   * 流程：OneBot 的图片引用 → fetchImage 拿到 base64 → 存进 attachment
   * store 拿 attachmentId → 组装 ImageBlock。中间任何一步失败都跳过该图
   * （不抛错），退化成"只有文字"的请求 —— 至少机器人还能回话。
   *
   * 只抓**最近一条**带图的消息，且限制张数 —— 历史图片对当前回复没有价值，
   * 反而把 token 烧光（尤其是免费渠道的上下文预算）。
   *
   * @param {Array} recent 最近的消息（升序）
   * @returns {Promise<Map<string, object>>} 原图片引用 → ImageBlock
   */
  async _collectImages(recent) {
    const out = new Map()
    // 配置里显式关掉就不抓（省钱 / 模型不支持图片时）
    if (this.cfg.reply?.imagesEnabled === false) {
      this.log.info?.('bridge：配置里 imagesEnabled=false —— 不抓图（模型只能看到"[图片]"文字）')
      return out
    }
    // 没有 attachment 服务就只能走纯文本（否则请求必然报错）
    if (typeof this.gateway?.makeImageBlock !== 'function') {
      this.log.warn?.('bridge：attachment 服务不可用 —— 图片降级为文字（检查 DSH 的 dsh-attachment-local 是否装载）')
      return out
    }

    // 从最新往前找，只取一条
    const withImg = [...recent].reverse().find((m) => !m.isMe && (m.images ?? []).length > 0)
    if (!withImg) return out

    const refs = withImg.images.slice(0, this.cfg.reply?.maxImages ?? 2)
    // ⚠️ 这几条以前是 debug 级 —— 图坏了日志里什么都看不到，用户只能猜。
    //    图片属于"看不见就是功能坏了"的东西，失败必须留下痕迹。
    this.log.info?.(`bridge：发现 ${refs.length} 张待取图片（引用示例：${String(refs[0]).slice(0, 80)}）`)
    for (const ref of refs) {
      try {
        const img = await this.onebot.fetchImage(ref, { maxBytes: this.cfg.reply?.maxImageBytes ?? 4 * 1024 * 1024 })
        if (!img?.dataUrl) {
          this.log.warn?.(`bridge：取图失败（拿不到可下载内容）ref=${String(ref).slice(0, 80)}`)
          continue
        }
        // dataUrl 形如 data:image/png;base64,XXXX —— 拆出纯 base64 与 mime
        const m = /^data:([^;]+);base64,(.*)$/s.exec(img.dataUrl)
        if (!m) continue
        const block = await this.gateway.makeImageBlock({
          base64: m[2],
          mediaType: m[1],
          name: 'qq-image',
        })
        if (block) out.set(ref, block)
        else this.log.warn?.('bridge：图片入库失败（makeImageBlock 返回空）')
      } catch (e) {
        this.log.warn?.(`bridge：取图失败 — ${String(e?.message ?? e)}`)
      }
    }
    if (out.size > 0) this.log.info?.(`bridge：已附图 ${out.size} 张（多模态）`)
    else this.log.warn?.('bridge：有图片但一张都没入库，本条按纯文本发送')
    return out
  }

  /**
   * 当前这条消息是不是**已经被群里新出现的内容取代**了？
   *
   * 用途：延迟/生成期间如果群里又聊开了，原来那条回复可能已经过时。
   * 直接发出去就是"答非所问"，比沉默更伤。
   *
   * ## 为什么读 `_inbound` 而不是 `mem`
   *
   * ⚠️ 这是 2026-10-23 修的一个真 bug。
   *
   * 同会话是**串行**的：第一条在 sleep/生成时，第二条的 `_handle` 还没
   * 开始跑，所以**还没写进 mem**。原来这里读 `mem.recent()`，于是
   * 「已经到达、正在排队」的消息对检测完全不可见 —— 过时检测永远返回
   * null，等于没做。
   *
   * 实测（tests/_probe-concurrency.mjs）：第一条生成期间连发两条，
   * mem 里只有 1 条，检测返回 null，三条全部照发。
   *
   * 现在读 `_inbound`（入口即写、不受串行队列阻塞），能看到排队中的消息。
   *
   * ## 判据（必须**同时**满足，避免误伤）
   *
   *   ① 我这条之后，别人又来了 ≥ minNew 条
   *   ② 这些新消息里**没有任何一条提到我**（没人在等这个答案）
   *   ③ 这些新消息里**没有对我的引用回复**（那说明有人在追问我）
   *
   * 只要有人提到我或引用我，就照常发送 —— 说明这个答案还有人在等。
   *
   * @param {object} msg   触发本次回复的消息
   * @param {object} mem   ConversationMemory（保留参数以兼容旧调用，本函数不再读它）
   * @param {object} [opts]
   * @param {number} [opts.minNew] 至少几条新消息才算过时（默认 2）
   * @param {number} [opts.afterSeq] 本条消息的入站序号；缺省时按 messageId 反查
   * @returns {null|{count:number}} null = 没过时
   */
  _checkSuperseded(msg, mem, opts = {}) {
    const minNew = Number(opts.minNew ?? 2)
    const scope = String(msg?.scope ?? 'unknown')

    // 本条的入站序号：优先用调用方传的（_handle 里一定知道），
    // 否则按 messageId 反查 —— 兼容直接调用（如测试）。
    let seq = Number(opts.afterSeq)
    if (!Number.isFinite(seq)) {
      const myId = msg?.messageId != null ? String(msg.messageId) : null
      const rec = this._inbound?.get(scope)
      const hit = myId && rec ? rec.entries.find((e) => e.messageId === myId) : null
      if (!hit) return null        // 查不到序号 → 无法判断，宁可不过时
      seq = hit.seq
    }

    const newer = this._inboundAfter(scope, seq)
    if (newer.length < minNew) return null

    // 有人提到我 / 引用我 → 这个答案还有人在等，照常发
    for (const e of newer) {
      if (e.mentionsMe) return null
      // 引用的如果是**我的回复**，说明在追问我
      // （e.replyTo 指向自己那条消息也算：他在追问自己刚问的那句）
      if (e.replyTo != null && (e.replyTo === (msg?.messageId != null ? String(msg.messageId) : null))) return null
      if (e.replyTo != null && this._isMyReplyId(scope, e.replyTo)) return null
    }

    return { count: newer.length }
  }

  /**
   * 这个 messageId 是不是**我发出去的**回复？
   *
   * 用途：判断后续消息里的引用回复是不是在追问我。
   * 我自己发的消息 id 记在 mem 里（isMe 那条的 id）。
   *
   * @param {string} scope
   * @param {string} id
   * @returns {boolean}
   */
  _isMyReplyId(scope, id) {
    if (!this._myReplyIds) this._myReplyIds = new Map()
    const set = this._myReplyIds.get(String(scope))
    return Boolean(set && set.has(String(id)))
  }

  /**
   * 记下自己发出的回复 id（按 scope 分组）。
   *
   * 只需要最近一小段：过时检测只看「我这条之后」的消息，
   * 而它们能引用到的我的回复必然是最近的。
   *
   * @param {string} scope
   * @param {string[]} ids
   */
  _rememberMyReplyIds(scope, ids) {
    if (!Array.isArray(ids) || ids.length === 0) return
    if (!this._myReplyIds) this._myReplyIds = new Map()
    const key = String(scope ?? 'unknown')
    let set = this._myReplyIds.get(key)
    if (!set) { set = new Set(); this._myReplyIds.set(key, set) }
    for (const id of ids) {
      if (id != null) set.add(String(id))
    }
    // 只留最近 50 个
    if (set.size > 50) {
      const arr = [...set]
      this._myReplyIds.set(key, new Set(arr.slice(arr.length - 50)))
    }
  }

  /** 组装场景描述（群名走缓存）。 */
  async sceneOf(msg) {
    if (msg.kind !== 'group') return { kind: 'private', userId: msg.userId }
    return { kind: 'group', groupId: msg.groupId, groupName: await this.groupName(msg.groupId) }
  }

  /**
   * 从近期记忆里归纳「这个群里都有谁」（id + 显示名）。
   *
   * 用途：决策层判断「当前这句话是不是在跟**别的群友**说」。
   * 例：机器人答完话，小红说「你今天怎么了？」—— 「你」指的是另一个
   * 群友，不是机器人。要识别这一点，得先知道群里有哪些名字。
   *
   * ⚠️ 只从**已有记忆**归纳，不额外调协议端接口：
   *    · 零成本、零延迟
   *    · 名字本来就在消息里（senderName），够用
   *    · 名单会随记忆窗口自然滚动，不会无限增长
   *
   * @param {object} mem ConversationMemory
   * @returns {Array<{id:string,name:string}>}
   */
  _knownPeers(mem) {
    const out = []
    const seen = new Set()
    for (const m of mem.recent(30)) {
      if (m.isMe) continue
      const id = String(m.sender ?? '')
      const name = String(m.senderName ?? '').trim()
      // 名字太短容易误伤（「甲」「乙」这种单字），也认不出什么
      if (name.length < 2 || seen.has(id)) continue
      // 名字等于机器人自己的名字 → 不是在叫别人
      if (this.selfName && name === this.selfName) continue
      seen.add(id)
      out.push({ id, name })
    }
    return out
  }

  /** 调 LLM 生成回复。 */
  async _generate(msg, mem, scene, self) {
    const long = this.longMemory?.get(msg.scope)
    const memoryText = long?.toPrompt() ?? ''

    // ── 联网搜索（只在"需要新信息"时才查）─────────────────────
    //
    // 为什么需要：各免费渠道的模型训练数据都有截止日期。实测踩过 ——
    // 群里发了「GPT-6 Luna 已开放」的截图，机器人回「这图一眼假，纯段子」，
    // 而 GPT-6 Luna 确实存在（连它自己的模型库里都有）。
    //
    // ⚠️ 不能每条都搜：一次 5~15 秒，群聊里绝大多数是闲聊。
    //    触发判断在 search.js 的 needsFreshInfo()，收得比较紧。
    let searchContext = ''
    /** 本次回复备下的封面图（随返回值带走，避免实例变量竞态）。 */
    let pendingCover = null
    const qqCfg = this.cfg.search ?? {}
    if (qqCfg.enabled !== false && this.searchKey) {
      const hit = needsFreshInfo(msg.text)
      if (hit.need) {
        try {
          this.log.info?.(`bridge：需要联网（${hit.why}）→ 查「${hit.query.slice(0, 40)}」`)
          const r = await webSearch({
            question: hit.query,
            apiKey: this.searchKey,
            maxUses: qqCfg.maxUses ?? 3,
            timeoutMs: qqCfg.timeoutMs ?? 20000,
            log: (m) => this.log.info?.(`bridge：${m}`),
          })
          if (r.ok) {
            searchContext = formatSearchContext(r)
            this._lastSearch = { at: Date.now(), query: hit.query, sources: r.sources.slice(0, 5), ms: r.ms }

            // 搜索成功时也顺手看一眼余额（低频，一天查几次就够）。
            // 只在**该提醒时**才设标记，避免每条消息都查接口。
            try {
              const lastCheck = this._balanceCheckedAt ?? 0
              if (Date.now() - lastCheck > 6 * 3600_000) {
                this._balanceCheckedAt = Date.now()
                const b = await checkBalance(this.searchKey, 6000)
                if (b.ok) {
                  this._balance = b
                  this._balanceLow = b.cny <= (this.cfg.search?.lowBalanceCny ?? 2)
                  if (this._balanceLow) {
                    this.log.warn?.(`bridge：搜索余额偏低 ¥${b.cny}`)
                  }
                }
              }
            } catch { /* 查不到就算了 */ }

            // 把搜索本身的 token 记进用量统计。
            //
            // ⚠️ 搜索走的是 DeepSeek 官方 key（真花钱），而聊天走免费渠道。
            //    不记这一笔的话侧栏"折合费用"会显示 0，用户以为搜索不花钱 ——
            //    实际每月几十上百次就是几十块。
            try {
              const u = r.usage ?? {}
              if ((u.in ?? 0) + (u.out ?? 0) > 0) {
                this.usage?.record?.({
                  provider: 'deepseek-official',
                  model: r.model ?? 'deepseek-flash',
                  source: 'search',
                  tokensIn: u.in ?? 0,
                  tokensOut: u.out ?? 0,
                  // ⚠️ 必须传 —— Search 接口按**次**收费（¥0.005/次），
                  //    不传的话只算 token，会低估一半以上（简单问题时
                  //    按次费比 token 费还高）。
                  searches: u.searches ?? 0,
                  ok: true,
                  ms: r.ms,
                })
                this.log.info?.(`bridge：搜索用量已记录（in=${u.in} out=${u.out}，搜了 ${u.searches} 次）`)
              }
            } catch { /* 统计失败不影响回复 */ }

            // 顺手抓一张封面图 —— 聊到具体作品/产品时，配张图比纯文字更像人。
            // 抓不到就算了（pickCoverImage 内部吞掉所有错误），不影响回复。
            if (this.cfg.search?.images !== false) {
              try {
                const img = await pickCoverImage(r.sources, { maxProbe: 3, timeoutMs: 4000 })
                if (img) {
                  pendingCover = img
                  this.log.info?.(`bridge：备好封面图 ${img.url.slice(0, 80)}`)
                }
              } catch { /* 图是锦上添花 */ }
            }
          } else {
            this.log.warn?.(`bridge：联网失败（按无联网继续）— ${r.error}`)

            // ⚠️ 搜索失败最常见的两个原因：网络不通、**余额见底**。
            //    后者以前完全是静默的 —— 用户只看到"它怎么老是不联网"，
            //    根本不知道去充值。这里查一次余额留个记号，下一条回复
            //    会顺带提一句（大肥鱼的"要 token"人格正好用上）。
            try {
              const b = await checkBalance(this.searchKey, 6000)
              if (b.ok) {
                this._balance = b
                if (b.cny <= (this.cfg.search?.lowBalanceCny ?? 2)) {
                  this._balanceLow = true
                  this.log.warn?.(`bridge：搜索余额偏低 ¥${b.cny}（阈值 ¥${this.cfg.search?.lowBalanceCny ?? 2}）`)
                }
              }
            } catch { /* 查不到就算了 */ }
          }
        } catch (e) {
          this.log.warn?.(`bridge：联网异常（按无联网继续）— ${String(e?.message ?? e)}`)
        }
      }
    }

    // 最后一条是表情/图片时，给一句"临场提醒"。
    //
    // 为什么要单独提醒：人格里虽然有通用规则，但模型很健忘 ——
    // 实测收到猫的表情包时它还是会回「这猫是被吓到了还是被丑到了」。
    // 在这条请求里明确点一下，效果好得多（而且不占常驻 prompt 的篇幅）。
    const lastText = String(mem.recent(1)[0]?.text ?? '')
    const mediaHint = /\[表情包|\[表情:|\[图片\]/.test(lastText)
      ? (this.cfg.reply?.mediaHint !== false
        ? '## 这条消息带了表情/图片\n' +
          '对方发的是表情或图 —— **不要描述图里有什么**（对方自己知道）。\n' +
          '直接**回一个表情**（[表情:N] 或 [表情包]）最自然，' +
          '最多再配几个字的语气词（「哈哈」「确实」「绷不住了」）。\n' +
          '只有在图里确实有**对方不知道的新信息**（新闻、数字、别人的聊天记录）时，才谈内容。\n' +
          // ⚠️ 这条是 2026-10-19 补的，实测踩过：模型会把消息里那句
          //    「（对方发了个QQ表情，id=20）」**当成正文复述出来**，
          //    群友看到的是一句机械旁白。那段括号是系统给它看的注解，
          //    不是对话内容 —— 必须明说，否则它会照抄。
          '⚠️ 消息里形如「（对方发了个QQ表情，id=20）」的括号是**系统注解**，' +
          '告诉你对方发了什么，**不是对话内容**。绝对不要把它写进你的回复里。'
        : '')
      : ''

    const system = this.persona.buildSystemPrompt({
      memory: memoryText,
      scene,
      self,
      extras: [
        searchContext,
        mediaHint,
        // 余额偏低时的提醒。
        //
        // ⚠️ 不写"请充值"这种客服腔 —— 大肥鱼的人格里有「Token 是脑力口粮」
        //    「我要 token」「白米饭」这一串设定，直接让她按性格抱怨就行。
        //    也不用每条都说：只在 searchEnabled 且确实低的时候挂一句，
        //    而且明确"最多提一两次"，免得变成复读机。
        this._balanceLow
          ? `## 你的 Token 快没了
你查资料用的钱包里只剩 ¥${this._balance?.cny ?? 0} 了（搜索是要花钱的，聊天不用）。
这属于**你自己的脑力口粮**，符合你会念叨 Token 的性格 —— 可以自然地抱怨一句，
比如"钱包要空了""再不喂我要饿死了""白米饭！"之类。
⚠️ 但**最多提一次**，别每条都念，也别把话题整个带跑。`
          : '',
        (this._balanceWarned = this._balanceLow, ''),
        // ⚠️ 关键：告诉模型"该不该说话已经由决策层定好了"。
        //
        //    人格里写着「如果决定不说话，只输出 [SILENT]」，那是给**决策层**
        //    用的约定。但生成层也会看到这句，于是它又自己判一次
        //    "我觉得不必说话" → 吐 [SILENT] → 整条被丢掉。
        //
        //    实测症状极具迷惑性：界面上明明显示「发言 p=0.95」，
        //    outcome 却是 model-silent，计数里 replied 一直是 0 ——
        //    两层都做了同一个决定，而第二层把第一层否掉了。
        //
        //    所以这里明确划清职责：**你来就负责说，别再纠结说不说**。
        '## 这条是你已经决定要接的话\n' +
        '「该不该说话」由上层判断过了，结论是——**要说**。\n' +
        '所以：**不要输出 [SILENT]**，也不用再权衡要不要开口。\n' +
        '你的任务只是把这句话说好。真的无话可说时，回一个表情\n' +
        '（[表情:N] 或 [表情包]）也比沉默好。',
        `## 上下文提示
距你上次说话：${Number.isFinite(mem.sinceMyLast()) ? Math.round(mem.sinceMyLast() / 1000) + ' 秒' : '很久/还没说过'}
你已连续发言：${mem.consecutiveTurns} 轮
当前时间是 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      ].filter(Boolean),
    })

    // 最近几条里有图片的话，抓成 **ImageBlock**（受大小限制）
    //
    // ⚠️ 必须是 dsh-llm 认的 ImageBlock（{type:'image', attachment:{attachmentId,…}}），
    //    不能传 {type:'image', url:'data:…'} —— 后者字段不对，上游会报
    //    "content.some is not a function" / "reading 'replayState'"。
    // 取最近 10 条里的图（原来是 6）。
    //
    // 为什么放宽：图上一条消息问「这图里是什么」很常见，而 6 条在活跃群里
    // 一眨眼就滑过去了 —— 图还在记忆里但已经不在收集窗口内，模型只看到
    // 「（对方发了一张图）」却拿不到图，只能瞎猜或者装作没看见。
    const imageCache = await this._collectImages(mem.recent(10))

    const messages = buildChatMessages({
      system,
      history: mem.recent(20),
      imageCache,
      lastRoute: this._lastRoute,
    })

    // 走网关的路由（免费优先）
    // 用 _candidatesAsync —— 它会先等目录就绪（冷启动那几秒目录是空的）
    const candidates = await this._candidatesAsync()
    if (candidates.length === 0) throw new Error('没有可用的 LLM 渠道')

    // ⚠️ maxTokens：**0 / 空 = 不限制** —— 直接**不传这个字段**，
    //    让上游用自己的上限（实测这样最快且正文正常）。
    //
    //    实测反直觉但很重要 —— 同一道题：
    //      maxTokens=4096    68s  推理 8469 字  正文  0 字（被推理吃光）
    //      不传（无限）      34s  推理 3997 字  正文 24 字
    //    推理没有天然终点，给个中等上限它会一路顶到极限、正文全没。
    const mt = Number(this.cfg.maxTokens)
    const request = { messages }
    if (Number.isFinite(mt) && mt > 0) request.maxTokens = mt
    // 推理等级：用户在侧栏「推理等级」下拉里选的。
    //
    // ⚠️ 必须**校验这个等级对当前模型是否合法**，不能直接透传。
    //    等级是模型相关的：gemini 支持 tiered，buddy 不支持。用户在 auto
    //    模式下选了一个并集里的等级（比如 tiered），之后模型切到 buddy，
    //    这个值就非法了 —— 透传会让**每一次**生成都失败：
    //      provider "buddy" model "xxx" does not support reasoning effort "tiered"
    //    用户看到的是"机器人不回复了"，完全联想不到是等级不匹配。
    //    这里按 resolveModelInfo 报的 efforts 校验，不合法就退回默认（不传）。
    if (typeof this.cfg.effort === 'string' && this.cfg.effort !== '') {
      const wanted = this.cfg.effort
      // 只对**显式指定**的模型校验：auto 模式下每个候选模型的等级集合都不同，
      // 逐候选校验代价太高（每个都要 resolveModelInfo）。auto 时宁可不传等级，
      // 让适配器用自己的默认 —— 这样永远不会因为等级不匹配而整轮失败。
      const explicit = this.cfg.model !== undefined && this.cfg.model !== '' && this.cfg.model !== 'auto'
      if (explicit) {
        let ok = false
        try {
          const info = await this.gateway?.resolveModelInfo?.(candidates[0]?.provider, candidates[0]?.model)
          const list = (info?.reasoning?.efforts ?? []).map((e) => (typeof e === 'string' ? e : e?.id)).filter(Boolean)
          ok = list.includes(wanted)
          if (!ok && list.length > 0) {
            this.log.warn?.(`bridge：模型 ${candidates[0]?.provider}/${candidates[0]?.model} 不支持推理等级 "${wanted}"（支持：${list.join('/')}），本次改用默认`)
          }
        } catch { ok = true /* 查不到就照传，交给适配器判断 */ }
        if (ok) request.reasoningEffort = wanted
      }
    }

    const opened = await openFirstAvailable({
      llm: this.gateway,
      candidates,
      request,
      onAttempt: (a) => {
        if (!a.ok) this.log.debug?.(`bridge：渠道 ${a.provider}/${a.model} 不可用 — ${a.error}`)
      },
    })

    // 图片进没进请求 + 路由到了哪个模型 —— 两者决定"它到底看没看到图"：
    //   · imageCache 为空 → 模型只看到 "[图片]" 文字，当然"看不见"
    //   · 路由到纯文本模型（auto 模式可能如此）→ 图传了也白传
    // 不打这条的话，用户只能从回复内容反推，出问题完全无从诊断。
    const imgCount = [...imageCache.values()].length
    if (imgCount > 0) {
      // ⚠️ 路由信息在 `opened.picked` 里，不在 `opened` 顶层。
      //    openFirstAvailable 返回 { stream, picked, attempts } —— 之前写成
      //    opened.provider 永远得到 undefined，日志打成 "发给 ?/?"，
      //    等于这条诊断信息完全没用（想查"图发给了哪个模型"查不到）。
      const picked = opened.picked ?? {}
      const where = picked.provider !== undefined ? `${picked.provider}/${picked.model}` : '未知渠道'
      this.log.info?.(`bridge：本条带 ${imgCount} 张图发给 ${where}（若模型不支持视觉，图等于没传）`)
    }

    let text = ''
    let reason = ''
    let ttftMs = null
    let finish = null
    const t0 = Date.now()
    // 记住这次用的渠道/模型 —— 存自己的回复进记忆时要用它填 assistant 的 source
    // 同样是 opened.picked（见上面 openFirstAvailable 的返回结构）
    const routePicked = opened.picked ?? {}
    this._lastRoute = { provider: routePicked.provider ?? null, model: routePicked.model ?? null }
    // 用量：优先用上游返回的 usage（准确），拿不到就按字符估算。
    let usage = null
    try {
      for await (const chunk of opened.stream) {
        const t = chunk?.type
        // 首字延迟：用户感知的"反应快不快"。推理模型可能先吐几百字思考，
        // 那段时间群里就是干等 —— 所以把它单独记下来做统计。
        if ((t === 'text-delta' || t === 'text' || t === 'reasoning-delta') && ttftMs === null) {
          ttftMs = Date.now() - t0
        }
        if (t === 'text-delta' || t === 'text') text += chunk.text ?? ''
        else if (t === 'reasoning-delta' || t === 'reasoning') reason += chunk.text ?? ''
        else if (t === 'usage') usage = chunk.usage ?? chunk
        else if (t === 'finish') {
          finish = chunk.reason
          if (chunk.usage) usage = chunk.usage
          if (chunk.reason?.kind === 'error') {
            throw new Error(chunk.reason.failure?.message ?? '模型返回错误')
          }
        }
      }
    } finally {
      // ⚠️ 无论成功失败都要记 —— 失败的调用同样消耗了上游 token
      try {
        this._trackUsage(opened, messages, text, usage, Date.now() - t0, { ttftMs, reasonChars: reason.length })
      } catch { /* ignore */ }
      // ⚠️ 非正常结束要留痕。
      //
      // 实测踩过：群里收到「[表情:」这串字面文本 —— 生成被截断在标记中间，
      // 残缺的标记不匹配发送时的正则，就被当普通文本发出去了。
      // 不打日志的话完全看不出"这次是截断的"。
      const kind = finish?.kind
      if (kind && kind !== 'stop') {
        this.log.warn?.(`bridge：本次生成非正常结束（${kind}）—— 正文 ${text.length} 字、推理 ${reason.length} 字` +
          (text ? `，结尾：${JSON.stringify(text.slice(-20))}` : '，正文为空'))
      } else if (text && /\[表情[:：]?\s*$|\[表情包[:：]?\s*$/.test(text)) {
        this.log.warn?.(`bridge：输出结尾是残缺的表情标记，已修补/清除 — ${JSON.stringify(text.slice(-20))}`)
      }
    }
    // 把封面图**随返回值带出去**，而不是挂在 this 上。
    //
    // ⚠️ 用实例变量（this._pendingImage）会有竞态：_generate 到 _send 中间
    //    隔了几百行调用，群里并发处理两条消息时，后一条搜到的图可能被
    //    前一条的发送流程取走 —— 张冠李戴。
    const cover = pendingCover
    pendingCover = null
    return { text: cleanModelText(text), cover }
  }

  /**
   * 记一次用量。
   *
   * 网关流式接口多数不返回 usage，所以这里按字符数**估算**：
   * 中文约 1 字 ≈ 1.5 token，英文约 4 字符 ≈ 1 token。
   * 宁可粗一点，也好过总览页永远显示 0。
   */
  _trackUsage(opened, messages, outText, usage, ms, extra = {}) {
    const tracker = this.usage
    if (!tracker?.record) return

    let tokensIn = Number(usage?.prompt_tokens ?? usage?.inputTokens ?? usage?.input_tokens) || 0
    let tokensOut = Number(usage?.completion_tokens ?? usage?.outputTokens ?? usage?.output_tokens) || 0

    if (!tokensIn) {
      // 估算输入：所有消息的文本长度（图片按 200 token 粗算）
      let chars = 0, imgs = 0
      for (const m of messages) {
        const c = m.content
        if (typeof c === 'string') chars += c.length
        else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'text') chars += String(b.text ?? '').length
            else if (b.type === 'image') imgs++
          }
        }
      }
      tokensIn = Math.round(chars / 1.6) + imgs * 200
    }
    if (!tokensOut) tokensOut = Math.round(String(outText ?? '').length / 1.6)

    // ⚠️ 路由信息在 `opened.picked` 里，不在 `opened` 顶层。
    //    openFirstAvailable 返回 { stream, picked, attempts }。
    //    写成 opened.provider / opened.model 会永远得到 undefined，
    //    于是 estimateCost 拿不到价格、费用恒为 0 —— 面板上显示「¥0」。
    const picked = opened.picked ?? {}
    tracker.record({
      provider: picked.provider,
      model: picked.model,
      source: 'qq',
      tokensIn,
      tokensOut,
      // 性能统计（纯记录，不做限制）：首字延迟 / 推理长度 / 正文长度
      ttftMs: extra.ttftMs ?? null,
      reasonChars: extra.reasonChars ?? 0,
      textChars: String(outText ?? '').length,
      ok: true,
      ms,
    })
  }

  /** 决定用哪些候选渠道（复用路由策略）。 */
  async _candidatesAsync() {
    // ⚠️ 冷启动竞态：目录是异步刷新的，空的目录会让 auto 解析出零候选。
    //    第一次收到消息时目录可能还没好 —— 主动等一次（最多 15 秒）。
    if ((this.gateway.catalog?.length ?? 0) === 0 && typeof this.gateway.refreshCatalog === 'function') {
      try {
        await Promise.race([
          this.gateway.refreshCatalog(),
          new Promise((r) => setTimeout(r, 15000)),
        ])
        this.log.info?.(`bridge：目录未就绪，已等待刷新（现有 ${this.gateway.catalog?.length ?? 0} 个模型）`)
      } catch { /* 刷新失败就按现有数据继续 */ }
    }
    return this._candidates()
  }

  /** 决定用哪些候选渠道（复用路由策略）。 */
  _candidates() {
    const free = this.gateway.providers ?? []
    // bridge 默认固定用一个"聊天模型"，避免每次决策都变幻
    const prefer = this.cfg.model ?? 'auto'
    if (prefer && prefer !== 'auto') {
      return resolveCandidates(prefer, {
        freeProviders: free,
        freeOrder: this.cfg.freeOrder ?? [],
        disabledProviders: this.cfg.disabledProviders ?? [],
        catalog: this.gateway.catalog,
        selfModels: this.gateway.defaultModels?.() ?? {},
        fallback: this.cfg.fallback,
      })
    }
    // auto：按**用户配置的优先级**取第一个可用渠道。
    // ⚠️ 不能写死 'gemini' —— 用户可能把别的渠道排在前面，
    //    或者根本没有 gemini（自备渠道场景）。
    // ⚠️ 也不能写死模型名（如 'gemini-3.8-flash-medium'）—— 自备渠道
    //    （ollama 等）没有这个名字，会得到 400。统一从 defaultModels 取。
    const selfModels = this.gateway.defaultModels?.() ?? {}
    const disabled = this.cfg.disabledProviders ?? []
    const ordered = applyFreeOrder(free, this.cfg.freeOrder).filter((p) => !disabled.includes(p))

    // ⚠️ 逐个渠道找"能用的模型"，不能只看第一个。
    //
    //    踩过的坑：`PROVIDER_MODEL_HINTS` 里大多数渠道是**空数组**
    //    （那是刻意的 —— 表示"没有内置偏好，去模型目录现查"）。
    //    原来只取 ordered[0] 的 hint，hint 为空就直接返回 [] ——
    //    于是 buddy 排第一时永远"没有可用的 LLM 渠道"，哪怕目录里
    //    明明有它 18 个模型。日志表现为「已附图 1 张」紧跟
    //    「生成失败 — 没有可用的 LLM 渠道」。
    //
    //    正确的顺序：内置偏好 → 自备渠道默认模型 → 模型目录。
    const catalog = this.gateway.catalog ?? []
    for (const p of ordered) {
      const hinted = (PROVIDER_MODEL_HINTS[p] ?? [])[0]
      const fromCatalog = catalog.find((m) => m.provider === p)?.id
      const model = selfModels[p] || hinted || fromCatalog || ''
      if (model) {
        return [{ provider: p, model, kind: 'free', why: 'bridge 按配置优先级取首个可用渠道' }]
      }
    }
    return []
  }

  /**
   * 发送（可分句，像人一样）。
   *
   * 文本里的表情标记会被转成**真正的 QQ 表情段**：
   *   [表情:4]        → { type:'face', data:{ id:'4' } }        QQ 内置小黄脸
   *   [表情包:猫猫]    → 找一张匹配的收藏表情发出（见 _pickMface）
   *
   * 为什么要支持：群里本来就习惯用表情包代替打字。只会发纯文字的
   * 机器人在这种群里显得很突兀 —— 而且模型自己也会主动吐
   * `[表情:4]` 这类标记来表达情绪，不转换的话用户看到的是一串标签。
   */
  /**
   * 发送一条（可能是多段）消息。
   *
   * @returns {Promise<string[]>} 发出去的每条消息的 message_id。
   *   ⚠️ 必须返回 id —— 否则"用户引用我的话回复"就匹配不上
   *   （见 _handle 里 quotedMine 的判断）。
   */
  /**
   * @param {object} msg
   * @param {string} text
   * @param {object|null} [cover] 搜索时抓到的封面图 { url, title }
   */
  async _send(msg, text, cover = null) {
    const reply = this.cfg.reply ?? {}
    const maxChars = reply.maxChars ?? 500
    /** @type {string[]} */
    const sentIds = []

    // 先按表情标记切分：纯文本走原来的分句逻辑，表情单独成段
    const pieces = splitFaceMarkers(text)

    // 整体分句（只在连续文本段上做，避免把表情和文本混切）
    const segments = []
    for (const piece of pieces) {
      if (piece.kind === 'face' || piece.kind === 'mface') { segments.push(piece); continue }
      const chunks = reply.segment === true ? splitMessage(piece.text, maxChars) : [piece.text]
      for (const c of chunks) if (String(c).trim()) segments.push({ kind: 'text', text: String(c) })
    }

    // 搜索时备下的封面图：接在回复最后发出去。
    //
    // cover 只在**真的聊到具体作品/产品**时才有（由 _generate 随返回值带出）。
    // 它是锦上添花 —— 发送失败静默跳过，不能因此让整条回复失败。
    if (cover?.url && segments.length > 0) {
      segments.push({ kind: 'image', url: cover.url })
    }

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      let payload
      if (seg.kind === 'image') {
        // OneBot 的 image 段直接收 URL
        payload = [{ type: 'image', data: { file: seg.url } }]
      } else if (seg.kind === 'face') {
        payload = [{ type: 'face', data: { id: String(seg.id) } }]
      } else if (seg.kind === 'mface') {
        const m = await this._pickMface(seg.name)
        if (!m) continue          // 找不到对应表情就跳过，不发乱码
        payload = m
      } else {
        if (!seg.text.trim()) continue
        payload = seg.text
      }

      const res = msg.kind === 'group'
        ? await this.onebot.sendGroup(msg.groupId, payload)
        : await this.onebot.sendPrivate(msg.userId, payload)

      if (res?.status === 'failed' || (typeof res?.retcode === 'number' && res.retcode !== 0)) {
        // 图片发失败（外链失效、被反盗链拦）不影响文字回复已经发出的事实，
        // 记一条 warn 就够 —— 否则整条回复会被当成失败重试。
        if (seg.kind === 'image') {
          this.log.warn?.(`bridge：封面图发送失败（跳过）— ${JSON.stringify(res).slice(0, 120)}`)
          continue
        }
        throw new Error(`OneBot 返回失败：${JSON.stringify(res).slice(0, 200)}`)
      }
      // 记下这条的 message_id（OneBot 放在 data.message_id）
      const mid = res?.data?.message_id ?? res?.message_id
      if (mid != null) sentIds.push(String(mid))
      // 多条之间像人一样停顿
      if (i < segments.length - 1) {
        await sleep(400 + Math.random() * 600)
      }
    }
    return sentIds
  }

  /**
   * 取当前账号的**收藏表情**列表（NapCat 的 fetch_custom_face）。
   *
   * ⚠️ 这条路是实测挖出来的：OneBot 标准的 `mface` 段要 emoji_id +
   *    emoji_package_id，那是腾讯内部编号，普通用户拿不到 —— 所以按标准
   *    做法根本发不出表情包。
   *
   *    但 NapCat 有私有接口 `fetch_custom_face`，直接返回一组**可下载的
   *    GIF 地址**（实测 HTTP 200、content-type: image/gif）。于是我们
   *    把它当普通图片段发出去就行，绕开了内部编号。
   *
   * 结果缓存 10 分钟 —— 收藏会变，但没必要每次发表情都问一遍。
   */
  async _customFaces() {
    const now = Date.now()
    if (this._facesCache && now - this._facesCache.at < 600000) return this._facesCache.urls
    try {
      const res = await this.onebot.call('fetch_custom_face', {}, 8000)
      const urls = (Array.isArray(res?.data) ? res.data : []).filter((u) => typeof u === 'string' && /^https?:/.test(u))
      this._facesCache = { at: now, urls }
      if (urls.length) this.log.info?.(`bridge：取到 ${urls.length} 个收藏表情`)
      return urls
    } catch (e) {
      this.log.debug?.(`bridge：取收藏表情失败 — ${String(e?.message ?? e)}`)
      this._facesCache = { at: now, urls: [] }
      return []
    }
  }

  /**
   * 自动收藏别人发的表情包。
   *
   * ## 判据
   *
   * 只看 `msg.stickerRefs` —— 它是 onebot 解析消息时按 `sub_type === 1`
   * （或 summary 含"动画表情"）挑出来的**表情包**引用，普通图片不在里面。
   * 不靠尺寸/格式/有没有文字，那些都不准（表情包经常带文字）。
   *
   * ## 流程
   *
   *   fetchImage(引用) → base64 → 写临时文件 → add_custom_face → 删临时文件
   *
   * 为什么必须落盘：`add_custom_face` 只收本地路径，传 URL 会被 schema 拒绝。
   *
   * ## 什么时候不做
   *
   *   · 自己发的（isMe）
   *   · 配置关掉（`qq.autoCollectStickers === false`）
   *   · 收藏已经很多（超过 `qq.maxCollectedStickers`，默认 200）
   *     —— 不然总有一天把账号的收藏塞满
   *
   * @param {object} msg 规范化后的消息
   */
  async _autoCollectStickers(msg) {
    const cfg = this.cfg ?? {}
    if (cfg.autoCollectStickers === false) return
    const refs = Array.isArray(msg?.stickerRefs) ? msg.stickerRefs : []
    if (refs.length === 0) return
    if (typeof this.onebot.addCustomFace !== 'function') return

    const cap = Number(cfg.maxCollectedStickers ?? 200)
    // 收藏总数只在需要时查一次（10 分钟缓存，见 _customFaces）
    const existing = await this._customFaces()
    if (existing.length >= cap) {
      if (!this._collectCapWarned) {
        this._collectCapWarned = true
        this.log.warn?.(`bridge：收藏表情已达上限 ${cap}，停止自动收藏（可在设置里调 qq.maxCollectedStickers）`)
      }
      return
    }

    for (const ref of refs.slice(0, 3)) {
      try {
        const img = await this.onebot.fetchImage(String(ref), { maxBytes: this.cfg.reply?.maxImageBytes ?? 4 * 1024 * 1024 })
        if (!img?.dataUrl) continue
        const m = /^data:([^;]+);base64,(.*)$/s.exec(img.dataUrl)
        if (!m) continue
        const ext = (m[1].split('/')[1] ?? 'png').replace('jpeg', 'jpg')
        // 临时文件：放系统 temp，收藏完立刻删
        const tmp = path.join(os.tmpdir(), `gd-face-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
        fs.writeFileSync(tmp, Buffer.from(m[2], 'base64'))
        try {
          const r = await this.onebot.addCustomFace(tmp)
          if (r.ok) {
            this.stats.collected = (this.stats.collected ?? 0) + 1
            // 收藏变了，清缓存让下次 _customFaces 重新拉
            this._facesCache = undefined
            this.log.info?.(r.existed
              ? 'bridge：这张表情已经在收藏里了'
              : `bridge：已自动收藏一张表情（当前共 ${existing.length + 1} 张）`)
          } else {
            this.log.warn?.(`bridge：收藏表情失败 — ${JSON.stringify(r.raw ?? {}).slice(0, 160)}`)
          }
        } finally {
          try { fs.unlinkSync(tmp) } catch { /* 删不掉也无所谓，系统会清 temp */ }
        }
      } catch (e) {
        this.log.debug?.(`bridge：自动收藏跳过 — ${String(e?.message ?? e)}`)
      }
    }
  }

  /**
   * 挑一个表情包发出。
   *
   * 优先级：
   *   1) 配置里的映射 `config.qq.reply.mfaceMap`（用户想固定某张图时用）
   *   2) **QQ 内置表情表按名字查**（本地索引，见 faces.json）—— 这就是
   *      "按关键词搜表情"：模型说 `[表情包:大笑]`，我们查到「大哭」这类
   *      同义/包含项，发出**语义正确**的那个表情，而不是随机兜底
   *   3) 账号的收藏表情（NapCat 拿到的真实 GIF）
   *   4) 常见小黄脸兜底
   *
   * ## 关于"用 QQ 自带搜索找表情"
   *
   * QQ **没有公开的表情搜索 API** —— 实测几个候选接口全是 404，
   * NapCat 也没暴露（只有 fetch_custom_face 取收藏）。
   *
   * 但 NapCat 内嵌了 QQ 完整的 face_config（329 条：经典小黄脸 + 动画表情），
   * 我们把它导出成 `src/qq/faces.json`（258 条可用）。查这张表等价于
   * "在 QQ 的表情库里搜" —— 而且**更快、更可靠**（不依赖网络）。
   *
   * 从来没有"啥都不发"这一档 —— 模型说了要发表情，就该发出点什么。
   *
   * 配置形状（config.qq.reply.mfaceMap）：
   *   { "猫猫": "https://…/cat.gif", "笑": "file:///D:/pic/x.jpg" }
   */
  async _pickMface(name) {
    const map = this.cfg.reply?.mfaceMap ?? {}
    const key = String(name ?? '').trim()

    // 1) 配置映射（精确优先，其次模糊包含）
    if (key) {
      let hit = map[key]
      if (!hit) {
        const k = Object.keys(map).find((x) => key.includes(x) || x.includes(key))
        if (k) hit = map[k]
      }
      if (hit) return [{ type: 'image', data: { file: String(hit) } }]
    }

    // 2) QQ 内置表情表按名字查（"本地搜索"）
    if (key) {
      const hit = lookupFace(key)
      if (hit) {
        this.log.info?.(`bridge：表情「${key}」→ ${hit.by === 'exact' ? '精确' : '近似'}匹配「${hit.name}」(${hit.kind} ${hit.id ?? hit.ani})`)
        if (hit.kind === 'face') return [{ type: 'face', data: { id: String(hit.id) } }]
        // 动画表情要 mface 段；拿不到必需编号就退成收藏表情/兜底，
        // 不要发一个坏段出去（那会在群里显示成一条错误消息）
      }
    }

    // 3) 账号的收藏表情。
    //    收藏表情不带名字，所以按名字做**确定性挑选**：
    //    同一个名字每次挑到同一张，看起来比较稳定；
    //    没给名字就随机 —— "随手发个表情"本来就该随机。
    const faces = await this._customFaces()
    if (faces.length > 0) {
      const idx = key
        ? (hashStr(key) % faces.length)
        : Math.floor(Math.random() * faces.length)
      return [{ type: 'image', data: { file: faces[idx] } }]
    }

    // 4) 兜底：随机一个常见小黄脸。
    //    不返回 null：模型已经说了要发表情，什么都不发会让它显得"答应了却没做"。
    const COMMON = [4, 13, 20, 12, 28, 42, 0, 42, 74]
    return [{ type: 'face', data: { id: String(COMMON[hashStr(key || 'x') % COMMON.length]) } }]
  }

  /**
   * 把「因冷却被推迟」的消息排进队列，冷却结束后自动补回。
   *
   * ## 为什么只留最后一条
   *
   * 冷却 15 秒内用户可能连发 5 条（"在吗" "问你个事" "？" "算了" "…"）。
   * 全部排队回一遍会让机器人像复读机，而且前面几条的上下文早过时了。
   * 只保留**最新**那条 —— 它自然包含了前文的意思。
   *
   * ## 为什么用 timer 而不是轮询
   *
   * 每条消息各自算"还要等多久"，一次性 setTimeout 最省事；
   * 同会话再来新消息就把旧 timer 清掉重排（等价于"推迟到最新那条"）。
   *
   * @param {object} msg
   * @param {object} mem
   * @param {object} scene
   * @param {object} self
   * @param {object} d 决策结果（含 defer.waitMs）
   */
  _enqueueDeferred(msg, mem, scene, self, d) {
    const key = String(msg.scope ?? 'unknown')
    const prev = this._deferred.get(key)
    if (prev?.timer) clearTimeout(prev.timer)

    // 多等 300ms 缓冲：冷却刚好卡在边界时，决策层可能仍判"还在冷却"
    // （时间计算有毫秒级误差），白跑一次重试。
    const waitMs = Math.max(500, Number(d.defer?.waitMs ?? 0) + 300)
    const timer = setTimeout(() => {
      this._deferred.delete(key)
      // 冷却结束时用户可能已经不在这个话题上了 —— 重新走一遍完整处理
      // （决策、生成、发送），而不是无条件发言。这次冷却已过，应该能正常回。
      // 走 _queues 串行链，避免和同一会话的其它消息并发。
      const prev = this._queues.get(key) ?? Promise.resolve()
      const next = prev.then(() => this._handle(msg)).catch((e) => {
        this.log.warn?.(`bridge：补回消息失败 — ${String(e?.message ?? e)}`)
      })
      this._queues.set(key, next)
    }, waitMs)
    // 别让这个 timer 拖住进程退出
    if (typeof timer?.unref === 'function') timer.unref()

    this._deferred.set(key, { msg, mem, scene, self, at: Date.now(), timer })
    this.stats.deferred = (this.stats.deferred ?? 0) + 1
    this.log.info?.(`bridge：${key} 冷却中，${Math.ceil(waitMs / 1000)}s 后补回「${String(msg.text ?? '').slice(0, 30)}」`)
  }

  /** 记录最近一次交互（Web UI 用）。 */
  _record(msg, decision, replyText, outcome) {
    this.recent.unshift({
      at: Date.now(),
      scope: msg.scope,
      senderName: msg.senderName,
      text: msg.text.slice(0, 200),
      // ⚠️ 图片信息要一起记下来 —— 否则 UI 只显示 "[图片]"，用户
      //    根本没法判断"到底是没收到图，还是收到了但模型没用上"。
      //    这里存**引用**（url / file_id），不存 base64 数据（会撑爆内存）。
      images: (msg.images ?? []).map(function(r) { return String(r).slice(0, 200) }),
      mentionsMe: this.selfId ? msg.isAtMe(this.selfId) : false,
      decision: {
        reply: decision?.reply,
        probability: decision?.probability,
        provider: decision?.provider,
        reason: decision?.reason,
      },
      reply: replyText ? replyText.slice(0, 300) : null,
      outcome,
    })
    if (this.recent.length > 50) this.recent.length = 50
  }

  _maybeSummarize(scope, mem, scene) {
    if (!this.longMemory?.enabled) return
    this.longMemory.maybeSummarize(scope, {
      messages: mem.recent(),
      scene,
      self: { qq: this.selfId, nickname: this.selfName },
    }).catch(() => { })
  }

  /** 供 Web UI 的状态。 */
  statsSnapshot() {
    return {
      enabled: this.cfg.enabled === true,
      paused: this.paused,
      self: { id: this.selfId, name: this.selfName },
      connected: this.onebot?.connected ?? false,
      counters: { ...this.stats },
      memory: this.memory?.stats?.() ?? null,
      longMemory: this.longMemory?.stats?.() ?? null,
      recent: this.recent.slice(0, 20),
      // 白名单要暴露出来 —— 否则界面上看不出"为什么它不回我"
      // （名单为空 + fail-closed = 所有消息被静默丢弃）。
      allow: {
        private: this.cfg.allow?.private ?? [],
        groups: this.cfg.allow?.groups ?? [],
        allowAllWhenEmpty: this.cfg.allow?.allowAllWhenEmpty === true,
      },
      // 联网能力状态（界面显示"能不能查网"）
      search: {
        available: Boolean(this.searchKey),
        enabled: this.cfg.search?.enabled !== false,
        last: this._lastSearch,
      },
    }
  }
}

/** 按句读 + 长度拆分成多条消息（像人发消息那样）。 */
export function splitMessage(text, maxChars = 500) {
  const t = String(text).trim()
  if (!t) return []

  // ── ① 空行是**显式的分段意图** ──────────────────────────────
  //
  // 模型写两段中间空一行，意思就是"这两句分开说"。真人聊天也这样：
  // 「行吧」＋「等我先吃完这碗饭」是两条消息，不是一条长消息。
  //
  // 所以空行优先于长度判断 —— 哪怕整段只有 10 个字，有空行也要分开。
  // ⚠️ 用两个及以上换行（\n\s*\n）作判据，单个换行不算分段，
  //    否则模型偶尔折行也会被切成两条。
  const blocks = t.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean)
  if (blocks.length > 1) {
    const out = []
    for (const b of blocks) {
      // 每个块内部再按长度/句子细分
      out.push(...splitBySentences(b, maxChars))
    }
    return out
  }

  // ── ② 没有空行 → 按长度和句子切 ────────────────────────────
  return splitBySentences(t, maxChars)
}

/**
 * 按句末标点把一段切成不超过 maxChars 的多条。
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function splitBySentences(text, maxChars) {
  const t = String(text).trim()
  if (!t) return []
  if (t.length <= maxChars) return [t]

  const parts = []
  // 先按句末标点切
  const sentences = t.split(/(?<=[。！？!?~…\n])/)
  let buf = ''
  for (const s of sentences) {
    if ((buf + s).length > maxChars && buf) {
      parts.push(buf)
      buf = s
    } else {
      buf += s
    }
  }
  if (buf) parts.push(buf)

  // 单句仍然超长 → 硬切
  const out = []
  for (const p of parts) {
    if (p.length <= maxChars) { out.push(p); continue }
    for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars))
  }
  return out.filter((s) => s.trim())
}
