/**
 * 「**约定时间到了就催一句**」的回归测试（2026-11-03，用户确认的设计）。
 *
 * ## 用户原话（这条功能的全部依据）
 * · 「太安静了到时间不会催促人，只会在那里安静的等待」
 * · 「前面时间是**只对话里面约定的时间**」
 * · 「约定时间就是这个意思」「你理解的是对的」
 *
 * ## 全链路（一句话）
 * 他说「我洗漱五分钟」→ 她在末尾写 `[等:5]` → `_send` **剥掉标记**
 * （绝不发给群友）+ 记一条待催 → 到点、且他仍然一句话没说 → 催一句
 * → 他中途说话 → 立刻作废。
 *
 * ## 这条测试最该守住的三件事
 * 1. **标记绝不外泄**（2026-11-03 刚从 `[表情]` 上踩过一模一样的坑）
 * 2. **只在"他没动静"时才催** —— 人回来了还催就是骚扰
 * 3. **频率不要太多**（每天上限 + 两次最小间隔）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge, stripWaitMarkers } from '../src/qq/bridge.js'

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

console.log('约定时间 → 到点催一句')

// ── ① 标记解析与剥离 ─────────────────────────────────────
ok('★ 剥掉 [等:5] 并把分钟数抽出来（正文其余不动）', () => {
  const r = stripWaitMarkers('五分钟够了，去吧。[等:5]')
  assert.equal(r.text, '五分钟够了，去吧。')
  assert.deepEqual(r.waits, [5])
})

ok('全角冒号 / 冒号后空格都认', () => {
  assert.deepEqual(stripWaitMarkers('好[等：10]').waits, [10])
  assert.deepEqual(stripWaitMarkers('好[等: 7]').waits, [7])
})

ok('多个标记都收；写坏的（[等] / [等:abc]）也剥掉、只是不计数', () => {
  const r = stripWaitMarkers('a[等:3]b[等:9]c')
  assert.deepEqual(r.waits, [3, 9])
  assert.equal(r.text, 'abc')
  const bad = stripWaitMarkers('走了[等]算了[等:abc]')
  assert.deepEqual(bad.waits, [])
  assert.equal(bad.text, '走了算了', '写坏的也不能发出去（那就是字面量）')
})

ok('⚠️ 末尾残缺的 [等:5 / [等: / [等 → 删掉，不许外泄', () => {
  assert.equal(stripWaitMarkers('等我[等:5').text, '等我')
  assert.equal(stripWaitMarkers('等我[等:').text, '等我')
  assert.equal(stripWaitMarkers('等我[等').text, '等我')
})

ok('没标记时原样返回（别把正常正文动了）', () => {
  const r = stripWaitMarkers('五分钟够了')
  assert.equal(r.text, '五分钟够了')
  assert.deepEqual(r.waits, [])
})

ok('⚠️ 别误伤别的标记：[表情:5] 不归它管', () => {
  const r = stripWaitMarkers('笑[表情:5]')
  assert.equal(r.text, '笑[表情:5]')
  assert.deepEqual(r.waits, [])
})

// ── ② 排催 / 取消 ────────────────────────────────────────
const mkBridge = (nudgeCfg = {}, replyCfg = {}) => {
  const br = new QQBridge({
    cfg: { reply: replyCfg, nudge: nudgeCfg },
    onebot: {}, gateway: {}, decision: {}, memory: {}, persona: {}, log: {},
  })
  br.stats = {}
  return br
}
const MSG = { scope: 'private:222', kind: 'private', userId: '222' }

ok('★ 记下约定：分钟数 + 到点时间', () => {
  const br = mkBridge()
  br._scheduleNudge(MSG, [5])
  const rec = br._nudges.get('private:222')
  assert.equal(rec.minutes, 5)
  assert.ok(rec.dueAt - Date.now() >= 5 * 60_000 - 1000, '到点时间应该是 5 分钟后')
})

ok('★ 他改口 → 同一会话只留最近一次（是改约，不是排两个）', () => {
  const br = mkBridge()
  br._scheduleNudge(MSG, [5])
  br._scheduleNudge(MSG, [20])
  assert.equal(br._nudges.size, 1)
  assert.equal(br._nudges.get('private:222').minutes, 20)
})

ok('太远的约定不接（默认 240 分钟）', () => {
  const br = mkBridge()
  br._scheduleNudge(MSG, [999])
  assert.equal(br._nudges?.size ?? 0, 0)
})

ok('enabled = false → 不排催', () => {
  const br = mkBridge({ enabled: false })
  br._scheduleNudge(MSG, [5])
  assert.equal(br._nudges?.size ?? 0, 0)
})

ok('他说话了 → 作废', () => {
  const br = mkBridge()
  br._scheduleNudge(MSG, [5])
  assert.equal(br._cancelNudge('private:222', '他说话了'), true)
  assert.equal(br._nudges.size, 0)
  assert.equal(br._cancelNudge('private:222'), false, '没东西可取消时不该炸')
})

await okAsync('★★ 端到端：_send 里标记被剥掉（没发出去）+ 排上了催', async () => {
  const sent = []
  const br = mkBridge({}, { maxChars: 500 })
  br.onebot = {
    sendPrivate: async (_id, payload) => { sent.push(payload); return { status: 'ok' } },
    sendGroup: async (_id, payload) => { sent.push(payload); return { status: 'ok' } },
  }
  await br._send({ ...MSG }, '五分钟够了，去吧。[等:5]')
  const dumped = JSON.stringify(sent)
  assert.ok(!dumped.includes('[等'), `标记漏出去了：${dumped}`)
  assert.ok(dumped.includes('五分钟够了'), '正文该照旧发出去')
  assert.equal(br._nudges.get('private:222').minutes, 5, '同时要排上催')
})

// ── ③ 到点催 + 频率闸 ───────────────────────────────────
const mkDue = (nudgeCfg = {}, overMs = 1000) => {
  const br = mkBridge(nudgeCfg)
  const fired = []
  br._speakUp = async (m, mem, hint) => { fired.push({ m, hint }) }
  br._scheduleNudge(MSG, [5])
  br._nudges.get('private:222').dueAt = Date.now() - overMs
  return { br, fired }
}

await okAsync('★★ 到点且他没动静 → 催一句（走 _speakUp 那条链，带提示词）', async () => {
  const { br, fired } = mkDue()
  await br._tickNudges()
  assert.equal(fired.length, 1, '该催一次')
  assert.match(fired[0].hint, /5 分钟/, '提示词要说清是几分钟的约定')
  assert.match(fired[0].hint, /\[SILENT\]/, '要给"不想催"的出口')
  assert.equal(br._nudges.size, 0, '催完就从表里拿掉（不重复催）')
})

await okAsync('没到点 → 不催（定时器每 30 秒扫，不该提前）', async () => {
  const { br, fired } = mkDue({}, -60_000)     // 到点时间在 1 分钟后
  await br._tickNudges()
  assert.equal(fired.length, 0)
  assert.equal(br._nudges.size, 1, '还在表里等着')
})

await okAsync('★★ 「频率不要太多」：刚催过 → 下一次不催（最小间隔）', async () => {
  const { br, fired } = mkDue({ minGapMinutes: 5 })
  await br._tickNudges()
  assert.equal(fired.length, 1)
  br._scheduleNudge(MSG, [5])
  br._nudges.get('private:222').dueAt = Date.now() - 1000
  await br._tickNudges()
  assert.equal(fired.length, 1, '距上次催不到 5 分钟，不许再催')
})

await okAsync('★★ 每天上限：到上限就不催了', async () => {
  const { br, fired } = mkDue({ maxPerDay: 1 })
  br._nudgeStat = { day: new Date().toDateString(), count: 1, lastAt: 0 }
  await br._tickNudges()
  assert.equal(fired.length, 0, '今天已经催过 1 次（上限 1）')
})

await okAsync('跨天重置计数（不是永久封顶）', async () => {
  const { br, fired } = mkDue({ maxPerDay: 1 })
  br._nudgeStat = { day: 'Tue Jan 01 2026', count: 9, lastAt: 0 }
  await br._tickNudges()
  assert.equal(fired.length, 1, '新的一天该重新计数')
})

// ── ④ 源码锁：入站要作废、启动要开定时器 ─────────────────
ok('⚠️ 源码锁：onEvent 里必须挂 _cancelNudge（否则"人回来了还催"）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const atCb = src.indexOf('_cancelNudge(msg.scope')
  assert.ok(atCb > 0, 'onEvent 里要调 _cancelNudge')
  // 必须在 allowed 判断之后（被忽略的噪音不该把约定取消掉）
  const atAllowed = src.indexOf('if (!this.allowed(msg))')
  assert.ok(atAllowed > 0 && atCb > atAllowed, '取消要放在白名单判断之后')
})

ok('⚠️ 源码锁：发送漏斗里必须剥标记（每条出站路径都走它）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const atSend = src.indexOf('async _send(msg, text, cover = null)')
  const seg = src.slice(atSend, atSend + 1200)
  assert.match(seg, /stripWaitMarkers\(/, '_send 开头就要剥 [等:N]')
  assert.match(seg, /_scheduleNudge\(/, '剥出来的分钟数要排上催')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)