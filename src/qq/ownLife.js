/**
 * 「她自己的生活」—— 静默唤醒（2026-11-19）
 *
 * 对齐 ai-companion-kit 的 own-life 做法：每隔一段时间往她上下文里投一条
 * **只进上下文、QQ 上什么都看不到**的提示。发不发说说、写不写日记、
 * 还是什么都不干，由她自己决定。
 *
 * ## 和「主动聊天（_speakUp）」的区别
 *   · **不往聊天里发任何字** —— 他那边一点动静都没有；
 *   · 只认一个出口：`[说说:…]` → 直接发空间。**不走**「私聊预览 + 等他确认」，
 *     那条路占用聊天通道，正是 2026-11-19「发说说被插话打断」的根因；
 *   · 有自己的安静时段 / 每日上限 / 发布冷却，重启不补发。
 *
 * 思路来源：https://github.com/pinganbbOvO/ai-companion-kit
 *   docs/她自己的生活-定时静默唤醒.md
 *   「给她一个闹钟，响了不跟人说话，只提醒她现在是她自己的时间。」
 *
 * ## 状态文件
 * `<home>/own-life.json` = { day, fires, lastFireAt, lastPostAt, posts }
 * lastFireAt 先落盘再生成 —— 重启时不会因为「上次记录太旧」而开机补发一堆。
 *
 * ## 配置（都可选）
 * `qq.ownLife = { enabled, intervalMs, quietStart, quietEnd, maxPerDay,
 *                 allowPost, postMinGapMs, idleMinMs }`
 */
import fs from 'node:fs'
import path from 'node:path'
import { checkQzoneText } from './qzoneProactive.js'
import { extractQQMarkers } from './qqActions.js'

const DEFAULTS = {
  enabled: true,
  /** 多久叫醒一次（默认 2.5 小时，和参考实现一致） */
  intervalMs: 2.5 * 3600_000,
  /** 安静时段 [start, end)：这段时间不叫 */
  quietStart: 3,
  quietEnd: 8,
  /** 每天最多叫醒几次（≠ 每天最多发几条） */
  maxPerDay: 6,
  /** 允许她在自己的时间发说说 */
  allowPost: true,
  /** 每天最多发几条说说（0 = 不限）。叫醒次数 ≠ 发布条数。 */
  postDailyMax: 1,
  /**
   * 两次「发空间」之间的最小间隔。
   * ⚠️ 私聊通道本身**没有**冷却（qq.actions 里私聊 gapMs=0），
   *    所以这里必须自己补一道，否则每天能发好几条。
   */
  postMinGapMs: 6 * 3600_000,
  /** 他最近说过话就先不打扰（毫秒）；她自己刚说完不算 */
  idleMinMs: 3 * 60_000,
}

/**
 * 挂载静默唤醒。
 * @param {object} bridge
 * @param {{home?: string}} opts
 */
export function startOwnLife(bridge, opts = {}) {
  try {
    if (!bridge) return null
    if (bridge._ownLifeTimer) return bridge._ownLifeTimer
    const home = opts.home ?? null
    if (!home) { bridge.log?.info?.('own-life：没有 home，跳过挂载'); return null }

    const stateFile = path.join(home, 'own-life.json')
    /* bridge.cfg 是**扁平**的（bridgeCfgOf = { ...cfg.qq }），所以先读顶层 */
  const cfg = () => ({ ...DEFAULTS, ...(bridge.cfg?.ownLife ?? bridge.cfg?.qq?.ownLife ?? {}) })
    const now = () => Date.now()
    const today = () => new Date(now()).toLocaleDateString('sv-SE')

    const readState = () => {
      try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) ?? {} } catch { return {} }
    }
    const writeState = (v) => {
      try {
        const tmp = `${stateFile}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(v))
        fs.renameSync(tmp, stateFile)
      } catch { /* 写不进去不影响跑 */ }
    }

    let state = readState()
    if (state.day !== today()) { state = { day: today(), fires: 0, lastFireAt: 0, lastPostAt: 0, posts: 0 } }
    let busy = false

    const memOf = (scope) => {
      try { return bridge._memOf?.(scope) ?? bridge.memory?.get?.(scope) ?? null } catch { return null }
    }

    /** 只挑绑定的那个私聊（说说是公开动作，绝不发给别人） */
    const pickPrivateScope = () => {
      const byScope = bridge.cfg?.persona?.activeByScope ?? {}
      const pinned = Object.keys(byScope).filter((k) => String(k).startsWith('private:'))
      for (const k of pinned) if (memOf(k)?.recent?.(1)?.length) return k
      return pinned[0] ?? ''
    }

    const inQuiet = () => {
      const h = new Date(now()).getHours()
      const { quietStart, quietEnd } = cfg()
      return quietStart <= quietEnd
        ? (h >= quietStart && h < quietEnd)
        : (h >= quietStart || h < quietEnd)
    }

    /** 他正在聊 / 她正在生成 → 这一轮先不叫 */
    const quietTalk = (scope) => {
      try {
        if (bridge._queueBusy?.(scope)) return true
        const rec = bridge._inbound?.get?.(String(scope))
        const last = rec?.entries?.[rec.entries.length - 1]
        const at = Number(last?.at ?? 0)
        if (!at) return false
        return now() - at < Number(cfg().idleMinMs)
      } catch { return false }
    }

    const buildHint = () => {
      const c = cfg()
      return [
        '## 现在是你的时间',
        '没人找你。**这不是回消息** —— 你接下来写的字不会发到聊天里，只用来决定你要做什么。',
        '',
        '想干嘛干嘛：发条说说、写两句日记、发会儿呆，也可以什么都不干。',
        '',
        c.allowPost
          ? '想发说说 → 输出一行 [说说:一句话]。要求：不超过 60 字，只讲今天具体的一件小事，'
            + '不要出现「你/您/说说/空间/图/拍」，不要感叹号，不要标签，不要第二句抒情。'
          : '今天不发说说。',
        '什么都不想做 → 输出 [SILENT]。',
        '',
        '⚠️ 不要提发图/拍照（这条链路没有配图能力），也不要写「喏」「给你看」这类话。',
      ].join('\n')
    }

    const tick = async () => {
      const c = cfg()
      if (!c.enabled) return
      if (busy) return
      if (inQuiet()) return
      if (state.day !== today()) { state = { day: today(), fires: 0, lastFireAt: 0, lastPostAt: Number(state.lastPostAt ?? 0), posts: 0 } }
      if (Number(state.fires ?? 0) >= Number(c.maxPerDay)) return
      /* 间隔：上一次叫醒到现在 */
      if (state.lastFireAt && now() - Number(state.lastFireAt) < Number(c.intervalMs)) return

      const scope = pickPrivateScope()
      if (!scope) return
      if (quietTalk(scope)) return

      /* 先落盘再生成：重启后不会因为「上次记录太旧」立刻补一次 */
      busy = true
      state.fires = Number(state.fires ?? 0) + 1
      state.lastFireAt = now()
      writeState(state)

      try {
        const mem = memOf(scope)
        const self = { id: bridge.selfId, name: bridge.selfName }
        let scene = null
        try { scene = await bridge.sceneOf?.({ scope, kind: 'private' }) } catch { scene = null }
        const full = {
          scope,
          kind: 'private',
          userId: String(scope).slice('private:'.length),
          groupId: null,
          sender: String(scope).slice('private:'.length),
          senderName: '',
          text: '',
          speakHint: buildHint(),
          isMe: false,
          at: now(),
          __ownLife: true,
        }
        const gen = await bridge._generate(full, mem, scene, self)
        const raw = String(gen?.text ?? '').trim()
        if (!raw || raw.includes('[SILENT]')) {
          bridge.log?.info?.('own-life：她这次什么都不想做')
          return
        }
        const { items } = extractQQMarkers(raw)
        const q = items.find((x) => x.id === 'qzone')
        if (!q) {
          bridge.log?.info?.(`own-life：没发说说（她的时间，未用出口）——「${raw.slice(0, 40)}」`)
          return
        }
        if (!c.allowPost) { bridge.log?.info?.('own-life：allowPost=false，挡下这条说说'); return }
        const text = String(q.arg ?? '').trim()
        const chk = checkQzoneText(text, text, { basisOk: true })
        if (!chk.ok) {
          bridge.log?.warn?.(`own-life：说说没过内容检查（${chk.reasons.join('、')}）→ 不发`)
          return
        }
        if (Number(c.postDailyMax) > 0 && Number(state.posts ?? 0) >= Number(c.postDailyMax)) {
          bridge.log?.info?.(`own-life：今天已经发过 ${state.posts} 条说说 → 这次不发`)
          return
        }
        if (state.lastPostAt && now() - Number(state.lastPostAt) < Number(c.postMinGapMs)) {
          const h = Math.max(1, Math.round((now() - Number(state.lastPostAt)) / 3600_000))
          bridge.log?.info?.(`own-life：${h} 小时前刚发过说说 → 这次只想想，不发`)
          return
        }
        const ok = await bridge._sendQzoneNow(scope, text, null)
        if (ok) {
          state.lastPostAt = now()
          state.posts = Number(state.posts ?? 0) + 1
          writeState(state)
          bridge.log?.info?.(`own-life：她自己的时间发了一条说说「${text.slice(0, 40)}」`)
        }
      } catch (e) {
        bridge.log?.warn?.(`own-life：这一轮失败 — ${String(e?.message ?? e).slice(0, 80)}`)
      } finally {
        busy = false
      }
    }

    const timer = setInterval(() => { void tick() }, 60_000)
    timer.unref?.()
    bridge._ownLifeTimer = timer
    bridge._ownLifeTick = tick
    /* 启动 2 分钟后跑第一次（别和开机那些重活挤在一起） */
    try { setTimeout(() => { void tick() }, 120_000).unref?.() } catch { /* ignore */ }

    const c0 = cfg()
    bridge.log?.info?.(
      `own-life：已武装 · 每 ${Math.round(Number(c0.intervalMs) / 3600_000 * 10) / 10}h 一次`
      + ` · 安静 ${c0.quietStart}:00–${c0.quietEnd}:00 · 每天最多 ${c0.maxPerDay} 次`
      + ` · 发说说冷却 ${Math.round(Number(c0.postMinGapMs) / 3600_000)}h`
      + ` · 每天最多发 ${c0.postDailyMax} 条`,
    )
    return timer
  } catch (e) {
    bridge?.log?.warn?.(`own-life：启动失败 — ${String(e?.message ?? e).slice(0, 80)}`)
    return null
  }
}
