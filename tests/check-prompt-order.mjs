/**
 * 系统提示词的**位置纪律**（2026-10-31）。
 *
 * ## 核心规律（这条我自己记过，这次还是踩了）
 * > **规则离生成位置越远，约束力越弱。关键规则要在末尾重复。**
 *
 * ## 事故
 * B 站信息**确实进了 system prompt**（8411 字里第 ~3600 字），
 * 标题/评论/弹幕/警告全都在。但模型只回：
 * ```
 * 「又是链接，本鱼这边还是没展开」
 * ```
 * 连标题都没提。
 *
 * 因为 `## 输出要求` 里写着「默认往短了说…别把知道的都倒出来」，
 * 它**在第 3594 字**，而 B 站那段在它前面 —— **后面的规则赢了**。
 *
 * ## 修法
 * `extras` 里的 B 站那段**不跟其它一起塞中间**，而是挪到**最末尾**。
 */

import assert from 'node:assert/strict'
import { PersonaStore } from '../src/persona/store.js'
import { formatVideoContext } from '../src/qq/bilibili.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}

const mkPersona = () => {
  const p = new PersonaStore({ home: 'C:/Users/Null_zwei/.dsh/whale-pod' })
  p.init()
  return p
}

const biliCtx = formatVideoContext({
  bvid: 'BV1',
  title: '姐你到底会不会开车啊',
  owner: '某UP',
  duration: 180,
  view: 50000,
  desc: '',
  comments: [{ like: 100, text: '姐姐好飒' }],
  danmaku: [{ text: '笑死', count: 12 }],
})

console.log('=== 位置纪律 ===')

ok('★ B 站那段必须在 `## 输出要求` **之后**（离生成更近）', () => {
  /*
   * 这条是整个功能能不能生效的关键。
   * 之前它在第 3600 字、输出要求在第 3594 字 —— **只差一点，但顺序反了**，
   * 于是「往短了说」把它压掉了。
   */
  const sys = mkPersona().buildSystemPrompt({
    extras: [biliCtx, '## 现在\n现在是 2026/10/31 20:50:56（**晚上**）。'],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  const atBili = sys.indexOf('## 对方分享的 B 站视频')
  const atOut = sys.indexOf('## 输出要求')
  assert.ok(atBili > 0, 'B 站那段要在 prompt 里')
  assert.ok(atOut > 0, '要有输出要求')
  assert.ok(
    atBili > atOut,
    `★ B 站那段(${atBili}) 必须在输出要求(${atOut}) 之后 —— 否则"往短了说"会把它压掉`,
  )
})

ok('★ B 站那段要接近末尾（距结尾不超过 600 字）', () => {
  const sys = mkPersona().buildSystemPrompt({
    extras: [biliCtx],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  const at = sys.indexOf('## 对方分享的 B 站视频')
  const tail = sys.length - at
  assert.ok(tail < 600, `B 站那段距结尾 ${tail} 字 —— 太远了，约束力会弱`)
})

ok('其它 extras（比如「现在」）仍然在中间，不受影响', () => {
  const nowCtx = '## 现在\n现在是 2026/10/31 20:50:56（**晚上**）。'
  const sys = mkPersona().buildSystemPrompt({
    extras: [biliCtx, nowCtx],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  assert.ok(sys.includes(nowCtx), '「现在」那段不能丢')
  const atNow = sys.indexOf('## 现在')
  const atBili = sys.indexOf('## 对方分享的 B 站视频')
  assert.ok(atNow < atBili, '只有 B 站那段被挪后，「现在」保持原位')
})

ok('没有 B 站那段时，extras 顺序不变（不影响其它功能）', () => {
  const a = '## A\n第一段'
  const b = '## B\n第二段'
  const sys = mkPersona().buildSystemPrompt({
    extras: [a, b],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  assert.ok(sys.indexOf(a) < sys.indexOf(b), '普通 extras 保持原顺序')
})

console.log('\n=== 内容完整性 ===')

ok('挪位置不能丢内容（标题/评论/弹幕/警告都要在）', () => {
  const sys = mkPersona().buildSystemPrompt({
    extras: [biliCtx],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  for (const key of ['姐你到底会不会开车啊', '评论区怎么说', '姐姐好飒', '弹幕在刷什么', '笑死', '没看过这个视频', '你得说点具体的']) {
    assert.ok(sys.includes(key), `丢了「${key}」`)
  }
})

console.log('\n=== 【本次程序核实的事实】独立通道（2026-10-31）===')
/*
 * ## 事故
 * ```
 * 23:01:03  日志：B站：BV1bbeY6wE9x 评论 5 条 / 弹幕 10 条   ← 程序真抓到了
 * 23:01:10  我：「还是不行，ts 都一样，估计根本没走到解析那一步」
 * ```
 * **它在照着自己上一轮说的「没展开」演**，完全不看刚抓到的数据。
 *
 * 根因：模型分不清
 *   ① 程序抓到的真实数据   ← 真的
 *   ② 它自己上一轮说过的话 ← 可能错
 * 两者在上下文里长得一模一样，而②**更近、更像"我的经历"** → 它信了②。
 *
 * 修法：给①一个**独立通道**（`buildSystemPrompt` 的 `facts` 参数）——
 * 单独成段、带权威标记、放最末尾、并明确写「冲突时以这里为准」。
 */

ok('★ facts 要独立成段，带【本次程序核实的事实】标记', () => {
  const sys = mkPersona().buildSystemPrompt({
    facts: [biliCtx],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  assert.match(sys, /## 【本次程序核实的事实】/, '要有显眼的独立标记')
  assert.match(sys, /程序刚刚抓到的真实数据/, '要说明这是程序抓的')
  assert.match(sys, /不是你的记忆、也不是你猜的/, '要和记忆/猜测区分开')
})

ok('★★ 事实段要写明「和你之前说过的话冲突时以这里为准」', () => {
  /*
   * 这是**治本的那一句**。没有它，①（真数据）和②（它自己说过的话）
   * 在模型眼里还是平等的 —— 而②更近，会赢。
   */
  const sys = mkPersona().buildSystemPrompt({
    facts: [biliCtx],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  assert.match(sys, /这一段的优先级最高/, '要明确优先级')
  assert.match(sys, /看不到 \/ 打不开 \/ 没展开 \/ 不知道/, '要点名那几句旧话')
  assert.match(sys, /那是过去的状态，现在已经有数据了/, '要说明旧话已过时')
  assert.match(sys, /以这一段为准/, '要给出裁决规则')
})

ok('★ 事实段必须在**最末尾**（比输出要求还靠后）', () => {
  const sys = mkPersona().buildSystemPrompt({
    facts: [biliCtx],
    extras: ['## 现在\n现在是 2026/10/31 23:01（**晚上**）。'],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  const atFacts = sys.indexOf('## 【本次程序核实的事实】')
  const atOut = sys.indexOf('## 输出要求')
  assert.ok(atFacts > atOut, `事实段(${atFacts}) 必须在输出要求(${atOut}) 之后`)
  const tail = sys.length - atFacts
  assert.ok(tail < 1000, `距结尾 ${tail} 字，太远了约束力会弱`)
})

ok('事实正文里的 `##` 要降级成 `###`（别和段落标题平级）', () => {
  const sys = mkPersona().buildSystemPrompt({
    facts: [biliCtx],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  const at = sys.indexOf('## 【本次程序核实的事实】')
  const seg = sys.slice(at)
  assert.match(seg, /### 对方分享的 B 站视频/, '正文标题要降成三级')
  assert.ok(
    !/^## 对方分享的 B 站视频/m.test(seg),
    '不能和「## 【本次程序核实的事实】」平级 —— 看着像另一个并列章节',
  )
})

ok('没有 facts 时不产生空段（不影响普通回复）', () => {
  const sys = mkPersona().buildSystemPrompt({
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  assert.ok(!sys.includes('【本次程序核实的事实】'), '没有事实就不该有这一段')
})

ok('⚠️ 源码锁：B 站那段必须走 facts，不能再塞回 extras', async () => {
  /*
   * 第一版它就在 extras 里 —— 位置虽然在末尾，但**语义上还是"补充材料"**，
   * 模型把它和自己说过的话当同一层。挪到 facts 才是治本。
   *
   * ⚠️ 用 `await import`，不是 `require` —— 这是 ESM 文件（本会话踩过两次）。
   */
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = src.indexOf('const system = this.persona.buildSystemPrompt')
  assert.ok(at > 0, '要能找到 buildSystemPrompt 调用')
  const seg = src.slice(at, at + 900)
  assert.match(seg, /facts: \[biliContext\]/, '★ B 站要走 facts')
  assert.ok(
    !/extras:\s*\[\s*[\s\S]{0,200}biliContext/.test(seg),
    '不能再把 biliContext 放进 extras',
  )
})

console.log('\n=== 「你刚才说过的话」—— 防八股（2026-11-01）===')
/*
 * 参考 dsh-bili-scroll 的章程原话：
 * > 把「它自己以前发过的评论」喂进去 —— 没有这段，它每轮都从零开始，
 * > 自然每条都往"平均腔调"上靠（那就是八股）。
 * > 有这段它才会长出自己的口癖、并避开重复开头。
 *
 * 我们的历史消息里虽然有它自己的话，但模型不会主动对比 ——
 * 要单独列一小段 + 一句"别用相同的开头/句式"。
 */

ok('★ recentSelf 要单独成段，并明说别重复开头/句式', () => {
  const sys = mkPersona().buildSystemPrompt({
    recentSelf: ['擦完就赶紧躺下', '晚安'],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  assert.match(sys, /## 你刚才说过的话/, '要单独一段')
  assert.match(sys, /擦完就赶紧躺下/, '要列出说过的话')
  assert.match(sys, /别用相同的开头、别套同一个句式/, '要明确要求不重复')
})

ok('★ 这段要在**输出要求之后**（约束力更强）', () => {
  const sys = mkPersona().buildSystemPrompt({
    recentSelf: ['晚安'],
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  assert.ok(
    sys.indexOf('## 你刚才说过的话') > sys.indexOf('## 输出要求'),
    '要在输出要求之后',
  )
})

ok('没有 recentSelf 时不产生空段', () => {
  const sys = mkPersona().buildSystemPrompt({
    memory: '',
    scene: { kind: 'private' },
    self: { name: '蓝色大肥鱼', qq: '1000000001' },
  })
  assert.ok(!sys.includes('## 你刚才说过的话'))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
