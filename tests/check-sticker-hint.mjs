/**
 * 表情包提示词的分支测试。
 *
 * 背景：让它看表情包判断「像不像自己」→ 它对每张都要表个态
 * （「这不是我，是那只青蛙」「蓝毛勉强沾点边」），比不接更烦人。
 *
 * 现在的规则：**纯表情包的提示词里不许出现「像不像」这套话术**，
 * 只看图上有没有字。真图片才保留「像不像你」的判断。
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

// 找出三块 mediaHint 分支
const stickerSeg = SRC.match(/\?\s*`## 这条是表情包([\s\S]*?)`\s*\n\s*: hasWords/)
const imageSeg = SRC.match(/`## 这条消息只有一张图([\s\S]*?)`\)/)

ok('找到了表情包分支', () => {
  assert.ok(stickerSeg, '应存在「## 这条是表情包」段')
})

ok('表情包分支里不出现「像不像你」', () => {
  const seg = stickerSeg[1]
  assert.ok(!/像不像你/.test(seg), '表情包不该判断像不像自己')
})

ok('表情包分支明确禁止「这不是我」', () => {
  const seg = stickerSeg[1]
  assert.ok(/绝对不要.*这不是我|这不是我.*绝对不要|不要.*说「这不是我」/.test(seg),
    '应明确禁止说「这不是我」')
})

ok('表情包分支要求「有字接梗」', () => {
  const seg = stickerSeg[1]
  assert.ok(/有字/.test(seg) && /把那个意思点出来|顺着那个梗/.test(seg))
})

ok('表情包分支要求「没字回表情」', () => {
  const seg = stickerSeg[1]
  assert.ok(/没字/.test(seg) && /\[表情包\]|\[表情:N\]/.test(seg))
})

ok('真图片分支仍保留「像不像你」', () => {
  assert.ok(imageSeg, '应存在「## 这条消息只有一张图」段')
  assert.ok(/像不像你/.test(imageSeg[1]), '真图片该保留判断')
})

ok('真图片分支禁止硬凑「勉强沾点边」', () => {
  assert.ok(/勉强沾点边/.test(imageSeg[1]))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)