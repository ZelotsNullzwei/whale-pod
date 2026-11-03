/**
 * 「说话不加括号；动作和身体感觉**必须**加括号」（2026-11-03）。
 *
 * ## 用户原话
 * 「描述动作和感觉的时候加括号，不然我分不清是说话还是身体上的表现，你看私聊就懂」
 *
 * ## 私聊现场（为什么必须加这一条）
 * 她把动作和身体感觉**裸写在正文里**，和台词混成一片：
 * ```
 * 手自己往下走，碰到第一下我自己先抖了一下。
 * 比想的热，也比刚才紧。
 * 腿开始抖了，你别碰我腰，让我自己缓一下。
 * ```
 * 这三行到底是"她说的"还是"她身上的反应"？读的人分不出来 —— 用户要的就是这个区分。
 *
 * ## 和旧规则的关系（容易改错的地方）
 * 旧规则写的是「**十条里最多一条带括号**」，那条是当年为了治"括号当起手式"
 * 的（她曾经每条都以同一个括号动作开头，用户点名说过两次）。
 * 新语义下括号是**动作的标记** —— 该用就得用；被禁的只剩**位置**（句首当起手式）。
 * 所以这两条必须一起改，只改一条就会互相打架（测试两条都锁）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/persona/store.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 按章节结构切出大肥鱼人格里的一节（切到下一个 `### ` 为止）。 */
function section(title) {
  const start = src.indexOf(`### ${title}`)
  assert.ok(start >= 0, `模板里找不到章节「${title}」`)
  const rest = src.slice(start + 4)
  const end = rest.indexOf('\n### ')
  return end < 0 ? rest.slice(0, 900) : rest.slice(0, end)
}

console.log('括号：说话不加、动作/感觉必须加')

ok('标题就得说清"动作和感觉要加括号"（不然模型读不出这条）', () => {
  assert.ok(src.includes('### 说话不加括号；动作和身体感觉**必须**加括号'),
    '章节标题要直说：说话不加括号、动作和感觉必须加')
})

ok('★ 要点名"不许裸写动作和感觉"（真正要治的就是这个）', () => {
  const s = section('说话不加括号；动作和身体感觉**必须**加括号')
  assert.ok(/动作 \/ 身体反应 \/ 感觉/.test(s), '要把"动作/身体反应/感觉"列出来')
  assert.ok(/整段放进括号/.test(s), '要给出正确做法')
  assert.ok(/不许把动作和感觉裸写在正文里/.test(s), '要明确禁止裸写')
  assert.ok(/台词/.test(s), '要对照"台词不加括号"')
})

ok('★ 保留"不写内心判断"（括号不是用来写怎么想的）', () => {
  const s = section('说话不加括号；动作和身体感觉**必须**加括号')
  assert.ok(/不写内心判断|怎么想/.test(s), '旧的"不写判断过程"不能被这次改动吃掉')
})

ok('★ 位置仍受约束：不许当起手式（不然旧毛病会复发）', () => {
  const s = section('说话不加括号；动作和身体感觉**必须**加括号')
  assert.ok(/起手式/.test(s), '要保留"别拿括号当起手式"')
  assert.ok(/句中|句末/.test(s), '要说清动作该放哪儿')
})

ok('留下用户原话当依据（这仓库的规矩）', () => {
  const s = section('说话不加括号；动作和身体感觉**必须**加括号')
  assert.ok(s.includes('不然我分不清是说话还是身体上的表现'), '要留用户原话')
  assert.ok(/2026-11-03/.test(s), '要留日期')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)