/**
 * 时间注记 / 空注记的泄漏（2026-11-04 傍晚）。
 *
 * ## 现场（私聊，一天里至少 6 次）
 * ```
 * 10:18:08 （4 秒后）（愣了一下，倒也没接着追）行，不想就不想。
 * 10:19:30 （4 秒后）没一直改？从榨到不榨…
 * 10:20:10 （5 秒后）嗯，早上又深喉了。
 * 10:21:26 （（3 秒后）行吧，你不在，那我真自己来了）
 * 16:59:41 （-）上瘾怎么了，好东西当然得多说几遍。
 * 17:23:52 （+? 秒）那不就得了，LYFan也这么讲…
 * 17:37:57 （+? 秒）醒醒，五点三十六了，十分钟到了。
 * ```
 * 这些括号是 `buildChatMessages` 给每条历史加的时间戳（让她知道两条隔了多久），
 * 她照着念了。前几种以前修过；`（+? 秒）`（没算出来的时间写成 ?）和
 * `（-）`（空注记）是这次新撞到的形态。
 *
 * ## 这条测试守两件事
 * ① 上面 7 种真实形态都要剥干净
 * ② **别误伤台词**：`（笑）`「（2 天没睡了）」这类正常括号必须留着
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanModelText } from '../src/qq/bridge.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const clean = (s) => cleanModelText(s)

console.log('=== 1. 日志里的真实漏出形态 ===')
ok('（4 秒后）前缀 → 剥掉，保留台词', () => {
  assert.equal(clean('（4 秒后）（愣了一下，倒也没接着追）行，不想就不想。'), '（愣了一下，倒也没接着追）行，不想就不想。')
})

ok('（5 秒后）前缀 → 剥掉', () => {
  assert.equal(clean('（5 秒后）嗯，早上又深喉了。'), '嗯，早上又深喉了。')
})

ok('★ 嵌套：（（3 秒后）台词）→ 只留台词', () => {
  assert.equal(clean('（（3 秒后）行吧，你不在，那我真自己来了）'), '行吧，你不在，那我真自己来了')
})

ok('★（+? 秒）—— 没算出来的时间写成问号', () => {
  assert.equal(clean('（+? 秒）那不就得了，LYFan也这么讲。'), '那不就得了，LYFan也这么讲。')
})

ok('★（-）—— 空注记', () => {
  assert.equal(clean('（-）上瘾怎么了，好东西当然得多说几遍。'), '上瘾怎么了，好东西当然得多说几遍。')
})

ok('（+几秒）/（半秒）也要剥（老形态回归）', () => {
  assert.equal(clean('（+几秒）这条本鱼手上什么都没有'), '这条本鱼手上什么都没有')
})

console.log('=== 2. 不能误伤 ===')
ok('（笑）是表演提示，必须留', () => {
  assert.equal(clean('（笑）我不是大肥鱼'), '（笑）我不是大肥鱼')
})

ok('句中的（3 分钟）是正文，不能动', () => {
  assert.equal(clean('我等了（3 分钟）就走了'), '我等了（3 分钟）就走了')
})

ok('（2 天没睡了）括号里还有字 → 不是时间注，保留', () => {
  const out = clean('（2 天没睡了）困死了')
  assert.match(out, /困死了/, `实际：${out}`)
})

ok('没有注记的普通句子原样返回', () => {
  assert.equal(clean('行，那我睡了。'), '行，那我睡了。')
})

console.log('=== 3. 记忆里不能留已经剥掉的标记（源码锁） ===')
//
// 现场：3 条她自己的消息在 memory-short.json 里带着 `[等:10]` —— 用户看不到
// （_send 剥了），但记忆写的是剥之前的 text，模型下一轮照样看得见、继续模仿。
ok('_send 把剥完的正文挂到 msg 上，写记忆时用它', () => {
  const src = fs.readFileSync(path.join(root, 'src/qq/bridge.js'), 'utf8')
  assert.match(src, /msg\.__sentText = text/, '没挂 __sentText')
  assert.match(src, /text: msg\.__sentText \?\? text/, '回复路径写记忆没用剥完的那份')
  assert.match(src, /text: full\.__sentText \?\? clean/, '主动发言路径写记忆没用剥完的那份')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)