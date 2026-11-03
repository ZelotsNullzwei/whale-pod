/**
 * ★★ client.js 里那段 CSS 模板串**没有被截断**。
 *
 * ## 这个测试防的是什么
 * 那个文件里有一大段 CSS 装在 `const CSS =` 后面开着的**模板字符串**里。
 * 一旦有人在**那段里**（包括里面的注释）写了一个反引号，
 * 模板串就被**提前截断**，后面的内容被当成 JS 解析。
 *
 * ## 为什么它特别难发现（也是为什么必须机器扫）
 * 它是**语法上合法**的：反引号成对出现时，
 * `<模板>`.xxx<模板>` 会被解析成「字符串的成员访问」——
 * **开闭角色整体翻转一次**，从此往后每个模板串的意义都变了。
 * 于是：
 *   · `node --check` **一路绿灯**
 *   · 但 CSS 被劈成一地碎片、所有模板串串味
 *
 * 实测代价（2026-11-02）：直接让 **DSH 进恢复模式** ——
 *   `dsh-whale-pod: import failed` → `Renderer recovery exhausted: web boot: 1 entry did not activate`
 * 而当时 `node --check` 是过的。
 *
 * ## 历史
 * 文件里原本就写着"踩过 4 次"。2026-11-02 我改规则时踩了第 5 次，
 * **然后写"不要用反引号"这段警告时又踩了第 6 次**（就在第 958 行）。
 * 所以改为机器扫。
 *
 * ## 判据为什么这样选
 * 光数「模板串内部有没有反引号」**不够** —— 因为反引号成对时，
 * 第一对正好被当成"收尾"，内部计数是 0（我第一次的扫描器就这么骗过了自己）。
 * 所以改成**哨兵**：模板串的正文必须包含**靠近 CSS 末尾的那条规则**。
 * 被截断时正文会短一大截，末尾规则必然落在外头 → 测试红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
const BT = String.fromCharCode(96)

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const marker = 'const CSS = ' + BT
const open = src.indexOf(marker)
const close = open < 0 ? -1 : src.indexOf(BT, open + marker.length)
const body = open < 0 || close < 0 ? '' : src.slice(open + marker.length, close)
const bodyEndLine = src.slice(0, close).split('\n').length

ok('能定位到 CSS 模板串', () => {
  assert.ok(open >= 0, '找不到 ' + marker)
  assert.ok(close > open, '找不到收尾反引号')
})

ok('★★ 模板串正文里**一个反引号都没有**', () => {
  const n = (body.split(BT).length - 1)
  assert.equal(n, 0, `正文里有 ${n} 个反引号 —— 它们会把模板串截断`)
})

ok('★★ 正文必须够长（被截断时会短一大截）', () => {
  assert.ok(body.length > 20000,
    `正文只有 ${body.length} 字符（正常 >24000）—— 八成被截断了`)
})

ok('★★ 哨兵：正文必须包含**靠近 CSS 末尾那条规则**', () => {
  // .gd_chrow / .gd_group 都在后半段 —— 被截断时它们会落到模板串外面
  for (const sentinel of ['.gd_root{', '.gd_group{', '.gd_grouptitle{', '.gd_chrow{']) {
    assert.ok(body.includes(sentinel), `正文里缺 ${sentinel} —— 被截断了`)
  }
})

ok('★ 收尾反引号必须**独占一行**（不是被注释里的反引号抢走）', () => {
  const lineText = src.split('\n')[bodyEndLine - 1]
  assert.equal(lineText.trim(), BT,
    `第 ${bodyEndLine} 行是收尾行，但内容是 ${JSON.stringify(lineText.trim().slice(0, 40))} —— `
    + '说明有反引号**提前**当了收尾（开闭角色翻转，后面全乱）')
})

ok('★ 注释里不许出现反引号（含 .gd_ 类名的那种写法）', () => {
  // 只查 CSS 正文里的注释行 —— 那是最容易手滑的地方
  const bad = body.split('\n')
    .map((l, i) => ({ l, i: i + 1 }))
    .filter((x) => x.l.trim().startsWith('*') && x.l.includes(BT))
  assert.equal(bad.length, 0, '这些注释行里有反引号: ' + bad.map((x) => x.i).join(', '))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)