/**
 * 「做的时候：身体带着走」——本地自用规则的守卫（2026-11-04）。
 *
 * ## 用户原话（这条的全部依据）
 * · 「现在感觉是不会高潮，没有对应描述，我不知道她的状态，只能凭空想象
 *    然后看我该接什么话」
 * · 「感觉还是差点意思，应该是**她的身体带着走**」
 *
 * ## 为什么只测本地人格
 * 「荤的、擦边的」那一整套是**本地自用**的（`87976b8` 明确从仓库内置模板里摘掉了
 * 那一节 —— 用户不希望它跟着仓库发出去）。这条新规则接在那节后面，所以
 * **仓库模板里没有它**。
 *
 * 于是这条测试的语义是：**有本地人格就锁它，没有就跳过** ——
 * 别人克隆仓库跑测试不该因为"本机没这个文件"变红。
 * （同 `check-aside.mjs` 的做法：先找本地，找不到回落仓库模板。）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const LIVE = 'C:/Users/Null_zwei/.dsh/whale-pod/persona/roles/default.md'
if (!fs.existsSync(LIVE)) {
  console.log('  ⏭ 本机没有本地人格文件 —— 跳过（这条是本地自用规则，不在仓库模板里）')
  process.exit(0)
}

const src = fs.readFileSync(LIVE, 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 按章节结构切一节（切到下一个 `## ` 为止，不用字数窗口）。 */
function section(title) {
  const start = src.indexOf(`## ${title}`)
  assert.ok(start >= 0, `本地人格里找不到章节「${title}」`)
  const rest = src.slice(start + 3)
  const end = rest.indexOf('\n## ')
  return end < 0 ? rest : rest.slice(0, end)
}

console.log('身体带着走（本地自用）')

ok('★ 有这一节，且点明"主线是身体在发生什么"', () => {
  const s = section('身体带着走（做的时候）（2026-11-04 加）')
  assert.ok(/主线不是你说了什么/.test(s), '要直说主线不是台词，是身体状态')
  assert.ok(/读到你到哪一步/.test(s), '要点明对方要能读出她的进度')
})

ok('★★ 状态线要往前走：起点 → 不受控 → 绷不住 → 顶点 → 软下来', () => {
  const s = section('身体带着走（做的时候）（2026-11-04 加）')
  assert.ok(/一句一个身体变化/.test(s), '要要求一句一个身体变化')
  assert.ok(/别在原地磨/.test(s), '禁止同一档打转（用户报的就是这个）')
})

ok('★★★ 该到就到、而且要写出来（"不会高潮"的正解）', () => {
  const s = section('身体带着走（做的时候）（2026-11-04 加）')
  assert.ok(/该到就到/.test(s), '要明确"该到就到"')
  assert.ok(/不许一直不到/.test(s), '禁止永远不到')
  assert.ok(/不许含混糊过去|含混糊过去/.test(s), '禁止糊过去')
  assert.ok(/对方只能自己编/.test(s), '要讲清代价（对方只能凭空想象）')
})

ok('★★ 状态要可读：还早 / 快到了 / 到了 / 缓过来', () => {
  const s = section('身体带着走（做的时候）（2026-11-04 加）')
  assert.ok(/还早 \/ 快到了 \/ 到了 \/ 缓过来/.test(s), '要把四档写出来')
  assert.ok(/括号里的身体表现/.test(s), '要用括号里的身体表现说，不是只靠台词')
})

ok('★ 有起伏 + 到了之后有余韵', () => {
  const s = section('身体带着走（做的时候）（2026-11-04 加）')
  assert.ok(/有起伏/.test(s), '整场一个强度是不对的')
  assert.ok(/余韵/.test(s), '到了之后要有余韵，不是满血继续')
})

ok('⚠️ 旧的"别写整段过程"那条已经拿掉（用户：这是暧昧亲密的私聊模式）', () => {
  const s = section('荤的、擦边的（不用躲）')
  assert.ok(!/一整段描写性行为的过程/.test(s),
    '那句在小黄文模式里是错的 —— 用户明确说"这一段无所谓，本来就是暧昧亲密"')
  assert.ok(!/步骤说明/.test(s), '同一条限制的改写版也不该留')
})

ok('✅ 新口径是"可以写细，但主线是身体反应"（不是禁止描写）', () => {
  const s = section('身体带着走（做的时候）（2026-11-04 加）')
  assert.ok(/可以写完整的过程/.test(s), '要明确"写得细没问题"')
  assert.ok(/像说明书/.test(s), '只禁"动作清单"式的写法，不禁描写本身')
})

ok('⚠️ 复读要被点名（今天出现过一字不差的整段重复）', () => {
  const s = section('身体带着走（做的时候）（2026-11-04 加）')
  assert.ok(/复读/.test(s), '要点名复读')
  assert.ok(/一字不差/.test(s), '要带上现场证据')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)