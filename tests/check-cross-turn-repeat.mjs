/**
 * 跨轮重复：新回复整段照抄上一条 → 只留新内容（2026-11-10）
 *
 * ## 现场（私聊，两个输入、两次独立生成）
 * ```
 * 16:53:10  输入「手机里面」
 *           「（隔着手机也算在了。／那本鲸不出去了，跟你说也一样。／（往沙发上一靠）你今天忙到这会儿，累不累。」
 * 16:53:19  输入「[表情包]」
 *           「（隔着手机也算在了。／那本鲸不出去了，跟你说也一样。／（往靠枕上蹭了蹭）你今天忙到这会儿，累不累。」
 * ```
 * 两条 message id 不同（745669361 / 1224700182）→ 不是重发；
 * 但前两段逐字相同。`_stripSelfRepeat` 只管"同一条内部"，这里补"和上一条比"。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const PREV = '（隔着手机也算在了。\n\n那本鲸不出去了，跟你说也一样。\n\n（往沙发上一靠）你今天忙到这会儿，累不累。'
const b = Object.create(QQBridge.prototype)
b.log = { info() {}, warn() {} }
b._lastBotText = new Map([['private:1', PREV]])
const strip = (t, scope = 'private:1') => b._stripCrossTurnRepeat(t, scope)

console.log('=== 1. 事故原样 ===')
ok('★ 前两段照抄上一条 → 只留第三段（新的那句）', () => {
  const next = '（隔着手机也算在了。\n\n那本鲸不出去了，跟你说也一样。\n\n（往靠枕上蹭了蹭）你今天忙到这会儿，累不累。'
  const out = strip(next)
  assert.ok(!/隔着手机也算在了/.test(out), '重复的第一段应去掉')
  assert.ok(!/不窝着|不出去了，跟你说也一样/.test(out), '重复的第二段应去掉')
  assert.ok(/往靠枕上蹭了蹭/.test(out), '新的动作要留')
  assert.ok(/累不累/.test(out), '新信息要留')
})

console.log('\n=== 2. 不该误伤 ===')
ok('★ 完全不同 → 原样', () => {
  const t = '行啊。\n\n那你先忙，本鲸自己待会儿。'
  assert.equal(strip(t), t)
})
ok('★ 只有一段、且和上一条不同 → 原样', () => {
  const t = '（伸了个懒腰）刚醒。'
  assert.equal(strip(t), t)
})
ok('★ 换了个说法（不是逐字相同）→ 不删', () => {
  const t = '（隔着手机也算数。\n\n本鲸不出去转了，跟你说也一样。'
  assert.equal(strip(t), t)
})
ok('别的会话不受影响', () => {
  const t = '（隔着手机也算在了。\n\n那本鲸不出去了，跟你说也一样。'
  assert.equal(strip(t, 'private:2'), t)
})

console.log('\n=== 3. 兜底 ===')
ok('★ 全段重复 → 回退原文（不发明、不发空）', () => {
  const t = '（隔着手机也算在了。\n\n那本鲸不出去了，跟你说也一样。'
  assert.equal(strip(t), t)
})
ok('上一条为空 → 原样', () => {
  const c = Object.create(QQBridge.prototype)
  c.log = { info() {}, warn() {} }
  c._lastBotText = new Map()
  const t = '（隔着手机也算在了。\n\n本鲸不出去转了。'
  assert.equal(c._stripCrossTurnRepeat(t, 'private:1'), t)
})

console.log('\n=== 4. 接线锁：基准要在 _send 单一出口更新 ===')
ok('★ `_send` 发送成功后写 `_lastBotText`（不能只在 _handle 里写）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const i = src.lastIndexOf('return sentIds')
  const seg = src.slice(Math.max(0, i - 900), i)
  assert.match(seg, /_lastBotText\.set\(/, '_send 出口没更新基准')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
