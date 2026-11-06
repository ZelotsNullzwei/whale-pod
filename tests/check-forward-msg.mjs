/**
 * 合并转发（聊天记录）能不能看（2026-11-06）。
 *
 * ## 之前是什么样
 * `parseMessage` 把 forward 段压成正文里的「[合并转发]」四个字，**id 扔了**
 * —— 她只知道"有人转了一段聊天记录"，里面一个字都看不到。
 *
 * ## 现在
 * ① 解析时把 id 留下来（`forwards: [{id}]`，数组和 CQ 码两条路径都要）
 * ② `OneBotClient#getForwardMsg` 用 `get_forward_msg` 换内容，按
 *    节点数 / 总字数 / 单条字数**三重截断**（转发动辄上百条，全塞会把
 *    免费渠道的上下文预算吃光）
 * ③ bridge 就地把 `[合并转发]` 占位**替换成内容**（照 dsh-qq 的做法），
 *    取不到就保持占位、warn 一句，绝不影响回复
 */
import assert from 'node:assert/strict'
import { parseMessage, normalizeEvent, OneBotClient } from '../src/qq/onebot.js'

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

console.log('=== 1. 解析：id 必须留下来 ===')
ok('数组形态：forward 段带 id', () => {
  const r = parseMessage([
    { type: 'text', data: { text: '你看这个' } },
    { type: 'forward', data: { id: 'abc123' } },
  ])
  assert.deepEqual(r.forwards, [{ id: 'abc123' }])
  assert.equal(r.text, '你看这个[合并转发]', '正文占位要保留（取不到内容时的兜底）')
})

ok('CQ 码形态：forward 也认', () => {
  const r = parseMessage('你看这个[CQ:forward,id=xyz789]')
  assert.deepEqual(r.forwards, [{ id: 'xyz789' }])
  assert.equal(r.text, '你看这个[合并转发]')
})

ok('没有转发 → 空数组（老代码不会因此崩）', () => {
  assert.deepEqual(parseMessage([{ type: 'text', data: { text: 'hi' } }]).forwards, [])
})

ok('事件规范化后 forwards 跟着上来', () => {
  const ev = normalizeEvent({
    post_type: 'message', message_type: 'group', group_id: 1, user_id: 2,
    message_id: 3, time: 1, sender: { card: '甲' },
    message: [{ type: 'forward', data: { id: 'f1' } }],
  })
  assert.deepEqual(ev.forwards, [{ id: 'f1' }])
})

console.log('\n=== 2. getForwardMsg：取内容 + 三重截断 ===')
const mkClient = (messages) => {
  const c = Object.create(OneBotClient.prototype)
  c.callHttp = async () => ({ status: 'ok', data: { messages } })
  return c
}
const node = (text, who = '番茄') => ({
  message: [{ type: 'text', data: { text } }],
  sender: { card: who },
})

await okAsync('正常取回：带"转发了聊天记录·N条"抬头、每行名字：内容', async () => {
  const c = mkClient([node('第一句'), node('第二句', '风宝'), node('第三句')])
  const got = await c.getForwardMsg('f1')
  assert.ok(got)
  assert.match(got.text, /\[转发了聊天记录·3条\]/)
  assert.match(got.text, /番茄：第一句/)
  assert.match(got.text, /风宝：第二句/)
  assert.equal(got.total, 3)
  assert.equal(got.used, 3)
  assert.equal(got.truncated, false)
})

await okAsync('节点数截断：给 20 条只展开 16，并说明还有几条', async () => {
  const c = mkClient(Array.from({ length: 20 }, (_, i) => node(`第${i + 1}句`)))
  const got = await c.getForwardMsg('f1', { maxNodes: 16 })
  assert.equal(got.total, 20)
  assert.equal(got.used, 16)
  assert.equal(got.truncated, true)
  assert.match(got.text, /后面还有 4 条没展开/)
})

await okAsync('总字数截断：超出预算就停（防止撑爆上下文）', async () => {
  const c = mkClient(Array.from({ length: 30 }, () => node('这是一句很长很长的话'.repeat(3))))
  const got = await c.getForwardMsg('f1', { maxNodes: 16, maxChars: 200 })
  assert.ok(got.used < 16, `只该展开几条，实际 ${got.used}`)
  assert.ok(got.text.length < 1200, `长度 ${got.text.length}`)
})

await okAsync('单条太长 → 省略号截断，不是硬切', async () => {
  const c = mkClient([node('啊'.repeat(500))])
  const got = await c.getForwardMsg('f1', { nodeChars: 100 })
  assert.ok(got.text.includes('…'))
  assert.ok(got.text.length < 200)
})

await okAsync('里面的图片/表情被认出来（不是当成空节点丢掉）', async () => {
  const c = mkClient([{
    message: [
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { file: 'a.jpg', sub_type: 1, summary: '猫猫' } },
    ],
    sender: { card: '风宝' },
  }])
  const got = await c.getForwardMsg('f1')
  // 文字和表情各占一行（按段拆），关键是**表情没丢**
  assert.match(got.text, /风宝：看这个/)
  assert.match(got.text, /风宝：\[表情包:猫猫\]/)
})

await okAsync('接口失败 → null（不抛，不影响回复）', async () => {
  const c = Object.create(OneBotClient.prototype)
  c.callHttp = async () => { throw new Error('timeout') }
  assert.equal(await c.getForwardMsg('f1'), null)
})

await okAsync('返回空 messages → null', async () => {
  assert.equal(await mkClient([]).getForwardMsg('f1'), null)
})

await okAsync('★ id 必须原样传字符串（19 位超出安全整数，转 Number 会丢精度）', async () => {
  let seen = null
  const c = Object.create(OneBotClient.prototype)
  c.callHttp = async (action, params) => {
    seen = { action, params }
    return { status: 'ok', data: { messages: [node('x')] } }
  }
  await c.getForwardMsg('7704891221357637709')
  assert.equal(seen.action, 'get_forward_msg')
  // ⚠️ 线上实测：传 Number 会被 NapCat 判成「消息已过期」，必须原样字符串
  assert.equal(seen.params.message_id, '7704891221357637709')
  assert.equal(seen.params.id, '7704891221357637709')
  assert.equal(typeof seen.params.id, 'string')
})

console.log('\n=== 3. 协议端的"报错当内容"必须过滤（2026-11-06 线上实测）===')
/*
 * 现场：她回「转的啥啊，这边就看到一句消息已过期」。
 * 查下来不是她在猜 —— NapCat 取不到转发内容时**不报错**，
 * 而是把「消息已过期或者为内层消息，无法获取转发消息」当成一条消息返回，
 * 我们照单收下当成了转发内容，她就照着念。
 */
const expiredNode = {
  message: [{ type: 'text', data: { text: '消息已过期或者为内层消息，无法获取转发消息' } }],
}

await okAsync('整段都是报错话术 → 返回 null（保留占位，不喂假内容）', async () => {
  const c = mkClient([expiredNode])
  assert.equal(await c.getForwardMsg('f1'), null)
})

await okAsync('报错话术混在真内容里 → 只留真内容', async () => {
  const c = mkClient([expiredNode, node('真的第一句'), node('真的第二句')])
  const got = await c.getForwardMsg('f1')
  assert.ok(got)
  assert.ok(!got.text.includes('消息已过期'), '报错话术不能进提示词')
  assert.match(got.text, /真的第一句/)
  // 抬头按**真正展开的条数**算（报错那条不算内容）
  assert.equal(got.total, 2)
  assert.match(got.text, /转发了聊天记录·2条/)
})

await okAsync('英文版报错也认（not found / expired）', async () => {
  const c = mkClient([{ message: [{ type: 'text', data: { text: 'message not found' } }] }])
  assert.equal(await c.getForwardMsg('f1'), null)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)