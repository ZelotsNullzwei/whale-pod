/**
 * QQ 侧的动作标记（2026-11-04）。
 *
 * ## 为什么单独一个文件
 * `_handle` 里已经有五段标记（找图/禁言/改昵称/改标签/等 N 分钟），
 * 再往那儿堆就成垃圾场了。这一批是 **NapCat 直接提供、风险低、像人** 的动作：
 *
 * ```
 * [回应:13]      给这条消息贴一个 QQ 表情（不是打字，是"贴表情"）
 * [戳]           戳一戳对方（群里 group_poke，私聊 friend_poke）
 * [签名:一句话]   改她自己的个性签名（set_qq_profile）
 * [撤回]         撤回她上一条发出去的（delete_msg）
 * ```
 *
 * ## 三条纪律
 * ① **best-effort**：任何失败只 warn，绝不影响这条回复发出去。
 *    理由：这些是锦上添花，一个字都不能因此丢。
 * ② **只动她自己和当条消息**：不改别人资料、不碰群设置、不碰凭据类接口。
 * ③ 标记必须从正文里**剥干净** —— 漏出去就是「[戳]」三个字被发到群里。
 *
 * ## 动作名和参数（在 protocol/napcat 的动作表里核实过）
 * ```
 * set_msg_emoji_like  { message_id, emoji_id }      贴表情
 * group_poke          { group_id, user_id }         群戳
 * friend_poke         { user_id }                   私聊戳
 * set_qq_profile      { nickname?, personal_note }  改资料（签名）
 * delete_msg          { message_id }                撤回
 * ```
 *
 * ## 开关
 * 每个动作都有开关（`qq.actions`，默认值和"要不要权限"写在
 * `config/store.js` 那张表里）。**关掉时标记照样剥掉** ——
 * 绝不能因为开关关了就把标记漏到聊天里。
 */

/*
 * ★ **表情编号必须是"她真能用的"**（2026-11-04 20:xx 修）。
 *
 * 交接文档里那条实测：
 * ```
 * [回应] / [戳] 一次都没触发过 —— 她不知道表情编号该写什么
 * ```
 * 只写「输出 [回应:表情编号]」等于没说：编号从哪儿来？猜一个？于是她
 * **永远不写**，这条通道等于不存在。
 *
 * 所以这里做两件事：
 *   ① 从 `faces.json`（NapCat 导出的 QQ 内置表情表）里挑一小组**常用**的，
 *      连同编号一起写进提示词 —— 有具体数字她才敢写；
 *   ② 允许直接写**表情名**（`[回应:偷笑]`），由 `resolveEmojiId` 翻成编号。
 *      模型对「名字」比「数字」熟练得多，这条路能兜住大部分情况。
 *
 * ⚠️ 只认**经典小黄脸**（`faces.json` 里值是数字的那些，编号 0~104）。
 *    动画表情在表里是 `{ani, pack}`，`set_msg_emoji_like` 不吃这套 ——
 *    给了她也只会失败。
 */
import FACE_TABLE from './faces.json' with { type: 'json' }

/** 贴表情允许的编号范围（`faces.json` 里经典小黄脸就是 0~104）。 */
export const EMOJI_ID_MIN = 0
export const EMOJI_ID_MAX = 104

/**
 * 写进提示词的常用表情（**名字**）。
 *
 * 挑选标准：一眼能用上、情绪/态度明确、不挑语境。
 * 那些「龙年快乐」「超级赞」之类的活动表情刻意没放 —— 它们带节令，
 * 写进提示词会让她在三月里祝人龙年快乐。
 */
export const EMOJI_HINT_NAMES = [
  '呲牙', '偷笑', '调皮', '得意', '害羞', '白眼', '流泪', '大哭',
  '难过', '惊讶', '酷', '冷汗', '鼓掌', '强', '弱', '抱拳',
  '玫瑰', '爱心', '亲亲', '蛋糕', '咖啡', '睡', '太阳', '月亮',
]

/**
 * 把 `faces.json` 里的一条翻成可用的编号。
 *
 * @param {string} name
 * @returns {number|null} 经典小黄脸编号；动画表情/查不到 → null
 */
export function faceIdOf(name) {
  const v = FACE_TABLE?.[String(name ?? '').trim()]
  return typeof v === 'number' ? v : null
}

/**
 * 生成「可用表情」这段提示词（关掉 emojiLike 时上层不会调用）。
 *
 * 名字查不到的直接跳过，不会留下「名字0」这种残句 ——
 * 表的形状将来变了，提示词自己会瘦下去，不用人跟着改。
 *
 * @returns {string} 形如 `呲牙13 / 偷笑20 / …`
 */
export function buildEmojiHint() {
  const out = []
  for (const n of EMOJI_HINT_NAMES) {
    const id = faceIdOf(n)
    if (id == null) continue
    out.push(`${n}${id}`)
  }
  return out.join(' / ')
}

/**
 * 把模型给的 `[回应:…]` 参数翻成编号。
 *
 * 除了数字，也认名字 —— 而且名字走的是**精确匹配优先、模糊包含兜底**，
 * 这样 `[回应:有点委屈]` 也能落到「委屈」上，不会因为多写了两个字就白丢一个动作。
 *
 * @param {string} arg 标记里的原始参数（`13` / `偷笑` / `有点委屈`）
 * @returns {number|null}
 */
export function resolveEmojiId(arg) {
  const raw = String(arg ?? '').trim()
  if (!raw) return null
  if (/^\d{1,3}$/.test(raw)) {
    const n = Number(raw)
    return n >= EMOJI_ID_MIN && n <= EMOJI_ID_MAX ? n : null
  }
  const exact = faceIdOf(raw)
  if (exact != null) return exact
  // 模糊：参数里含某个表情名，或表情名含参数（都要求 ≥2 字，避免「笑」乱撞）
  if (raw.length < 2) return null
  const names = Object.keys(FACE_TABLE ?? {})
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length)
  for (const n of names) {
    if (raw.includes(n) || n.includes(raw)) {
      const id = faceIdOf(n)
      if (id != null) return id
    }
  }
  return null
}

/** 四个标记，`g` 标志用于一次抽出多条。 */
const PATTERNS = [
  // 参数既可以是编号，也可以是表情名（见 `resolveEmojiId`）
  { id: 'emojiLike', re: /[\[［]\s*回应\s*[:：]\s*([^\]］]{1,10})\s*[\]］]/g },
  { id: 'poke', re: /[\[［]\s*戳\s*(?:[:：]\s*([^\]］]+))?\s*[\]］]/g },
  { id: 'signature', re: /[\[［]\s*签名\s*[:：]\s*([^\]］]*)[\]］]/g },
  { id: 'recall', re: /[\[［]\s*撤回\s*[\]］]/g },
  // [说说:内容] —— 发一条 QQ 空间说说（2026-11-05 加）
  { id: 'qzone', re: /[\[［]\s*说说\s*[:：]\s*([^\]］]*)[\]］]/g },
]

/** 动作键（和 `qq.actions` 的键一一对应）。 */
export const ACTION_KEYS = ['emojiLike', 'poke', 'signature', 'recall', 'qzone']

/** 签名长度上限 —— QQ 个人签名本身就短，超了会被截断，不如先拦。 */
const MAX_SIGNATURE = 40

/**
 * 从正文里抽出这些标记，并返回剥干净的正文。
 *
 * @param {string} text
 * @returns {{items: Array<{id:string,arg:string}>, text:string}}
 */
export function extractQQMarkers(text) {
  const raw = String(text ?? '')
  const items = []
  let rest = raw
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    for (const m of raw.matchAll(p.re)) items.push({ id: p.id, arg: String(m[1] ?? '').trim() })
    rest = rest.replace(p.re, '')
  }
  return { items, text: rest.replace(/[ \t]{2,}/g, ' ').trim() }
}

/**
 * 挨个执行（best-effort）。
 *
 * @param {object} o
 * @param {Array}  o.items    `extractQQMarkers().items`
 * @param {object} o.onebot   OneBot 客户端
 * @param {object} o.msg      触发这条回复的消息（要 groupId / userId / messageId）
 * @param {object} o.mem      会话记忆（撤回要用"我上一条"的 id）
 * @param {object} [o.cfg]    `qq.actions` 开关；缺字段 = 开（老配置无痛）
 * @param {object} [o.log]    日志
 * @returns {Promise<string[]>} 给用户看的说明（会像禁言那样附在正文后面）
 */
export async function runQQMarkers({ items, onebot, msg, mem, cfg = {}, log = {}, selfName = '' }) {
  const notes = []
  const enabled = (k) => cfg?.[k] !== false

  const call = async (action, params) => {
    try {
      const r = await onebot?._sendPreferHttp?.(action, params)
      const ok = r?.status === 'ok' || r?.retcode === 0 || r?.retcode === undefined
      if (!ok) log.warn?.(`qq-actions：${action} 返回失败 — ${JSON.stringify(r)?.slice(0, 120)}`)
      return { ok, r }
    } catch (e) {
      log.warn?.(`qq-actions：${action} 抛错 — ${String(e?.message ?? e)}`)
      return { ok: false }
    }
  }

  for (const it of items) {
    if (!enabled(it.id)) {
      log.info?.(`qq-actions：${it.id} 被开关关掉了（qq.actions.${it.id} = false）`)
      continue
    }

    if (it.id === 'emojiLike') {
      /*
       * 参数可能是编号（`13`）也可能是名字（`偷笑`）——
       * 见 `resolveEmojiId`：名字能查表，编号必须落在 0~104。
       * 查不到就**放弃这个动作**（warn 一句），绝不能把 `[回应:随便]`
       * 这三个字发到聊天里 —— 剥标记那一步已经把它拿掉了，这里只决定发不发。
       */
      const emojiId = resolveEmojiId(it.arg)
      if (emojiId == null) {
        log.warn?.(`qq-actions：回应表情认不出来（${String(it.arg ?? '')}），跳过`)
        continue
      }
      if (!msg?.messageId) { log.warn?.('qq-actions：这条没有 messageId，贴不了表情'); continue }
      const { ok } = await call('set_msg_emoji_like', {
        message_id: String(msg.messageId),
        emoji_id: String(emojiId),
      })
      if (ok) notes.push('回应了')
      continue
    }

    if (it.id === 'poke') {
      const target = String(it.arg ?? '').replace(/\D/g, '') || String(msg?.userId ?? '')
      if (!target) { log.warn?.('qq-actions：戳一戳没有目标'); continue }
      const r = msg?.groupId
        ? await call('group_poke', { group_id: String(msg.groupId), user_id: target })
        : await call('friend_poke', { user_id: target })
      if (r.ok) notes.push('戳了一下')
      continue
    }

    if (it.id === 'qzone') {
      /*
       * 发 QQ 空间说说（2026-11-05）。
       *
       * ⚠️ 这是**公开动作**：好友、空间访客都看得到。所以：
       *   · 内容为空 → 跳过；
       *   · `qq.actions.qzone = false` → 只把标记剥掉、不发；
       *   · 失败只 warn，不影响这条回复本身。
       */
      const content = String(it.arg ?? '').trim()
      if (!content) { log.warn?.('qq-actions：说说内容为空，跳过'); continue }
      // ⚠️ 字段名是 content（NapCat 的 payloadSchema 里写的），不是 message
      const { ok } = await call('send_qzone_msg', { content: content.slice(0, 300), ugc_right: 1 })
      if (ok) notes.push('发空间了')
      continue
    }

    if (it.id === 'signature') {
      /*
       * ⚠️ 签名**只在"我和她"那条私聊里可用**（2026-11-04 用户确认的收口）。
       *
       * 签名是全局可见的：所有好友、所有群、搜索结果都看得到。
       * 群聊里随口改、或者对陌生人也能改，都属于"把账号标识交出去"。
       * 所以：`qq.actions.signature` 打开只是第一道闸，
       * 第二道是 `signatureTo` —— 只有这些 QQ 号的**私聊**里才生效，
       * 默认空数组 = 谁都不行。
       */
      const scope = String(msg?.scope ?? '')
      const peer = scope.startsWith('private:') ? scope.slice('private:'.length) : ''
      /*
       * 放行表是 `QQ号: true` 的 map（跟 persona.activeByScope 同一种形状）。
       * 为兼容手滑写成数组的老配置，数组也认（当成"这些号全开"）。
       */
      const allow = cfg?.signatureAllow ?? {}
      const allowed = Array.isArray(allow)
        ? allow.map(String).includes(peer)
        : allow?.[peer] === true
      if (!peer || !allowed) {
        log.warn?.(
          `qq-actions：签名只对放行名单里的私聊生效（scope=${scope || '?'}，`
          + `名单=${Array.isArray(allow) ? allow.join(',') : Object.keys(allow).join(',') || '空'}）`,
        )
        continue
      }
      const text = String(it.arg ?? '').trim().slice(0, MAX_SIGNATURE)
      if (!text) { log.warn?.('qq-actions：签名是空的'); continue }
      /*
       * ⚠️ **必须同时带 nickname**（2026-11-04 直接打协议端实测）。
       *
       * 只传 `{ personal_note }` 时 NapCat 回：
       *   `retcode 400 / Schema compilation error: Expected required property`
       * —— 它的 schema 把 nickname 也标成必填。实测带**当前昵称**（值不变）
       * 就能写进去：回读 `get_stranger_info().longNick` 从 "" 变成「测试签名-可删」，
       * 再写回 "" 也成功。
       */
      const params = { personal_note: text }
      if (selfName) params.nickname = String(selfName)
      const { ok } = await call('set_qq_profile', params)
      if (ok) notes.push(`签名改成「${text}」`)
      continue
    }

    if (it.id === 'recall') {
      const mine = (mem?.recent?.(20) ?? []).filter((m) => m.isMe && m.id).slice(-1)[0]
      if (!mine?.id) { log.warn?.('qq-actions：没有可撤回的自己消息'); continue }
      const { ok } = await call('delete_msg', { message_id: String(mine.id) })
      if (ok) notes.push('撤回了一条')
      continue
    }
  }
  return notes
}