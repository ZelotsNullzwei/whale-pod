/**
 * 发完说说，她得知道自己发了什么（2026-11-08 用户：「她发空间她知道吗」「这一点也很重要」）。
 *
 * ## 现场
 * 动作说明原来只拼进她那句话（「…（发空间了）」）→ 记忆里只有个括号注，
 * **不知道发的内容**。结果：被问「你刚发了什么」答不上来，或者过一会儿又把同一件事说一遍。
 *
 * ## 守什么
 * ① 发说说成功后，往她的短期记忆里写一条**只进记忆、不发出**的记录
 * ② 记录里带正文（不是只写"发空间了"）
 * ③ 删说说也要留痕
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 源码锁：动作之后要写记忆 ===')
ok('★ 发说说成功后 mem.push 一条记录', () => {
  assert.match(SRC, /const said = \(marks\.items \?\? \[\]\)\.find\(\(x\) => x\.id === 'qzone'\)/,
    '没找到从标记里取说说正文的逻辑')
  assert.match(SRC, /mem\.push\(makeMessage\(\{[\s\S]{0,200}qzone-/, '没找到写记忆的调用')
})

ok('★ 记录里带正文，不是只写「发空间了」', () => {
  assert.match(SRC, /'（刚发了条说说：' \+ body/, '记录里没带正文')
})

ok('★ 带上「有没有图」', () => {
  assert.match(SRC, /withImg \? '｜带图' : '｜没图'/, '没标出带图/没图')
})

ok('★ 删说说也留痕', () => {
  assert.match(SRC, /'（把刚发的说说删了）'/, '删说说没留痕')
})

console.log('\n=== 2. 测试不能污染真实数据目录 ===')
ok('★ 隔离模块存在且是第一个 import', () => {
  const t = fs.readFileSync('D:/DSH WorkSpace/whale-pod/tests/check-qq-actions.mjs', 'utf8')
  const firstImport = t.split('\n').find((l) => l.trim().startsWith('import'))
  assert.match(String(firstImport), /_isolate-home/, '第一个 import 不是隔离模块')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
