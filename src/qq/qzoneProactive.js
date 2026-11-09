/**
 * QQ 空间「主动发说说」调度器（2026-11-10）
 *
 * ## 和现有实现的区别
 * 现有的 `[说说:…]` 是**模型在对话里临时决定**发一条（`qqActions.js`）。
 * 交接文档要的是**独立的调度器**：跟主动聊天分开，有自己的每日上限、
 * 冷却和随机时间窗；而且**默认只出草稿**——生成文字+配图先私聊给他看，
 * 他说「发」才真的发。
 *
 * ## 为什么单独一个文件
 * `src/qq/bridge.js` 那几天被多条线同时改（几分钟一个提交）。把新逻辑放这里，
 * bridge 里只加一个挂载点，冲突面积最小。
 *
 * ## 流程
 * ```
 * 定时 tick（每分钟）
 *   → 闸门：enabled / 时间窗 / 每日上限 / 冷却 / 已有待确认
 *   → 取材：近期她自己说过的话 + 当日**已完成**时段 + 事件记忆
 *   → 生成一句（走 bridge._generate，带专用 hint）
 *   → 去重（和上一条草稿比）
 *   → bridge._askQzoneConfirm()：生成配图 + 私聊发预览 + 存 pending
 *   → 他回「发」→ bridge 走 _sendQzoneNow（已存在）
 *   → 我在 _sendQzoneNow 外面包一层，成功后落 history 记账
 * ```
 *
 * ## 默认值（都可配）
 * `qq.qzoneProactive = { enabled, dailyMax, minGapMs, windowStart, windowEnd, minChars, draftCooldownMs }`
 * 默认：**开启**、每天 1 条、冷却 6 小时、09–23 点、草稿间隔 90 分钟。
 * 之所以敢默认开：它**只产生草稿**，他不确认就永远发不出去。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { currentSlot } from '../memory/dayPlan.js'

const DEFAULTS = {
  enabled: true,
  dailyMax: 1,
  minGapMs: 6 * 3600_000,
  windowStart: 9,
  windowEnd: 23,
  minChars: 12,
  draftCooldownMs: 90 * 60_000,
}

/** 等他确认的最长时间。与 bridge._handle 里那道闸共用同一个常量，避免两边漂移。 */
export const QZONE_CONFIRM_TTL_MS = 30 * 60_000

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16)

const memOf = (bridge, scope) => {
  try { return bridge.memory?.get?.(scope) ?? null } catch { return null }
}

/** 当日已完成时段（不含当前与未来） */
function completedSlots(plan, slotId) {
  const order = ['morning', 'noon', 'afternoon', 'evening']
  const cur = Math.max(-1, order.indexOf(String(slotId ?? '')))
  return order.slice(0, cur).reverse()
    .map((k) => String(plan?.[k] ?? '').trim())
    .filter(Boolean)
}

export function startQzoneProactive(bridge, opts = {}) {
  if (!bridge || bridge._qzoneProactiveTimer) return bridge?._qzoneProactiveTimer ?? null
  const home = String(opts.home ?? '')
  if (!home) {
    bridge.log?.warn?.('qzone-proactive：没有 home，跳过挂载')
    return null
  }
  /** 测试可注入时钟；生产就是 Date.now() */
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const stateFile = path.join(home, 'qzone-proactive.json')

  const cfg = () => ({ ...DEFAULTS, ...(bridge.cfg?.qq?.qzoneProactive ?? {}) })

  const readState = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) ?? {} } catch { return {} }
  }
  const writeState = (v) => { try { fs.writeFileSync(stateFile, JSON.stringify(v)) } catch { /* ignore */ } }
  let state = readState()

  const today = () => new Date(clock()).toLocaleDateString('sv-SE')   // YYYY-MM-DD（本地）
  const postsToday = () => (state.day === today() ? Number(state.posts ?? 0) : 0)

  /** 只挑私聊：空间是公开的，必须先跟他确认 */
  const pickPrivateScope = () => {
    const byScope = bridge.cfg?.persona?.activeByScope ?? {}
    const pinned = Object.keys(byScope).filter((k) => String(k).startsWith('private:'))
    for (const k of pinned) if (memOf(bridge, k)?.recent?.(1)?.length) return k
    try {
      for (const s of (bridge._knownScopes?.('private') ?? [])) {
        if (memOf(bridge, s)?.recent?.(1)?.length) return s
      }
    } catch { /* ignore */ }
    return pinned[0] ?? ''
  }

  const gatherMaterial = (scope) => {
    const mem = memOf(bridge, scope)
    const recent = mem?.recent?.(40) ?? []
    const mine = recent
      .filter((m) => m?.isMe && typeof m.text === 'string')
      .map((m) => String(m.text).replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= 6 && !/^\[/.test(t))
      .slice(-6)
    let plan = {}
    try { plan = bridge.dayPlan?.today?.() ?? {} } catch { /* ignore */ }
    const done = completedSlots(plan, currentSlot().id)
    const events = (() => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(home, 'memory-events.json'), 'utf8'))
        const arr = j?.sessions?.[scope] ?? j?.[scope] ?? []
        return (arr.slice?.(-3) ?? []).map((e) => String(e?.text ?? e?.summary ?? '')).filter(Boolean)
      } catch { return [] }
    })()
    return { mine, done, events }
  }

  const buildHint = ({ mine, done, events }) => [
    '## 你现在要发一条 QQ 空间说说（不是聊天回复）',
    '',
    '**必须是生活里的小事**，一两句，口语，不超过 120 字。',
    '- 只写**已经发生**的事；日程只当灵感，**不许把还没发生的事说成发生了**',
    '- 不要写今天的行程表、不要列清单、不要总结一天',
    '- 不要提「他」「聊天」「空间」「说说」这些字',
    '- 不要用 emoji；不要用括号动作',
    '',
    mine.length ? `你最近说过的话（挑一件真的有意思的当素材）：\n${mine.map((t) => `- ${t}`).join('\n')}` : '',
    done.length ? `今天已经过去的部分（只能当灵感，不能照抄）：\n${done.map((t) => `- ${t}`).join('\n')}` : '',
    events.length ? `最近发生过的小事：\n${events.map((t) => `- ${t}`).join('\n')}` : '',
    '',
    '直接输出说说正文，一行。说不出来就输出 [SILENT]。',
  ].filter(Boolean).join('\n')

  const draft = async (scope) => {
    const mem = memOf(bridge, scope)
    if (!mem || typeof bridge._generate !== 'function') return ''
    const material = gatherMaterial(scope)
    const fake = {
      scope,
      kind: 'private',
      userId: String(scope).slice('private:'.length),
      text: '',
      images: [],
    }
    try {
      const gen = await bridge._generate(fake, mem, { kind: 'private' }, null, null, buildHint(material))
      let t = String(gen?.text ?? '').trim()
      if (!t || /^\[SILENT\]$/i.test(t)) return ''
      t = t.replace(/[（(][^）)]*[）)]/g, ' ').replace(/\[[^\]]{1,20}\]/g, ' ').replace(/\s+/g, ' ').trim()
      if (t.length < cfg().minChars) return ''
      return t.slice(0, 300)
    } catch (e) {
      bridge.log?.warn?.(`qzone-proactive：起草失败 — ${String(e?.message ?? e).slice(0, 80)}`)
      return ''
    }
  }

  /** 发布成功后记账：包一层 _sendQzoneNow，不改它的实现 */
  if (typeof bridge._sendQzoneNow === 'function' && !bridge._qzoneNowWrapped) {
    const orig = bridge._sendQzoneNow.bind(bridge)
    bridge._sendQzoneNow = async (...args) => {
      const ok = await orig(...args)
      if (ok) {
        state = readState()
        state.day = today()
        state.posts = postsToday() + 1
        state.lastPostedAt = clock()
        state.lastHash = hash(String(args?.[1] ?? ''))
        state.history = [...(state.history ?? []), {
          at: clock(),
          text: String(args?.[1] ?? '').slice(0, 200),
          scope: String(args?.[0] ?? ''),
        }].slice(-30)
        writeState(state)
        bridge.log?.info?.(`qzone-proactive：已发布并记账（今天第 ${state.posts} 条）`)
      }
      return ok
    }
    bridge._qzoneNowWrapped = true
  }

  /**
   * 清掉过期的待确认项（2026-11-10 修：评审指出的死锁）。
   *
   * `bridge._handle` 里超过 30 分钟只是**跳过不处理**、不删除；
   * 而调度器看到 `_qzonePending` 非空就不起草 ——
   * 于是**没人回的那条预览会让之后的主动草稿永远停摆**。
   * 每轮 tick 先清一次，既解开死锁，也顺手把 map 里的僵尸项收掉。
   */
  const pruneExpiredPending = () => {
    const m = bridge._qzonePending
    if (!m || typeof m.forEach !== 'function') return 0
    const now = clock()
    let n = 0
    for (const [k, v] of [...m.entries()]) {
      if (!v || now - Number(v.at ?? 0) > QZONE_CONFIRM_TTL_MS) { m.delete(k); n++ }
    }
    if (n > 0) bridge.log?.info?.(`qzone-proactive：清掉 ${n} 条过期待确认`)
    return n
  }

  const tick = async () => {
    const c = cfg()
    if (!c.enabled) return
    state = readState()

    const hour = new Date(clock()).getHours()
    const inWindow = c.windowStart <= c.windowEnd
      ? hour >= c.windowStart && hour < c.windowEnd
      : (hour >= c.windowStart || hour < c.windowEnd)
    if (!inWindow) return

    if (postsToday() >= Number(c.dailyMax)) return
    if (state.lastPostedAt && clock() - state.lastPostedAt < Number(c.minGapMs)) return
    if (state.lastDraftAt && clock() - state.lastDraftAt < Number(c.draftCooldownMs)) return
    pruneExpiredPending()          // 先清过期项，别让没人回的旧预览把调度器卡死
    if (bridge._qzonePending?.size > 0) return
    if (typeof bridge._askQzoneConfirm !== 'function') return

    const scope = pickPrivateScope()
    if (!scope) return

    const text = await draft(scope)
    if (!text) return
    if (state.lastHash && hash(text) === state.lastHash) {
      bridge.log?.info?.('qzone-proactive：和上次一样，跳过')
      return
    }

    state.lastDraftAt = clock()
    state.lastDraftText = text
    writeState(state)

    try {
      await bridge._askQzoneConfirm({ scope, content: text, imageUrl: '' })
      bridge.log?.info?.(`qzone-proactive：草稿已发私聊预览「${text.slice(0, 30)}」`)
    } catch (e) {
      bridge.log?.warn?.(`qzone-proactive：发预览失败 — ${String(e?.message ?? e).slice(0, 80)}`)
    }
  }

  const timer = setInterval(() => { void tick() }, 60_000)
  timer.unref?.()
  bridge._qzoneProactiveTimer = timer
  /** 测试钩子：直接跑一次 tick，不用等 60 秒 */
  bridge._qzoneProactiveTick = tick
  bridge.log?.info?.(`qzone-proactive：调度器已启动（每天 ${cfg().dailyMax} 条，${cfg().windowStart}–${cfg().windowEnd} 点）`)
  return timer
}
