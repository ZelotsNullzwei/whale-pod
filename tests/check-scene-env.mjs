/**
 * 括号里不许写环境（2026-11-10）
 *
 * ## 现场
 * 私聊日常：
 * ```
 * 17:43:05「（窝在沙发上，手机举着，屋里灯没开，天暗下来了）\n\n本来要出门的…」
 * ```
 * 真人聊天不会描述房间/灯光/天色，更不会把它单独写成一段（像舞台提示）。
 * 括号里合法的是**动作、身体感觉、情绪**。
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const b = Object.create(QQBridge.prototype)
b.log = { info() {}, warn() {} }
const strip = (t) => b._stripEnvScene(t)

console.log('=== 1. 环境子句要删掉 ===')
ok('★ 事故原句：灯/天色删掉，体姿保留，正文不动', () => {
  const t = '（窝在沙发上，手机举着，屋里灯没开，天暗下来了）\n\n本来要出门的，一坐就坐到现在。'
  const out = strip(t)
  assert.ok(!/灯没开/.test(out), '「灯没开」应删掉')
  assert.ok(!/天暗下来/.test(out), '「天暗下来了」应删掉')
  assert.ok(/窝在沙发上/.test(out), '体姿要保留')
  assert.ok(/手机举着/.test(out), '动作要保留')
  assert.ok(/本来要出门的/.test(out), '正文一个字都不能少')
})

ok('★ 整个括号段只有环境 → 整段删掉，不留空行', () => {
  const out = strip('（屋里灯没开，天暗下来了）\n\n刚洗完碗。')
  assert.ok(!/灯没开/.test(out), '环境段应整段删')
  assert.equal(out, '刚洗完碗。')
})

console.log('\n=== 2. 正常的括号不许误伤 ===')
ok('★「（往沙发上一靠）」保留（有身体动作）', () => {
  const t = '（往沙发上一靠）你今天忙到这会儿，累不累。'
  assert.equal(strip(t), t)
})
ok('★ 纯身体/情绪括号保留', () => {
  for (const t of ['（耳鳍动了动）嗯。', '（腿根紧了一下）', '（笑）行啊', '（趴在桌上）累死了', '（不看你了）']) {
    assert.equal(strip(t), t, `不该改：${t}`)
  }
})
ok('无括号 → 原样', () => {
  const t = '屋里灯没开，天暗下来了'
  assert.equal(strip(t), t)
})

console.log('\n=== 3. 兜底：全删光就回退原文 ===')
ok('★ 整条只有环境括号 → 返回原文，不发空', () => {
  const t = '（屋里灯没开）'
  assert.equal(strip(t), t)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
