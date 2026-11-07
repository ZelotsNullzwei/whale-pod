/**
 * 「我离线过多久」要让她知道（2026-11-07）。
 *
 * 现场：他 10:12 在私聊里说「今天断电了 / 没给你开机 / 中午给你开机就能聊天了」，
 * 但那时进程根本没在跑 —— 她 12:08 起来以后，不知道自己错过了一段时间。
 *
 * 现在：心跳文件 alive.json 记「最后一次活着」，启动时算 gap（≥10 分钟才算数），
 * 然后在提示词里明说「你刚才不在线 N 小时」：先看补回来的记录、别说"我一直都在"。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-alive-'))
// 用原型做底：这些方法内部会互相调用（_aliveFile 等）
const mk = (home) => Object.assign(Object.create(p), { cfg: { home }, log: { info: () => {}, warn: () => {} } })
const fake = mk(dir)

console.log('=== 1. 心跳 ===')
ok('★ 写心跳文件', () => {
  p._touchAlive.call(fake)
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'alive.json'), 'utf8'))
  assert.ok(Number(j.at) > 0)
})

console.log('\n=== 2. 离线 gap ===')
ok('★ 两小时前的心跳 → 算得出 120 分钟左右', () => {
  fs.writeFileSync(path.join(dir, 'alive.json'), JSON.stringify({ at: Date.now() - 120 * 60_000 }))
  const b = mk(dir)
  p._loadOfflineGap.call(b)
  assert.ok(b._offlineGap?.gap >= 119 * 60_000, 'gap 没算出来')
})
ok('★ 提示词里说明「你刚才不在线」并要求别装一直在', () => {
  const b = Object.assign(mk(dir), { _bootAt: Date.now() })
  p._loadOfflineGap.call(b)
  const hint = p._offlineHint.call(b)
  assert.match(hint, /你刚才不在线/)
  assert.match(hint, /两个小时|2 小时/)
  assert.match(hint, /别提「我一直都在」/)
})
ok('没有心跳文件 → 不提示、不崩', () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-alive2-'))
  const b = mk(d2)
  p._loadOfflineGap.call(b)
  assert.equal(p._offlineHint.call(b), '')
})
ok('只断了几十秒 → 不提示', () => {
  fs.writeFileSync(path.join(dir, 'alive.json'), JSON.stringify({ at: Date.now() - 30_000 }))
  const b = Object.assign(mk(dir), { _bootAt: Date.now() })
  p._loadOfflineGap.call(b)
  assert.equal(p._offlineHint.call(b), '')
})

ok('★ 源码锁：开机补历史 + 主动补一句', () => {
  const src = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
  assert.ok(src.includes('countUse'), '离线时补历史要放大条数')
  assert.ok(src.includes('开机补话'), '要主动补一句')
  assert.ok(src.includes('_speakUp('), '走主动发言那条路')
})

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
