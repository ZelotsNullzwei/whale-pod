/**
 * 主动发言：不许把「已经交付的事」再答应一遍（2026-11-08）。
 *
 * ## 事故现场（私聊 private:2129024700）
 * ```
 * 15:09  他：拍张照我也看看（杯子）
 * 15:10  画图 → 14s 画好了
 * 15:11  她：「喏。」+ 图              ← 已经交付
 * 15:42  proactive：私聊安静够久了
 * 15:42  她：「（尾巴尖一翘）行吧，就给你看一眼。」  ← 同一件事又答应一遍
 * ```
 * 用户：「主动发言接话逻辑是不是有问题，还是老问题，前面提过的结束的时间又会被拿出来说」
 *
 * ## 根因
 * `speakHint` 把「共同回忆」排在第一位，而**没有任何地方告诉她"这件事已经办完了"**。
 * 短期记忆里最后一条是她自己 15:11 的「喏。」，于是她顺着"拍照"再答应一次。
 * 而 `_recentDrewHint` 只有 5 分钟窗口（防"刚拍完又问怎么拍"），管不到 31 分钟后。
 *
 * ## 这里锁住什么
 * 提示词里必须保留那条**「先过这一关：这件事是不是已经办完了」**的硬判据，
 * 以及小时级的「刚发过图」提醒。防止下次重构时被删掉。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

/** 取 `_speakUp` 里拼 hint 的那一段（到 hotHint 之前） */
const hintBlock = (() => {
  const start = src.indexOf('const speakHint = idle < FRESH_MS')
  assert.ok(start > 0, '找不到 speakHint 的拼装处')
  return src.slice(start, start + 4000)
})()

console.log('=== 主动发言：已交付的事不许再答应 ===')

ok('★ 有「先过这一关：这件事是不是已经办完了」的判据', () => {
  assert.match(hintBlock, /已经办完了|是不是.*办完/, '缺"是否已办完"的判断关')
})

ok('★ 明确"最后一条是你自己发的且已办完 → 那是迟到回复"', () => {
  assert.match(hintBlock, /迟到.*回复/, '缺"迟到回复"这句判据')
  assert.match(hintBlock, /最后一条/, '没给出可操作的检查对象（最后一条）')
})

ok('★ 「共同回忆」限定为"只挑还没结果的"', () => {
  assert.match(hintBlock, /共同回忆[^\n]*(还没结果|没有结果)/, '共同回忆没加"只挑没结果的"限定')
  assert.match(hintBlock, /已经有结果的就别提|已经有结果的就别提/, '没写明"有结果的别提"')
})

ok('★ 反面教材写进了事故原句（同一件事答应两次）', () => {
  assert.match(hintBlock, /就给你看一眼/, '缺事故原句，模型不知道具体长什么样')
  assert.match(hintBlock, /同一件事又答应一次|答应一遍/, '没点明"同一件事答应二次"这个错误')
})

ok('★ 有小时级的「刚发过图」提醒（不是只有 5 分钟那个）', () => {
  assert.match(src, /drewAgoMin/, '没有按分钟算的"刚发过图"变量')
  assert.match(src, /<= 90/, '窗口不是小时级（应为 90 分钟），管不到 31 分钟后的主动发言')
  assert.match(src, /才给他发过一张图/, '缺"刚发过图"的提示文案')
  assert.match(src, /绝对不要再提拍照|别再提拍照/, '没禁止再提拍照')
})

ok('★ 提醒只在主动发言分支里拼（不能污染普通回复）', () => {
  // drewNote 必须拼在 speakHint 的**长分支**里，而不是全局
  assert.match(hintBlock, /\$\{drewNote\}/, 'drewNote 没拼进 speakHint 的长分支')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
