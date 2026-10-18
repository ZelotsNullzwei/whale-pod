/**
 * 决策层测试：降级链、阈值、规则各分支。
 * 用法：node tests/check-decision.mjs
 */
import { createDecisionLayer, applyThreshold } from '../src/decision/index.js'
import { DecisionRegistry, DecisionProvider } from '../src/decision/provider.js'
import { RuleDecisionProvider, mentionsSelf, nicknameTokens, detectThread } from '../src/decision/rule.js'

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name} ${extra}`) }
}

const log = { info: () => {}, warn: () => {} }

/** 构造一个固定返回值的假 provider。 */
class Fake extends DecisionProvider {
  constructor(id, result, opts = {}) {
    super()
    this.id = id
    this.label = id
    this.result = result
    this.throwErr = opts.throw
    this.calls = 0
  }
  async probe() { return { ok: !this.throwErr, detail: this.throwErr ?? 'ok' } }
  async decide() {
    this.calls++
    if (this.throwErr) throw new Error(this.throwErr)
    return this.result
  }
}

const baseInput = {
  messages: [{ id: '1', sender: 'u1', senderName: '小明', text: '你好', at: Date.now(), mentionsMe: false, isMe: false }],
  self: { qq: '10001', nickname: '机器人' },
  scene: { kind: 'group', groupId: '123' },
  sinceMyLastMessage: Infinity,
  consecutiveTurns: 0,
}

console.log('=== 1. 规则层：被 @ ===')
{
  const p = new RuleDecisionProvider({}, { random: () => 0.1 })
  const d = await p.decide({ ...baseInput, messages: [{ ...baseInput.messages[0], mentionsMe: true }] })
  check('被 @ → 回复', d.reply === true, JSON.stringify(d))
  check('概率 = 0.95', d.probability === 0.95)
  check('有延迟建议', typeof d.delayMs === 'number')
}

console.log('\n=== 2. 规则层：冷却期 ===')
{
  const p = new RuleDecisionProvider({ cooldownMs: 15000 }, { random: () => 0.99 })
  const d = await p.decide({ ...baseInput, sinceMyLastMessage: 3000 })
  check('冷却期内 → 不回复', d.reply === false, JSON.stringify(d))
  check('理由提到冷却', /冷却/.test(d.reason))
}

console.log('\n=== 3. 规则层：连续发言收尾 ===')
{
  const p = new RuleDecisionProvider({ maxConsecutiveTurns: 3 }, { random: () => 0.99 })
  const d = await p.decide({ ...baseInput, consecutiveTurns: 3 })
  check('连续 3 轮 → 不回复', d.reply === false, JSON.stringify(d))
  check('理由提到收尾', /收尾/.test(d.reason))
}

console.log('\n=== 4. 规则层：自己发的消息 ===')
{
  const p = new RuleDecisionProvider({}, { random: () => 0 })
  const d = await p.decide({ ...baseInput, messages: [{ ...baseInput.messages[0], isMe: true }] })
  check('自己发的 → 不回复', d.reply === false)
}

console.log('\n=== 5. 规则层：私聊 ===')
{
  const p = new RuleDecisionProvider({ cooldownMs: 1000 }, { random: () => 0.5 })
  const d = await p.decide({ ...baseInput, scene: { kind: 'private' }, sinceMyLastMessage: 999999 })
  check('私聊 → 回复', d.reply === true, JSON.stringify(d))
}

console.log('\n=== 6. 规则层：群聊随机插话（确定性） ===')
{
  // random=0 → 一定命中；random=0.99 → 一定不中
  const low = new RuleDecisionProvider({ idleChatterProbability: 0.1 }, { random: () => 0 })
  const d1 = await low.decide(baseInput)
  check('random=0 → 插话', d1.reply === true, JSON.stringify(d1))

  const high = new RuleDecisionProvider({ idleChatterProbability: 0.1 }, { random: () => 0.99 })
  const d2 = await high.decide(baseInput)
  check('random=0.99 → 沉默', d2.reply === false)
}

console.log('\n=== 7. 注册表：降级（jev 失败 → rule） ===')
{
  const reg = new DecisionRegistry({ order: ['jev', 'rule'], log })
  reg.register(new Fake('jev', null, { throw: 'no key' }))
  reg.register(new Fake('rule', { reply: true, probability: 0.8, reason: '规则命中' }))
  const d = await reg.decide(baseInput)
  check('最终由 rule 给出结论', d.provider === 'rule', JSON.stringify(d))
  check('有降级计数', reg.stats.fallbacks === 1)
  check('有错误记录', reg.stats.errors === 1)
}

console.log('\n=== 8. 注册表：全部失败 → 保守不回复 ===')
{
  const reg = new DecisionRegistry({ order: ['a', 'b'], log })
  reg.register(new Fake('a', null, { throw: 'boom-a' }))
  reg.register(new Fake('b', null, { throw: 'boom-b' }))
  const d = await reg.decide(baseInput)
  check('返回 reply=false（不崩）', d.reply === false, JSON.stringify(d))
  check('provider=none', d.provider === 'none')
  check('理由含错误', /boom/.test(d.reason))
}

console.log('\n=== 9. 阈值过滤 ===')
{
  const reg = createDecisionLayer(
    { provider: 'custom', threshold: 0.6, custom: { enabled: true, url: 'http://x' }, fallbackOnError: true },
    { log, fetch: async () => ({ ok: true, json: async () => ({ reply: true, probability: 0.4 }) }) },
  )
  const d = await reg.shouldReply(baseInput)
  check('p=0.4 < 阈值 0.6 → 不回复', d.reply === false, JSON.stringify(d))
  check('仍保留原概率', d.probability === 0.4)
}

console.log('\n=== 10. shouldReply 通过时给延迟 ===')
{
  const reg = createDecisionLayer(
    { provider: 'custom', threshold: 0.5, delay: { min: 1000, max: 1000 }, custom: { enabled: true, url: 'http://x' } },
    { log, random: () => 0.5, fetch: async () => ({ ok: true, json: async () => ({ reply: true, probability: 0.9 }) }) },
  )
  const d = await reg.shouldReply(baseInput)
  check('通过 → reply=true', d.reply === true, JSON.stringify(d))
  check('有延迟', d.delayMs === 1000, String(d.delayMs))
}

console.log('\n=== 11. 按配置组装 provider 顺序 ===')
{
  const cases = [
    ['rule', ['rule']],
    ['jev', ['jev', 'rule']],
    ['custom', ['custom', 'rule']],
    ['auto', ['jev', 'custom', 'rule']],
    ['未知值', ['rule']],
  ]
  for (const [provider, expect] of cases) {
    const reg = createDecisionLayer({ provider }, { log })
    const got = reg.order.join(',')
    check(`provider=${provider} → ${expect.join(',')}`, got === expect.join(','), `实际 ${got}`)
  }
}

console.log('\n=== 12. probeAll（供 Web UI） ===')
{
  const reg = createDecisionLayer({ provider: 'auto', jev: { enabled: false }, custom: { enabled: false } }, { log })
  const r = await reg.probeAll()
  check('有 3 个 provider', r.providers.length === 3, JSON.stringify(r.providers.map((p) => p.id)))
  check('rule 可用', r.providers.find((p) => p.id === 'rule')?.ok === true)
  check('jev 不可用（未启用）', r.providers.find((p) => p.id === 'jev')?.ok === false)
  check('active 是 jev（order 首位，即使不可用）', r.active === 'jev', String(r.active))
}

console.log('\n=== 13. explain 摘要 ===')
{
  const reg = createDecisionLayer({ provider: 'rule' }, { log })
  const txt = reg.explain({ reply: true, probability: 0.8, provider: 'rule', reason: '被 @ 了' })
  check('摘要可读', /发言/.test(txt) && /0\.80/.test(txt) && /rule/.test(txt), txt)
}

// ── 14. decided 语义：已决的 provider 不该被阈值二次过滤 ────────
//
// ⚠️ 踩过的坑：rule 自己掷过骰子（reply 就是最终结论），外层又按阈值筛一遍，
//    界面上就会出现「概率 0.80 … 本次保持沉默」这种看着像坏了的组合。
//    阈值本来是给 jev/custom 那种"软概率"提供者用的。
console.log('\n=== 14. decided 语义（rule 不该被阈值二次过滤）===')
{
  // rule 明确返回 decided:true
  const rp = new RuleDecisionProvider({ cooldownMs: 4000 })
  const r1 = await rp.decide({
    messages: [{ sender: '1', senderName: '甲', text: '在吗', isMe: false }],
    scene: { kind: 'group' }, sinceMyLastMessage: 999999, consecutiveTurns: 0, self: { qq: '9' },
  })
  check('rule 的结果带 decided=true', r1.decided === true, JSON.stringify(r1))

  // provider.js 必须把 decided 透传出来（否则下面的判断全失效）
  class Decided extends DecisionProvider {
    constructor() { super(); this.id = 'decided'; this.label = 'decided' }
    async probe() { return { ok: true, detail: '' } }
    async decide() { return { reply: true, probability: 0.1, reason: '已决', decided: true } }
  }
  const reg = new DecisionRegistry({ order: ['decided'], log })
  reg.register(new Decided())
  const raw = await reg.decide({})
  check('provider.js 透传 decided 字段', raw.decided === true, JSON.stringify(raw))

  // ── 阈值过滤的纯函数 ──
  check('已决 + p=0.1 → 仍发言（跳过阈值）',
    applyThreshold({ reply: true, probability: 0.1, decided: true }, 0.5) === true)
  check('软概率 p=0.3 < 0.5 → 沉默',
    applyThreshold({ reply: true, probability: 0.3 }, 0.5) === false)
  check('软概率 p=0.8 ≥ 0.5 → 发言',
    applyThreshold({ reply: true, probability: 0.8 }, 0.5) === true)
  check('reply=false → 一律沉默（不管概率多高）',
    applyThreshold({ reply: false, probability: 0.99 }, 0.5) === false)
  check('没给概率 → 按愿意处理',
    applyThreshold({ reply: true }, 0.5) === true)
  check('空结果安全', applyThreshold(null, 0.5) === false)
}

// ── 15. 提及识别（群里叫它名字，不该装没听见）─────────────────
//
// ⚠️ 踩过的坑：群里聊「你不是某某吗」「某某在吗」—— 明明在说它，
//    它却一律沉默，因为它只在**真被 @** 时才意识到跟自己有关。
//    中文群里直接叫名字才是常态。
console.log('\n=== 15. 提及识别 ===')
{
  const NICK = '测试机器人'
  const SELF = { qq: '1000000001', nickname: NICK }

  check('提到昵称片段（机器人）', mentionsSelf('你不是机器人吗', SELF) === true)
  check('提到全名', mentionsSelf('测试机器人出来', SELF) === true)
  check('提到后半段（器人）', mentionsSelf('器人在吗', SELF) === true)
  check('叫 QQ 号', mentionsSelf('@1000000001 在么', SELF) === true)
  check('通用称呼「机器人」', mentionsSelf('机器人呢', SELF) === true)

  check('无关内容不误判', mentionsSelf('居然是青蛙', SELF) === false)
  check('字母噪音不误判', mentionsSelf('ZA', SELF) === false)
  check('标点不误判', mentionsSelf('?', SELF) === false)
  check('日常话题不误判', mentionsSelf('今天中午吃啥', SELF) === false)
  check('常见词不进片段表（「什么」不该误伤）', mentionsSelf('什么情况', SELF) === false)

  // 昵称带装饰时要能剥掉
  check('带 emoji 的昵称也能认', mentionsSelf('番茄在吗', { qq: '9', nickname: '🍅番茄🍅' }) === true)
  check('单字昵称不生成片段（避免乱撞）', nicknameTokens('猫').length === 0)
  check('空昵称安全', nicknameTokens('').length === 0 && nicknameTokens(null).length === 0)

  // 提及 → 意愿被抬到高位（不被短消息惩罚压回去）
  const rp = new RuleDecisionProvider({ cooldownMs: 4000, idleChatterProbability: 0.1 }, {})
  const withName = await rp.decide({
    messages: [{ sender: '1', senderName: '甲', text: '测试机器人在吗', isMe: false }],
    self: SELF, scene: { kind: 'group' }, sinceMyLastMessage: 999999, consecutiveTurns: 0,
  })
  check('提到名字 → 意愿被抬高', withName.probability >= 0.75, String(withName.probability))

  // 纯语气词 + 提到名字 → 不该被语气词规则压下去
  const filler = await rp.decide({
    messages: [{ sender: '1', senderName: '甲', text: '哈哈 测试机器人', isMe: false }],
    self: SELF, scene: { kind: 'group' }, sinceMyLastMessage: 999999, consecutiveTurns: 0,
  })
  check('语气词里带名字 → 仍保持高意愿', filler.probability >= 0.75, String(filler.probability))
}

// ── 16. 话题连续性（连着聊同一件事时不该装没听见）───────────────
//
// ⚠️ 踩过的坑：决策是**逐条独立**掷骰子的。群里连着三四条同一话题时，
//    它会一条接一条地沉默，看起来像走神。真人会接上。
console.log('\n=== 16. 话题连续性 ===')
{
  const SELF = { qq: '1000000001', nickname: '测试机器人' }
  const T = (arr) => arr.map((t) => ({ sender: '1', senderName: '甲', text: t, isMe: false }))

  check('连发多张图 → 在刷梗', detectThread(T(['[图片]', '[图片]', '[图片]']), SELF).hit === true)
  check('连着提它 → 在说它', detectThread(T(['你不是机器人吗', '测试机器人呢']), SELF).hit === true)
  check('同话题（共同实词）', detectThread(T(['记忆模块有问题', '记忆模块真没问题吗']), SELF).hit === true)
  check('无关闲聊 → 不算同话题', detectThread(T(['今天吃啥', '晚上打游戏吗']), SELF).hit === false)
  check('只有一条 → 不算', detectThread(T(['在吗']), SELF).hit === false)
  check('自己的消息不参与判定', detectThread(T(['[图片]']).concat([{ text: '[图片]', isMe: true }]), SELF).hit === false)

  // 效果：同话题的回复率要明显高于无关话题
  const CFG = { cooldownMs: 2500, maxConsecutiveTurns: 6, mentionProbability: 0.95, idleChatterProbability: 0.5, shortMessagePenalty: 0.15 }
  const rate = async (hist, n = 3000) => {
    const d = new RuleDecisionProvider(CFG, {})
    const inp = {
      messages: T(hist), self: SELF, scene: { kind: 'group' },
      sinceMyLastMessage: 999999, consecutiveTurns: 0,
    }
    let y = 0
    for (let i = 0; i < n; i++) if ((await d.decide(inp)).reply) y++
    return y / n
  }
  const threadRate = await rate(['记忆模块有问题', '记忆模块真没问题吗', '真的吗'])
  const plainRate = await rate(['今天吃啥', '晚上打游戏吗', '真的吗'])
  check(`同话题回复率(${Math.round(threadRate * 100)}%) 明显高于无关(${Math.round(plainRate * 100)}%)`,
    threadRate > plainRate + 0.1, `${threadRate.toFixed(2)} vs ${plainRate.toFixed(2)}`)
  check('同话题时几乎必接（≥85%）', threadRate >= 0.85, String(threadRate.toFixed(3)))
}

// ── 17. 概率上限不能吃掉加成 ─────────────────────────────────
//
// ⚠️ 实测踩过：上限原来是 0.8，而"话题连续"加成算出来 1.25 被削到 0.8 ——
//    于是同话题和孤立一句的回复率都是 80%，**调参完全没效果**。
console.log('\n=== 17. 概率上限留出加成空间 ===')
{
  const SELF = { qq: '9', nickname: 'Bot' }
  const d = new RuleDecisionProvider(
    { cooldownMs: 0, maxConsecutiveTurns: 99, mentionProbability: 0.95, idleChatterProbability: 0.5, shortMessagePenalty: 0.15 },
    {},
  )
  const r = await d.decide({
    messages: [
      { sender: '1', senderName: '甲', text: '记忆模块有问题', isMe: false },
      { sender: '1', senderName: '甲', text: '记忆模块真没问题吗', isMe: false },
    ],
    self: SELF, scene: { kind: 'group' }, sinceMyLastMessage: 999999, consecutiveTurns: 0,
  })
  check('上限允许到 0.9（不是 0.8）', r.probability > 0.8, String(r.probability))
  check('且不超过 0.9', r.probability <= 0.9, String(r.probability))
}

console.log(`\n${'='.repeat(40)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
