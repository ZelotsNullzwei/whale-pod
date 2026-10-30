/**
 * 「还它否决权」的回归测试（2026-10-29）。
 *
 * ## 为什么改
 * 用户观感：**太乖了**。量化证据：
 * ```
 * 今天发出 94 条 → 解析出 50 条文本
 * 纯表情/纯表情包: 19 条 (38%)
 * ```
 * 追下去，凶手是两处**最后注入的指令**：
 * ```
 * 「你的任务只是把这句话说好。真的无话可说时，回一个表情（[表情:N] 或 [表情包]）也比沉默好。」
 * 「⚠️ 不要输出 [SILENT]」
 * ```
 * 前者把"聊天"降级成"完成输出"，后者直接**剥夺了它"不想说"的权力**。
 *
 * ## 原来的理由也是真问题
 * 人格里写着「不想说就输出 [SILENT]」，生成层照做 → 两层都判一次 →
 * 第二层否掉第一层 → 界面「发言 p=0.95」而 outcome 是 model-silent、
 * replied 一直是 0（看着像 bug）。
 *
 * **但解法选错了**：该理清记账语义，不是让人格闭嘴。
 *
 * ## 现在的语义
 *   · 上层仍告诉它「判过该接」（省得重复权衡）
 *   · 但**最终由它定** —— 可以说，也可以 [SILENT]
 *   · `[SILENT]` 记成 `persona-declined`（正常结论，不是矛盾）
 *   · `empty-after-clean` 才是输出侧毛病（清理太狠）
 *   · 明确禁掉「用表情搪塞」
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const repo = path.resolve(import.meta.dirname, '..')
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8')

// ── ① 人格的「输出要求」必须允许沉默 ───────────────────────
ok('人格输出要求：允许 [SILENT]，不再强制"必须说"', () => {
  const src = read('src/persona/store.js')
  const at = src.indexOf('## 输出要求')
  assert.ok(at > 0, '应能找到「输出要求」段')
  const block = src.slice(at, at + 1200)
  assert.match(block, /\[SILENT\]/, '要提到 [SILENT]')
  assert.ok(
    !/不要输出 \[SILENT\]/.test(block),
    '不能再说「不要输出 [SILENT]」—— 那等于剥夺否决权',
  )
  assert.ok(
    !/也比沉默好/.test(block),
    '不能再教「回个表情也比沉默好」—— 实测这条直接造出 38% 纯表情',
  )
})

ok('人格输出要求：明禁"用表情搪塞"', () => {
  const src = read('src/persona/store.js')
  assert.match(src, /别用表情搪塞/, '要有这条 —— 表情是回应，不是占位符')
})

// ── ② 生成前的注入块不能再把聊天降级成任务 ─────────────────
ok('生成注入：去掉「你的任务只是把这句话说好」', () => {
  const src = read('src/qq/bridge.js')
  assert.ok(
    !/你的任务只是把这句话说好/.test(src),
    '这句话把"参与聊天"降级成"完成输出"，是"太乖"的直接来源',
  )
  assert.ok(
    !/所以：\*\*不要输出 \[SILENT\]\*\*/.test(src),
    '注入里不能禁止 [SILENT]',
  )
})

ok('生成注入：明确「最终由你定」且允许 [SILENT]', () => {
  const src = read('src/qq/bridge.js')
  const at = src.indexOf('## 群里刚说到这句')
  assert.ok(at > 0, '应能找到新的注入块')
  const block = src.slice(at, at + 600)
  assert.match(block, /最终由你定/, '要交还决定权')
  assert.match(block, /\[SILENT\]/, '要说明可以沉默')
  assert.match(block, /别用表情搪塞/, '要禁掉表情搪塞')
})

// ── ③ 记账语义要分开 ──────────────────────────────────────
ok('记账：persona-declined 与 empty-after-clean 分开', () => {
  const src = read('src/qq/bridge.js')
  assert.match(src, /'persona-declined'/, '人格主动不说 → 正常结论')
  assert.match(src, /'empty-after-clean'/, '清理完什么都不剩 → 输出侧毛病')
  assert.ok(
    !/'model-silent'/.test(src.replace(/\/\/.*$/gm, '')),
    '代码里不该再有 model-silent 这个含糊的名字（注释里可以有）',
  )
})

ok('记账：persona-declined 要打日志（否则又变成静默）', () => {
  const src = read('src/qq/bridge.js')
  assert.match(src, /人格选择不说/, '要有可检索的日志行')
})

// ── ④ 行为不变：真的不发 ──────────────────────────────────
ok('[SILENT] 仍然真的不发送（行为没被改坏）', async () => {
  // 交给 check-qq.mjs 的端到端用例覆盖；这里只锁"没在 cleanModelText 里被吃掉"
  const { cleanModelText } = await import('../src/qq/bridge.js')
  assert.equal(cleanModelText('[SILENT]'), '[SILENT]', '要留给调用方判断，不能在这里变空')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)