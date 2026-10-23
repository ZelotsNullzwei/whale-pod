/**
 * 社交决策测试：对话对象识别、追问分级、间隔、节奏。
 *
 * 覆盖 2026-10-23 这次改造的每一条判断逻辑，正例和反例都写。
 * 用法：node tests/check-social.mjs
 *
 * ⚠️ 全部用**注入的随机源**验证概率边界，不靠人工读码。
 */
import {
  RuleDecisionProvider, resolveAddressee, detectFollowUp, detectThread, mentionsSelf,
} from '../src/decision/rule.js'
import { makeMessage, ConversationMemory } from '../src/memory/short.js'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

const SELF = { qq: '1000000001', nickname: '蓝色大肥鱼', aliases: ['蓝色大肥鱼', '肥鱼', '鲸鱼', '白饭', '鱼'] }
const PEERS = [{ id: 'u3', name: '小红' }, { id: 'u4', name: '阿强' }]

let seq = 0
const me = (text, at = seq += 1000) => makeMessage({
  id: `m${seq}`, sender: SELF.qq, senderName: SELF.nickname, text, at, isMe: true,
})
const other = (text, { sender = 'u2', name = '小明', at = seq += 1000, replyTo = null } = {}) =>
  makeMessage({ id: `m${seq}`, sender, senderName: name, text, at, isMe: false, replyTo })

/** 用固定随机源跑决策，返回结果。 */
async function decide(msgs, { random = () => 0, cfg = {}, since = 999999, turns = 0, peers = PEERS, scene = { kind: 'group' } } = {}) {
  const p = new RuleDecisionProvider(
    { cooldownMs: 0, maxConsecutiveTurns: 99, idleChatterProbability: 0.04, ...cfg },
    { random },
  )
  return p.decide({
    messages: msgs, self: SELF, scene, peers,
    sinceMyLastMessage: since, consecutiveTurns: turns,
  })
}

// ══════════════════════════════════════════════════════════════
console.log('=== 1. resolveAddressee：在跟谁说话 ===')

// 引用回复是最硬的证据
{
  const mine = me('我觉得 V4 快一些')
  const r = resolveAddressee([mine, other('真的吗', { replyTo: mine.id })], SELF, PEERS)
  check('引用我的消息 → me', r.who === 'me', JSON.stringify(r))

  // ⚠️ 被引用的那条必须**真的在历史里**，否则无法确认引用了谁。
  //    （真实场景：引用的是很久以前的消息，已滑出记忆窗口。）
  const theirs = other('今晚打游戏', { sender: 'u3', name: '小红' })
  const r2 = resolveAddressee(
    [mine, theirs, other('来啊', { replyTo: theirs.id })],
    SELF, PEERS,
  )
  check('引用别人的消息 → other', r2.who === 'other', JSON.stringify(r2))

  // 引用的消息已不在上下文里 → 不能默认是「我」
  const r3 = resolveAddressee([mine, other('真的吗', { replyTo: 'gone-999' })], SELF, PEERS)
  check('引用已滑出窗口的消息 → unclear（不臆断）', r3.who === 'unclear', JSON.stringify(r3))
}

// 紧接着我、中间没人 → 默认接我的话
{
  const r = resolveAddressee([me('我觉得 V4 快一些'), other('为什么')], SELF, PEERS)
  check('紧接在我之后 → me', r.who === 'me', JSON.stringify(r))
}

// 同一人连发
{
  const r = resolveAddressee(
    [me('我觉得 V4 快一些'), other('那你常用哪个'), other('说说看')],
    SELF, PEERS,
  )
  check('同一人连发第二条 → me', r.who === 'me', JSON.stringify(r))
}

// 句中出现别的群友名字
{
  const r = resolveAddressee(
    [me('我觉得 V4 快一些'), other('小红你今天怎么了？', { sender: 'u2', name: '小明' })],
    SELF, PEERS,
  )
  check('句中叫了别人的名字 → other', r.who === 'other', JSON.stringify(r))
}

// 我没说过话
{
  const r = resolveAddressee([other('大家好')], SELF, PEERS)
  check('我没说过话 → unclear', r.who === 'unclear', JSON.stringify(r))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. detectFollowUp：真追问（应 hit）===')
{
  const r1 = detectFollowUp([me('我觉得 V4 快一些'), other('那你最喜欢哪个？')], SELF, { peers: PEERS })
  check('答完后追问 → hit', r1.hit === true, JSON.stringify(r1))
  check('且是强信号', r1.strength === 'strong', r1.strength)

  const r2 = detectFollowUp([me('我觉得 V4 快一些'), other('为什么啊')], SELF, { peers: PEERS })
  check('答完后「为什么啊」→ hit（疑问语气词）', r2.hit === true, JSON.stringify(r2))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. detectFollowUp：用户之间对话（不该 hit）===')
//
// ⚠️ 这是本次改造修的**首要误判**：原来只要出现「你」就判成追问、
//    概率抬到 0.97，机器人会抢答不属于它的话。
{
  const r1 = detectFollowUp(
    [me('我觉得 V4 快一些'), other('你今天怎么了？', { sender: 'u3', name: '小红' })],
    SELF, { peers: PEERS },
  )
  check('「你今天怎么了？」对第三人说 → 不 hit', r1.hit === false, JSON.stringify(r1))
  // ⚠️ 这种是「unclear」而不是「other」：它紧接在我之后、带第二人称，
  //    但没有任何指向别人的证据。不确定就不假装确定 —— 判成 other 会让
  //    机器人该接的时候装死，判成 me 就会抢话（原来 0.97 的 bug）。
  check('  且判定为「不确定」（不硬猜成别的）', r1.who === 'unclear', r1.who)

  const r2 = detectFollowUp(
    [me('我觉得 V4 快一些'), other('你在干嘛呢', { sender: 'u3', name: '小红' })],
    SELF, { peers: PEERS },
  )
  check('「你在干嘛呢」对第三人说 → 不 hit', r2.hit === false, JSON.stringify(r2))

  const r3 = detectFollowUp(
    [me('我觉得 V4 快一些'), other('小红你今天怎么了？', { sender: 'u2', name: '小明' })],
    SELF, { peers: PEERS },
  )
  check('点名别人 → 不 hit', r3.hit === false, JSON.stringify(r3))
}

// 引用别人 → 不 hit
{
  const theirs = other('今晚打游戏', { sender: 'u3', name: '小红' })
  const r = detectFollowUp(
    [me('我觉得 V4 快一些'), theirs, other('你那把赢了吗', { replyTo: theirs.id })],
    SELF, { peers: PEERS },
  )
  check('引用别人的消息 → 不 hit', r.hit === false, JSON.stringify(r))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. detectFollowUp：间隔过久（不该算追问）===')
{
  const mine = me('我觉得 V4 快一些', 1000)
  const later = other('今天中午吃啥', { at: 1000 + 30 * 60 * 1000 })
  const r = detectFollowUp([mine, later], SELF, { peers: PEERS })
  check('30 分钟后 → 不 hit', r.hit === false, JSON.stringify(r))

  // 显式传 gapMs 也要生效
  const r2 = detectFollowUp([mine, other('为什么啊')], SELF, { peers: PEERS, gapMs: 20 * 60_000 })
  check('显式 gapMs=20min → 不 hit', r2.hit === false, JSON.stringify(r2))

  // 但 4 分钟内仍算
  const r3 = detectFollowUp([mine, other('为什么啊', { at: 1000 + 4 * 60_000 })], SELF, { peers: PEERS })
  check('4 分钟内 → 仍 hit', r3.hit === true, JSON.stringify(r3))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. 概率：真追问 vs 用户间对话 必须拉开差距 ===')
{
  // 真追问：强信号 → 0.97
  const real = await decide([me('我觉得 V4 快一些'), other('那你最喜欢哪个？')])
  check('真追问 p=0.97', real.probability === 0.97, String(real.probability))

  // 用户之间对话：不该被抬到追问档
  const toOther = await decide([
    me('我觉得 V4 快一些'),
    other('你今天怎么了？', { sender: 'u3', name: '小红' }),
  ])
  check('对别人说「你…」p 远低于 0.97', toOther.probability < 0.5, String(toOther.probability))
  check('  且低于 0.3', toOther.probability < 0.3, String(toOther.probability))
}

// 弱追问（隔了几句）只给 0.85
{
  const weak = await decide([
    me('我觉得 V4 快一些'),
    other('嗯', { sender: 'u5', name: '阿强' }),
    other('那你最喜欢哪个？'),
  ])
  check('弱追问 p=0.85（不是 0.97）', weak.probability === 0.85, String(weak.probability))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. 概率边界（固定随机源）===')
{
  // random 恰等于 p 时不算命中（rnd() < p 是严格小于）
  const at = await decide([me('答'), other('那你选哪个？')], { random: () => 0.97 })
  check('random=0.97 vs p=0.97 → 不命中（严格小于）', at.reply === false, JSON.stringify(at))

  const below = await decide([me('答'), other('那你选哪个？')], { random: () => 0.96 })
  check('random=0.96 → 命中', below.reply === true, JSON.stringify(below))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. 硬规则优先级仍然正确 ===')
{
  // @ 排在冷却之前
  const at = await decide(
    [other('@bot 在吗', {})].map((m) => ({ ...m, mentionsMe: true })),
    { since: 100, cfg: { cooldownMs: 15000 } },
  )
  check('被 @ 时冷却不拦', at.reply === true, JSON.stringify(at))
  check('  p=0.95', at.probability === 0.95, String(at.probability))

  // 冷却期内的普通闲聊 → defer
  const cool = await decide([other('今天吃啥')], { since: 3000, cfg: { cooldownMs: 15000 } })
  check('冷却期普通闲聊 → 不回复', cool.reply === false, JSON.stringify(cool))
  check('  且带 defer（晚点补回）', typeof cool.defer?.waitMs === 'number', JSON.stringify(cool.defer))

  // 连续发言过多 → 收尾
  const many = await decide([other('在吗')], { turns: 3, cfg: { maxConsecutiveTurns: 3 } })
  check('连续 3 轮 → 收尾', many.reply === false && /收尾/.test(many.reason), JSON.stringify(many))

  // 自己发的 → 绝不回
  const self = await decide([{ ...me('我自己说的') }])
  check('最后一条是我 → 不回', self.reply === false, JSON.stringify(self))

  // 私聊 → 默认回
  const priv = await decide([other('在吗')], { scene: { kind: 'private' }, since: 999999 })
  check('私聊 → 回复', priv.reply === true, JSON.stringify(priv))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. 点名（没 @ 但叫名字）仍是高优先级 ===')
{
  const nick = await decide([other('蓝色大肥鱼 你在吗')])
  check('点名 → p≥0.95', nick.probability >= 0.95, String(nick.probability))

  const alias = await decide([other('肥鱼出来')])
  check('别名「肥鱼」→ p≥0.95', alias.probability >= 0.95, String(alias.probability))

  // 点名也受冷却约束之外，但连续发言仍能收尾
  const nickMany = await decide([other('肥鱼出来')], { turns: 5, cfg: { maxConsecutiveTurns: 3 } })
  check('连续刷屏时点名仍被收尾规则拦住', nickMany.reply === false, JSON.stringify(nickMany))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 9. 纯表情 / 短句 / 吐槽 ===')
{
  const filler = await decide([other('哈哈哈')])
  check('纯语气词 → 低意愿', filler.probability < 0.1, String(filler.probability))

  const emoji = await decide([other('[表情包:猫猫]')])
  check('孤立一个表情包 → 不被抬到高位', emoji.probability < 0.7, String(emoji.probability))

  const rant = await decide([other('这破系统又崩了 麻了')])
  check('吐槽 → 意愿高于纯语气词', rant.probability > filler.probability, `${rant.probability} vs ${filler.probability}`)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 10. 话题连续 ===')
{
  const thread = await decide([other('记忆模块有问题'), other('记忆模块真没问题吗')])
  check('同话题 → 高意愿', thread.probability >= 0.8, String(thread.probability))

  const r = detectThread(
    [other('今天吃啥'), other('晚上打游戏吗')], SELF,
  )
  check('无关闲聊 → 不算同话题', r.hit === false, JSON.stringify(r))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 11. makeMessage 的 replyTo 字段 ===')
{
  const m = makeMessage({ text: 'x', replyTo: 12345 })
  check('replyTo 被保留为字符串', m.replyTo === '12345', String(m.replyTo))
  const n = makeMessage({ text: 'x' })
  check('没引用时 replyTo=null', n.replyTo === null, String(n.replyTo))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 12. 会话隔离（不同群互不干扰）===')
{
  const store = { get: (s) => new ConversationMemory() }
  const g1 = store.get('group:1')
  const g2 = store.get('group:2')
  g1.push({ text: '群1', sender: 'u1', isMe: true })
  g1.push({ text: '群1 别人', sender: 'u2' })
  check('群1 有自己的历史', g1.recent().length === 2)
  check('群2 不受影响', g2.recent().length === 0)
  check('群1 的连续发言不影响群2', g1.consecutiveTurns === 1 && g2.consecutiveTurns === 0)
}

// ══════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(40)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
