/**
 * 「卫的日子记岔」—— 记忆里的时间必须是绝对日期（2026-11-07）。
 *
 * ## 现场
 * 用户：「还有就是卫的事，我不知道是她没表达清楚还是记不清日子」。
 *
 * 查 memory-long.json 的 history（最近三代摘要）：
 * ```
 * 【事】说定了：他明天下午打卫戍协议，本鲸蹲旁边当观众…
 * 【事】说定的事没变：他明天下午打卫戍协议…
 * 【事】说定的事没变：他明天下午打卫戍协议…这回本鲸把日子记岔成今天，被他点出来，当场认了。
 * ```
 * **「明天」连着被抄了三代** —— 每过一天它就指向另一天。
 * 事实库里同一件事还攒了 **14 份**（merge 每轮把旧【事】归档一遍）。
 *
 * ## 三个修法（本节各守一条）
 * ① SUMMARY_PROMPT：时间一律写绝对日期，禁止「明天/后天/昨天」；
 * ② `toPrompt()` 注入时带上「这段摘要写于哪天」，相对词她自己能换算；
 * ③ `addFacts` 近似去重 + `merge` 只在**话题真被换掉**时才归档。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LongTermStore, SUMMARY_PROMPT } from '../src/memory/long.js'
import { addFacts, configureFacts, factsFor } from '../src/memory/facts.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mtime-'))

console.log('=== 1. 提示词：时间写绝对日期 ===')
await ok('★ 【事】明禁「明天/后天/昨天」并要求写绝对日期', () => {
  const i = SUMMARY_PROMPT.indexOf('\n【事】\n')
  const seg = SUMMARY_PROMPT.slice(i, SUMMARY_PROMPT.indexOf('\n【我】\n', i + 1))
  assert.match(seg, /时间一律写绝对日期/, '缺绝对日期规则')
  assert.match(seg, /不许写「明天 \/ 后天 \/ 昨天/, '缺相对词禁令')
  assert.match(seg, /他明天下午打卫戍协议/, '缺这次真实的坏例子')
  assert.match(seg, /说定的事没变/, '缺「续命句式」禁令')
})
await ok('★ 【事实】也要绝对日期（事实库里躺过「明天有课」）', () => {
  const i = SUMMARY_PROMPT.indexOf('\n【事实】\n')
  const seg = SUMMARY_PROMPT.slice(i, SUMMARY_PROMPT.indexOf('\n【事】\n', i + 1))
  assert.match(seg, /时间也要写绝对日期/)
  assert.match(seg, /明天有课/)
})

console.log('\n=== 2. 注入时带上「写于哪天」 ===')
await ok('★ toPrompt 里有写入日期 + 换算提醒', () => {
  const store = new LongTermStore({ home: tmp(), cfg: { enabled: true } })
  const node = store.get('private:1')
  node.summary = '【事】\n他明天下午打卫戍协议'
  node.updatedAt = Date.now()
  const out = node.toPrompt()
  assert.match(out, /这段摘要写于/, '没带写入日期')
  assert.match(out, /都是\*\*那天的口径\*\*/, '没提醒相对词要换算')
})

console.log('\n=== 3. 近似去重（同一件事不许攒十几份）===')
const near = [
  '说定了：他明天下午打卫戍协议，本鲸蹲旁边当观众，他打完先回来找本鲸。',
  '说定的事没变：他明天下午打卫戍协议，本鲸蹲旁边当观众，打完他先回来找本鲸。',
  '说定的事没变：他明天下午打卫戍协议，本鲸蹲旁边当观众，打完他先回来找本鲸。这回本鲸把日子记岔成今天，被他点出来，当场认了。',
]
await ok('★ 三条近似只留一条，而且留信息最多的那条', () => {
  const home = tmp()
  configureFacts({ home })
  addFacts(near.map((t) => ({ text: t, scope: 'private' })))
  const left = factsFor('private:1', 50).filter((x) => /卫戍/.test(x.text))
  assert.equal(left.length, 1, `应该只留 1 条，实际 ${left.length} 条`)
  assert.ok(left[0].text.includes('日子记岔'), '留下的不是信息最多那条')
})
await ok('★ 不同的事不许被合并', () => {
  const home = tmp()
  configureFacts({ home })
  addFacts([
    { text: '他说白色吊带好看', scope: 'private' },
    { text: '他半夜常来缠，起了性致就不太收得住', scope: 'private' },
  ])
  assert.equal(factsFor('private:1', 50).length, 2)
})

console.log('\n=== 4. merge 只在话题真被换掉时才归档 ===')
await ok('★ 旧【事】和新【事】几乎一样 → 不归档（不再攒重复）', () => {
  const home = tmp()
  configureFacts({ home })
  const store = new LongTermStore({ home, cfg: { enabled: true } })
  const node = store.get('private:1')
  node.summary = '【人】\n2129024700 | A | 学生党\n\n【事】\n说定的事没变：他明天下午打卫戍协议，本鲸蹲旁边当观众，打完他先回来找本鲸。\n\n【我】\n我嘴硬。'
  node.merge('【事】\n说定了：他明天下午打卫戍协议，本鲸蹲旁边当观众，他打完先回来找本鲸。')
  const kept = factsFor('private:1', 50).filter((x) => /卫戍/.test(x.text))
  // 近似 → 最多 1 条（去重后），不该出现两份
  assert.ok(kept.length <= 1, `归档了重复：${kept.length} 条`)
})
await ok('★ 话题真的换了 → 旧【事】要留底', () => {
  const home = tmp()
  configureFacts({ home })
  const store = new LongTermStore({ home, cfg: { enabled: true } })
  const node = store.get('private:1')
  node.summary = '【人】\n2129024700 | A | 学生党\n\n【事】\n说定的事没变：他明天下午打卫戍协议，本鲸蹲旁边当观众，打完他先回来找本鲸。\n\n【我】\n我嘴硬。'
  node.merge('【事】\n他今天说宿舍断电了，晚上只能早点睡。')
  const kept = factsFor('private:1', 50).filter((x) => /卫戍/.test(x.text))
  assert.equal(kept.length, 1, '旧话题没被留底')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
