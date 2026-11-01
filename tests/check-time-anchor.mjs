/**
 * 「时间锚点」两条修复的回归测试（2026-10-31）
 *
 * ## ② 时间倒流 → 消息没有时间标签
 * `[我]` 的 `at` 是**推送完成时间**，`[他]` 是**收到时间**，两个基准混用。
 * 生成要几秒，于是时间会倒流（实测）：
 * ```
 * 13:27:33 [他] 吃这么好
 * 13:27:50 [我] 吃得好点怎么了…     ← 回复
 * 13:27:47 [他] 我就只吃了…         ← 用户消息，比回复更早，却排在后面
 * ```
 * `stamp()` 里 `nextAt > at` 不成立 → `gap = 0` → **那条没有时间标签**（3/16 条）。
 *
 * 修法：渲染前把 `at` **单调化**（不改原数据、不重排 —— 数组顺序本来就是对的）。
 *
 * ## ③ 主动发言没有「当前时间」
 * 原来 `## 上下文提示`（含「当前时间是 …」）只写在**回复路径**的注入块里。
 * 实测 09:30 主动说「中午了」，被问后又改口「我当下午了呢」—— 两次都错。
 * 修法：挪到**公共 extras**，并带时段标签。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const { buildChatMessages } = await import('../src/qq/bridge.js')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}
const okAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}

const T0 = new Date('2026-10-31T13:27:00+08:00').getTime()
/** 拿一条消息渲染出来的纯文本 */
const textOf = (m) => (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
const hasStamp = (t) => /（([+＋]?[\d.]+\s*(秒|分钟|小时|天))|([\d.]+\s*(秒|分钟|小时|天)前)|紧接着）/.test(t)

console.log('=== ② 时间倒流：所有消息都要有时间标签 ===')

ok('★ 倒序的 at 也要每条都有标签（改前 3/16 条没有）', () => {
  const history = [
    { text: '吃这么好', at: T0, isMe: false, senderName: 'A' },
    { text: '吃得好点怎么了', at: T0 + 17000, isMe: true },   // 推送时间（比下一条晚）
    { text: '我就只吃了蛋炒饭', at: T0 + 14000, isMe: false, senderName: 'A' }, // 收到时间更早
    { text: '蛋炒饭还行', at: T0 + 23000, isMe: true },
    { text: '你想弄啥', at: T0 + 36000, isMe: false, senderName: 'A' },
  ]
  const out = buildChatMessages({ system: 'S', history }).slice(1)
  assert.equal(out.length, history.length, '条数不能变')
  const missing = out.filter((m) => !hasStamp(textOf(m)))
  assert.equal(
    missing.length, 0,
    `每条都该有时间标签，实际缺 ${missing.length} 条：${missing.map(textOf).join(' | ')}`,
  )
})

ok('不重排 —— 对话顺序必须保持原样', () => {
  const history = [
    { text: '甲', at: T0 + 5000, isMe: false, senderName: 'A' },
    { text: '乙', at: T0 + 1000, isMe: true },   // 时间更早，但顺序在后
    { text: '丙', at: T0 + 9000, isMe: false, senderName: 'A' },
  ]
  const out = buildChatMessages({ system: 'S', history }).slice(1)
  assert.ok(textOf(out[0]).includes('甲'), '第 1 条还是甲')
  assert.ok(textOf(out[1]).includes('乙'), '★ 第 2 条还是乙 —— 不能按 at 排序把对话打乱')
  assert.ok(textOf(out[2]).includes('丙'), '第 3 条还是丙')
})

ok('倒流造成的 1ms 间隔写成「紧接着」，不是「+0 秒」', () => {
  const history = [
    { text: '甲', at: T0 + 9000, isMe: false, senderName: 'A' },
    { text: '乙', at: T0 + 1000, isMe: true },   // 倒流 → monoAt 压成 +1ms
    { text: '丙', at: T0 + 12000, isMe: false, senderName: 'A' },
  ]
  const out = buildChatMessages({ system: 'S', history }).slice(1)
  const t = textOf(out[0])
  assert.ok(!/\+0 秒/.test(t), `不该出现「+0 秒」（像 bug）：${t}`)
  assert.ok(/紧接着/.test(t), `应该是「（紧接着）」：${t}`)
})

ok('正常顺序的时间标签不受影响', () => {
  const history = [
    { text: '甲', at: T0, isMe: false, senderName: 'A' },
    { text: '乙', at: T0 + 17000, isMe: true },
  ]
  const out = buildChatMessages({ system: 'S', history }).slice(1)
  assert.match(textOf(out[0]), /\+17 秒/, '正常的 17 秒间隔要保留')
})

console.log('\n=== ③ 当前时间必须在公共 extras ===')

const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

/**
 * ⚠️ 用**足够独特、且不含换行**的锚点。
 *
 * 两次踩坑：
 * 1. `indexOf('## 现在')` 匹配到了**另一处注释**「## 现在的规则（放行条件…）」
 *    （表情包那段），窗口全错。
 * 2. `indexOf('## 现在\n现在是')` 在 **CRLF** 文件里永远找不到 ——
 *    源码是 `\r\n`，`\n` 对不上（实测 CRLF=4491 / LF=0）。
 *
 * 所以用不含换行的组合锚点。
 */
const NOW_ANCHOR = '现在是 ${new Date()'

ok('★ 源码锁：`## 现在` 要在 extras 里、且在 speakHint 之前', () => {
  const atNow = SRC.indexOf(NOW_ANCHOR)
  const atSpeak = SRC.indexOf('msg.speakHint ??')
  assert.ok(atNow > 0, '要有 `## 现在` 这个公共块')
  assert.ok(atSpeak > 0, '要有 speakHint')
  assert.ok(
    atNow < atSpeak,
    '`## 现在` 必须在 speakHint 之前 —— 同一个 extras 数组里，两条路径都吃得到',
  )
})

ok('★ 源码锁：回复路径的 `## 上下文提示` 已经删掉（避免重复/漂移）', () => {
  /*
   * ⚠️ 必须先**剥掉注释行**再查。
   *
   * 三次踩坑记录：
   * 1. 裸 `includes()` → 撞到我写的注释（「原来这里还有 `## 上下文提示`」），恒 true
   * 2. 加上反引号 `'`## 上下文提示'` → **注释里也带反引号**，还是撞
   * 3. 正确做法：过滤掉 `//` / `*` / `/*` 开头的行，只看**代码**
   *
   * 另外 `includes()` 返回**布尔**，第一版还和 `0` 比过 —— 那是另一个错。
   */
  const CODE = SRC
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.equal(
    CODE.includes('## 上下文提示'),
    false,
    '代码里不该再有这个模板块 —— 已经挪到公共 extras，否则两处会各自漂移',
  )
})

ok('`## 现在` 要带时段标签（早上/中午/下午/晚上）', () => {
  const at = SRC.indexOf(NOW_ANCHOR)
  // ⚠️ 时段是**先算好再插进模板**的（`slot` 变量在 `## 现在` 之前几行），
  //    所以窗口要往前也开一段
  const seg = SRC.slice(Math.max(0, at - 900), at + 700)
  assert.match(seg, /slot\.label|s\.label/, '要渲染时段标签，不能只给钟点')
  assert.match(seg, /先看这一行/, '要明确要求它先看时间，别按感觉猜')
})

ok('主动发言的 speakHint 本身不写时间（靠公共 extras，避免两套时钟）', () => {
  const at = SRC.indexOf('const speakHint = idle < FRESH_MS')
  assert.ok(at > 0, '要能找到 speakHint')
  const seg = SRC.slice(at, at + 1200)
  assert.ok(
    !/当前时间|现在是 \$\{/.test(seg),
    'speakHint 里不该再塞时间 —— 统一由 `## 现在` 提供',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
