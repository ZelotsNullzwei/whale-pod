/**
 * 被戳时说的话不要是固定两句（2026-11-07）。
 *
 * 原来从一个 6 句固定池随机，戳多了就那两句来回。
 * 现在先让模型现编一句极短的话；模型失败/超时才回退固定池。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const mk2 = (list) => ({ memory: { get: () => ({ recent: () => list }) } })

const mk = (chunks) => ({
  cfg: { model: 'magpie/magpie/auto/deepseek-v4.1-flash' },
  gateway: {
    stream: () => (async function* () { for (const c of chunks) yield c })(),
  },
})

console.log('=== 1. 模型能出话 ===')
await ok('★ 拼出模型给的短句', async () => {
  const t = await p._pokeLine.call(mk([{ type: 'text-delta', text: '干嘛呀' }]))
  assert.equal(t, '干嘛呀')
})
await ok('去引号/去括号', async () => {
  const t = await p._pokeLine.call(mk([{ type: 'text-delta', text: '「别戳了」' }]))
  assert.equal(t, '别戳了')
})

console.log('\n=== 2. 失败要回退 ===')
await ok('★ 上游报错 → null（调用方回退固定池）', async () => {
  const fake = {
    cfg: { model: 'x/y' },
    gateway: { stream: () => (async function* () { yield { type: 'error', message: 'boom' } })() },
  }
  assert.equal(await p._pokeLine.call(fake), null)
})
await ok('没有 gateway → null', async () => {
  assert.equal(await p._pokeLine.call({ cfg: {} }), null)
})
await ok('空文本 → null', async () => {
  assert.equal(await p._pokeLine.call(mk([{ type: 'text-delta', text: '   ' }])), null)
})

console.log('\n=== 3. 被戳 = 问一句，不是报状态（2026-11-07 用户口径）===')
await ok('★ 单独一个「？」能原样发出去', async () => {
  const t = await p._pokeLine.call(mk([{ type: 'text-delta', text: '？' }]))
  assert.equal(t, '？')
})
await ok('★ 它硬写括号动作 → 剥掉只留话', async () => {
  const t = await p._pokeLine.call(mk([{ type: 'text-delta', text: '（抬头）干嘛' }]))
  assert.equal(t, '干嘛')
})
await ok('★ 整条只有括号动作 → null（回退固定池）', async () => {
  const t = await p._pokeLine.call(mk([{ type: 'text-delta', text: '（揉了揉眼睛）' }]))
  assert.equal(t, null)
})
await ok('★ 提示词要明说「不许描述自己在做什么」', () => {
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(SRC, /不许描述自己正在做什么/, '缺这条约束 —— 她就会说「困着呢」这种')
  assert.match(SRC, /第一反应是\*\*问对方要干嘛\*\*/, '缺"问一句"的导向')
})
await ok('★ 固定池里要有「？」和「干嘛」', () => {
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const i = SRC.indexOf(": ['？'")
  assert.ok(i > 0, '找不到固定池')
  const seg = SRC.slice(i, i + 120)
  assert.ok(seg.includes('干嘛'), '固定池缺「干嘛」')
})

console.log('\n=== 4. 正聊着的时候，戳 = 催（2026-11-07 用户口径）===')
await ok('★ 刚聊过（他最后一句）→ 算"连着"', () => {
  const now = Date.now()
  const r = p._recentChatState.call(mk2([
    { isMe: true, text: 'a', at: now - 60_000 },
    { isMe: false, text: 'b', at: now - 30_000 },
  ]), 'group:1')
  assert.equal(r.fresh, true)
  assert.equal(r.lastFromHim, true)
})
await ok('★ 20 分钟前的消息 → 不算连着（那是冷场）', () => {
  const r = p._recentChatState.call(mk2([
    { isMe: false, text: 'b', at: Date.now() - 20 * 60_000 },
  ]), 'group:1')
  assert.equal(r.fresh, false)
})
await ok('★ 全是她自己说的话 → 不算聊天', () => {
  const r = p._recentChatState.call(mk2([
    { isMe: true, text: 'c', at: Date.now() - 20_000 },
  ]), 'group:1')
  assert.equal(r.fresh, false)
})
await ok('★ 源码锁：戳=催的分支必须排在「随机不理」之前', () => {
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const iNudge = SRC.indexOf('当成催促，直接接话')
  const iChance = SRC.indexOf('本次随机不理')
  assert.ok(iNudge > 0, '没有「戳=催」的分支')
  assert.ok(iChance > 0, '找不到概率闸')
  assert.ok(iNudge < iChance, '「戳=催」排在随机不理后面 —— 催他也会装死')
})
await ok('★ 催促提示词要明禁「干嘛」和 [SILENT]', () => {
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const i = SRC.indexOf('别问「干嘛」「怎么了」')
  assert.ok(i > 0, '缺"别问干嘛"的约束')
  const seg = SRC.slice(i, i + 220)
  assert.ok(seg.includes('[SILENT]'), '缺"不要 [SILENT]"的约束')
})

console.log('\n=== 5. 别人互相戳要进上下文（2026-11-07「爆点米」事件）===')
/*
 * 现场：17:48 番茄「看了给你充token」，18:33 他**戳了风宝一下**再说「爆点米」
 * （= 催风宝也出钱）。她只看到孤零零的「爆点米」，理解成米饭，
 * 回「本鲸哪来的米，米都进本鲸肚子里了」。
 *
 * 根因：戳一戳是 notice，不进消息流；而 _onNotice 原来只处理"戳我"的，
 * 别人之间的戳被整条 return 掉。
 */
const mkName = (list) => ({ memory: { get: () => ({ recent: () => list }) } })
await ok('★ _nameFromMemory 能从会话记忆里认出昵称', () => {
  const b = mkName([
    { sender: '1001', senderName: '番茄' },
    { sender: '1002', senderName: '风宝' },
  ])
  assert.equal(p._nameFromMemory.call(b, 'group:1', '1002'), '风宝')
})
await ok('★ 认不出来的返回空串（调用方退回用号码）', () => {
  const b = mkName([{ sender: '1001', senderName: '番茄' }])
  assert.equal(p._nameFromMemory.call(b, 'group:1', '9999'), '')
})
await ok('★ 源码锁：别人互相戳要在 return 之前记一条', () => {
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const iSelf = SRC.indexOf("if (!this.selfId || targetId !== String(this.selfId))")
  assert.ok(iSelf > 0, '找不到「只理戳我」那条判断')
  const seg = SRC.slice(iSelf, iSelf + 900)
  assert.match(seg, /戳了 \$\{to\} 一下/, '没有把「谁戳了谁」写成注记')
  assert.match(seg, /已记进群上下文/, '没有对应日志')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
