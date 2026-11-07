/**
 * 说话风格要放在提示词**最末尾**（2026-11-07）。
 *
 * 现场：私聊里她几乎每条都带括号动作，而且全是「（耳朵一压）」「（耳朵一翘）」
 * 这种同一模板 —— 越看越像只会动耳朵。
 *
 * 两个原因：
 * ① 人格文件是提示词的**第一段**，离生成位置最远，写在里面的
 *    「日常别每条都带括号」几乎不起作用（16:06 加的规则，16:19 那条照样带）。
 * ② 短时记忆带着**她自己**最近 3 条回复，就在生成位置前面 ——
 *    她看见自己上一句「（耳朵一压）」就顺着写。
 *
 * 修法：把这段放到最末尾（紧贴生成位置），并把她最近用过的括号动作点名出来。
 * ⚠️ 只对 close 私聊开 —— 群里的声口一点不能动（用户原话：
 *    「感觉不用改，改了就死了，不活跃了」）。
 */
import assert from 'node:assert/strict'
import { PersonaStore } from '../src/persona/store.js'

const HOME = 'C:/Users/Null_zwei/.dsh/whale-pod'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const mk = () => new PersonaStore({
  home: HOME,
  active: 'default',
  activeByScope: { group: 'default', private: 'default', 'private:2129024700': 'close' },
})

const recentSelf = [
  '（耳朵一压）知道了，本鲸又不傻。',
  '（尾巴一歪）松了松了。',
  '少来这套。',
]

console.log('=== 1. close 私聊：末尾要有这段 ===')
const priv = mk().buildSystemPrompt({ scope: 'private:2129024700', recentSelf })
ok('★ 含「说话风格」段', () => {
  assert.ok(priv.includes('说话风格'), '没有这段')
})
ok('★ 它在末尾区域（越靠后约束力越强）', () => {
  const i = priv.indexOf('## 说话风格')
  assert.ok(i > priv.length * 0.8, `位置太靠前（${i}/${priv.length}）—— 越靠后约束力越强`)
  /*
   * ⚠️ 2026-11-07：它的后面又加了一段**全局**的「开口前过一遍」
   * （两个说话毛病，对所有角色生效）。所以"必须是最后一个标题"这条
   * 已经不再成立 —— 这里改成守"它仍在末尾 20%，且排在输出要求之后"。
   */
  const out = priv.indexOf('## 输出要求')
  assert.ok(i > out, '「说话风格」必须排在输出要求之后')
})
ok('★ 全局纠错段（开口前过一遍）在最后', () => {
  const k = priv.lastIndexOf('## ')
  const tail = priv.slice(k)
  assert.match(tail, /开口前过一遍/, `最后一个标题不是纠错段：${tail.slice(0, 40)}`)
  assert.match(tail, /别空转/, '缺"别空转"')
})
ok('★ 点名她最近用过的括号动作', () => {
  assert.match(priv, /耳朵一压/)
  assert.match(priv, /尾巴一歪/)
})
ok('★ 说清「别连着两条都带」和「别当起手式」', () => {
  assert.match(priv, /别连着两条都带/)
  assert.match(priv, /不要当起手式/)
})
ok('★ 提醒她不只有耳朵和尾巴', () => {
  assert.match(priv, /不只有耳朵和尾巴/)
})

console.log('\n=== 2. 群里不能有这段（声口不能动）===')
ok('★ group scope → 没有「说话风格」段', () => {
  const grp = mk().buildSystemPrompt({ scope: 'group:704291282', recentSelf })
  assert.ok(!grp.includes('说话风格'), '群里的声口被改了')
})
ok('普通私聊（default 角色）→ 也没有', () => {
  const p2 = mk().buildSystemPrompt({ scope: 'private:999999', recentSelf })
  assert.ok(!p2.includes('说话风格'), '不该影响别的私聊')
})

console.log('\n=== 3. 系统注解不算「动作」 ===')
ok('★ 对方发了个QQ表情… 这种注记不进黑名单', () => {
  const s = mk().buildSystemPrompt({
    scope: 'private:2129024700',
    recentSelf: ['（对方发了个QQ表情：流泪（id=5））嗯'],
  })
  assert.ok(!s.includes('别再用'), '系统注记被当成动作了')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
