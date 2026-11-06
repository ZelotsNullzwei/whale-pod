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
import fs from 'node:fs'
import { QQBridge, pickPrivateCover } from '../src/qq/bridge.js'

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

console.log('\n=== 4. 图只给群（用户选 B）===')
/*
 * 现场：
 * ```
 * 15:45:21  画好了（20s）
 * 15:45:24  发群「短的那套上身了，谁要来看」（带图）
 * 15:45:26  [我] private「…好了，这就发。」   ← 嘴上说"这就发"，私聊什么都没有
 * ```
 * 用户口径：**图只给群**，但私聊那句不能说"这就发"。
 */
const img = { url: 'base64://IMG' }

ok('★ 图已经进群了 → 私聊不再重复带同一张', () => {
  assert.equal(pickPrivateCover({ drawnImage: img, sentToGroup: true }), null)
})

ok('★ 图没发成（节流/去重/找不到群）→ 图留在私聊，不能丢', () => {
  assert.deepEqual(pickPrivateCover({ drawnImage: img, sentToGroup: false }), img)
})

ok('找图（findImage）优先级最高，和发群无关', () => {
  const r = pickPrivateCover({ findImage: { buffer: Buffer.from('abc') }, drawnImage: img, sentToGroup: true })
  assert.ok(String(r?.url ?? '').startsWith('base64://'))
})

ok('什么都没画 → null（不硬凑）', () => {
  assert.equal(pickPrivateCover({}), null)
})


console.log('\n=== 5. 30 分钟次数节流默认关掉（用户「冷却不是关了吗」）===')
ok('★ 默认值是 0 = 不限（这个键从没暴露到设置页，不该在后台拦人）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /crossGroupMinGapMs \?\? 0/, '默认必须是不限')
  assert.ok(!/crossGroupMinGapMs \?\? 30 \* 60 \* 1000/.test(src), '不能再有 30 分钟默认值')
})

ok('★ 内容去重还在（防刷屏，跟"他明确要发"不冲突）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /_groupSendDup/)
})

console.log('\n=== 6. 「发个图」要算作"要拍"（否则画图被拦、发群只剩文字）===')
ok('★ wantsPic 覆盖 图/照片/发个/发张/群里发', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const m = /const wantsPic = (\/.*?\/)\.test/.exec(src)
  assert.ok(m, '找不到 wantsPic')
  const re = eval(m[1])
  for (const t of ['群里发个图', '发张照片', '发个图看看', '给我张图']) {
    assert.equal(re.test(t), true, `应该算要拍：${t}`)
  }
  assert.equal(re.test('？'), false, '「？」仍然不算')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
