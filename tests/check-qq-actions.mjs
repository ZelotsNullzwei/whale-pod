/**
 * QQ 侧动作标记（2026-11-04）。
 *
 * `[回应:13]` 贴表情 / `[戳]` 戳一戳 / `[签名:…]` 改自己签名 / `[撤回]` 撤回上一条。
 *
 * ## 守什么
 * ① 标记认得出、剥得干净（漏出去就是「[戳]」三个字发到群里）
 * ② 执行时参数对：贴表情带 message_id、群戳带 group_id、私聊走 friend_poke、
 *    撤回用的是"我上一条"的 id
 * ③ **开关关掉就不调**（用户要的是"免费默认开、别的可关"）
 * ④ **失败绝不影响回复**：onebot 抛错 → 返回空说明，不往外抛
 */
/*
 * ⚠️ **隔离状态文件**（2026-11-08）：
 *   qqActions 会把「上次发说说的时间」写到 <WHALE_POD_HOME>/qzone-last.json，
 *   用来做 20 小时限频。测试如果不隔离，跑第一次之后**后面全被限频挡住**
 *   （实测：check-qzone-own-photo 6 项全挂，原因就是这个文件被上一次测试写进去了）。
 */
import './_isolate-home.mjs' // ★ 必须是第一个 import：ESM 提升，晚设 env 无效
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { extractQQMarkers, runQQMarkers, ACTION_KEYS } from '../src/qq/qqActions.js'

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

/** 假 onebot：把调用记下来。 */
const mkOnebot = (reply = { status: 'ok' }) => {
  const calls = []
  return {
    calls,
    _sendPreferHttp: async (action, params) => { calls.push({ action, params }); return reply },
  }
}
const mem = (texts) => ({
  recent: () => texts.map((t, i) => ({ text: t, isMe: true, id: 'mid' + i })),
})

console.log('=== 1. 标记的认与剥 ===')
ok('四个标记都认得出', () => {
  const r = extractQQMarkers('好[回应:13]戳你[戳]签名[签名:今天也在摸鱼]撤回[撤回]')
  assert.deepEqual(r.items.map((x) => x.id), ['emojiLike', 'poke', 'signature', 'recall'])
  assert.deepEqual(r.items.map((x) => x.arg), ['13', '', '今天也在摸鱼', ''])
})

ok('剥干净：正文里不留方括号', () => {
  const r = extractQQMarkers('行吧[戳]')
  assert.equal(r.text, '行吧')
})

ok('全角括号也认', () => {
  const r = extractQQMarkers('［回应：14］')
  assert.equal(r.items[0]?.id, 'emojiLike')
  assert.equal(r.items[0]?.arg, '14')
  assert.equal(r.text, '')
})

ok('没有标记 → 原样返回', () => {
  const r = extractQQMarkers('今天天气不错')
  assert.equal(r.items.length, 0)
  assert.equal(r.text, '今天天气不错')
})

console.log('=== 2. 执行参数 ===')
await okAsync('贴表情 → set_msg_emoji_like{message_id, emoji_id}', async () => {
  const ob = mkOnebot()
  const notes = await runQQMarkers({
    items: [{ id: 'emojiLike', arg: '13' }], onebot: ob,
    msg: { messageId: '999', userId: '1' }, mem: mem(['x']), cfg: {}, log: {},
  })
  assert.equal(ob.calls[0].action, 'set_msg_emoji_like')
  assert.deepEqual(ob.calls[0].params, { message_id: '999', emoji_id: '13' })
  assert.equal(notes[0], '回应了')
})

await okAsync('群聊里戳 → group_poke 带 group_id', async () => {
  const ob = mkOnebot()
  await runQQMarkers({
    items: [{ id: 'poke', arg: '' }], onebot: ob,
    msg: { groupId: '704291282', userId: '2129024700' }, mem: mem(['x']), cfg: {}, log: {},
  })
  assert.equal(ob.calls[0].action, 'group_poke')
  assert.equal(ob.calls[0].params.group_id, '704291282')
  assert.equal(ob.calls[0].params.user_id, '2129024700')
})

await okAsync('私聊里戳 → friend_poke', async () => {
  const ob = mkOnebot()
  await runQQMarkers({
    items: [{ id: 'poke', arg: '' }], onebot: ob,
    msg: { userId: '2129024700' }, mem: mem(['x']), cfg: {}, log: {},
  })
  assert.equal(ob.calls[0].action, 'friend_poke')
  assert.deepEqual(ob.calls[0].params, { user_id: '2129024700' })
})

await okAsync('签名 → set_qq_profile{personal_note}（截 40 字，只在放行的私聊里）', async () => {
  const ob = mkOnebot()
  await runQQMarkers({
    items: [{ id: 'signature', arg: '一'.repeat(60) }], onebot: ob,
    msg: { userId: '2129024700', scope: 'private:2129024700' }, mem: mem(['x']),
    cfg: { signatureAllow: { '2129024700': true } }, log: {},
    selfName: '蓝色大鲸鱼',
  })
  assert.equal(ob.calls[0].action, 'set_qq_profile')
  assert.equal(ob.calls[0].params.personal_note.length, 40)
  /*
   * ★ 协议端 schema 把 nickname 也标成必填（2026-11-04 实测）：
   *   只传 personal_note → 400 "Schema compilation error: Expected required property"
   *   带上当前昵称 → ok，且回读 longNick 真变了。
   */
  assert.equal(ob.calls[0].params.nickname, '蓝色大鲸鱼', '缺 nickname 会被协议端直接拒')
})

await okAsync('签名：群聊里一律拒绝（哪怕在放行名单里）', async () => {
  const ob = mkOnebot()
  await runQQMarkers({
    items: [{ id: 'signature', arg: '随便写' }], onebot: ob,
    msg: { userId: '2129024700', groupId: '704291282', scope: 'group:704291282' }, mem: mem(['x']),
    cfg: { signatureAllow: { '2129024700': true } }, log: {},
  })
  assert.equal(ob.calls.length, 0, '群里不该改签名')
})

await okAsync('签名：不在名单里的私聊也拒绝', async () => {
  const ob = mkOnebot()
  await runQQMarkers({
    items: [{ id: 'signature', arg: '随便写' }], onebot: ob,
    msg: { userId: '999', scope: 'private:999' }, mem: mem(['x']),
    cfg: { signatureAllow: { '2129024700': true } }, log: {},
  })
  assert.equal(ob.calls.length, 0)
})

await okAsync('撤回 → delete_msg 用"我上一条"的 id', async () => {
  const ob = mkOnebot()
  await runQQMarkers({
    items: [{ id: 'recall', arg: '' }], onebot: ob,
    msg: { userId: '1' }, mem: mem(['第一条', '第二条']), cfg: {}, log: {},
  })
  assert.equal(ob.calls[0].action, 'delete_msg')
  assert.deepEqual(ob.calls[0].params, { message_id: 'mid1' })
})

console.log('=== 3. 开关 ===')
await okAsync('关掉的动作不调接口（但标记照样被剥）', async () => {
  const ob = mkOnebot()
  const notes = await runQQMarkers({
    items: [{ id: 'poke', arg: '' }], onebot: ob,
    msg: { userId: '1' }, mem: mem(['x']), cfg: { poke: false }, log: {},
  })
  assert.equal(ob.calls.length, 0)
  assert.equal(notes.length, 0)
})

await okAsync('ACTION_KEYS 覆盖四个动作', async () => {
  assert.deepEqual([...ACTION_KEYS].sort(), ['emojiLike', 'poke', 'recall', 'signature'])
})

console.log('=== 4. 失败不能影响回复 ===')
await okAsync('onebot 抛错 → 不往外抛、说明为空', async () => {
  const ob = { _sendPreferHttp: async () => { throw new Error('协议端 500') } }
  const notes = await runQQMarkers({
    items: [{ id: 'poke', arg: '' }], onebot: ob,
    msg: { userId: '1' }, mem: mem(['x']), cfg: {}, log: {},
  })
  assert.deepEqual(notes, [])
})

await okAsync('协议端返回非 ok → 也不算成功', async () => {
  const ob = mkOnebot({ status: 'failed', retcode: 100 })
  const notes = await runQQMarkers({
    items: [{ id: 'poke', arg: '' }], onebot: ob,
    msg: { userId: '1' }, mem: mem(['x']), cfg: {}, log: {},
  })
  assert.deepEqual(notes, [])
})


console.log('\n=== 撤回的触发条件（2026-11-08）===')
ok('★ 提示词里写清三种该撤的情形 + 可解释可不解释', () => {
  const b = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(b, /话还没说完你就接了下半句/)
  assert.match(b, /抽象得离谱/)
  assert.match(b, /已经过时/)
  assert.match(b, /撤完可以解释一句/)
})
ok('★ [撤回] 能被解析成动作并从文本里剥掉', async () => {
  const { extractQQMarkers } = await import('../src/qq/qqActions.js')
  const r = extractQQMarkers('刚说错了 [撤回] 当我没说')
  assert.equal(r.items[0]?.id, 'recall')
  assert.ok(!r.text.includes('撤回'))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)