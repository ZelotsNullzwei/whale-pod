/**
 * 冷却豁免测试：明确在问它时，冷却不该拦。
 *
 * 背景（实测数据）：群 123450001 历史上「冷却中」179 次，其中 21 次带问句特征。
 * 典型误伤：「肥鱼还活着吗」距上次发言 2s 被拦、「你能看到？」被拦。
 *
 * 但**不能直接调小冷却**：同一批 179 条里 70 条是图片/表情、51 条是 ≤4 字短句，
 * 这些本来就不值得接，冷却是帮了忙。所以只豁免「问句 + 在说它」。
 *
 * 用法：node tests/check-cooldown-exempt.mjs
 */
import { RuleDecisionProvider, mentionsSelf } from '../src/decision/rule.js'
import { makeMessage } from '../src/memory/short.js'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

const SELF = { qq: '1000000001', nickname: '蓝色大肥鱼', aliases: ['蓝色大肥鱼', '肥鱼', '鲸鱼', '白饭', '鱼'] }
const PEERS = [{ id: 'u3', name: '小红' }, { id: 'u4', name: '阿强' }]

let seq = 0
const me = (text, at) => makeMessage({
  id: `m${++seq}`, sender: SELF.qq, senderName: SELF.nickname,
  text, at: at ?? Date.now(), isMe: true,
})
const other = (text, opts = {}) => makeMessage({
  id: `m${++seq}`, sender: opts.sender ?? 'u2', senderName: opts.name ?? '小明',
  text, at: opts.at ?? Date.now(), isMe: false, replyTo: opts.replyTo ?? null,
})

/** 跑一次决策。默认冷却 15s、距上次发言 2s（**在冷却期内**）。 */
async function decide(msgs, opts = {}) {
  const p = new RuleDecisionProvider(
    {
      cooldownMs: opts.cooldownMs ?? 15000,
      privateCooldownMs: opts.privateCooldownMs ?? 1500,
      maxConsecutiveTurns: 99,
      idleChatterProbability: 0.04,
      ...opts.cfg,
    },
    { random: opts.random ?? (() => 0) },
  )
  return p.decide({
    messages: msgs, self: SELF, scene: opts.scene ?? { kind: 'group' },
    peers: PEERS,
    sinceMyLastMessage: opts.since ?? 2000,
    consecutiveTurns: 0,
  })
}

// ══════════════════════════════════════════════════════════════
console.log('=== 1. 豁免：叫名字 + 问句（实测被误伤的原文）===')
{
  const d = await decide([me('我说完了'), other('肥鱼还活着吗')], { since: 2000 })
  check('「肥鱼还活着吗」距上次 2s → 不被冷却拦', !/冷却/.test(d.reason), d.reason)
  check('  实际回复了', d.reply === true, JSON.stringify(d))
}
{
  const d = await decide([me('我能看到'), other('你能看到？')], { since: 2000 })
  check('「你能看到？」→ 不被冷却拦', !/冷却/.test(d.reason), d.reason)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 2. 豁免：追问（没叫名字，但紧接着我的话在问）===')
{
  const d = await decide([me('我觉得 V4 快一些'), other('那你最喜欢哪个？')], { since: 3000 })
  check('答完后追问 → 不被冷却拦', !/冷却/.test(d.reason), d.reason)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 3. 不豁免：是问句，但没在说它 ===')
{
  const d = await decide([me('我说完了'), other('今天中午吃啥？')], { since: 2000 })
  check('普通问句（没叫它）→ 仍受冷却', /冷却/.test(d.reason), d.reason)
  check('  且带 defer（排队补回）', typeof d.defer?.waitMs === 'number', JSON.stringify(d.defer))
}
{
  // ⚠️ 发送者是**小明**，他在叫「小红」—— 这才是「对别人说的问句」。
  //    （原来写成 sender=u3/name=小红，等于小红自己喊自己名字，不成立；
  //     而代码里「跳过自己的名字」那条规则会让它绕过排除。）
  const d = await decide(
    [me('我说完了'), other('小红你今天怎么了？', { sender: 'u2', name: '小明' })],
    { since: 2000 },
  )
  check('对别人说的问句 → 仍受冷却', /冷却/.test(d.reason), d.reason)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 4. 不豁免：叫了名字，但不是问句 ===')
{
  const d = await decide([me('我说完了'), other('肥鱼真能吃')], { since: 2000 })
  check('「肥鱼真能吃」（陈述句）→ 仍受冷却', /冷却/.test(d.reason), d.reason)
}
{
  const d = await decide([me('我说完了'), other('肥鱼')], { since: 2000 })
  check('「肥鱼」（只有名字）→ 仍受冷却', /冷却/.test(d.reason), d.reason)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 5. 不豁免：图片/表情/短句（这些本来就不该接）===')
{
  const d = await decide([me('我说完了'), other('[表情包:猫猫]')], { since: 2000 })
  check('表情包 → 仍受冷却', /冷却/.test(d.reason), d.reason)
}
{
  const d = await decide([me('我说完了'), other('[图片]')], { since: 2000 })
  check('图片 → 仍受冷却', /冷却/.test(d.reason), d.reason)
}
{
  const d = await decide([me('我说完了'), other('哈哈')], { since: 2000 })
  check('纯语气词 → 仍受冷却', /冷却/.test(d.reason), d.reason)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 6. 冷却外的正常行为不受影响 ===')
{
  const d = await decide([other('肥鱼在吗')], { since: 20000 })
  check('冷却已过 + 叫名字 → 正常高意愿', d.probability >= 0.95, String(d.probability))
}
{
  const d = await decide([other('今天吃啥')], { since: 20000 })
  check('冷却已过 + 普通闲聊 → 走正常评分', d.probability < 0.5, String(d.probability))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 7. 连续发言收尾仍然优先于豁免 ===')
{
  // 即使豁免成立，连续刷屏也要被收尾规则拦住
  const p = new RuleDecisionProvider(
    { cooldownMs: 15000, maxConsecutiveTurns: 3 },
    { random: () => 0 },
  )
  const d = await p.decide({
    messages: [me('x'), other('肥鱼在吗？')], self: SELF, scene: { kind: 'group' },
    peers: PEERS, sinceMyLastMessage: 2000, consecutiveTurns: 3,
  })
  check('连续 3 轮 → 收尾（豁免不绕过它）', /收尾/.test(d.reason), d.reason)
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 8. 私聊不受影响（本来就 1.5s）===')
{
  const d = await decide([other('在吗')], { scene: { kind: 'private' }, since: 3000 })
  check('私聊 3s → 回复', d.reply === true, JSON.stringify(d))
  const d2 = await decide([other('在吗')], { scene: { kind: 'private' }, since: 500 })
  check('私聊 0.5s → 仍在 1.5s 冷却内', d2.reply === false, JSON.stringify(d2))
}

// ══════════════════════════════════════════════════════════════
console.log('\n=== 9. _isAskingMe 的纯函数行为 ===')
{
  const p = new RuleDecisionProvider({}, {})
  const inp = { self: SELF, peers: PEERS }
  check('名字 + 问号 → true', p._isAskingMe(other('肥鱼在吗？'), [me('x'), other('肥鱼在吗？')], inp) === true)
  check('名字 + 句尾「吗」→ true', p._isAskingMe(other('肥鱼在吗'), [me('x'), other('肥鱼在吗')], inp) === true)
  check('名字 + 陈述 → false', p._isAskingMe(other('肥鱼真好'), [me('x'), other('肥鱼真好')], inp) === false)
  check('问号但没提它 → false', p._isAskingMe(other('吃啥？'), [me('x'), other('吃啥？')], inp) === false)
  check('空文本 → false', p._isAskingMe(other(''), [me('x'), other('')], inp) === false)
  check('null 安全', p._isAskingMe(null, [], inp) === false)
}

console.log(`\n${'='.repeat(46)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
