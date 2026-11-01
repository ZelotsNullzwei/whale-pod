/**
 * 表情包提示词的分支测试。
 *
 * 用户的三条要求（原话）：
 *   「严格限制，不复述，只接梗，懂意思」
 *   「这种情况回表情啊」  ← 没字的纯情绪图
 *
 * 所以分两类处理：
 *   A. 有字的梗图 → 懂意思、用自己的话接一句，不念字
 *   B. 没字的情绪图 → 只回表情，不打字、不描述
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const stickerSeg = SRC.match(/`## 这条是表情包([\s\S]*?)`\s*\n\s*: hasWords/)
const imageSeg = SRC.match(/`## 这条消息只有一张图([\s\S]*?)`\)/)

ok('找到了表情包分支', () => {
  assert.ok(stickerSeg, '应存在「## 这条是表情包」段')
})

ok('区分为「有字的梗图」和「没字的情绪图」两类', () => {
  assert.ok(/有字的梗图/.test(stickerSeg[1]))
  assert.ok(/没字的情绪图/.test(stickerSeg[1]))
})

ok('A 类：要求用自己的话接', () => {
  assert.ok(/用你自己的话回应/.test(stickerSeg[1]))
})

ok('B 类：要求「只回一个表情，不要打字」', () => {
  assert.ok(/只回一个表情，不要打字/.test(stickerSeg[1]))
})

ok('B 类：禁止用文字接（「我也是」「这表情」）', () => {
  assert.ok(/配了就是错/.test(stickerSeg[1]))
})

ok('明确禁止「描述画面」', () => {
  assert.ok(/描述画面/.test(stickerSeg[1]))
})

ok('明确禁止「把图翻译成文字」', () => {
  assert.ok(/把图翻译成文字/.test(stickerSeg[1]))
})

ok('明确禁止「认领」', () => {
  assert.ok(/这不是我/.test(stickerSeg[1]))
})

ok('给出反例：「我这边也是这个表情」是错的', () => {
  assert.ok(/吃了惊|我这边也是这个表情/.test(stickerSeg[1]))
})

ok('表情包分支不出现「像不像你」', () => {
  assert.ok(!/像不像你/.test(stickerSeg[1]))
})

ok('真图片分支仍保留「像不像你」', () => {
  assert.ok(imageSeg, '应存在「## 这条消息只有一张图」段')
  assert.ok(/像不像你/.test(imageSeg[1]))
})

ok('describeMedia 的 tail 区分两类', () => {
  const seg = SRC.match(/const tail = '([\s\S]{0,220}?)\n\s+return n/)
  assert.ok(seg, '应存在 tail')
  assert.ok(/有字的梗图/.test(seg[1]))
  assert.ok(/只回一个表情/.test(seg[1]))
})

// ── describeMedia：区分「你 / 对方」+ 表情给名字（2026-10-31）────────
/*
 * ## 事故
 * ```
 * 18:59:04 他「[表情包]」
 * 18:59:06 我「[表情:5]」          ← 流泪
 * 18:59:27 他「哭啥」
 * 18:59:29 我「那表情是你发的吧」  ← 指着自己发的说"你发的"
 * ```
 * 两个错都在 `describeMedia`：
 * 1. 三个替换**全写死「对方」** → 机器人自己发的也在历史里标成"对方发的"
 * 2. `[表情:N]` 只给 `id=N` → 模型不知道 5 是"流泪"，只能盲选
 */
const { describeMedia: dm } = await import('../src/qq/bridge.js')

ok('★ 自己发的表情要说「你」，不能是「对方」', () => {
  const s = dm({ text: '[表情:5]', isMe: true })
  assert.match(s, /^（你/, `应以「你」开头，实际：${s}`)
  assert.ok(!/对方/.test(s), `自己发的不能说"对方"：${s}`)
})

ok('★ 对方发的表情仍然说「对方」', () => {
  const s = dm({ text: '[表情:5]', isMe: false })
  assert.match(s, /对方/, `实际：${s}`)
  assert.ok(!/^（你/.test(s), `不该说"你"：${s}`)
})

ok('★ 表情要给**名字**，不能只给 id（id=5 是流泪）', () => {
  const mine = dm({ text: '[表情:5]', isMe: true })
  const other = dm({ text: '[表情:5]', isMe: false })
  for (const [label, s] of [['自己', mine], ['对方', other]]) {
    assert.match(s, /流泪/, `${label}：id=5 应该渲染成「流泪」，实际：${s}`)
    assert.match(s, /id=5/, '保留 id 便于排查')
  }
  assert.match(dm({ text: '[表情:14]', isMe: true }), /微笑/, 'id=14 是微笑')
})

ok('不认识的 id 退回 id（不炸、不编名字）', () => {
  const s = dm({ text: '[表情:9999]', isMe: true })
  assert.match(s, /id=9999/, `实际：${s}`)
})

ok('表情包 / 图片 也要区分「你 / 对方」', () => {
  assert.match(dm({ text: '[表情包]', isMe: true }), /^（你发了一个表情包/, '自己发的表情包')
  assert.match(dm({ text: '[表情包]', isMe: false }), /对方发了一个表情包/, '对方发的表情包')
  assert.match(dm({ text: '[图片]', isMe: true }), /^（你发了一张图/, '自己发的图')
  assert.match(dm({ text: '[图片]', isMe: false }), /对方发了一张图/, '对方发的图')
})

ok('⚠️ 源码锁：剥离"系统注解"的正则必须同时认「对方」和「你」', () => {
  /*
   * ⚠️ 这是本会话差点漏掉的**真回归**：
   *
   * `describeMedia` 改成「（你发了个QQ表情：流泪（id=5））」之后，
   * 输出侧那条剥离正则原来只认「对方发了」——
   * **自己那半边就漏了**，模型一旦照抄注解，会直接发到群里。
   *
   * 所以锁的不是"代码里不许出现那个字符串"（注释和提示词里本来就该提到它），
   * 而是**剥离正则必须覆盖两种人称**。查之前先剥注释，避免撞注释。
   */
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  assert.match(
    code,
    /\(\?:对方\|你\)发\(\?:了个QQ表情\|了一个表情包\|了一张图\)/,
    '剥离正则要写成 (?:对方|你)发(?:了个QQ表情|了一个表情包|了一张图)',
  )
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)