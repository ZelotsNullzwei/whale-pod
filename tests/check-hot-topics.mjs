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
 * 2. **回复场景里：挂不上钩就什么都不注入** —— 热点是"接话的料"，不是"开口的理由"，
 *    否则它变成转发新闻的机器人
 * 3. **跨天作废** —— 热点隔夜就是旧闻
 *
 * ## ⚠️ 2026-10-31 对第 2 条的**有界放宽**（用户要求）
 * 用户原话：「不是能连贴吧吗，**话题从贴吧找呗**」。
 *
 * 背景：主动发言原来只有 dayPlan 可讲 —— 而 dayPlan 是"日记"，
 * 念出来就是「洗漱完煮了八个馄饨，汤里放了紫菜虾皮」这种流水账
 * （实测事故：「福是真福，就是橘子吃完手黏」）。
 *
 * 所以新增 `toPromptForProactive()`：**主动发言时**不要求挂钩，直接给榜单前几条。
 *
 * **边界没变**：
 *   · **回复场景**仍走 `toPrompt()`（必须挂钩，规矩 2 原样有效）
 *   · 主动发言拿到的是**话头素材**，提示词明确要求「**别照念标题**，用自己的话提一句」
 *   · 时政黑名单、跨天作废，两条都照旧
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

// ── ⑥ 新鲜度 + 主动发言素材（2026-10-31 加）────────────────────
/*
 * 两个真问题：
 * 1. `today()` 只看"是不是今天" → **一天只抓一次**。实测 `hot-topics.json`
 *    停在 00:03，18:29 还在用 —— **18 小时前的热点**。
 * 2. `toPrompt(recentTexts)` 必须挂钩才给 → 而**主动发言的场景就是没人在聊** →
 *    永远返回空 → 它只能去念 dayPlan（事故：「福是真福，就是橘子吃完手黏」）。
 */

ok('★ fresh()：30 分钟内的算新鲜，超时算过期', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-fresh-'))
  try {
    const s = new HotTopicStore({ home })
    s.setToday('贴吧热议', filterTopics([{ title: '影之刃零真香,吧友调侃黑猴钟馗' }]))
    assert.ok(s.fresh(), '刚写进去应该算新鲜')
    assert.ok(s.fresh(60_000), '1 分钟内也新鲜')
    assert.equal(s.fresh(-1), null, '超过窗口就该判过期')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

ok('★ toPromptForProactive：按"这个群/这个人关心什么"筛，**不是啥都分享**', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-pro-'))
  try {
    const s = new HotTopicStore({ home })
    s.setToday('贴吧热议', filterTopics([
      { title: '影之刃零真香,吧友调侃黑猴钟馗' },
      { title: '表情包大赛32强,收官之战' },
    ]))
    // 回复场景：没得挂钩就该空（规矩 2 原样有效）
    assert.equal(s.toPrompt([]), '', '回复场景：没得挂钩就该空')
    // 拿不到依据时退回按热度（兜底，不是主路）
    assert.notEqual(s.toPromptForProactive({ limit: 2 }), '', '没有依据时退回按热度')
    // ★ 有依据 → 按依据筛
    const hit = s.toPromptForProactive({ interest: '影之刃零 黑猴 钟馗', limit: 2 })
    assert.notEqual(hit, '', '挂得上就该给')
    assert.match(hit, /影之刃零/, '要给挂得上的那条')
    assert.match(hit, /话头/, '要说明是"话头"素材')
    // ★★ 挂不上 → 空。这一条就是"不是啥都分享"
    const miss = s.toPromptForProactive({ interest: '研究生调剂政策 论文答辩 考公', limit: 2 })
    assert.equal(miss, '', '★ 挂不上就该空 —— 技术群不该聊表情包大赛')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

ok('toPromptForProactive 没有热点时返回空（不许硬编）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-pro2-'))
  try {
    const s = new HotTopicStore({ home })
    assert.equal(s.toPromptForProactive({}), '')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

ok('⚠️ 源码锁：主动发言要按"群摘要 / 那个人档案"取兴趣，而不是啥都发', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /toPromptForProactive/, '主动发言要取热点素材')
  const at = src.indexOf('const sceneInterest = ')
  assert.ok(at > 0, '要有 sceneInterest 计算')
  const seg = src.slice(at, at + 700)
  assert.match(seg, /this\.people\?\.get/, '私聊/@ 要按那个人的档案')
  assert.match(seg, /mem\?\.summary|p\.facts/, '要有"关心什么"的依据（群摘要或人物事实）')
  /*
   * ⚠️ 2026-10-31：**不预筛** —— 用户说「这还是人为定的」。
   * 热点清单原样交给模型，让它按自己的人格挑；场合只作参考。
   * 所以这里锁的是「不拿 interest 去预筛」，而不是"必须有 interest 过滤"。
   */
  assert.match(src, /toPromptForProactive\?\.\(\{ interest: selfInterests/, '只有显式覆盖才传 interest')
})

ok('⚠️ 源码锁：必须要求「别照念标题」+「不感兴趣就 SILENT」', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = src.indexOf('const hotRule = ')
  assert.ok(at > 0, '要有 hotRule')
  const seg = src.slice(at, at + 900)
  assert.match(seg, /别照念标题/, '★ 必须要求改写，否则变成新闻播报机器人（规矩 2 的边界）')
  assert.match(seg, /\[SILENT\]/, '要允许"都不感兴趣就不说"')
  assert.match(seg, /真觉得有意思/, '要它按自己的兴趣挑，不是"该分享了"')
})

ok('⚠️ 源码锁：热点刷新用 fresh() 而不是 today()', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = src.indexOf('async _ensureHotTopics(')
  assert.ok(at > 0)
  const seg = src.slice(at, at + 700)
  assert.match(seg, /\.fresh\?\.\(/, '要用 fresh()（today() 会导致一天只抓一次）')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)