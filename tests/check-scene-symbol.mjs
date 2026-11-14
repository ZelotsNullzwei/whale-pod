/**
 * 场景内符号兜底 `_ensureSceneSymbol`（2026-11-10）
 *
 * ## 两次事故
 * 1. `13:34:01 「嗯，窝着。／又没别的事，不窝着干嘛♡」` —— 日常聊天凭空多一个 ♡。
 *    原因：判定词里有 `[嗯哈啊唔]`，把普通应答「嗯」当"声音描写"。
 * 2. 去掉语气词后仍会误触：判定用的是**环境词**（被子/躺着/睡觉…），
 *    日常「我躺会儿」「进被窝了」还是会被补 ♡。
 *
 * ## 用户口径
 * 「限定成**做的时候**才触发不就好了，日常完全不用。」
 *
 * ## 现在的规则
 * - 上下文里必须出现**明确的行为动作**（顶到/插/舔/揉/自己动/高潮…）才算"在做"
 * - 光有环境/体位词（被子/躺着/睡觉/抱/贴）一律不算 → 日常完全不触发
 * - 正文要有真的身体/声音描写（呼吸/喘/哑/颤/抖/腰/腿/湿/敏感）
 * - 已有 ♡/🖤 不重复
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const b = Object.create(QQBridge.prototype)
const sym = (t, ctx) => b._ensureSceneSymbol(t, ctx)

const DOING = '顶到里面 自己做的时候 不要停'
const DAILY = '在床上 被子 躺着 睡觉 抱着'

console.log('=== 1. 日常完全不触发 ===')
ok('★ 事故原句：日常 + 场景环境词 → 不补', () => {
  const t = '嗯，窝着。\n\n又没别的事，不窝着干嘛'
  assert.equal(sym(t, DAILY), t)
})
ok('★「我躺会儿」「进被窝了」「早点睡觉」→ 不补', () => {
  for (const t of ['我躺会儿', '进被窝了', '早点睡觉', '抱着你睡会儿', '贴着你躺下']) {
    assert.equal(sym(t, DAILY), t, `${t} 不该补`)
  }
})
ok('★ 身体描写但上下文只是日常 → 也不补', () => {
  for (const t of ['（腿根紧了一下）', '呼吸乱了', '腰有点酸']) {
    assert.equal(sym(t, DAILY), t, `${t} 在日常上下文里不该补`)
  }
})

console.log('\n=== 2. 真在做的时候才补 ===')
ok('★「（腿根紧了一下）嗯……」+ 在做 → 补一个 ♡', () => {
  assert.equal(sym('（腿根紧了一下）嗯……', DOING), '（腿根紧了一下）嗯……♡')
})
ok('★「呼吸乱了」+ 在做 → 补', () => {
  assert.equal(sym('呼吸乱了', DOING), '呼吸乱了♡')
})
ok('★ 只有语气词 + 在做 → 也不补（正文得是描写）', () => {
  for (const t of ['嗯……', '哈啊', '唔']) assert.equal(sym(t, DOING), t, `${t} 不该补`)
})

console.log('\n=== 3. 边界 ===')
ok('已有 ♡ / 🖤 不重复补', () => {
  for (const t of ['腰都软了♡', '呼吸乱了🖤']) assert.equal(sym(t, DOING), t)
})
ok('空串 → 原样', () => {
  assert.equal(sym('', DOING), '')
})

console.log('\n=== 4. 源码锁 ===')
ok('★ 判定里不许出现语气词 [嗯哈啊唔]', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const codeLines = src.split(/\r?\n/).filter((l) => /^\s*(const doing|if \(\/)/.test(l))
  const bad = codeLines.find((l) => l.includes('嗯哈啊唔'))
  assert.equal(bad, undefined, `判定行里还有语气词：${bad}`)
})
ok('★ 不许再用"环境词"判定场景（被子/躺着/睡觉/抱着）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const i = src.indexOf('const doing =')
  assert.ok(i > 0, '找不到 doing 判定')
  const line = src.slice(i, src.indexOf('\n', i))
  for (const w of ['被子', '躺着', '睡觉', '抱着']) {
    assert.ok(!line.includes(w), `doing 判定里还有环境词「${w}」`)
  }
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
