/**
 * 群禁言：让模型能「把某人闭麦一会儿」。
 *
 * ## 安全设计（这一条最重要）
 *
 * 这是**唯一**一个「模型能对其他群友造成实际影响」的能力。
 * 所以它不是「模型给什么就执行什么」，而是三道闸：
 *
 *   ① 模型只能输出**结构化标记** `[禁言:QQ号:分钟]`，
 *      不能指定 API、不能传任意参数
 *   ② 代码校验目标（不能是群主/管理员/自己）和时长（≤10 分钟）
 *   ③ 频率限制（同一目标每小时 1 次，全群每天 10 次）
 *
 * 任何一道不过 → **不执行**，并把原因记进日志。
 *
 * ## 为什么不让它「因为讨厌谁就禁言谁」
 *
 * 用户讨论过这条路，明确否决了。原因很实在：
 *   · 模型判断「讨厌」的依据极不可靠（一句玩笑就能被读成敌意）
 *   · 禁言对当事人是**不可见**的（他不知道为什么突然不能说话）
 *   · 群里的权力关系会变得莫名其妙
 *
 * 所以性格归性格（冷淡、不理、顶嘴），
 * 动手只在**被明确要求**时。
 */

/** 单次最长禁言（分钟）。再长就该由人手动去做了。 */
export const MAX_BAN_MINUTES = 10

/** 默认禁言时长（分钟）—— 模型只写 `[禁言:123]` 时用这个。 */
export const DEFAULT_BAN_MINUTES = 5

/**
 * 找出文本里的 `[禁言:QQ号:分钟]` 标记。
 *
 * 兼容两种写法：
 *   `[禁言:3604321136:5]`   —— 带时长
 *   `[禁言:3604321136]`     —— 用默认时长
 * 全角冒号也接受（模型经常写全角）。
 *
 * @param {string} text
 * @returns {Array<{userId:string, minutes:number, raw:string}>}
 */
export function extractBanMarkers(text) {
  const out = []
  const s = String(text ?? '')
  // QQ 号 5~12 位；分钟数可选
  const re = /\[禁言[:：]\s*(\d{5,12})(?:[:：]\s*(\d{1,3}))?\s*\]/g
  let m
  while ((m = re.exec(s)) !== null) {
    const userId = String(m[1])
    const minutes = m[2] === undefined ? DEFAULT_BAN_MINUTES : Number(m[2])
    out.push({ userId, minutes, raw: m[0] })
  }
  return out
}

/**
 * 从文本里移除所有禁言标记。
 *
 * 标记是给程序的指令，绝不能发到群里
 * （和 `（+3 秒）`、`[找图:...]` 是同一类问题）。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripBanMarkers(text) {
  return String(text ?? '')
    .replace(/\[禁言[:：]\s*\d{5,12}(?:[:：]\s*\d{1,3})?\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 校验一次禁言请求能不能执行。
 *
 * @param {object} o
 * @param {string} o.userId      目标 QQ
 * @param {number} o.minutes     请求的时长
 * @param {string} o.selfId      机器人自己
 * @param {Array<{user_id:number|string, role:string}>} o.members  群成员列表
 * @param {object} o.history     频率记录 { perUser: Map, perDay: number }
 * @param {number} [o.now]
 * @returns {{ok:boolean, reason:string, minutes?:number}}
 */
export function validateBan(o) {
  const userId = String(o.userId ?? '')
  if (!/^\d{5,12}$/.test(userId)) return { ok: false, reason: 'QQ 号不合法' }

  // 不能禁言自己
  if (o.selfId && userId === String(o.selfId)) {
    return { ok: false, reason: '不能禁言自己' }
  }

  /*
   * ⚠️ 2026-10-27 改：**不再限制目标身份**（用户明确要求「想禁谁就禁谁」）。
   *
   * 原来这里会拒绝群主和管理员。取消的理由：
   *   · 群主/管理员本来就能自己解开禁言（QQ 的权限就是这样）
   *   · 拒绝反而让它在需要维持秩序时"卡住"
   *
   * 保留的检查只有三条 —— 都是**执行层面必须成立**的，不是价值判断：
   *   ① 目标在群里（不然 API 直接报「成员不存在」）
   *   ② 不是它自己
   *   ③ 时长/频率封顶（防止它玩疯）
   *
   * 仍然**不建议**禁群主 —— 但这是提示词层面的事（见 persona），
   * 不是代码强拦。代码强拦会让"群主自己让禁自己"这种场景没法做。
   */
  const target = (o.members ?? []).find((m) => String(m.user_id) === userId)
  if (!target) return { ok: false, reason: '这个人不在群里' }

  // 时长封顶
  const want = Number.isFinite(Number(o.minutes)) ? Number(o.minutes) : DEFAULT_BAN_MINUTES
  if (want <= 0) return { ok: false, reason: '时长必须大于 0' }
  const minutes = Math.min(MAX_BAN_MINUTES, Math.max(1, Math.round(want)))

  // 频率
  const now = o.now ?? Date.now()
  const perUser = o.history?.perUser
  if (perUser && typeof perUser.get === 'function') {
    const last = Number(perUser.get(userId) ?? 0)
    if (last > 0 && now - last < 3600_000) {
      return { ok: false, reason: '这个人一小时之内已经被禁言过了' }
    }
  }
  const dayCount = Number(o.history?.perDay ?? 0)
  if (dayCount >= 10) return { ok: false, reason: '今天禁言次数已达上限' }

  return { ok: true, reason: '可以禁言', minutes }
}

/**
 * 把分钟数说成人话（发到群里的说明用）。
 *
 * @param {number} minutes
 * @returns {string}
 */
export function describeBanMinutes(minutes) {
  if (minutes < 1) return '一会儿'
  if (minutes === 1) return '1 分钟'
  return `${minutes} 分钟`
}

// ── 改自己的 QQ 昵称 ─────────────────────────────────────────

/** 昵称长度上限（QQ 本身限 36 字符，但太长的昵称在群里会折行）。 */
export const MAX_NICKNAME_LEN = 12

/** 一小时最多改几次 —— 防它玩疯了反复改。 */
export const NICKNAME_PER_HOUR = 3

/**
 * 找出文本里的 `[改昵称:新名字]` 标记。
 *
 * @param {string} text
 * @returns {Array<{name:string, raw:string}>}
 */
export function extractNicknameMarkers(text) {
  const out = []
  const s = String(text ?? '')
  const re = /\[改昵称[:：]\s*([^\[\]]{1,40})\]/g
  let m
  while ((m = re.exec(s)) !== null) {
    const name = String(m[1] ?? '').trim()
    if (!name) continue
    out.push({ name, raw: m[0] })
  }
  return out
}

/**
 * 从文本里移除所有改昵称标记。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripNicknameMarkers(text) {
  return String(text ?? '')
    .replace(/\[改昵称[:：]\s*[^\[\]]{0,40}\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/**
 * 校验一次改昵称请求。
 *
 * ## 为什么 QQ 昵称要比群名片严
 *
 * 群名片只影响一个群，改错了在群里一看就知道；
 * **QQ 昵称是全局的** —— 所有群、所有好友、所有搜索里都是新名字。
 * 改成一个莫名其妙的名字，别人会以为这号被盗了。
 *
 * 所以：长度更短（12）、每小时限 3 次、不许含控制字符/换行/引号，
 * 也不许改成空白或纯符号。
 *
 * @param {object} o
 * @param {string} o.name
 * @param {string} [o.currentName]
 * @param {number[]} [o.history]  最近改名的时刻（ms）
 * @param {number} [o.now]
 * @returns {{ok:boolean, reason:string, name?:string}}
 */
export function validateNickname(o) {
  const raw = String(o.name ?? '')
  // 换行/制表/首尾空白会让昵称显示成怪样子
  const name = raw.replace(/[\r\n\t]/g, ' ').trim()

  if (!name) return { ok: false, reason: '新昵称是空的' }
  if (name.length > MAX_NICKNAME_LEN) {
    return { ok: false, reason: `昵称最多 ${MAX_NICKNAME_LEN} 个字` }
  }
  // 纯符号/纯空格没意义
  if (!/[\p{L}\p{N}]/u.test(name)) {
    return { ok: false, reason: '昵称里至少要有字或数字' }
  }
  // 引号和反斜杠在部分客户端会显示异常
  if (/["'\\]/.test(name)) {
    return { ok: false, reason: '昵称里不要放引号或反斜杠' }
  }
  // 跟当前一样就没必要改（省一次 API 调用，也避免它自娱自乐）
  if (o.currentName && name === String(o.currentName).trim()) {
    return { ok: false, reason: '跟现在的昵称一样' }
  }

  const now = o.now ?? Date.now()
  const hist = Array.isArray(o.history) ? o.history.filter((t) => now - t < 3600_000) : []
  if (hist.length >= NICKNAME_PER_HOUR) {
    return { ok: false, reason: `一小时最多改 ${NICKNAME_PER_HOUR} 次` }
  }

  return { ok: true, reason: '可以改', name }
}

