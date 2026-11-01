/**
 * check-people.mjs —— 按 QQ 号认人 + 摘要蒸馏。
 *
 * 重点验证「认人按 QQ 号而不是昵称」这条 —— 这是整个设计的地基：
 *   1. 同一个人换昵称 → 还是同一个人，印象被更新
 *   2. 不同的人用同名 → 是两个人，印象不串
 *   3. merge 是替换不是拼接（长度不会膨胀）
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PeopleStore, PersonProfile, personKey } from '../src/memory/person.js'
import { LongTermMemory, parsePeople, renderPeople, parsePersonFacts, stripFactsSection } from '../src/memory/long.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ppl-'))

console.log('按 QQ 号认人')

// ── 1. 核心：认的是 QQ 号 ─────────────────────────────────────
ok('同一个人换昵称 → 还是同一个人', () => {
  const s = new PeopleStore()
  s.touch('123450002', '阿甲', 1000)
  s.touch('123450002', '不是不是阿甲', 2000)
  assert.equal(s.people.size, 1, '不该因为改名变成两个人')
  const p = s.get('123450002')
  assert.deepEqual(p.aliases, ['阿甲', '不是不是阿甲'], '两个昵称都留作别名')
  assert.equal(p.displayName, '不是不是阿甲', '展示最近的昵称')
  assert.equal(p.seen, 2)
})

ok('不同人用同一个昵称 → 是两个人', () => {
  const s = new PeopleStore()
  s.touch('111111', '小明', 1000)
  s.touch('222222', '小明', 2000)
  assert.equal(s.people.size, 2, '昵称撞了也必须是两个人')
  s.get('111111').setImpression('爱打游戏')
  s.get('222222').setImpression('爱学习')
  assert.equal(s.get('111111').impression, '爱打游戏')
  assert.equal(s.get('222222').impression, '爱学习')
})

ok('personKey 加 u: 前缀，数字/字符串等价', () => {
  assert.equal(personKey(123456), 'u:123456')
  assert.equal(personKey('12345678'), 'u:12345678')
  assert.equal(personKey(''), '')
})

// ── 2. 画像约束 ──────────────────────────────────────────────
ok('印象是覆盖，不是拼接', () => {
  const p = new PersonProfile('1')
  p.setImpression('爱攒抽')
  p.setImpression('爱攒抽、爱发图')
  assert.equal(p.impression, '爱攒抽、爱发图', '应该被替换而不是「爱攒抽 爱攒抽、爱发图」')
})

ok('印象超长会被截断', () => {
  const p = new PersonProfile('1')
  p.setImpression('啊'.repeat(500))
  assert.ok(p.impression.length <= 120, `实际 ${p.impression.length}`)
})

ok('事实去重 + 上限', () => {
  const p = new PersonProfile('1')
  p.addFact('在本地')
  p.addFact('在本地')   // 重复
  assert.equal(p.facts.length, 1, '同一件事不该记两遍')
  for (let i = 0; i < 20; i++) p.addFact(`事实${i}`)
  assert.ok(p.facts.length <= 12, `实际上限 ${p.facts.length}`)
})

// ── 3. relevant 排序 ────────────────────────────────────────
ok('relevant 把当前说话人排最前', () => {
  const s = new PeopleStore()
  for (const [id, name] of [['1', 'A'], ['2', 'B'], ['3', 'C']]) {
    s.touch(id, name, Number(id) * 1000)
    s.get(id).setImpression(`${name}的印象`)
  }
  const list = s.relevant({ self: '1', limit: 3 })
  assert.equal(list[0].id, '1', '当前说话人优先，即使他不是最近的')
})

ok('没有印象的人不占位置', () => {
  const s = new PeopleStore()
  s.touch('1', 'A', 1000)
  s.get('1').setImpression('有印象')
  s.touch('2', 'B', 2000)   // 没印象
  const list = s.relevant({ limit: 5 })
  assert.equal(list.length, 1, '没沉淀的人不该占 prompt')
  assert.equal(list[0].id, '1')
})

// ── 4. 摘要 merge 是替换 ────────────────────────────────────
ok('merge 同一个人换名字后整行替换，不新增', () => {
  const m = new LongTermMemory('group:1')
  m.merge('【人】\n12345 | 阿甲 | 爱攒抽\n22345 | 甲 | 爱发图\n\n【事】\n在聊抽卡')
  const len1 = m.summary.length
  m.merge('【人】\n12345 | 不是不是阿甲 | 爱攒抽、爱发图\n\n【事】\n在聊游戏平衡')
  // 应该还是 2 个人（111 被替换，222 保留）
  const people = parsePeople(m.summary)
  assert.equal(people.size, 2, '不该变成 3 个人')
  assert.match(m.summary, /不是不是阿甲/, '昵称更新了')
  assert.doesNotMatch(m.summary, /111 \| 阿甲 \| 爱攒抽\n/, '旧的那行被替换掉了')
  // 长度不该翻倍
  assert.ok(m.summary.length < len1 * 2, `长度 ${len1} → ${m.summary.length}，不该翻倍`)
})

ok('merge 二十次长度不会爆炸', () => {
  const m = new LongTermMemory('group:1')
  for (let i = 0; i < 20; i++) {
    m.merge(`【人】\n12345 | 阿甲${i} | 第${i}次印象\n\n【事】\n第${i}轮话题`)
  }
  assert.ok(m.summary.length < 500, `20 次 merge 后 ${m.summary.length} 字，旧实现会到 1000+`)
  assert.equal(parsePeople(m.summary).size, 1, '还是同一个人')
})

ok('老格式摘要（没有【人】）→ 整体替换而不是拼接', () => {
  const m = new LongTermMemory('group:1')
  m.summary = '很老的纯文本摘要'
  m.merge('另一段纯文本')
  assert.equal(m.summary, '另一段纯文本', '旧实现会拼成两行并越滚越长')
})

ok('parsePeople 容忍模型乱写分隔符', () => {
  const people = parsePeople('【人】\n12345678 张三：爱摸鱼\n789012 | 李四 | 爱卷\n【事】\n聊工作')
  assert.equal(people.size, 2)
  assert.match(people.get('12345678'), /张三/)
  assert.match(people.get('789012'), /李四/)
})

ok('parsePeople 丢掉没有 QQ 号的行', () => {
  const people = parsePeople('【人】\n某个没写号的人 | 爱摸鱼\n12345678 | 有号 | 爱卷\n【事】\nx')
  assert.equal(people.size, 1, '没 QQ 号认不了人，必须丢掉')
  assert.ok(people.has('12345678'))
})

// ── 5. 落盘 ─────────────────────────────────────────────────
ok('落盘后能恢复，别名和印象都在', () => {
  const home = tmp()
  const a = new PeopleStore({ home })
  a.touch('12345', '阿甲', 1000)
  a.touch('12345', '不是不是阿甲', 2000)
  a.get('12345').setImpression('爱攒抽')
  a.get('12345').addFact('在本地')
  a.save()

  const b = new PeopleStore({ home })
  const p = b.get('12345')
  assert.equal(p.impression, '爱攒抽')
  assert.deepEqual(p.aliases, ['阿甲', '不是不是阿甲'])
  assert.deepEqual(p.facts, ['在本地'])
  assert.equal(p.seen, 2)

  fs.rmSync(home, { recursive: true, force: true })
})

ok('文件损坏不炸', () => {
  const home = tmp()
  fs.writeFileSync(path.join(home, 'people.json'), '{坏 json')
  const s = new PeopleStore({ home })
  assert.equal(s.people.size, 0)
  s.touch('1', 'A', 1)
  assert.equal(s.people.size, 1)

  fs.rmSync(home, { recursive: true, force: true })
})

// ── 事实层（2026-10-31 新增）──────────────────────────────────
/*
 * ## 事故：人物档案里 facts 永远是空的
 * `PersonProfile.addFact()` 写好了（去重 + 上限 12），但 **`PeopleStore` 上
 * 没有入口** → 全项目零调用 → `people.json` 里 5 个人 facts 全是 `[]`。
 *
 * 于是"记住一个人"只剩一句性格标签：
 * `"impression": "学生党，周末要值班…爱发表情包叫我小馋猫"`
 * —— **具体的事一件都没留下**，而且混入了机器人视角（「叫我」）。
 *
 * ## 改法
 * 摘要多输出一段【事实】（`QQ号 | 一件事`）→ `parsePersonFacts`
 * → `PeopleStore.addFact` → `people.json`（跨会话累积）
 * → `toPromptLine()` 渲染时带上。
 * 然后 `stripFactsSection` 从摘要里摘掉（避免两份、避免裁剪时神秘消失）。
 */

ok('★ parsePersonFacts 能解析【事实】段', () => {
  /*
   * ⚠️ ID 必须 ≥4 位 —— 解析器和 `parsePersonLines` 同一口径（`\d{4,12}`，
   * 真 QQ 号就是 5-12 位）。我第一版测试用 `123`（3 位），解析器正确地
   * 跳过了它，测试却报"解析出 0 条"—— **是测试数据错，不是代码错**。
   */
  const text = [
    '【人】',
    '123450002 | 甲 | 学生',
    '',
    '【事实】',
    '123450002 | 周末要值班',
    '123450002 | 住的地方晚上会断电',
    '',
    '【事】',
    '在上课。',
  ].join('\n')
  const facts = parsePersonFacts(text)
  assert.equal(facts.length, 2, `应解析出 2 条，实际 ${facts.length}`)
  assert.equal(facts[0].id, '123450002')
  assert.match(facts[0].fact, /周末要值班/)
})

ok('parsePersonFacts 不会越过【事实】去吃后面的段', () => {
  const text = '【事实】\n123450002 | 在玩一款手游\n【我】\n我越来越会等了。'
  const facts = parsePersonFacts(text)
  assert.equal(facts.length, 1, '【我】那段不该被当事实')
  assert.match(facts[0].fact, /手游/)
})

ok('★ stripFactsSection 摘掉【事实】，其它段一个不动', () => {
  const text = '【人】\n123450002 | 甲 | 学生\n\n【事实】\n123450002 | 在玩一款手游\n\n【事】\n在上课。\n\n【梗】\n本鱼 | 自称'
  const out = stripFactsSection(text)
  assert.ok(!out.includes('【事实】'), '【事实】该被摘掉')
  assert.ok(!out.includes('手游'), '事实内容也该一起带走')
  for (const sec of ['【人】', '【事】', '【梗】']) {
    assert.ok(out.includes(sec), `${sec} 不能被误删`)
  }
})

ok('★ PeopleStore.addFact 真的写进 facts（以前是零调用）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-facts-'))
  try {
    const store = new PeopleStore({ home })
    store.addFact('123450002', '周末要值班')
    store.addFact('123450002', '在玩一款手游')
    const p = store.get('123450002')
    assert.ok(p, '该建出这个人的档案')
    assert.equal(p.facts.length, 2, `facts 该有 2 条，实际 ${p.facts.length}`)
    // 去重
    store.addFact('123450002', '周末要值班')
    assert.equal(store.get('123450002').facts.length, 2, '重复的事实不该再加')
    // 渲染时带上
    const line = store.get('123450002').toPromptLine()
    assert.match(line, /值班/, `toPromptLine 要带事实：${line}`)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

ok('addFact 也累积昵称别名（和 setImpression 一致）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-facts2-'))
  try {
    const store = new PeopleStore({ home })
    store.addFact('123450002', '在玩一款手游', '阿甲')
    store.addFact('123450002', '课到九点', '不是不是阿甲')
    const p = store.get('123450002')
    assert.deepEqual(p.aliases, ['阿甲', '不是不是阿甲'], '两个昵称都要留作别名')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
