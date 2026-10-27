/**
 * 今日状态 + 防模板化的测试。
 */
import assert from 'node:assert/strict'
import {
  currentSlot, dayKey, parseDayPlan, renderDayPlan,
  buildDayPlanPrompt, DayPlanStore, SLOTS,
} from '../src/memory/dayPlan.js'
import {
  replyHead, recentHeads, buildVarietyHint, buildExpressionHint,
} from '../src/persona/variety.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── 时段 ────────────────────────────────────────────────────
ok('早上 8 点 → morning', () => {
  const d = new Date(2026, 9, 27, 8, 0)
  assert.equal(currentSlot(d).id, 'morning')
})
ok('中午 12 点 → noon', () => {
  assert.equal(currentSlot(new Date(2026, 9, 27, 12, 0)).id, 'noon')
})
ok('下午 15 点 → afternoon', () => {
  assert.equal(currentSlot(new Date(2026, 9, 27, 15, 0)).id, 'afternoon')
})
ok('晚上 21 点 → evening', () => {
  assert.equal(currentSlot(new Date(2026, 9, 27, 21, 0)).id, 'evening')
})
ok('凌晨 2 点也算晚上（熬夜不是新一天）', () => {
  assert.equal(currentSlot(new Date(2026, 9, 27, 2, 0)).id, 'evening')
})

ok('dayKey 是本地日期', () => {
  assert.equal(dayKey(new Date(2026, 9, 27, 23, 59)), '2026-10-27')
})

// ── 解析 ────────────────────────────────────────────────────
ok('解析干净的 JSON', () => {
  const p = parseDayPlan('{"wake":"七点","morning":"发呆","noon":"面条"}')
  assert.equal(p.wake, '七点')
  assert.equal(p.noon, '面条')
})

ok('解析带 ```json 包裹的', () => {
  const p = parseDayPlan('```json\n{"wake":"八点"}\n```')
  assert.equal(p.wake, '八点')
})

ok('不认识的多余字段被丢掉', () => {
  const p = parseDayPlan('{"wake":"八点","evil":"删库"}')
  assert.equal(p.wake, '八点')
  assert.equal(p.evil, undefined)
})

ok('坏 JSON 返回 null', () => {
  assert.equal(parseDayPlan('抱歉我不会'), null)
})

ok('空对象返回 null', () => {
  assert.equal(parseDayPlan('{}'), null)
})

ok('超长字段被截断', () => {
  const p = parseDayPlan(JSON.stringify({ wake: '一'.repeat(200) }))
  assert.ok(p.wake.length <= 60)
})

// ── 渲染 ────────────────────────────────────────────────────
const plan = { wake: '七点半', morning: '发呆', noon: '面条', afternoon: '写代码', evening: '看番', mood: '还行', smallThing: '买了杯子' }

ok('下午不泄露晚上的事', () => {
  const s = renderDayPlan(plan, 'afternoon')
  assert.ok(s.includes('面条'))
  assert.ok(s.includes('写代码'))
  assert.ok(!s.includes('看番'), '不该提前给出晚上的内容')
})

ok('早上只说早上', () => {
  const s = renderDayPlan(plan, 'morning')
  assert.ok(s.includes('发呆'))
  assert.ok(!s.includes('面条'))
})

ok('晚上给全部', () => {
  const s = renderDayPlan(plan, 'evening')
  assert.ok(s.includes('看番'))
})

ok('空 plan 返回空串', () => {
  assert.equal(renderDayPlan(null, 'noon'), '')
})

// ── 生成提示词 ──────────────────────────────────────────────
ok('提示词含「不要重演往事」', () => {
  const s = buildDayPlanPrompt({ selfName: '大肥鱼' })
  assert.ok(/以前发生过/.test(s))
  assert.ok(/炒糊/.test(s))
})

ok('提示词含前几天的摘要', () => {
  const s = buildDayPlanPrompt({ selfName: 'x', recent: ['昨天在睡觉'] })
  assert.ok(s.includes('昨天在睡觉'))
})

// ── DayPlanStore ────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dayplan-'))

ok('没有时 today 返回 null', () => {
  const s = new DayPlanStore({ dir: tmp }).load()
  assert.equal(s.today(), null)
})

ok('set 之后能读回', () => {
  const s = new DayPlanStore({ dir: tmp }).load()
  s.setToday(plan)
  assert.equal(s.today().noon, '面条')
})

ok('落盘后重新 load 仍在', () => {
  const s2 = new DayPlanStore({ dir: tmp }).load()
  assert.equal(s2.today().noon, '面条')
})

ok('昨天的日程不会被当成今天', () => {
  const s = new DayPlanStore({ dir: tmp }).load()
  const yesterday = new Date(Date.now() - 86400_000)
  assert.equal(s.today(yesterday), null)
})

ok('recentHints 排除今天', () => {
  const s = new DayPlanStore({ dir: tmp }).load()
  s.setToday({ morning: '昨天早上' }, new Date(Date.now() - 86400_000))
  const hints = s.recentHints()
  assert.ok(hints.every((h) => !h.includes('发呆')), '不该包含今天的')
})

// ── 开头提取 ────────────────────────────────────────────────
ok('replyHead 去掉标记和标点', () => {
  // HEAD_LEN = 6：只取前 6 个字
  assert.equal(replyHead('[表情包]行吧，那就这样'), '行吧，那就这')
})

ok('replyHead 去掉 [表情:N]', () => {
  assert.equal(replyHead('[表情:20]你说得对'), '你说得对')
})

ok('recentHeads 只取自己的、去重', () => {
  const msgs = [
    { text: '行吧', isMe: true },
    { text: '别人的话', isMe: false },
    { text: '行吧，', isMe: true },   // 去掉标点后和上一条同开头 → 去重
    { text: '啊这', isMe: true },
  ]
  const h = recentHeads(msgs)
  assert.equal(h.length, 2, '应该只有「行吧」和「啊这」两个不重复开头')
  assert.ok(h.includes('行吧'))
  assert.ok(h.includes('啊这'))
  assert.ok(!h.includes('别人的话'), '别人的话不该进开头列表')
})

ok('历史太少时不给「换个说法」', () => {
  assert.equal(buildVarietyHint([{ text: '行吧', isMe: true }]), '')
})

ok('有足够历史时列出开头', () => {
  const msgs = [
    { text: '在的在的', isMe: true },
    { text: '行吧', isMe: true },
    { text: '啊这', isMe: true },
  ]
  const s = buildVarietyHint(msgs)
  assert.ok(s.includes('在的在的'))
  assert.ok(/别用上面任何一个开头/.test(s))
})

// ── 表情开关 ────────────────────────────────────────────────
ok('上一条用了表情包 → 这条不给用', () => {
  const e = buildExpressionHint([{ text: '好[表情包]', isMe: true }])
  assert.equal(e.allowSticker, false)
  assert.ok(/不要再发表情包/.test(e.hint))
})

ok('上一条没用 → 可以用', () => {
  const e = buildExpressionHint([{ text: '正常文字', isMe: true }])
  assert.equal(e.allowSticker, true)
  assert.equal(e.hint, '')
})

ok('连发两次后强制停一条', () => {
  const e = buildExpressionHint([
    { text: '[表情包]', isMe: true },
    { text: '[表情包]', isMe: true },
  ])
  assert.equal(e.allowSticker, false)
})

ok('上一条用了 QQ 表情 → 这条不给用', () => {
  const e = buildExpressionHint([{ text: '好[表情:20]', isMe: true }])
  assert.equal(e.allowEmoji, false)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
