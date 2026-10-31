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
 *   · ⚠️ 2026-10-30 反转：「表情包想发就发」，**不许再有频率约束**（见下）
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

ok('⚠️ 人格里不该再有"表情频率"约束（2026-10-30 需求反转）', () => {
  const src = read('src/persona/store.js')
  /*
   * ⚠️ 这条原来叫「明禁"用表情搪塞"」，**方向是反的**。
   *
   * 数字（38% 纯表情）是真的，但**结论下错了**：我把它读成"用表情搪塞
   * （回避思考）"，于是在人格和注入块里各加了一条禁令。
   *
   * 用户连着说了两次 ——「表情包多发其实可以」「这个还是想发就发吧」。
   * 真正的问题从来不是"用了表情"，而是那句**「回个表情也比沉默好」**
   * 把它变成了默认逃生口。前者是正常的说话方式，后者才是躲事。
   *
   * 所以现在**反过来锁**：不许再写频率/节奏类约束。
   * 这类规则看着"更像人"，实际是把正常行为当异常压 —— 加一次错一次。
   */
  const banned = [
    '别用表情搪塞',
    '表情是调味',
    '大多数回复不该带表情',
    '几乎不用表情',
    '别每条都带表情',
    '删掉这个表情',
  ]
  for (const bad of banned) {
    assert.ok(!src.includes(bad), `不该再有「${bad}」这类约束 —— 表情包想发就发`)
  }
  // 但两条**技术性**约束必须留着
  assert.match(src, /不要用 emoji/, 'emoji 仍要禁 —— 一条带好几个是最明显的机器人特征')
  assert.match(src, /写\*\*完整\*\*/, '标记要写完整（残缺形式会变成一串方括号文字）')
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
  assert.ok(
    !block.includes('别用表情搪塞'),
    '注入块里也不能再禁表情（人格和注入块两处都要改，别只改一处）',
  )
  assert.match(block, /表情包想发就发/, '要明确允许表情包')
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

// ── ⑤ 「别写成 AI 报告」（2026-10-30）──────────────────────
/*
 * 用户看过实际输出后说：
 *   「群里描述图片太像ai了吧」
 *   「真人应该只会短短的说一下重点」
 *
 * 实测反例（都是它自己发过的）：
 *   「财富 93 顶到天，战斗 68、生存 69、搜索 63、合作 67，五边形歪成一坨」
 *   「控制终端六个、金条六根、钻石鱼子酱六罐，表还收了五块，家底挺厚」
 *   「十六万的 AKS-74U，基础伤害 34，射速 533，配件看着挺全的」
 * —— 全是**把图上的数字清点一遍**。
 */
ok('⚠️ 图片分支：要「只挑一个点」，不能只写「把意思点出来」', () => {
  const src = read('src/qq/bridge.js')
  assert.match(src, /只挑一个点，一两句话说完/, '要有明确的一个点 + 长度约束')
  assert.match(src, /真人看图不会做数据提取/, '要命名这个坏模式')
  assert.ok(
    !src.includes('有字就把那个意思点出来'),
    '旧措辞是"邀请它做信息提取"—— 就是它把数字念一遍的来源',
  )
  // 要带**正反例**：光说"简短"模型不知道短到哪
  assert.match(src, /✗「财富 93 顶到天/, '要有真实反例')
  assert.match(src, /✓「93% 都烧掉了/, '要有正例')
})

ok('⚠️ 通用长度规则：不能再说「真在讲事情就说完整」', () => {
  const src = read('src/persona/store.js')
  assert.ok(
    !src.includes('真在讲事情就说完整'),
    '这句让它把"有数据可讲"当成"该写完整"，是 AI 味的来源',
  )
  assert.match(src, /默认往短了说/, '要给出默认方向')
  assert.match(src, /挑重点说一两句/, '讲事情也要挑重点，不是写完整')
  assert.match(src, /不等于「报告」/, '要切断"完整=报告"这个联想')
})

ok('⚠️ 群聊放开、私聊收敛（2026-10-30 用户修正）', () => {
  const src = read('src/persona/store.js')
  /*
   * 用户先说「表情包多发其实可以」「想发就发」，我把**私聊的限制也删了** ——
   * 但那是群聊的语境。当晚他反馈「私聊又开始用emoji了」。
   *
   * ⚠️ 注意这**不是把"频率约束"加回来**（他明确反对那个）——
   * 这是**情境差异**：群里发表情是附和 / 刷梗，私聊里是拿表情顶人，
   * 观感完全不同。所以措辞必须是"看场合"，不是"配额"。
   */
  assert.match(src, /私聊里收敛/, '私聊要收着点')
  assert.match(src, /群里发表情是附和/, '要说明为什么群聊能放开 —— 情境，不是数量')
  assert.ok(
    !/私聊里也能用，不用刻意回避/.test(src),
    '这句是"全局放开"的措辞，已按用户反馈撤掉',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)