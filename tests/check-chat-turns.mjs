/**
 * 多用几轮"他那几种说法"跑一遍（2026-11-08 用户：像我那样多聊一下）。
 * 只走判定层，不真调模型：
 *   · 缓图类（快拍/图呢/重新来/再试一次）→ 必须允许画
 *   · 普通聊天 → 不许乱画
 *   · 说说确认词（发吧/不发）→ 判断正确
 */
import assert from 'node:assert/strict'
import { classifyDrawIntent, QQBridge } from '../src/qq/bridge.js'

const ans = (t) => QQBridge.prototype._qzoneAnswer.call({}, t)

const turns = [
  { who: '他', text: '拍一张发过来', want: { draw: true } },
  { who: '他', text: '快拍', want: { draw: true } },
  { who: '他', text: '图呢', want: { draw: true } },
  { who: '他', text: '重新来呢', want: { draw: true } },
  { who: '他', text: '再试一次', want: { draw: true } },
  { who: '他', text: '你的图还没来', want: { draw: true } },
  { who: '他', text: '没图过来哦', want: { draw: true } },
  { who: '他', text: '看看腿', want: { draw: true } },
  { who: '他', text: '今天下课好晚', want: { draw: false } },
  { who: '他', text: '晚饭吃什么', want: { draw: false } },
  { who: '他', text: '我看看书', want: { draw: false } },
  { who: '他', text: '这个纪录片挺有意思', want: { draw: false } },
]

let pass = 0
let fail = 0
console.log('=== 他那几种说法 → 该不该画 ===')
for (const t of turns) {
  const got = classifyDrawIntent(t.text).wantsPic
  const ok = got === t.want.draw
  console.log(`  ${ok ? 'OK ' : 'XX '} ${t.text.padEnd(14)} draw=${got}`)
  ok ? pass++ : fail++
}

console.log('\n=== 说说确认词 ===')
for (const [text, want] of [
  ['发吧', 'yes'], ['行', 'yes'], ['嗯', 'yes'], ['发出去', 'yes'], ['就这个', 'yes'],
  ['不发', 'no'], ['不行', 'no'], ['换一张', 'no'], ['算了', 'no'], ['别发', 'no'],
  ['这个纪录片讲深海的，挺好看', null],
]) {
  const got = ans(text)
  const ok = got === want
  console.log(`  ${ok ? 'OK ' : 'XX '} ${text.padEnd(14)} => ${got}`)
  ok ? pass++ : fail++
}

console.log('\n=== 多轮串联（说说 → 确认 → 发）===')
let pending = null
const flow = [
  ['他', '发个说说吧'],
  ['她', '[说说:今天在客厅看纪录片，鱼缸那片蓝把屋子照亮了]'],
  ['他', '？'],
  ['她', '图先给你看看，这张发空间行吗？'],
  ['他', '发吧'],
]
for (const [who, text] of flow) {
  if (who === '她' && text.startsWith('[说说:')) {
    pending = { content: text.slice(5, -1) }
    console.log('  · 摘下游说 → pending，等确认（不发）')
    continue
  }
  if (who === '他') {
    const a = ans(text)
    if (pending && a === 'yes') { console.log('  · 他确认 → 真发'); pending = null; continue }
    if (pending && a === 'no') { console.log('  · 他否决 → 丢弃'); pending = null; continue }
    console.log(`  · 他「${text}」→ 正常聊天${pending ? '（pending 仍在）' : ''}`)
  }
}
if (pending === null) { console.log('  OK  流程走完，pending 已清'); pass++ }
else { console.log('  XX  pending 没清掉'); fail++ }

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
