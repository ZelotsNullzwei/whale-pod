/**
 * 免费热点源（贴吧 / B站）的回归测试（2026-10-29）。
 *
 * ## 为什么用免费源
 * 付费搜索按次收费（当时余额 ¥0.86）。实测公开接口：
 * ```
 * 贴吧热议  ✅ 200  103ms  30 条   影之刃零真香 / 表情包大赛32强
 * B站热门   ✅ 200  200ms  20 条   （同一天稍后又 403 —— 会限流）
 * 头条热榜  ✅ 200  186ms  50 条   中共中央30日上午举行新闻发布会 ← 不能用
 * ```
 *
 * ## 三条硬规矩（本文件锁的就是这三条）
 * 1. **时政/灾难/案件必须被黑名单挡掉** —— 头条第一条就是时政，进群聊是事故
 * 2. **挂不上钩就什么都不注入** —— 热点是"接话的料"，不是"开口的理由"，
 *    否则它变成转发新闻的机器人
 * 3. **跨天作废** —— 热点隔夜就是旧闻
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  fetchHotTopics, filterTopics, pickRelevant, todayKey, HotTopicStore,
} from '../src/qq/hot-topics.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── ① 黑名单 ──────────────────────────────────────────────
ok('时政 / 军事 / 灾难 / 案件 全部挡掉', () => {
  const banned = [
    '中共中央30日上午举行新闻发布会',
    '国防部回应美方军事演习',
    '某地发生地震，已致多人遇难',
    '男子坠楼身亡，警方通报',
    '台湾地区选举结果公布',
    '俄乌停火谈判最新进展',
  ]
  for (const t of banned) {
    const out = filterTopics([{ title: t }])
    assert.equal(out.length, 0, `「${t}」应该被挡掉`)
  }
})

ok('游戏 / ACG 向的要留下', () => {
  const good = [
    '影之刃零真香,吧友调侃黑猴钟馗',
    '表情包大赛32强,收官之战',
    '四格meme介绍我的本命角色',
    '《崩坏：星穹铁道》千星纪游PV',
  ]
  const out = filterTopics(good.map((title) => ({ title })))
  assert.equal(out.length, good.length, '不该误杀')
  // 兴趣向的排前面
  assert.ok(out[0].score >= out[out.length - 1].score)
})

ok('去重 + 过滤过长标题', () => {
  const out = filterTopics([
    { title: '影之刃零真香,吧友调侃黑猴钟馗' },
    { title: '影之刃零真香,吧友调侃黑猴钟馗（重复）' },
    { title: '啊'.repeat(80) },
    { title: '短' },
  ])
  assert.equal(out.length, 1, `实际：${JSON.stringify(out.map((x) => x.title))}`)
})

// ── ② 相关性：挂不上钩就什么都不给 ─────────────────────────
ok('⚠️ 挂不上钩 → 返回空数组（不许"热搜有啥就说啥"）', () => {
  const topics = [{ title: '影之刃零真香,吧友调侃黑猴钟馗' }]
  const hits = pickRelevant(topics, ['今天中午吃什么', '好困啊'])
  assert.deepEqual(hits, [], '聊的是吃饭犯困，跟影之刃零无关 → 不该注入')
})

ok('挂得上钩 → 返回并标出匹配到的词', () => {
  const topics = [{ title: '影之刃零真香,吧友调侃黑猴钟馗' }]
  const hits = pickRelevant(topics, ['影之刃零那个战斗手感真不错'])
  assert.equal(hits.length, 1)
  assert.ok(hits[0].match.length >= 2, `匹配词：${hits[0].match}`)
  assert.ok('影之刃零那个战斗手感真不错'.includes(hits[0].match))
})

ok('没有近期消息 → 不注入', () => {
  assert.deepEqual(pickRelevant([{ title: '影之刃零真香' }], []), [])
})

// ── ③ 存储：当天有效，跨天作废 ─────────────────────────────
ok('setToday 之后 today() 有值；toPrompt 能出文本', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'))
  const s = new HotTopicStore({ home })
  assert.equal(s.today(), null, '一开始没有')
  assert.equal(s.toPrompt(['影之刃零真好玩']), '', '没热点时提示词里不该多东西')
  s.setToday('贴吧热议', filterTopics([{ title: '影之刃零真香,吧友调侃黑猴钟馗' }]))
  assert.ok(s.today(), '写入后应可读')
  const p = s.toPrompt(['影之刃零真好玩'], 3)
  assert.match(p, /影之刃零/, '挂上钩才出文本')
  assert.match(p, /因为聊到/, '要说清为什么给它')
})

ok('跨天作废（隔夜的热点是旧闻）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-'))
  fs.writeFileSync(path.join(home, 'hot-topics.json'), JSON.stringify({
    day: '2000-01-01', source: '贴吧热议', at: 0, items: [{ title: '影之刃零真香' }],
  }), 'utf8')
  const s = new HotTopicStore({ home })
  assert.equal(s.today(), null, '昨天的数据必须视为没有')
  assert.equal(s.toPrompt(['影之刃零真好玩']), '', '过期数据不该进提示词')
})

ok('落盘失败不炸（没有 home 时静默）', () => {
  const s = new HotTopicStore({})
  s.setToday('x', [{ title: '影之刃零' }])
  assert.ok(s.today(), '内存里仍可用')
})

// ── ④ 抓取：主源挂了自动换备用源 ───────────────────────────
await okAsync('第一个源失败 → 自动走备用源', async () => {
  const calls = []
  const fake = async (url) => {
    calls.push(url)
    if (url.includes('tieba')) throw new Error('ECONNRESET')
    return {
      ok: true,
      json: async () => ({ data: { list: [{ title: '影之刃零真香', bvid: 'BV1', stat: { view: 9 } }] } }),
    }
  }
  const r = await fetchHotTopics({ fetchImpl: fake })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.source, 'B站热门')
  assert.equal(r.items.length, 1)
  assert.equal(calls.length, 2, '应该试了两个源')
})

await okAsync('两个源都挂 → 返回 ok:false，不抛', async () => {
  const r = await fetchHotTopics({ fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
})

await okAsync('源返回空列表也算失败（换下一个）', async () => {
  const r = await fetchHotTopics({
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => (url.includes('tieba') ? { data: { bang_topic: { topic_list: [] } } } : { data: { list: [{ title: '影之刃零真香' }] } }),
    }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.source, 'B站热门')
})

// ── ⑤ 源码锁 ──────────────────────────────────────────────
ok('提示词里不许出现"直接播报热点"这类用法', () => {
  const src = fs.readFileSync(new URL('../src/qq/hot-topics.js', import.meta.url), 'utf8')
  assert.match(src, /接话的料/, '定位要写清楚，否则后人会拿它当"开口的理由"')
  assert.ok(!/转发|播报/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), '代码里不该有播报逻辑')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)