/**
 * 被点名时不该有 `[SILENT]` 出口（2026-11-01 实测事故）。
 *
 * ## 现场
 * ```
 * 21:22:50 客「@蓝色大鲸鱼 给我jm的白毛本的神秘数字」
 *          决策 → 发言 (p=0.95, 被 @ 了（不判断，直接回）)   ← 决策层说必须回
 * 21:22:53 人格选择不说（[SILENT]）                        ← 生成层把她按住了
 * ```
 * 用户看到的就是「叫它它不理」。
 *
 * ## 根因
 * 生成提示词里那段通用文案**无条件**给 `[SILENT]` 出口：
 * ```
 * 上层已经判过「该不该接」，结论是接 —— 但最终由你定。
 * 真没什么想说的，就直接输出 [SILENT]（不算错，也不用解释）。
 * ```
 * 它把人格里「有人叫你 → 这就是在叫你，要应」盖掉了。
 *
 * ## 这条锁要守住的
 * 1. `addressedToMe` 必须来自 `lastMsg.mentionsMe`（被 @ 或**引用了她的消息**）
 * 2. 被点名那一版**明说不许 [SILENT]**
 * 3. **非**被点名那一版的 [SILENT] 出口要留着（别一刀切，那是人格的决定权）
 * 4. 保留"政治/人身攻击可以不接"的例外（别把"被点名必须回"变成"什么都要回"）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

ok('addressedToMe 来自 lastMsg.mentionsMe', () => {
  assert.match(src, /const addressedToMe = Boolean\(lastMsg\?\.mentionsMe\)/,
    '判据必须是入库时算好的 mentionsMe（= 被 @ 或引用了她的消息）')
})

ok('被点名那一版：明说不许 [SILENT]', () => {
  const i = src.indexOf('## 有人点了你的名')
  assert.ok(i > 0, '找不到"被点名"那一版文案')
  const block = src.slice(i, i + 700)
  assert.match(block, /不要输出 \[SILENT\]/, '要点明被点名时不许沉默')
  assert.match(block, /被点名就得应一声/, '要给出"必须应"的正向指令')
})

ok('被点名那一版：给不了也要出声（别用"不给"换"不吭声"）', () => {
  const i = src.indexOf('## 有人点了你的名')
  const block = src.slice(i, i + 700)
  assert.match(block, /但别不吭声|别不吭声/, '要写明"给不了也说出来"')
})

ok('非被点名那版：仍保留 [SILENT] 出口（人格的决定权不能没收）', () => {
  /*
   * ⚠️ 必须用**代码分支**那处（带 `: ` 前缀），不能用裸的 `## 群里刚说到这句` ——
   * 上面注释里也提到了这串字（讲"原来只写在回复路径的…块里"），
   * `indexOf` 会命中注释那一处，切出来的片段里自然没有 [SILENT]。
   * （第一版就是这么假红的。）
   */
  const i = src.indexOf(": '## 群里刚说到这句")
  assert.ok(i > 0, '找不到通用那版代码分支')
  const block = src.slice(i, i + 500)
  assert.match(block, /\[SILENT\]/, '通用场景仍可以沉默')
})

ok('保留"政治 / 人身攻击照样不接"的例外', () => {
  const i = src.indexOf('## 有人点了你的名')
  const block = src.slice(i, i + 700)
  assert.match(block, /政治 \/ 人身攻击/, '别把"被点名必须回"变成"什么都要回"')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)