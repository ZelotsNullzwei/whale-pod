/**
 * 时序回归测试（2026-11-07）。
 *
 * 「时序乱序感觉很要命」—— 实测群 704291282 的 30 条短期记忆里有 **6 处乱序**：
 * ```
 * 12:08:28 → 11:05:05
 * 12:36:03 → 12:35:56
 * 12:36:51 → 12:36:50
 * 12:40:38 → 12:40:35
 * ```
 * 后果不是"顺序难看"，而是模型看到「我先说话、他后说话」，
 * 于是答上一条、重复回答、说自己"没收到图"。
 *
 * 根因两条：
 *   ① `at` 混用两套时钟：入站用 QQ 服务器时间（秒级、慢 1~3 秒），
 *      出站用本地 Date.now()（毫秒）
 *   ② `push` 无脑 append —— 它发生在**发送成功之后**，而生成要 5~8 秒，
 *      这期间新消息已经入列，于是她的回复"后入列但时间更早"
 *
 * 修法：
 *   B  `at` 统一成本地接收时刻，服务器时间另存 `serverAt`
 *   A  渲染给模型的那份副本按 `at` 稳定排序（原数组不动）
 *   A' 载入磁盘数据时稳定排序一次（修历史脏数据）
 *
 * ⚠️ 试过"push 按 at 插入"，但运行期有逻辑默认**数组顺序 = 推送顺序**
 *    （`_checkSuperseded` / `_coalesceInbound`），改了会让
 *    `check-concurrency` 从 32/0 掉到 29/3（三条只回一条）。所以只排副本。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConversationMemory, MemoryStore, makeMessage } from '../src/memory/short.js'
import { buildChatMessages } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const ats = (mem) => mem.messages.map((m) => Number(m.at))
const isSorted = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] <= v)

function mkMem(over = {}) {
  return new ConversationMemory({ maxMessages: 200, maxChars: 100000, maxAgeMs: 0, ...over })
}

console.log('=== 1. 渲染顺序按 at（A）===')
/*
 * ⚠️ 方案调整（2026-11-07）：
 * 一开始我把 `push` 改成"按 at 插入"，结果 `check-concurrency` 从 32/0 掉到 29/3
 * —— 运行期有逻辑（`_checkSuperseded` / `_coalesceInbound`）默认
 * **数组顺序 = 推送顺序**，动了它就会漏回消息。
 * 所以改成：**数组照旧 append，只在渲染给模型看的那份副本上排序**。
 */
ok('★ 数组里倒挂的，渲染输出必须按 at 有序', () => {
  const t0 = 1_800_000_000_000
  const history = [
    { id: '1', text: '他先说的', at: t0, isMe: false, sender: 'u1', senderName: '他' },
    // 迟到的回复：推入时排在后面，但时间在中间
    { id: '3', text: '我的回复', at: t0 + 3000, isMe: true, sender: 'bot', senderName: '她' },
    { id: '2', text: '他后说的', at: t0 + 5000, isMe: false, sender: 'u1', senderName: '他' },
  ]
  const out = buildChatMessages({ system: 'S', history, imageCache: new Map() })
  const texts = out.map((m) => (Array.isArray(m.content)
    ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
    : String(m.content ?? '')))
  const order = texts.findIndex((x) => x.includes('他先说的'))
  const mine = texts.findIndex((x) => x.includes('我的回复'))
  const later = texts.findIndex((x) => x.includes('他后说的'))
  assert.ok(order >= 0 && mine >= 0 && later >= 0, `三段都要在：${JSON.stringify(texts)}`)
  assert.ok(order < mine && mine < later, `渲染顺序应当是 他先说 → 我 → 他后说，实际 ${JSON.stringify(texts)}`)
})

ok('★ 原数组不能被改动（渲染只排副本）', () => {
  const t0 = 1_800_000_000_000
  const history = [
    { id: '1', text: 'A', at: t0 + 8000 },
    { id: '2', text: 'B', at: t0 + 1000 },
  ]
  const before = history.map((m) => m.text)
  buildChatMessages({ system: 'S', history, imageCache: new Map() })
  assert.deepEqual(history.map((m) => m.text), before, '调用方数组必须原样不动')
})

ok('同一毫秒的多条保持原有相对顺序（稳定排序）', () => {
  const t = 1_800_000_000_000
  const history = [
    { id: '1', text: '甲', at: t, isMe: false, sender: 'a', senderName: 'A' },
    { id: '2', text: '乙', at: t + 100, isMe: true, sender: 'bot', senderName: '她' },
    { id: '3', text: '丙', at: t, isMe: false, sender: 'b', senderName: 'B' },
  ]
  const out = buildChatMessages({ system: 'S', history, imageCache: new Map() })
  const texts = out.map((m) => (Array.isArray(m.content)
    ? m.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
    : String(m.content ?? '')))
  const a = texts.findIndex((x) => x.includes('甲'))
  const c = texts.findIndex((x) => x.includes('丙'))
  assert.ok(a < c, `同 at 的甲应排在丙前面（保持原序），实际 ${JSON.stringify(texts)}`)
})

ok('★ 计数逻辑仍按调用顺序（push 保持 append）', () => {
  const mem = mkMem()
  const t0 = 1_800_000_000_000
  mem.push({ text: '他1', at: t0, isMe: false })
  assert.equal(mem.consecutiveTurns, 0, '别人说话不增加连说')
  mem.push({ text: '我1', at: t0 + 100, isMe: true })
  assert.equal(mem.consecutiveTurns, 1, '我说话 +1')
  mem.push({ text: '我2', at: t0 + 50, isMe: true })
  assert.equal(mem.consecutiveTurns, 2, '计数与 at 无关')
  assert.equal(mem.messages.length, 3)
})

console.log('\n=== 2. 载入时修正历史脏数据（A\'）===')
ok('★ 磁盘里是乱序的，载入后必须有序', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-order-'))
  const file = path.join(dir, 'memory-short.json')
  const t = 1_800_000_000_000
  fs.writeFileSync(file, JSON.stringify({
    sessions: {
      'group:1': {
        messages: [
          { text: 'late', at: t + 8000 },
          { text: 'early', at: t + 1000 },
          { text: 'mid', at: t + 4000 },
        ],
        totalPushed: 3,
      },
    },
  }), 'utf8')

  const store = new MemoryStore({ dir, maxAgeMs: 0, maxMessages: 200 })
  store.load()
  const mem = store.get('group:1')
  assert.deepEqual(mem.messages.map((m) => m.text), ['early', 'mid', 'late'])
  assert.ok(isSorted(ats(mem)))
  fs.rmSync(dir, { recursive: true, force: true })
})

console.log('\n=== 3. onebot：at 用本地时间，服务器时间另存（B）===')
ok('★ parseMessage 的 at 是本地接收时刻，serverAt 保留 QQ 时间', () => {
  const src = fs.readFileSync(new URL('../src/qq/onebot.js', import.meta.url), 'utf8')
  assert.match(src, /at: Date\.now\(\),/, 'at 必须是本地时间')
  assert.match(src, /serverAt:/, '服务器时间要留下来')
  assert.ok(
    !/at: Number\(ev\.time \? ev\.time \* 1000/.test(src),
    '不能再用 QQ 服务器时间当 at（会和 Date.now() 混用）',
  )
})

console.log('\n=== 4. 抢跑守卫（deadair / proactive）===')
ok('★ deadair 会检查"这个会话正在生成"，并且"已经回过就不补"', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  /*
   * ⚠️ 必须找**方法定义**。只搜 `_armDeadAir(` 会先命中调用点
   *    （`this._armDeadAir(msg, ...)`），它在 2800 行之前，
   *    按字符窗口切根本够不到守卫（2026-11-07 踩过两次同样的坑）。
   */
  const i = src.indexOf('_armDeadAir(msg, mem, scene, self) {')
  assert.ok(i > 0, '找不到 _armDeadAir 的定义')
  const body = src.slice(i, i + 2500)
  assert.match(body, /_queueBusy\(scope\)/, 'deadair 要看有没有人在生成')
  assert.match(body, /已经回过了/, '已经回过就别再补')
})

ok('★ proactive 主动发言也要让路', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  // ⚠️ 不能搜「主动发言让路」—— 那会先命中我写的注释；
  //    直接搜代码行更稳。
  const i = src.indexOf('_queueBusy(msg.scope)')
  assert.ok(i > 0, 'proactive 没有 _queueBusy 守卫')
  const near = src.slice(i, i + 300)
  assert.match(near, /主动发言让路/, '守卫后面要跟着跳过')
})

console.log('\n=== 5. 别顺着"我没收到图"说下去（P2）===')
ok('★ 这一轮有图、上一轮说过"没收到" → 要纠正', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /别再重复"没收到\/没看着\/图没出来"/)
  assert.match(src, /上一轮说"没收到图"/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
