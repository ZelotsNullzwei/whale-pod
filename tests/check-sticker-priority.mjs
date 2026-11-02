/**
 * 挑表情的**优先级**（2026-11-02 修）。
 *
 * ## 现场（群里，实测）
 * ```
 * 07:44:14  群友「有收藏表情怎么又在用qq表情」
 * 07:44:25  表情「无语」→ 精确匹配「无语」(face 40)   ← 又发了个 QQ 内置
 * 07:45:45  表情「震惊」→ 精确匹配「震惊」(face 26)   ← 同上
 * 07:47:30  表情「疑惑」→ 按标签命中 …               ← 这次才是她收藏的
 * ```
 * 「无语」「震惊」「疑惑」这类词**既在 QQ 内置表的别名里**
 * （无语→擦汗 id40、震惊→惊恐 id26），**也是收藏表情的标签**。
 *
 * ## 原来的顺序（错的）
 * ```
 * ① 配置映射 → ② QQ 内置表情表 → ③ 收藏表情
 * ```
 * 第 ② 步先跑就永远轮不到收藏库 —— 她收了一堆收藏表情，
 * 发出来的还是 QQ 那套。这正是群友那句话的意思。
 *
 * ## 现在的顺序
 * ```
 * ① 配置映射 → ② 收藏表情按标签 → ③ QQ 内置表情表 → ④ 收藏表情随机
 * ```
 * 依据：提示词里给她的清单就是**她自己库里的标签**，
 * 所以 `[表情包:哭]` 的语义是"从我的库里挑一张像'哭'的"，
 * 不是"找一个叫'哭'的 QQ 表情"。
 *
 * ⚠️ `[表情:N]`（按**编号**指定 QQ 表情）走的是另一条路（splitFaceMarkers），
 *    不受这个顺序影响 —— 那条路仍然直接发内置表情。
 *
 * ## 为什么必须锁住
 * "先查内置表"看起来更稳（内置表一定命中），很容易被当成无害的优化改回去。
 * 但那是**拿用户的收藏换了一个确定命中** —— 行为上就是"她发不出自己的表情"。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

/*
 *
 * 第一版写的是 `src.slice(at, at + 1600)` —— 固定 1600 字窗口。
 * 而 `_pickMface` 前面正好有一段很长的说明注释，`findByTag` 被挤出窗口，
 * 于是断言报"要按标签查收藏表情"这种**听着像功能坏了、其实是量错地方**的错。
 * 这跟 `check-voice` 那个「固定 1200 字窗口被注释挤爆」是同一个毛病。
 *
 * 改成切到**这个方法的收尾**（下一个顶格两空格的 `}`）。
 */
const fnBody = () => {
  const at = src.indexOf('async _pickMface(')
  assert.ok(at > 0, '要有 _pickMface')
  const end = src.indexOf('\n  }\n', at)
  return src.slice(at, end > at ? end : at + 6000)
}

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

ok('★★ 收藏表情按标签要排在 QQ 内置表**之前**', () => {
  const body = fnBody()
  const iTag = body.indexOf('findByTag')
  const iLookup = body.indexOf('lookupFace(')
  assert.ok(iTag > 0, '要按标签查收藏表情（findByTag）')
  assert.ok(iLookup > 0, '要有 QQ 内置表查询（lookupFace）')
  assert.ok(
    iTag < iLookup,
    '按标签查收藏表情必须在 lookupFace **前面** —— 否则「无语/震惊」这类'
    + '既在内置别名里又是收藏标签的词，永远只会出 QQ 内置表情（用户报的就是这个）',
  )
})

ok('★ 收藏表情的取用要在 lookupFace 之前（别取两次）', () => {
  const body = fnBody()
  const n = (body.match(/await this\._customFaces\(\)/g) ?? []).length
  assert.equal(n, 1, `_customFaces() 只该调一次（实际 ${n} 次）—— 调两次会多打一次接口`)
})

ok('★ 配置映射仍然是最高优先级（用户显式指定最大）', () => {
  const body = fnBody()
  const iMap = body.indexOf('mfaceMap')
  const iTag = body.indexOf('findByTag')
  assert.ok(iMap > 0 && iTag > 0, '两者都要在')
  assert.ok(iMap < iTag, 'mfaceMap（配置里手写的映射）必须最优先')
})

ok('⚠️ 源码锁：说明里要写清"为什么换顺序"，否则后人会改回去', () => {
  const at = src.indexOf('async _pickMface(')
  const body = src.slice(Math.max(0, at - 1200), at + 1600)
  assert.match(body, /收藏表情怎么又在用qq表情|又在用 ?qq ?表情/, '要留下那句用户/群友的原话作为依据')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)