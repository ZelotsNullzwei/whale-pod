/**
 * 场景图（`[场景图:…]`）必须**画面里没有人**（2026-11-08）。
 *
 * ## 现场
 * 用户：「我问她要了，还是有人」—— 要"看到喜欢的杯子"，出来的是她站在厨房洗碗。
 *
 * ## 两个真实原因（都已修）
 * ① `refImage` 还是传了 → `/v1/images/edits` 把参考图当构图基线，提示词说"没人"也没用
 * ② 提示词里**自相矛盾**：一边写「画面里没有人」，一边又有
 *    「她本人基本不在画面里（只出现手/手臂/腿）」和「画面里只有她一个人」——
 *    模型听后者
 *
 * 这个测试守的是 ②：场景图提示词里不许再出现"可以把人画进来"的句子。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planShot } from '../src/photo/index.js'

const HOME = 'C:/Users/Null_zwei/.dsh/whale-pod'
const imageCfg = JSON.parse(fs.readFileSync(`${HOME}/config.json`, 'utf8')).qq?.image ?? {}

const scene = planShot({
  scene: '桌上那个带小蓝点的玻璃杯，暖光斜照',
  slot: 'noon',
  scope: 'test:scene-only',
  sceneOnly: true,
  mode: 'daily',
  imageCfg,
})
const withPerson = planShot({
  scene: '刚洗完澡，头发还湿着',
  slot: 'noon',
  scope: 'test:person',
  sceneOnly: false,
  mode: 'daily',
  imageCfg,
})

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 场景图：不许有人 ===')
ok('★ 明确写了「画面里没有人」', () => {
  assert.match(String(scene.prompt), /画面里没有人/)
})
ok('★ 没有「只出现手/手臂/腿」这种放行句', () => {
  assert.doesNotMatch(String(scene.prompt), /只出现手\/手臂\/腿/)
})
ok('★ 没有「画面里只有她」这种矛盾句', () => {
  assert.doesNotMatch(String(scene.prompt), /画面里只有她/)
})
ok('★ 禁止项改成「画面里出现任何人物」', () => {
  assert.match(String(scene.prompt), /画面里出现任何人物/)
})

console.log('\n=== 2. 普通照片：该有的人还在 ===')
ok('★ 普通照仍允许"她本人"', () => {
  assert.doesNotMatch(String(withPerson.prompt), /画面里没有人/)
})
ok('★ 普通照仍写清楚长相（避免画成路人）', () => {
  assert.match(String(withPerson.prompt), /蓝色长卷发|蓝发/)
})

console.log('\n=== 3. 参考图 ===')
ok('★ 场景图不带参考图（bridge 里判 hitScene / 环境照）', () => {
  const b = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
  assert.match(b, /hitScene \|\| shot\.framingInfo\?\.framing === '环境照'/)
  assert.match(b, /useRefPath = null/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
