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

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)