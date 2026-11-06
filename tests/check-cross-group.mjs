/**
 * 群聊 / 私聊 同步（`[发群]`）的三类 bug（2026-11-06）。
 *
 * 用户：「群聊天和私聊同步那一点感觉 bug 还很多」。
 *
 * 守什么：
 * ① **发错群**：`_activeGroupTarget()` 原来只挑「最近有人说话的群」，
 *    他在私聊说「发到 XX 群」也可能发到别的群 —— 公开动作，收不回。
 * ② **说了发了其实没发**：节流（30 分钟）/ 同内容去重 / 找不到群 三种跳过，
 *    代码只把 note 清空，她正文里的「我发群里了」照样发出去。
 * ③ **抠群名**：只认"发到/发去/发在 + XX + 群"，不能把「发群里」也当点名。
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 从他的话里抠"要发到哪个群" ===')
ok('「发到测试群」→ 测试', () => {
  assert.equal(p._groupHintFromText.call({}, '发到测试群'), '测试')
})
ok('「发去摸鱼群里」→ 摸鱼', () => {
  assert.equal(p._groupHintFromText.call({}, '发去摸鱼群里'), '摸鱼')
})
ok('「发到 704291282」→ 群号', () => {
  assert.equal(p._groupHintFromText.call({}, '发到 704291282'), '704291282')
})
ok('★「发群里」没点名 → 空（走默认目标，不算点名）', () => {
  assert.equal(p._groupHintFromText.call({}, '发群里给大家看看'), '')
})
ok('普通聊天不该抠出群名', () => {
  for (const t of ['今天好累', '你在干嘛', '我看看']) {
    assert.equal(p._groupHintFromText.call({}, t), '', `不该抠出：${t}`)
  }
})

console.log('\n=== 2. 点名了就必须发到那个群（对不上就不发）===')
function target({ hint, scopes, names }) {
  const memory = {
    scopes: () => scopes,
    get: (k) => ({ recent: () => [{ at: Number(k.split(':')[1]) }] }),
  }
  const bridge = { memory, _groupNames: new Map(Object.entries(names ?? {}).map(([id, name]) => [id, { name }])) }
  return p._activeGroupTarget.call(bridge, hint)
}

ok('★ 点名「测试群」→ 只发测试群（哪怕另一个群更活跃）', () => {
  const r = target({
    hint: '测试',
    scopes: ['group:111', 'group:222'],
    names: { 111: '摸鱼群', 222: '测试群' },
  })
  assert.equal(r?.groupId, '222')
})

ok('★ 点名的群不存在 → 返回 null（不发，绝不能发错群）', () => {
  const r = target({
    hint: '不存在的群',
    scopes: ['group:111'],
    names: { 111: '摸鱼群' },
  })
  assert.equal(r, null)
})

ok('没点名 → 回落到"最近活跃的群"（原行为保留）', () => {
  const r = target({ hint: '', scopes: ['group:111', 'group:222'] })
  assert.equal(r?.groupId, '222', '222 的时间戳更大')
})

ok('群名缓存还没热 → 不猜，返回 null', () => {
  const r = target({ hint: '测试', scopes: ['group:111'], names: {} })
  assert.equal(r, null)
})

console.log('\n=== 3. 说"发群里了"但其实没发 → 谎报 ===')
const claim = (text, did) => p._falseClaim.call({}, text, did, '')

ok('★ 节流跳过 + 她说「发群里了」→ 抓到', () => {
  assert.ok(claim('发群里了，等会儿他们就能看到', {}))
})

ok('★ 真发了 → 不抓', () => {
  assert.equal(claim('发群里了', { crossGroup: true }), null)
})

ok('「群里已经发了」也算', () => {
  assert.ok(claim('群里已经发了', {}))
})

ok('普通提到群 ≠ 谎报（不误伤）', () => {
  for (const t of ['群里在聊什么呢', '他们群里太吵了', '我不想发群']) {
    assert.equal(claim(t, {}), null, `不该抓：${t}`)
  }
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
