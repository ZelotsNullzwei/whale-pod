/**
 * 表情标记**漏成文字**的回归测试（2026-11-03）。
 *
 * ## 现场（用户截图 + 群里的日志）
 * ```
 * 21:19:25 [我] group:704291282「活着呢，玩什么
 *
 *                                [表情]」
 * ```
 * 群里那条消息的整个内容就是一串方括号文字「[表情]」。
 *
 * ## 根因：两处口径不一致
 *
 * 1. `splitFaceMarkers` 的老正则只认 `[表情:数字]` 和 `[表情包[:名字]]`，
 *    **光板的 `[表情]` 匹配不到** → 整串被当普通文本发出去。
 *
 * 2. 更要紧的是：输入侧在 id 缺失时产出的占位标记**就是这个光板形式**
 *    （`onebot.js`：`return id ? `[表情:${id}]` : '[表情]'`），
 *    而 `describeMedia` 只改写 `[表情:数字]` —— 于是它**原样留在模型的
 *    对话记录里**，模型照抄进回复。她写这个形式是**学来的**，不是瞎编。
 *    （`[表情包]` 那一支名字是可选的，所以抄它不会漏；只有这一支会。）
 *
 * 所以这条测试锁两件事：**发送侧必须认这些写法**、**输入侧不能再把光板
 * 标记喂给模型**。
 *
 * ## 口径（别改错方向）
 * `[表情]` **不是"删掉了事"** —— 她写标记 = 她**想发个表情**，
 * 按"没名字的表情包"处理（随机一张收藏）才对。依据见 `_pickMface`
 * 注释里那句「从来没有'啥都不发'这一档」。
 */
import assert from 'node:assert/strict'
import { splitFaceMarkers, repairTruncatedMarkers, buildOutgoingSegments, describeMedia } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 切成好读的形态，方便断言。 */
const shape = (t) => splitFaceMarkers(t).map((p) => {
  if (p.kind === 'text') return `text(${JSON.stringify(p.text)})`
  if (p.kind === 'face') return `face(${p.id})`
  return `mface(${p.name})`
})

// ── ① 核心：光板 [表情] 不能再落到 text ────────────────────────
ok('[表情] → mface（空名字），不是 text —— 这就是截图里那个气泡', () => {
  const segs = splitFaceMarkers('[表情]')
  assert.equal(segs.length, 1, `实际 ${JSON.stringify(segs)}`)
  assert.equal(segs[0].kind, 'mface')
  assert.equal(segs[0].name, '', '空名字 = "随手发一张"，交给 _pickMface 随机')
})

ok('现场原句：正文 + 空行 + [表情] → 文字段 + mface 段', () => {
  assert.deepEqual(shape('活着呢，玩什么\n\n[表情]'), ['text("活着呢，玩什么\\n\\n")', 'mface()'])
})

ok('句中的 [表情] 也要认（不能只有整条消息是标记时才生效）', () => {
  assert.deepEqual(shape('好[表情]吗'), ['text("好")', 'mface()', 'text("吗")'])
})

// ── ② 老语义不能被改坏 ─────────────────────────────────────────
ok('[表情:数字] 仍然是"点名内置表情"（face 段，id 原样）', () => {
  assert.deepEqual(shape('[表情:4]'), ['face(4)'])
  assert.deepEqual(shape('哈[表情:20]哈'), ['text("哈")', 'face(20)', 'text("哈")'])
})

ok('[表情包] / [表情包:名字] 语义不变', () => {
  assert.deepEqual(shape('[表情包]'), ['mface()'])
  assert.deepEqual(shape('[表情包:猫猫]'), ['mface(猫猫)'])
})

// ── ③ 同类漏网（同一个坑的其他写法）────────────────────────────
ok('[表情:偷笑] → mface(偷笑)：先收藏按标签、再内置按名字', () => {
  assert.deepEqual(shape('[表情:偷笑]'), ['mface(偷笑)'])
})

ok('全角冒号也认（模型写中文标点是常态）', () => {
  assert.deepEqual(shape('[表情：偷笑]'), ['mface(偷笑)'])
  assert.deepEqual(shape('[表情包：猫猫]'), ['mface(猫猫)'])
  assert.deepEqual(shape('[表情：5]'), ['face(5)'])
})

ok('冒号后带空格也认', () => {
  assert.deepEqual(shape('[表情: 4]'), ['face(4)'])
  assert.deepEqual(shape('[表情: 偷笑 ]'), ['mface(偷笑)'])
})

// ── ④ 别把普通文字吃掉 ────────────────────────────────────────
ok('非标记的方括号照旧是文字', () => {
  assert.deepEqual(shape('方括号[随便]照旧'), ['text("方括号[随便]照旧")'])
  assert.deepEqual(shape('[表情符号]不是标记'), ['text("[表情符号]不是标记")'])
})

// ── ⑤ 截断修复：名字形式的 [表情: 也要补全 ────────────────────
ok('末尾截断 [表情:偷笑 → 补上右括号（原来会留一串方括号发出去）', () => {
  assert.equal(repairTruncatedMarkers('好的[表情:偷笑'), '好的[表情:偷笑]')
})

ok('截断修复的老行为不变', () => {
  assert.equal(repairTruncatedMarkers('好的[表情:4'), '好的[表情:4]')
  assert.equal(repairTruncatedMarkers('好的[表情包:猫猫'), '好的[表情包:猫猫]')
  assert.equal(repairTruncatedMarkers('好的[表情:'), '好的', '只有前缀、没有名字 → 删掉')
  assert.equal(repairTruncatedMarkers('好的['), '好的')
})

// ── ⑥ 端到端：发送段里不许再出现 "[表情" 这串字 ────────────────
ok('buildOutgoingSegments：现场原句产出 mface 段，且没有任何 "[表情" 文字', () => {
  const segs = buildOutgoingSegments('活着呢，玩什么\n\n[表情]')
  assert.deepEqual(segs.map((s) => s.kind), ['text', 'mface'])
  assert.ok(!JSON.stringify(segs).includes('[表情'), `标记漏进段里了：${JSON.stringify(segs)}`)
})

ok('buildOutgoingSegments：[表情:偷笑] 也走 mface（按名字挑）', () => {
  const segs = buildOutgoingSegments('[表情:偷笑]')
  assert.deepEqual(segs.map((s) => s.kind), ['mface'])
  assert.equal(segs[0].name, '偷笑')
})

// ── ⑦ 输入侧：不能再把光板标记喂给模型（它就是这么学会的）────
ok('describeMedia：光板 [表情] 被改写成说明，模型抄不到原样标记', () => {
  const t = describeMedia({ text: '[表情]' })
  assert.ok(!t.includes('[表情]'), `还是原样喂给模型了：${t}`)
  assert.ok(t.includes('QQ表情'), `应该说明这是QQ表情：${t}`)
})

ok('describeMedia：带 id 的老行为不变（仍然给名字）', () => {
  const t = describeMedia({ text: '[表情:5]' })
  assert.ok(t.includes('流泪'), `id=5 应该给出名字：${t}`)
  assert.ok(!t.includes('[表情:5]'))
})

ok('describeMedia：自己发的说「你」', () => {
  assert.ok(describeMedia({ text: '[表情]', isMe: true }).includes('你'))
  assert.ok(describeMedia({ text: '[表情]', isMe: false }).includes('对方'))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)