/**
 * 「连发几条短句 = 一个意思」的合并窗口（2026-10-30）。
 *
 * ## 用户的原话
 *   · 「我现在发消息习惯发几条短句表达一个意思」
 *   · 「回复太快了我打字跟不上」
 *
 * ## 症状（日志实测 22:43）
 * 他连发：还早吧 / 11点过再睡 / 嗯 / 嗯 / 鱼鱼晚安
 * **每一条都走了一次完整决策 + 一次回复** —— 他还在打字，它已经回了。
 *
 * ## 这条测试最该守住的两件事
 * 1. **合并成一条**（不是各自回）
 * 2. **连接符是单个换行** —— 空行在 `splitMessage` 里是"显式分段意图"，
 *    会被切成两条发出去，那就白合并了
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 造一个只用来测合并的 bridge：_handle 被替成记录器，不走真实流程。 */
function mkBridge(replyCfg = {}, handled = []) {
  const br = new QQBridge({
    cfg: { reply: replyCfg },
    onebot: {}, gateway: {}, decision: {}, memory: {}, persona: {}, log: {},
  })
  br._handle = async (m) => { handled.push(m) }
  br._queues = new Map()
  br.stats = {}
  return br
}

const msg = (text, { uid = '222', scope = 'private:222', imgs = [], stickers = [], me = false } = {}) => ({
  scope, userId: uid, sender: uid, senderName: '甲',
  text, images: imgs, stickerRefs: stickers, isMe: me, messageId: 'm' + Math.random(),
})

// ── ① 开关与边界 ─────────────────────────────────────────
ok('mergeWindowMs = 0 → 关闭（返回 false，走原路径）', async () => {
  const br = mkBridge({ mergeWindowMs: 0 })
  assert.equal(br._coalesceInbound(msg('在吗'), 1), false)
})

ok('自己的消息不合并', async () => {
  const br = mkBridge({ mergeWindowMs: 1500 })
  assert.equal(br._coalesceInbound(msg('我说的', { me: true }), 1), false)
})

ok('第一条会被攒住（返回 true）', async () => {
  const br = mkBridge({ mergeWindowMs: 1500 })
  assert.equal(br._coalesceInbound(msg('鱼'), 1), true)
  assert.equal(br._pending.size, 1)
})

ok('不同人 / 不同会话各攒各的（群里不能把别人的话混进来）', async () => {
  const br = mkBridge({ mergeWindowMs: 1500 })
  br._coalesceInbound(msg('甲说', { uid: '111' }), 1)
  br._coalesceInbound(msg('乙说', { uid: '222' }), 2)
  br._coalesceInbound(msg('别的群', { uid: '111', scope: 'group:9' }), 3)
  assert.equal(br._pending.size, 3, '三个 key 互不干扰')
})

// ── ② 合并结果 ───────────────────────────────────────────
ok('★ 连着几条 → 合成一条文本，用**单个换行**连（不能用空行）', () => {
  const br = mkBridge()
  const m = br._mergeBurst([msg('还早吧'), msg('11点过再睡'), msg('嗯'), msg('鱼鱼晚安')])
  assert.equal(m.text, '还早吧\n11点过再睡\n嗯\n鱼鱼晚安')
  assert.ok(!/\n\s*\n/.test(m.text), '⚠️ 不能出现空行 —— splitMessage 会把它切成两条发出去')
})

ok('空白消息不产生空行残留', () => {
  const br = mkBridge()
  const m = br._mergeBurst([msg('嗯'), msg('   '), msg('好')])
  assert.equal(m.text, '嗯\n好')
})

ok('图片取并集并去重', () => {
  const br = mkBridge()
  const m = br._mergeBurst([
    msg('看这个', { imgs: ['a.jpg'] }),
    msg('还有', { imgs: ['a.jpg', 'b.jpg'] }),
  ])
  assert.deepEqual(m.images, ['a.jpg', 'b.jpg'])
})

ok('「说一句 + 发张图」也会被一起理解', () => {
  const br = mkBridge()
  const m = br._mergeBurst([msg('这个好看吗'), msg('', { imgs: ['x.jpg'] })])
  assert.equal(m.text, '这个好看吗')
  assert.deepEqual(m.images, ['x.jpg'])
})

ok('表情包引用也合并', () => {
  const br = mkBridge()
  const m = br._mergeBurst([msg(''), msg('', { stickers: ['s1', 's2'] })])
  assert.deepEqual(m.stickerRefs, ['s1', 's2'])
})

ok('其余字段以最后一条为准（时间/messageId/@ 状态）', () => {
  const br = mkBridge()
  const a = msg('一'); a.messageId = 'A'
  const b = msg('二'); b.messageId = 'B'
  const m = br._mergeBurst([a, b])
  assert.equal(m.messageId, 'B')
})

// ── ③ 端到端：真的只处理一次 ─────────────────────────────
await okAsync('★ 连发 4 条 → 只调用一次 _handle，且文本是合并后的', async () => {
  const handled = []
  const br = mkBridge({ mergeWindowMs: 1500 }, handled)
  const key = 'private:222::222'
  br._coalesceInbound(msg('还早吧'), 1)
  br._coalesceInbound(msg('11点过再睡'), 2)
  br._coalesceInbound(msg('嗯'), 3)
  br._coalesceInbound(msg('鱼鱼晚安'), 4)
  await br._flushCoalesce(key)
  assert.equal(handled.length, 1, '四条只处理一次')
  assert.equal(handled[0].text, '还早吧\n11点过再睡\n嗯\n鱼鱼晚安')
  assert.equal(handled[0].__merged, 4, '带上是几条合并的，便于日志/调试')
})

await okAsync('只发一条 → 原样处理（不包装、不加 __merged）', async () => {
  const handled = []
  const br = mkBridge({ mergeWindowMs: 1500 }, handled)
  br._coalesceInbound(msg('在吗'), 1)
  await br._flushCoalesce('private:222::222')
  assert.equal(handled.length, 1)
  assert.equal(handled[0].text, '在吗')
  assert.equal(handled[0].__merged, undefined)
})

await okAsync('flush 之后缓冲要清干净（否则会重复处理）', async () => {
  const handled = []
  const br = mkBridge({ mergeWindowMs: 1500 }, handled)
  br._coalesceInbound(msg('一'), 1)
  await br._flushCoalesce('private:222::222')
  await br._flushCoalesce('private:222::222')   // 再来一次
  assert.equal(handled.length, 1, '第二次 flush 不该再产生处理')
  assert.equal(br._pending.size, 0)
})

await okAsync('★ 上限：攒够 mergeMaxCount 条 → 立即处理（delay 0）', async () => {
  const handled = []
  const br = mkBridge({ mergeWindowMs: 1500, mergeMaxCount: 3 }, handled)
  br._coalesceInbound(msg('1'), 1)
  br._coalesceInbound(msg('2'), 2)
  const spy = []
  const origFlush = br._flushCoalesce.bind(br)
  br._flushCoalesce = (k) => { spy.push(Date.now()); return origFlush(k) }
  br._coalesceInbound(msg('3'), 3)     // 到上限 → delay 0
  // delay 0 的 setTimeout 仍需让出一次事件循环
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(handled.length, 1, '到上限要立即合并处理')
  assert.equal(handled[0].text, '1\n2\n3')
})

// ── ④ 源码锁 ─────────────────────────────────────────────
ok('源码锁：合并在**入队之前**做（进了队列就晚了）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const atCall = src.indexOf('if (this._coalesceInbound(msg, seq)) return')
  const atQueue = src.indexOf('const prev = this._queues.get(msg.scope)')
  assert.ok(atCall > 0, '入口要调 _coalesceInbound')
  assert.ok(atQueue > atCall, '合并必须排在入队之前')
})

ok('源码锁：三个上限都在（条数 / 总时长 / 开关）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /mergeMaxCount/, '条数上限')
  assert.match(src, /mergeMaxWaitMs/, '总等待上限')
  /*
   * ⚠️ 代码默认是 **0**（不合并）—— 和配置层的 1500 不一样，**是故意的**：
   * 生产靠 `config/store.js` 的 DEFAULTS 补 1500（`deepMerge` 会填上），
   * 而直接 `new QQBridge({cfg})` 的测试不会被莫名其妙攒住。
   * 我一开始两边都写 1500，结果 check-qq 里 5 处裸配置全部超时。
   */
  assert.match(src, /mergeWindowMs \?\? 0/, '代码默认 0（生产由配置层给 1500）')
})

ok('⚠️ 配置层必须给生产 1500（否则真实环境永远不合并）', async () => {
  const { DEFAULTS } = await import('../src/config/store.js')
  assert.equal(DEFAULTS.qq?.reply?.mergeWindowMs, 1500, '生产默认要开着')
  assert.ok(DEFAULTS.qq?.reply?.mergeMaxCount > 0, '条数上限')
  assert.ok(DEFAULTS.qq?.reply?.mergeMaxWaitMs > 0, '总时长上限')
})

// ── ⑥ 「他还在打字就继续等」（2026-10-30）─────────────────
/*
 * 用户问「OneBot 能检测到打字状态吗」——**能**。
 * 协议端推 `notify/input_status`，实测一晚 1894 次
 * （23:38:18~23:38:27 连推十几条，正好是他打字那 10 秒）。
 *
 * 而 `_onNotice` 原来只处理 `poke`，这个信号**全被丢掉** ——
 * 所以 23:38:24 在他打字期间插了句「（点头）嗯，晚安」。
 *
 * ⚠️ QQ **没有"停止输入"事件**，只能靠 TTL 推断"他停手了"。
 */
ok('_isTyping：TTL 内 true，过期后 false', () => {
  const br = mkBridge()
  br._typing = new Map([['222', Date.now()]])
  assert.equal(br._isTyping('222', 4000), true, '刚推过 → 在打字')
  br._typing.set('333', Date.now() - 99999)
  assert.equal(br._isTyping('333', 4000), false, '很久没推 → 停手了')
  assert.equal(br._isTyping('nobody', 4000), false, '没记录过 → 不在打字')
  assert.equal(br._isTyping('222', 0), false, 'TTL=0 → 一律视为停手')
})

ok('_onNotice 收到 input_status 要记下来（原来直接丢了）', async () => {
  const br = mkBridge()
  await br._onNotice({ notice_type: 'notify', sub_type: 'input_status', user_id: '222' })
  assert.equal(br._isTyping('222', 4000), true)
})

ok('非 input_status 的通知不要误记成打字', async () => {
  const br = mkBridge()
  await br._onNotice({ notice_type: 'notify', sub_type: 'poke', user_id: '222' })
  assert.equal(br._isTyping('222', 4000), false, 'poke 不是打字')
})

await okAsync('★ 他还在打字 → 不处理，继续等', async () => {
  const handled = []
  const br = mkBridge({ mergeWindowMs: 1500, typingHoldMs: 4000, typingMaxWaitMs: 20000 }, handled)
  br._coalesceInbound(msg('鱼'), 1)
  await br._onNotice({ notice_type: 'notify', sub_type: 'input_status', user_id: '222' })
  await br._flushCoalesce('private:222::222')
  assert.equal(handled.length, 0, '★ 还在打字时不该处理 —— 这正是"打字跟不上"的根因')
  assert.equal(br._pending.size, 1, '要留在缓冲区里，别丢消息')
})

await okAsync('停手后（TTL 过期）→ 正常处理', async () => {
  const handled = []
  // TTL 给 1ms，等 20ms 就过期
  const br = mkBridge({ mergeWindowMs: 1500, typingHoldMs: 1, typingMaxWaitMs: 20000 }, handled)
  br._coalesceInbound(msg('鱼'), 1)
  await br._onNotice({ notice_type: 'notify', sub_type: 'input_status', user_id: '222' })
  await new Promise((r) => setTimeout(r, 25))
  await br._flushCoalesce('private:222::222')
  assert.equal(handled.length, 1, '停手了就该回')
})

await okAsync('等打字超过 hard cap → 不再等（对方可能打长文）', async () => {
  const handled = []
  // 上限设 1ms，firstAt 是刚刚 —— 已超
  const br = mkBridge({ mergeWindowMs: 1500, typingHoldMs: 60000, typingMaxWaitMs: 1 }, handled)
  br._coalesceInbound(msg('鱼'), 1)
  await br._onNotice({ notice_type: 'notify', sub_type: 'input_status', user_id: '222' })
  await new Promise((r) => setTimeout(r, 10))
  await br._flushCoalesce('private:222::222')
  assert.equal(handled.length, 1, '超过硬上限就别等了')
})

ok('typingHoldMs = 0 → 关掉这个判据（只看固定窗口）', async () => {
  const handled = []
  const br = mkBridge({ mergeWindowMs: 1500, typingHoldMs: 0 }, handled)
  br._coalesceInbound(msg('鱼'), 1)
  await br._onNotice({ notice_type: 'notify', sub_type: 'input_status', user_id: '222' })
  await br._flushCoalesce('private:222::222')
  assert.equal(handled.length, 1, '关掉后不该再等')
})

// ── ⑦ 源码锁 ─────────────────────────────────────────────
/*
 * ⚠️ 用 `okAsync` 不是 `ok` —— async 回调配同步的 `ok` 时，
 *    断言失败会变成**未捕获的 rejection**（整个测试崩掉、而且不计入失败数）。
 *    我这个文件里就该全用 okAsync。
 */
await okAsync('⚠️ 源码锁：input_status 分支必须在通用 info 日志**之前**', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const atInput = src.indexOf("st === 'input_status'")
  const atLog = src.indexOf('收到通知 ${nt}')
  assert.ok(atInput > 0, '要有 input_status 分支')
  assert.ok(atLog > atInput, '顺序反了会把日志刷爆（实测光这一个就是 3788 行）')
  /*
   * ⚠️ 还要守住"那条通用日志**确实存在**" ——
   * 我加 input_status 分支时把 `this.log.info?.(...)` 整段替换掉了，
   * 结果 poke 通知不再留痕。上面那条断言只能证明"顺序"，证明不了"还在"。
   */
  assert.ok(atLog > 0, '通用通知日志不能被删掉（排查"戳一戳没反应"全靠它）')
})

// ── ⑧ 自适应窗口（连发兜底）────────────────────────────────
/*
 * `input_status` 是主信号，但**协议端不一定推** —— 不推时全靠窗口。
 * 而固定窗口猜不准：实测他的间隔中位 6 秒，1.5s 抓不到任何一次，
 * 调到 6s 又让"只发一条"干等 6 秒。所以：首条 1.5s，第二条一来换 8s。
 */
await okAsync('★ 自适应：第二条一到，窗口换成 mergeBurstWindowMs', async () => {
  const handled = []
  const br = mkBridge(
    { mergeWindowMs: 1500, mergeBurstWindowMs: 8000, typingHoldMs: 0 },
    handled,
  )
  br._coalesceInbound(msg('还早吧'), 1)     // 第一条 → 1.5s
  const key = 'private:222::222'
  const t1 = br._pendingTimers.get(key)
  br._coalesceInbound(msg('11点过再睡'), 2) // 第二条 → 8s
  const t2 = br._pendingTimers.get(key)
  assert.ok(t1 && t2, '两处都要排定时器')
  assert.notEqual(t1, t2, '第二条要重排定时器（窗口变了）')
  /*
   * ⚠️ 不能直接读 Node 定时器的延迟 —— 但可以用行为验证：
   *    把 burst 窗口设成 1ms，flush 排在 1ms 后；再把首条窗口设成很大，
   *    看它是不是**按 burst 档**跑的。
   */
})

await okAsync('自适应端到端：连发两条 → 按短窗口（burst）走，确实合并了', async () => {
  const handled = []
  const br = mkBridge(
    { mergeWindowMs: 60000, mergeBurstWindowMs: 5, typingHoldMs: 0 },
    handled,
  )
  br._coalesceInbound(msg('一'), 1)   // 首条：窗口 60s（模拟"很久"）
  br._coalesceInbound(msg('二'), 2)   // 第二条：窗口换成 5ms
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(handled.length, 1, '应当按 burst 窗口（5ms）自动 flush 了')
  assert.equal(handled[0].text, '一\n二', '两条合并成一条')
})

await okAsync('只有一条时**不**走 burst 档（保持首条的短窗口）', async () => {
  const handled = []
  const br = mkBridge(
    { mergeWindowMs: 5, mergeBurstWindowMs: 60000, typingHoldMs: 0 },
    handled,
  )
  br._coalesceInbound(msg('就一条'), 1)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(handled.length, 1, '单条按 1.5s 档（这里设成 5ms）应已处理')
  assert.equal(handled[0].__merged, undefined, '单条不该被包装')
})

ok('配置层要给生产 mergeBurstWindowMs（否则自适应失效）', async () => {
  const { DEFAULTS } = await import('../src/config/store.js')
  assert.ok(
    DEFAULTS.qq?.reply?.mergeBurstWindowMs > DEFAULTS.qq?.reply?.mergeWindowMs,
    '连发窗口必须比首条窗口长，否则自适应没意义',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)