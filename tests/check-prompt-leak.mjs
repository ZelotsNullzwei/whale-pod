/**
 * ★★ 给模型的**提示**不能漏进用户的正文。
 *
 * ## 真实事故（2026-11-02，用户私聊实测报的）
 * ```
 * 12:33:42 [我]「只回一个表情，不要打字也不要描述画面） 只回一个表情，不要打字也不要描述画面）
 *
 *             喏，说好两张就是两张。」
 * ```
 * **同一句提示漏了两遍**（他连发两张表情包）。她还得自己圆场：
 * 「那行字漏出来了…我写着写着把提示也打出去了」。
 *
 * ## 根因不是"模型照着念"，是**正则剥一半**
 * 剥媒体描述的那条正则是：
 *     /[（(]…[^）)]*[）)]/
 * `[^）)]*` **不许出现右括号**。而表情包注里的提示含一对**内层括号**
 * （「纯情绪图**（没字）**只回…」），正则在**内层**那个 `）` 处提前收手：
 *     被剥掉：（对方发了一个表情包，关于「猫猫」。纯情绪图（没字）
 *     留下来：只回一个表情，不要打字也不要描述画面）   ← 连右括号一起发给用户
 * 两张表情包 → 两段注 → **两遍**。
 *
 * ## 为什么这个坑值得单独一个测试文件
 * 这类"喂给模型的注记"历史上漏过**三次**（媒体描述、时间戳、这次的提示原文），
 * 每次都是「加了输入侧标注，忘了想输出侧怎么清」。
 * 而且它的症状是**用户看到一句莫名其妙的话**，日志里一点异常都没有。
 */
import assert from 'node:assert/strict'
import { cleanModelText, PROMPT_NOTE_TEXTS } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 日志里那句原样（两句提示 + 正文） */
const LEAKED = '只回一个表情，不要打字也不要描述画面） 只回一个表情，不要打字也不要描述画面）\n\n喏，说好两张就是两张。'

ok('★★★ 真实事故原样：提示被剥掉、正文留下', () => {
  const out = cleanModelText(LEAKED)
  assert.ok(!out.includes('不要打字也不要描述画面'),
    `提示必须剥干净，实际还剩：${JSON.stringify(out.slice(0, 80))}`)
  assert.ok(out.includes('喏，说好两张就是两张'),
    '正文一个字都不能丢')
  assert.ok(!out.includes('））'), '不该留下孤立的括号')
})

ok('★★ 整段媒体描述（含内层括号）要整段剥掉', () => {
  const raw = '（对方发了一个表情包，关于「猫猫」。纯情绪图（没字）只回一个表情，不要打字也不要描述画面）\n\n嗯。'
  const out = cleanModelText(raw)
  assert.ok(!out.includes('对方发了一个表情包'), '注记要剥掉')
  assert.ok(!out.includes('不要描述画面'), '内层括号之后的提示也要剥掉（原来就漏在这）')
  assert.ok(out.includes('嗯'), '正文要留下')
})

ok('★★ 新版注记 〔提示：…〕 也要剥掉', () => {
  const raw = '（对方发了一个表情包，关于「猫猫」）〔提示：' + PROMPT_NOTE_TEXTS[0] + '〕\n\n哈哈。'
  const out = cleanModelText(raw)
  assert.ok(!out.includes('〔提示'), '方括号注记要整段剥掉')
  assert.ok(!out.includes('不要描述画面'), '里面的提示文字也不能留')
  assert.ok(out.includes('哈哈'), '正文要留下')
})

ok('★ 自己发的那半边（「你发了个QQ表情」）也要剥', () => {
  const out = cleanModelText('（你发了个QQ表情：流泪（id=5））好')
  assert.ok(!out.includes('你发了个QQ表情'), '不能只认「对方」')
  assert.ok(out.includes('好'))
})

// ── 反向：不能剥过头 ─────────────────────────────────────────
ok('★★★ 反向：正常括号动作**不能**被误伤', () => {
  /*
   * ⚠️ 断言别写成 `keep.replace(/[（）]/g,'')` 再去 includes ——
   *    那样是把括号**去掉后拼成一串**，而输出里括号还在，必然 includes 失败。
   *    （这个测试第一版就这么写错了，红了一条"看起来像代码坏了"的。）
   *    正确写法：只查括号**里面那几个字**在不在。
   */
  for (const [raw, inner] of [
    ['嗯（笑）', '笑'],
    ['（认真脸）', '认真脸'],
    ['（挑眉）', '挑眉'],
    ['（小声）本鱼觉得不行', '小声'],
  ]) {
    const out = cleanModelText(raw)
    assert.ok(out.includes(inner), `${raw} 里的「${inner}」是正常动作，不该被剥掉`)
  }
})

ok('★★ 反向：正常聊天提到"表情包"也不能被剥', () => {
  const out = cleanModelText('你发的那个表情包挺好笑的')
  assert.ok(out.includes('表情包'), '普通句子里的"表情包"三个字不该被剥')
})

ok('★ 提示原文常量：注入侧和清洗侧共用同一份', () => {
  assert.ok(Array.isArray(PROMPT_NOTE_TEXTS) && PROMPT_NOTE_TEXTS.length > 0)
  assert.ok(PROMPT_NOTE_TEXTS[0].includes('只回一个表情'),
    '第一条就是表情包注里那句 —— 清洗侧按它擦')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)