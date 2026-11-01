/**
 * 摘要质量回归测试（2026-10-28，用户报「老是记小事」）。
 *
 * ## 两个根因
 *
 * ① **摘要输入没带 QQ 号** —— SUMMARY_PROMPT 要求【人】段按
 *    `QQ号 | 昵称 | 印象` 输出，但喂进去的是 `昵称: 文本`，
 *    模型物理上写不出 → 干脆整段不写【人】。
 * ② **maxTokens: 512 太小** —— 当前模型是推理模型，512 token 被推理吃光，
 *    正文 `content = null`（实测），摘要被 maybeSummarize 判空丢掉。
 *
 * 叠加后果：人像攒不下来 + 摘要经常不更新 → 长期记忆只剩「最近聊了什么」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { LongTermStore, SUMMARY_PROMPT, parsePeople, renderPeople } from '../src/memory/long.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

function mkStore() {
  return new LongTermStore({
    cfg: { enabled: true, summarizeAfter: 999 },   // 不触发自动摘要，只测 merge
    summarize: async () => '',
    log: {},
  })
}

// ── merge：模型忘了写【人】时要保住旧印象 ───────────────────
await ok('有旧人像 + 新摘要只有【事】→ 人像保留、话题更新', () => {
  const s = mkStore()
  const m = s.get('group:1')
  m.summary = renderPeople(
    new Map([['123450002', '123450002 | 阿乙 | 爱考据、揪年份']]),
    '之前在聊渲染',
  )
  m.merge('【事】\n换成聊祀的设定了')
  const people = parsePeople(m.summary)
  assert.equal(people.size, 1, '旧人像应被保留（以前会被整段冲掉）')
  assert.ok(m.summary.includes('123450002'), 'QQ 号应在')
  assert.ok(m.summary.includes('聊祀的设定'), '【事】应更新为新内容')
  assert.ok(!m.summary.includes('之前在聊渲染'), '旧【事】应被替换')
})

await ok('本就没人像 + 新摘要只有【事】→ 保持旧的整段替换行为', () => {
  const s = mkStore()
  const m = s.get('group:2')
  m.merge('【事】\n第一次摘要，只有事')
  assert.ok(m.summary.includes('第一次摘要'), '没有旧人像时仍按替换处理')
})

await ok('新摘要带【人】→ 按 QQ 号覆盖，没提到的人保留', () => {
  const s = mkStore()
  const m = s.get('group:3')
  /*
   * ⚠️ fixture 必须用**真实长度的 QQ 号**（4~12 位）—— `parsePeople` 靠
   *    `match(/(\d{4,12})/)` 认人，写 `111` 这种 3 位数会被直接丢掉。
   *    （这个坑当场踩了一次，测试报「0 !== 2」。）
   */
  m.summary = renderPeople(new Map([
    ['111111111', '111111111 | 甲 | 爱抬杠'],
    ['222222222', '222222222 | 乙 | 话很少'],
  ]), '旧话题')
  m.merge('【人】\n111111111 | 甲 | 爱抬杠，最近开始揪年份\n\n【事】\n新话题')
  const p = parsePeople(m.summary)
  assert.equal(p.size, 2, '没提到的 222222222 应保留')
  assert.ok(p.get('111111111').includes('揪年份'), '111111111 的印象应被新行替换')
  assert.ok(p.get('222222222').includes('话很少'), '222222222 原样保留')
})

await ok('旧【人】段第一个人被保留在摘要文本里（parsePeople 认得出）', () => {
  const s = mkStore()
  const m = s.get('group:4')
  m.summary = '【人】\n1095169608 | 阿甲 | 只甩表情包\n\n【事】\n旧事'
  m.merge('【事】\n新事')
  assert.equal(parsePeople(m.summary).size, 1)
  assert.ok(m.summary.startsWith('【人】'), '重新渲染后仍以【人】开头')
})

// ── 源码锁 ─────────────────────────────────────────────────
function codeLines(src) {
  return src.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('*/'))
}
const repo = path.resolve(import.meta.dirname, '..')
const idxLines = codeLines(fs.readFileSync(path.join(repo, 'src', 'index.js'), 'utf8'))

await ok('摘要输入必须带 QQ 号（sender），否则模型写不出【人】', () => {
  const line = idxLines.find((l) => l.includes('m.senderName') && l.includes('m.sender'))
  assert.ok(line, '格式化消息的行里应同时出现 senderName 和 sender（QQ 号）')
})

await ok('摘要请求不能传 maxTokens（推理模型会把正文吃光）', () => {
  const reqLine = idxLines.find((l) => l.includes('request:') && l.includes('text: prompt'))
  assert.ok(reqLine, '应能找到摘要的 request 行')
  assert.ok(!/maxTokens/.test(reqLine), `摘要 request 不该带 maxTokens，实际：${reqLine.slice(0, 120)}`)
})

await ok('SUMMARY_PROMPT 明确列出「不要记」的小事', () => {
  assert.ok(SUMMARY_PROMPT.includes('一律不记'), '要有「一律不记」这一段')
  assert.ok(/余额|钱包/.test(SUMMARY_PROMPT), '要点名钱/余额')
  assert.ok(/日常琐事/.test(SUMMARY_PROMPT), '要点名日常琐事')
  assert.ok(/吐槽/.test(SUMMARY_PROMPT), '要点名一次性吐槽')
})

await ok('SUMMARY_PROMPT 教模型 QQ 号从哪来', () => {
  assert.ok(/昵称\(数字\)|照抄那串数字/.test(SUMMARY_PROMPT), '要说明 QQ 号在「昵称(数字)」里')
})

// ── 摘要不许写"能力结论"（2026-10-31）──────────────────────────
/*
 * ## 事故
 * 摘要里留了一句：
 * ```
 * 【事】他连着甩B站链接考我能不能看到内容，第一条《小克你最好了》我看到了，
 *      后两条没打开。我让他下次直接发 BV 号，别带那堆分享参数。
 * ```
 * 那是**当时**真的（代码有 bug）。但**修好之后它就变成假的了** ——
 * 而摘要**不会自己更新**，于是机器人一直照它演：
 * ```
 * 21:28:23  B站：BV1bbeY6wE9x 评论 5 条 / 弹幕 10 条   ✅ 真抓到了
 * 21:28:27  我「还是没展开，跟刚才那条一模一样的链接」  ← 照着旧结论演
 * ```
 * **这跟"我说过要留一碗米饭"是同一类问题：把一次性状态写成了长期事实。**
 */

const shiSeg = () => {
  /*
   * ⚠️ 定位 `【事】` 的**正文段**，不能简单 indexOf / lastIndexOf。
   *
   * 实测全文 `【事】` 出现在 **6 处**：
   *   64   —— 开头「一共五部分（【人】【事实】【事】【我】【梗】）」
   *   825  —— **正文段（要的就是这个）**
   *   1495 / 1540 —— 【梗】段里的举例
   *   2172 / 2300 —— 「【已有印象】更新说明」里提到【事】
   *
   * 第一版 `indexOf` 取到 64（空段），第二版 `lastIndexOf` 取到 2300（更新说明），
   * 两次都假失败。**按位置锚定不可靠，按内容锚定更稳** ——
   * 正文段的特征是紧跟着「这个会话最近在聊什么」。
   */
  const anchor = SUMMARY_PROMPT.indexOf('这个会话最近在聊什么')
  const at = SUMMARY_PROMPT.lastIndexOf('【事】', anchor)
  const end = SUMMARY_PROMPT.indexOf('【我】', anchor)
  return SUMMARY_PROMPT.slice(at, end > anchor ? end : undefined)
}

await ok('★ 【事】里不许写"我做不到/打不开/看不到"这类能力结论', () => {
  const seg = shiSeg()
  assert.match(seg, /不要写「我做不到 \/ 打不开 \/ 看不到 \/ 读不出」/, '要有这条禁令')
  assert.match(seg, /当时那一刻|随时会变/, '要解释为什么（那是当时的状态）')
  assert.match(seg, /一直照着它演/, '要点破后果（会照旧结论演）')
})

await ok('★ 【事】里也不许教对方"下次该怎么发"', () => {
  const seg = shiSeg()
  assert.match(seg, /不要教对方/, '要有这条禁令')
  assert.match(seg, /掩饰/, '要说明那是掩饰性的话')
})

await ok('【事】要给出**中性事实**的正确写法', () => {
  const seg = shiSeg()
  assert.match(seg, /中性事实/, '要指明改写成中性事实')
  assert.match(seg, /他发过几条 B 站链接/, '要有具体示范')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)