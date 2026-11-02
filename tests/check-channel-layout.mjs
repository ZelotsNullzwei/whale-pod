/**
 * 渠道卡片的布局与分组标题（2026-11-02）。
 *
 * 用户看到 DSH 面板里两个渠道**上下摞着**，问「就两个，为什么不能并排节约格子」。
 *
 * ## 根因不是"卡片不会并排"，是分组把并排挡住了
 * ```
 * .gd_chcards{display:grid;grid-template-columns:repeat(2,...)}   ← 外层本来就是两列网格
 * .gd_group{display:flex;flex-direction:column}                   ← ★ 组内是竖向
 * ```
 * 每个「组」占外层网格的一格，**组内的卡片竖着排**。
 * 渠道包（14 个免费渠道）在的时候分组是「免费车道 / 账号型 / 其它」，
 * 每组好几张卡、竖排还算合理。包拆掉之后**永远只剩一组**（other）——
 * 于是"一组占一格 + 组内竖排" = 两张卡上下摞着，浪费一半宽度。
 *
 * ## 两处改动
 * ① `.gd_group` 占满整行、组内自己两列 → 卡片真的并排
 * ② 只有一组时**不显示组标题** —— 分组是渠道包留下的分类，包拆了只剩 other，
 *    「其它渠道」相对于什么都不成立（用户也点出"字样不对"）
 *
 * ## 为什么锁住
 * `.gd_group` 写成竖排 flex 是**有历史理由的**（当年多组、每组竖排），
 * 很容易被当成"本来就该这样"改回去 —— 一改回去用户又会看到卡片上下摞。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 取出某条 CSS 规则的正文 */
const cssRule = (sel) => {
  const at = src.indexOf(sel + '{')
  assert.ok(at > 0, `找不到规则 ${sel}`)
  const end = src.indexOf('}', at)
  return src.slice(at, end)
}

ok('★★ .gd_group 必须是**两列网格**，不能再是竖向 flex', () => {
  const rule = cssRule('.gd_group')
  assert.match(rule, /display:grid/, '要是网格')
  assert.match(rule, /grid-template-columns:repeat\(2/, '要两列')
  assert.ok(
    !/flex-direction:column/.test(rule),
    '不能是竖向 flex —— 那样组内卡片会上下摞着（用户报的就是这个）',
  )
})

ok('★ .gd_group 要占满整行（否则它只占外层网格的一格）', () => {
  const rule = cssRule('.gd_group')
  assert.match(rule, /grid-column:1\/-1/, '要 grid-column:1/-1')
})

ok('★ 组标题也要占满整行（不然它会挤掉一张卡片的位置）', () => {
  const rule = cssRule('.gd_grouptitle')
  assert.match(rule, /grid-column:1\/-1/)
})

ok('★ 只有一组时不显示组标题', () => {
  assert.match(src, /groupCount > 1/, '要按组数决定显不显示标题')
  assert.match(src, /groupCount > 1\s*\n?\s*\?/, '要是一个三元的条件')
})

ok('★ 「其它渠道」这个字样不能再有（"其它"相对于什么都不成立）', () => {
  assert.ok(
    !/'model\.group\.other':\s*'其它渠道'/.test(src),
    '改成「渠道」—— 分组是渠道包留下的，包拆了只剩 other，不该再叫"其它"',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)