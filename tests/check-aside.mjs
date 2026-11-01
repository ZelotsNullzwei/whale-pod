/**
 * 「决策旁白」外泄的回归测试（2026-10-29）。
 *
 * ## 现象（用户截图，2026-10-29 21:24）
 * ```
 * 蓝色大鲸鱼：
 *   哼，本鱼一直都在，只是没吭声
 *   (风堇那表情包......不回，转话题) 大晚上不睡觉，都在刷图呢
 * ```
 *
 * ## 定性
 * **不是管道 bug** —— `text-delta` / `reasoning-delta` 是分开攒的
 * （`bridge.js` 里 `text` 与 `reason` 两个变量）。这是**模型把决策旁白
 * 当成台词写了出来**。
 *
 * ## 根因
 * 人格在教它用括号写舞台提示（`persona:82`「（然后小声）」），
 * 模型把这套扩展到"决策/内心话"上 —— 它分不清
 * 「（小声）」是**表演**，而「（不回）」是**思考**。
 *
 * ## 判据（本文件锁的就是这条）
 *   · 括号里是**说给人听的表演提示** → 留（（小声）（心虚）（护食））
 *   · 括号里是**它对自己说的判断** → 剥（（不回）（该不该）（转话题））
 *   · 整条就是一个括号旁白 → 丢掉（一个字都不是对人说的）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cleanModelText } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── ① 反例：决策旁白必须被剥 ──────────────────────────────
ok('用户截图那条：行首决策旁白被剥，正文留下', () => {
  const raw = '（风堇那表情包……不回，转话题）大晚上不睡觉，都在刷图呢'
  const out = cleanModelText(raw)
  assert.equal(out, '大晚上不睡觉，都在刷图呢')
  assert.ok(!/不回|转话题/.test(out), '决策词不该出现在输出里')
})

ok('括号旁白 + 台词，只剥旁白', () => {
  assert.equal(cleanModelText('（该不该损他一句）行吧你赢了'), '行吧你赢了')
  assert.equal(cleanModelText('（要不要接这个话茬）行，说说看'), '行，说说看')
  assert.equal(cleanModelText('（先不接，看看他怎么说）在呢'), '在呢')
})

ok('全角/半角括号都认', () => {
  assert.equal(cleanModelText('(不回，转话题) 换个话题吧'), '换个话题吧')
})

ok('多行：第二行行首的旁白也要剥', () => {
  const raw = '哼，本鱼一直都在\n（不回，转话题）大晚上不睡觉'
  const out = cleanModelText(raw)
  assert.ok(!/不回/.test(out), `实际：${JSON.stringify(out)}`)
  assert.ok(out.includes('大晚上不睡觉'))
  assert.ok(out.includes('哼，本鱼一直都在'), '第一行不受影响')
})

// ── ② 整条是旁白 → 丢弃 ─────────────────────────────────
ok('整条就是一个括号旁白 → 返回空串（调用方当"没说"）', () => {
  assert.equal(cleanModelText('（开会还惦记着回我，挺闲啊）'), '')
  assert.equal(cleanModelText('（这表情包没意思，换个话题）'), '')
})

// ── ③ 正例：表演旁白必须保住 ─────────────────────────────
ok('⚠️ 表演旁白不能被剥（（小声）这类有味道，是角色风格）', () => {
  assert.equal(cleanModelText('（小声）我不是大肥鱼'), '（小声）我不是大肥鱼')
  assert.equal(cleanModelText('（心虚）我没吃'), '（心虚）我没吃')
  assert.equal(cleanModelText('（护食）盆呢？我盆呢？'), '（护食）盆呢？我盆呢？')
  assert.equal(cleanModelText('（边吃边说）那你吃了吗'), '（边吃边说）那你吃了吗')
})

ok('正文中间（非行首）的括号不剥', () => {
  const s = '我吧（其实没吃）不饿'
  assert.equal(cleanModelText(s), s)
})

ok('不含决策词的旁白，即使行首也保留', () => {
  // 「（笑）」不含决策词 → 留（判据是内容，不是"凡是行首括号都杀"）
  assert.equal(cleanModelText('（笑）你倒是会讲'), '（笑）你倒是会讲')
})

// ── ④ 时间戳标注的**三种**形态 ────────────────────────────
/*
 * ⚠️ 用户第二次截图（2026-10-29 23:29）：
 * ```
 * （8 秒）神秘黄豆群是吧，那地方天天瞎传，你也信。
 * （12 秒）去吧，慢慢找。
 * ```
 * 输入端只生成 `（8 秒前）` 和 `（+8 秒）` —— **是模型复述时自己丢了
 * `+` 或 `前`**，而旧正则要求那个标记，于是整段漏了出去。
 */
ok('（8 秒）/（12 秒）这种"丢了标记"的时间戳也要剥', () => {
  assert.equal(
    cleanModelText('（8 秒）神秘黄豆群是吧，那地方天天瞎传，你也信。'),
    '神秘黄豆群是吧，那地方天天瞎传，你也信。',
  )
  assert.equal(cleanModelText('（12 秒）去吧，慢慢找。'), '去吧，慢慢找。')
  assert.equal(cleanModelText('(8 秒)真的'), '真的', '半角括号也认')
})

ok('另外两种既有形态照旧（（5 秒前）/（+3 秒））', () => {
  assert.equal(cleanModelText('（5 秒前）真的'), '真的')
  assert.equal(cleanModelText('（+3 秒）wow什么啊'), 'wow什么啊')
  assert.equal(cleanModelText('（2 分钟）……'), '……')
  assert.equal(cleanModelText('（1 小时前）ok'), 'ok')
})

ok('⚠️ 不误伤正文里的括号（只有"括号在时间单位处结束"才剥）', () => {
  assert.equal(cleanModelText('我在想（2 天没睡了）'), '我在想（2 天没睡了）')
  assert.equal(cleanModelText('我等了（3 分钟）就走了'), '我等了（3 分钟）就走了')
  // 注：整句只有一个括号的会被 ⑫「整条旁白 → 丢弃」吃掉，那是另一条规则
  assert.equal(cleanModelText('（2 天没睡了）'), '', '整条是旁白 → 不发')
})

ok('主动发言那条「距上次有人说话已经 X 分钟」也要剥', () => {
  assert.equal(cleanModelText('在呢（距上次有人说话已经 18 分钟）'), '在呢')
})

// ── ⑤ 不破坏既有清理 ────────────────────────────────────
ok('[SILENT] / 媒体描述 / 时间戳 这些既有清理照旧', () => {
  assert.equal(cleanModelText('[SILENT]'), '[SILENT]', '[SILENT] 要留给调用方判，不能在这里变成空')
  assert.equal(cleanModelText('在呢（对方发了个QQ表情，id=20）'), '在呢')
  assert.equal(cleanModelText('（+3 秒）wow什么啊'), 'wow什么啊')
})

ok('[表情包] / [表情:N] 标记不被误伤', () => {
  assert.equal(cleanModelText('[表情包]'), '[表情包]')
  assert.equal(cleanModelText('[表情:20]'), '[表情:20]')
})

// ── ⑤ 源码锁：人格必须写清「括号只写怎么说」 ───────────────
ok('persona 里必须有「括号只用来写怎么说」的规则', () => {
  const live = 'C:/Users/Null_zwei/.dsh/whale-pod/persona/roles/default.md'
  const src = fs.existsSync(live)
    ? fs.readFileSync(live, 'utf8')
    : fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/persona/store.js'), 'utf8')
  assert.match(src, /括号只用来写「怎么说」/, '缺这条规则，模型就还会把判断写进括号')
  assert.match(src, /绝对不许/, '要有强约束')
  assert.match(src, /（不回，转话题）/, '要给反例 —— 只讲道理模型学不会')
})

ok('代码里必须只剥"含决策词"的行首括号（不能一刀切）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/qq/bridge.js'), 'utf8')
  assert.match(src, /DECIDE_ASIDE/, '决策词表要在')
  assert.match(src, /DECIDE_ASIDE\.test\(m\) \? '' : m/, '要按是否含决策词决定剥不剥')
})

// ── 「整条只有一个括号」也不能一刀切（2026-10-31）──────────────
/*
 * ## 事故（本轮才发现的老 bug）
 * 第 ⑫ 条规则是「整条就是一个括号 → 当成内心话，返回空串」。
 * 设计意图是对的（防「（开会还惦记着回我，挺闲啊）」这种纯旁白），
 * **但它把这些正常台词也吃了**：
 * ```
 * （笑）          → 整条丢 → 什么都不发
 * （2 天没睡了）   → 整条丢
 * ```
 * 「（笑）」是**说话方式**，不是内心话。
 *
 * ## 修法
 * 必须**同时命中 `DECIDE_ASIDE`（决策词）**才丢 ——
 * 只丢明确在"想"的，其余全留。误伤风险最低。
 */

ok('★ 纯括号的「说话方式」要保留（（笑）/（叹气））', () => {
  assert.equal(cleanModelText('（笑）'), '（笑）', '「（笑）」是说话方式，不是内心话')
  assert.equal(cleanModelText('（叹气）'), '（叹气）')
  assert.equal(cleanModelText('（小声）'), '（小声）')
  assert.equal(cleanModelText('（心虚）'), '（心虚）')
})

ok('★ 但长的/带数字标点的括号旁白仍然要丢', () => {
  /*
   * 不能全留 —— 「（开会还惦记着回我，挺闲啊）」是内心评价，
   * 留着会变成奇怪的自言自语。
   * 判据：1~6 个汉字/字母、无数字无标点 = 动作词 → 留；其余 → 丢。
   */
  assert.equal(cleanModelText('（开会还惦记着回我，挺闲啊）'), '', '长旁白（带逗号）→ 丢')
  assert.equal(cleanModelText('（2 天没睡了）'), '', '带数字 → 丢')
})

ok('★ 真正的决策旁白仍然要丢（（不回）/（该不该接））', () => {
  assert.equal(cleanModelText('（不回）'), '', '决策词命中 → 丢')
  assert.equal(cleanModelText('（该不该接）'), '', '决策词命中 → 丢')
  assert.equal(cleanModelText('（这表情包没意思，换个话题）'), '', '换话题 → 丢')
})

ok('⚠️ 源码锁：第 ⑫ 条必须分三类（决策词丢 / 短动作词留 / 其余丢）', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src/qq/bridge.js'), 'utf8')
  assert.match(src, /DECIDE_ASIDE\.test\(trimmed\)/, '决策词要先判')
  assert.match(
    src,
    /\[\\u4e00-\\u9fa5A-Za-z\]\{1,6\}/,
    '要有「1~6 个汉字/字母 = 短动作词」这条判据',
  )
})

// ── 时间戳注解：非数字形态也要剥（2026-10-31）────────────────
/*
 * 日志实测泄漏：
 * ```
 * （+几秒）这条本鱼手上什么都没有，没解析出东西来
 * ```
 * 原来的正则要求 `\d+`，而模型把数字写成中文（「几秒」）。
 * 另外第二轮为修时间倒流加过 `（紧接着）` 这种非数字标注 —— 也会被照抄。
 */

ok('★ 「（+几秒）」这种中文模糊时间要剥掉', () => {
  assert.equal(cleanModelText('（+几秒）这条本鱼手上什么都没有'), '这条本鱼手上什么都没有')
})

ok('★ 「（紧接着）」也要剥（那是加给历史的时间标注）', () => {
  assert.equal(cleanModelText('（紧接着）前面那些本鱼一条都没真看到'), '前面那些本鱼一条都没真看到')
})

ok('数字形态仍然有效（别改坏老的）', () => {
  assert.equal(cleanModelText('（+3 秒）wow什么啊'), 'wow什么啊')
  assert.equal(cleanModelText('（5 秒前）真的。'), '真的。')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)