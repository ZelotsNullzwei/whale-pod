/**
 * 日程生成必须只收正文、不能收推理草稿（2026-10-28 修）。
 *
 * 症状：日志里「日程生成：模型输出无法解析 — 我们需要回答用户，要求给…」
 * —— 贴出来的「原始输出」全是**推理内容**。
 *
 * 根因：`generateDayPlan` 的消费循环写的是「统一读 chunk.text，不猜 type」，
 * 而 `fallback.js` 产出的 `reasoning-delta` **也有 .text**：
 *   { type:'reasoning-delta', text:'我们需要回答用户，要求给…' }
 *   { type:'text-delta',      text:'{"wake":…}' }
 * 草稿被拼进 out、正文被埋在后面 → parseDayPlan 失败。
 *
 * 后果不只是报错：`_ensureDayPlan` 会**反复重试**，每次都白花一次模型调用。
 *
 * 实测（真实提示词）：旧写法 3/3 解析失败，新写法 3/3 成功。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseDayPlan } from '../src/memory/dayPlan.js'

let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 复刻 fallback.js 的 chunk 形状。 */
function collect(chunks, { skipReasoning }) {
  let out = ''
  for (const chunk of chunks) {
    if (typeof chunk === 'string') { out += chunk; continue }
    const kind = chunk?.type
    if (skipReasoning && (kind === 'reasoning-delta' || kind === 'reasoning')) continue
    if (typeof chunk?.text === 'string') out += chunk.text
  }
  return out
}

const chunks = [
  { type: 'reasoning-delta', text: '我们需要回答用户，要求给「蓝色大肥鱼」编一份今天的日程。' },
  { type: 'reasoning-delta', text: '必须 JSON 输出，不要加别的字。' },
  { type: 'text-delta', text: '{"wake":"7:30 醒","morning":"写代码","noon":"白饭配青菜",' },
  { type: 'text-delta', text: '"afternoon":"刷手机","evening":"洗袜子","mood":"还行"}' },
]

ok('不跳草稿 → 解析失败（这就是线上现象）', () => {
  assert.equal(parseDayPlan(collect(chunks, { skipReasoning: false })), null)
})

ok('跳过草稿 → 解析成功', () => {
  const plan = parseDayPlan(collect(chunks, { skipReasoning: true }))
  assert.ok(plan, '应该能解析出 JSON')
  assert.ok(String(plan.wake ?? '').includes('7:30'), '字段应正确')
})

ok('源码锁：generateDayPlan 的消费循环必须排除 reasoning', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'index.js'), 'utf8')
  const lines = src.split('\n').map((l) => l.trim())
  /*
   * ⚠️ 必须先定位到 generateDayPlan —— 文件里有**两个**消费循环
   *    （摘要在前、日程在后），直接 findIndex 会命中摘要那个，
   *    那里的判据是 type 白名单、当然不含 'reasoning-delta' 字样，
   *    会误报失败。（这个坑当场踩了一次。）
   */
  const fnAt = lines.findIndex((l) => l.includes('const generateDayPlan'))
  assert.ok(fnAt >= 0, '应能找到 generateDayPlan')
  const loopAt = lines.findIndex((l, i) => i > fnAt && l.includes('for await (const chunk of opened.stream)'))
  assert.ok(loopAt > fnAt, 'generateDayPlan 里应有消费循环')
  const block = lines.slice(loopAt, loopAt + 8)
  /*
   * 断言的是**顺序**，不是「那行不存在」——
   * 修好后仍然要拼 chunk.text，只是前面多了个 `continue` 把它挡在草稿之外。
   * 所以：排除 reasoning 的那句必须**出现在**拼 text 之前。
   */
  const guardAt = block.findIndex((l) => /reasoning-delta/.test(l))
  const takeAt = block.findIndex((l) => /out \+= chunk\.text/.test(l))
  assert.ok(guardAt >= 0, '循环里必须显式排除 reasoning-delta')
  assert.ok(takeAt >= 0, '循环里应当仍会拼 chunk.text（正文）')
  assert.ok(guardAt < takeAt, `排除草稿的那句必须在拼 text 之前（实际 guard@${guardAt} take@${takeAt}）`)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)