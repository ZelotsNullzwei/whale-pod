/**
 * 面板里的「搜索预算」两项（`plugin/client.js`）。
 *
 * ## 2026-11-03 加：每小时限次 + 预算换算
 * 用户的要求是「**¥5 搜索坚持用一个月**」。后端已经落了 `maxPerDay` 和
 * `pacing.hourlyMax` 两道闸，这里补上**面板入口** —— 否则只能改 `config.json`。
 *
 * ## ★★★ 本文件最要紧的一条：**必须送整个 `pacing` 对象**
 * 服务端把 `search.*` 归位到 `qq.search.*` 时用的是**浅合并**：
 * ```js
 * nested.qq.search = { ...(nested.qq.search ?? {}), ...nested.search }
 * ```
 * 于是面板若只送 `{'search.pacing.hourlyMax': 5}`，`qq.search.pacing`
 * 会被**整个替换**成 `{hourlyMax:5}` —— **同层的 `enabled` 就丢了** ✗。
 * 而 `enabled:false` 会让整套失效，所以这个坑的后果是"限次突然不管用了"。
 *
 * 更阴的是：**改完当时是生效的**（热更新会临时合并），
 * **重启后从盘上读就没了** —— "改了、丢了、看不出"三者同时成立。
 * （这类事这个项目里发生过：顶层 `search` / `qq.search` 那次就是这么漏的。）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const C = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

ok('★★★ 面板必须送**整个 pacing 对象**，不能只送 hourlyMax', () => {
  assert.match(C, /'search\.pacing':\s*\{/, '★ 要送整个对象')
  assert.match(C, /enabled:\s*sr\.pacing\?\.enabled !== false/, '★ 要把 enabled 一起带上（否则浅合并会丢掉它）')
  assert.match(C, /hourlyMax:\s*Number\(v\)/, 'hourlyMax 要转成数字')
  // 反例：只送三层点号键 —— 那会触发浅合并丢 enabled
  assert.ok(!/'search\.pacing\.hourlyMax'/.test(C),
    '★ 不许只送 search.pacing.hourlyMax —— 浅合并会把同层的 enabled 冲掉')
})

ok('★★ 每小时限次有输入框，且默认值是 3', () => {
  assert.match(C, /t\('search\.hourlyMax'\)/, '要有标签')
  assert.match(C, /sr\.pacing\?\.hourlyMax \?\? 3/, '默认该是 3（跟后端默认一致）')
  assert.match(C, /0 = 不限/, '要写明"填 0 = 不限"（跟日上限同一个约定）')
})

ok('★★ 预算换算：把"每天几次"翻成"一个月多少钱"', () => {
  assert.match(C, /t\('search\.budget'\)/, '要有这一行')
  // ⚠️ 单价必须是两笔加起来（接口费 + 处理结果的模型钱），不能只写 ¥0.005
  assert.match(C, /0\.0074/, '★ 单价该是 ¥0.0074（¥0.005 接口费 + ≈¥0.0024 模型钱）')
  assert.ok(!/\*\s*0\.005\b/.test(C), '★ 别拿 ¥0.005 当总价 —— 那只是接口费')
  assert.match(C, /budgetUnlimited/, '不限次数时要有提示（账单也没上限）')
})

ok('★ 默认值跟后端对齐（`maxPerDay` 12）', () => {
  assert.match(C, /sr\.maxPerDay \?\? 12/, '★ 面板默认该跟后端一样是 12，别留旧的 20')
  assert.ok(!/sr\.maxPerDay \?\? 20/.test(C), '不许再出现旧的 20')
})

ok('★ 中英文案都要有（别只写中文）', () => {
  for (const k of ['search.hourlyMax', 'search.hourlyMaxHint', 'search.budget', 'search.budgetHint', 'search.budgetValue', 'search.budgetUnlimited']) {
    const n = (C.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) ?? []).length
    assert.ok(n >= 2, `${k} 要中英各一份（找到 ${n} 份）`)
  }
})

ok('★ 换算用的占位符前后端一致（`{per}` / `{month}`）', () => {
  assert.match(C, /'search\.budgetValue':[^\n]*\{per\}/, '中文模板要有 {per}')
  assert.match(C, /'search\.budgetValue':[^\n]*\{month\}/, '中文模板要有 {month}')
  assert.match(C, /\.replace\('\{per\}'/, '要真的替换 {per}')
  assert.match(C, /\.replace\('\{month\}'/, '要真的替换 {month}')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)