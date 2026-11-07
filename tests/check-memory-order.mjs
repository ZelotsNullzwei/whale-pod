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
 *   C  `push` 按 `at` 插入到正确位置
 *   A' 载入磁盘数据时稳定排序一次（修历史脏数据）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConversationMemory, MemoryStore, makeMessage } from '../src/memory/short.js'

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

console.log('=== 1. push 按时间插入（C）===')
ok('★ 迟到的回复插到正确位置，不是无脑追加', () => {
  const mem = mkMem()
  const t0 = 1_800_000_000_000
  mem.push({ text: '他先说的', at: t0, isMe: false, sender: 'u1' })
  // 生成耗时 5 秒，期间又来了一条更新的消息
  mem.push({ text: '他后说的', at: t0 + 5000, isMe: false, sender: 'u1' })
  // 她的回复是针对第一条的，at 落在中间
  mem.push({ text: '我的回复', at: t0 + 3000, isMe: true, sender: 'bot' })

  assert.deepEqual(mem.messages.map((m) => m.text), ['他先说的', '我的回复', '他后说的'])
  assert.ok(isSorted(ats(mem)), '数组必须按 at 有序')
})

ok('★ 正常追加（at 递增）不受影响', () => {
  const mem = mkMem()
  const t0 = 1_800_000_000_000
  for (let i = 0; i < 5; i++) mem.push({ text: `m${i}`, at: t0 + i * 1000, isMe: i % 2 === 0 })
  assert.deepEqual(mem.messages.map((m) => m.text), ['m0', 'm1', 'm2', 'm3', 'm4'])
})

ok('同一毫秒的多条保持原有相对顺序（不能被排序打乱）', () => {
  const mem = mkMem()
  const t = 1_800_000_000_000
  mem.push({ text: 'A', at: t, isMe: false })
  mem.push({ text: 'B', at: t, isMe: true })
  mem.push({ text: 'C', at: t, isMe: false })
  assert.deepEqual(mem.messages.map((m) => m.text), ['A', 'B', 'C'])
})

ok('★ 计数逻辑仍按调用顺序（不能被插入位置影响）', () => {
  const mem = mkMem()
  const t0 = 1_800_000_000_000
  mem.push({ text: '他1', at: t0, isMe: false })
  assert.equal(mem.consecutiveTurns, 0, '别人说话不增加连说')
  mem.push({ text: '我1', at: t0 + 100, isMe: true })
  assert.equal(mem.consecutiveTurns, 1, '我说话 +1')
  // 迟到的回复：位置插到前面，但 consecutiveTurns 照样 +1
  mem.push({ text: '我2', at: t0 + 50, isMe: true })
  assert.equal(mem.consecutiveTurns, 2, '插入位置不影响计数')
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
