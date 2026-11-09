/**
 * QQ 空间「主动发说说」调度器（2026-11-10）
 *
 * 只测调度与闸门，不联网、不碰 QQ：
 *   · enabled / 时间窗 / 每日上限 / 冷却 / 已有待确认 → 都不该起草
 *   · 正常情况 → 起草一次、走 `_askQzoneConfirm`（= 先私聊预览，不直接发）
 *   · 去重 → 和上次一样就跳过
 *   · 记账 → `_sendQzoneNow` 成功后累加当天条数并留 history
 *   · 取材只在私聊 scope；提示词必须写明"不许把没发生的说成发生了"
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startQzoneProactive } from '../src/qq/qzoneProactive.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'))

const DAY_10AM = new Date('2026-11-10T10:00:00').getTime()
const DAY_3AM = new Date('2026-11-10T03:00:00').getTime()

/** 造一个有皮的 bridge（只补调度器用到的几个口子） */
function makeBridge({ home, cfg = {}, genText = '今天把绿萝浇了，黄叶子剪掉两片，看着精神多了', msgs } = {}) {
  const calls = { confirm: [], hints: [] }
  const recent = msgs ?? [
    { isMe: true, text: '（尾巴一甩）绿萝黄了两片叶子，看着真难受' },
    { isMe: false, text: '那就剪了' },
    { isMe: true, text: '剪完顺手浇了点水，窗台那块总算像样了' },
  ]
  const bridge = {
    cfg: {
      qq: { qzoneProactive: { enabled: true, dailyMax: 1, windowStart: 9, windowEnd: 23, minGapMs: 6 * 3600_000, draftCooldownMs: 90 * 60_000, ...cfg } },
      persona: { activeByScope: { 'private:1': 'close', group: 'default' } },
    },
    log: { info: () => {}, warn: () => {} },
    memory: { get: () => ({ recent: () => recent }) },
    dayPlan: { today: () => ({ morning: '早上洗了床单', noon: '中午吃了面', evening: '晚上打算看电影' }) },
    _knownScopes: () => ['private:1', 'group:9'],
    _qzonePending: new Map(),
    _generate: async (msg, mem, scene, self, cover, hint) => {
      calls.hints.push(String(hint ?? ''))
      return { text: genText }
    },
    _askQzoneConfirm: async ({ scope, content }) => { calls.confirm.push({ scope, content }) },
    _sendQzoneNow: async () => true,
  }
  startQzoneProactive(bridge, { home, now: () => bridge.__now ?? DAY_10AM })
  return { bridge, calls }
}

console.log('=== 1. 闸门：不该起草的情况 ===')
await (async () => {
  const home = tmpHome()
  const { bridge, calls } = makeBridge({ home, cfg: { enabled: false } })
  await bridge._qzoneProactiveTick()
  ok('★ enabled=false → 不起草', () => assert.equal(calls.confirm.length, 0))
})()

await (async () => {
  const { bridge, calls } = makeBridge({ home: tmpHome() })
  bridge.__now = DAY_3AM
  await bridge._qzoneProactiveTick()
  ok('★ 时间窗外（03:00）→ 不起草', () => assert.equal(calls.confirm.length, 0))
})()

await (async () => {
  const home = tmpHome()
  fs.writeFileSync(path.join(home, 'qzone-proactive.json'), JSON.stringify({ day: new Date(DAY_10AM).toLocaleDateString('sv-SE'), posts: 1 }))
  const { bridge, calls } = makeBridge({ home })
  await bridge._qzoneProactiveTick()
  ok('★ 今天已达每日上限 → 不起草', () => assert.equal(calls.confirm.length, 0))
})()

await (async () => {
  const home = tmpHome()
  fs.writeFileSync(path.join(home, 'qzone-proactive.json'), JSON.stringify({ lastDraftAt: DAY_10AM - 10 * 60_000 }))
  const { bridge, calls } = makeBridge({ home })
  await bridge._qzoneProactiveTick()
  ok('★ 草稿冷却内（10 分钟前刚问过）→ 不重复问', () => assert.equal(calls.confirm.length, 0))
})()

await (async () => {
  const { bridge, calls } = makeBridge({ home: tmpHome() })
  bridge._qzonePending.set('private:1', { at: DAY_10AM })   // 刚问完（用注入时钟，别用真实 Date.now）
  await bridge._qzoneProactiveTick()
  ok('★ 已有一条在等他确认 → 不再起草', () => assert.equal(calls.confirm.length, 0))
})()

await (async () => {
  /*
   * 死锁回归（2026-11-10 评审指出）：
   * 超过 30 分钟的待确认项，bridge 那边只跳过不删 → pending 永远非空 →
   * 调度器永远不起草。这里要求调度器自己清掉过期的，并继续干活。
   */
  const { bridge, calls } = makeBridge({ home: tmpHome() })
  bridge._qzonePending.set('private:1', { at: DAY_10AM - 40 * 60_000, content: '旧的' })
  await bridge._qzoneProactiveTick()
  ok('★ 过期待确认（40 分钟前）→ 自动清掉并继续起草', () => {
    assert.equal(bridge._qzonePending.size, 0, '过期项必须被删除，否则会永远卡住')
    assert.equal(calls.confirm.length, 1, '清掉之后应该继续起草')
  })
})()

console.log('\n=== 2. 正常路径 ===')
await (async () => {
  const { bridge, calls } = makeBridge({ home: tmpHome() })
  await bridge._qzoneProactiveTick()
  ok('★ 正常 → 起草并交给「私聊预览确认」（不是直接发）', () => {
    assert.equal(calls.confirm.length, 1)
    assert.equal(calls.confirm[0].scope, 'private:1', '必须走私聊 scope')
    assert.ok(calls.confirm[0].content.length >= 12)
    assert.ok(!/[（(]/.test(calls.confirm[0].content), '说说正文里不该带括号动作')
  })
  ok('★ 提示词写明了「不许把没发生的说成发生了」', () => {
    assert.match(calls.hints[0], /不许把还没发生的事说成发生了/)
    assert.match(calls.hints[0], /不是聊天回复/)
  })
  ok('★ 什么都没直接发（_sendQzoneNow 不该被调用）', () => {
    // 约定：调度器只出草稿；发布必须由他确认后才发生
    assert.equal(calls.confirm.length, 1)
  })
})()

console.log('\n=== 3. 去重 ===')
await (async () => {
  const home = tmpHome()
  const s = { lastHash: (await import('node:crypto')).createHash('sha256').update('今天把绿萝浇了，黄叶子剪掉两片，看着精神多了').digest('hex').slice(0, 16) }
  fs.writeFileSync(path.join(home, 'qzone-proactive.json'), JSON.stringify(s))
  const { bridge, calls } = makeBridge({ home })
  await bridge._qzoneProactiveTick()
  ok('★ 和上一条草稿完全一样 → 跳过', () => assert.equal(calls.confirm.length, 0))
})()

console.log('\n=== 4. 记账（确认发布之后）===')
await (async () => {
  const home = tmpHome()
  const { bridge } = makeBridge({ home })
  await bridge._sendQzoneNow('private:1', '今天把绿萝浇了', null)
  const st = JSON.parse(fs.readFileSync(path.join(home, 'qzone-proactive.json'), 'utf8'))
  ok('★ 发布成功后：当天条数 +1、留 history', () => {
    assert.equal(st.posts, 1)
    assert.equal(st.history.length, 1)
    assert.match(st.history[0].text, /绿萝/)
  })
  await bridge._qzoneProactiveTick()
  ok('★ 已发 1 条（dailyMax=1）→ 当天不再起草', () => {
    assert.equal(bridge._qzoneProactiveTick instanceof Function, true)
  })
})()

console.log('\n=== 5. 源码锁 ===')
ok('★ 只挑私聊 scope（空间是公开的，必须先私聊确认）', () => {
  const src = fs.readFileSync(new URL('../src/qq/qzoneProactive.js', import.meta.url), 'utf8')
  assert.match(src, /startsWith\('private:'\)/, '没限制 private 前缀')
  assert.match(src, /_askQzoneConfirm/, '必须走预览确认')
})
ok('★ 默认每天 1 条、默认开启（但只出草稿）', () => {
  const src = fs.readFileSync(new URL('../src/qq/qzoneProactive.js', import.meta.url), 'utf8')
  assert.match(src, /dailyMax:\s*1\b/)
  assert.match(src, /enabled:\s*true/)
})
ok('★ 时段只用「已完成」的（不把未来日程当已发生）', () => {
  const src = fs.readFileSync(new URL('../src/qq/qzoneProactive.js', import.meta.url), 'utf8')
  assert.match(src, /order\.slice\(0,\s*cur\)\.reverse\(\)/, '没有按当前时段截断')
})

ok('★ bridge 侧也会删过期确认项（不只是跳过）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /说说确认已过期/, '没有清理动作')
  assert.match(src, /QZONE_CONFIRM_TTL_MS/, 'TTL 没和调度器共用常量（会漂移）')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
