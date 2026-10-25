/**
 * 讨钱功能的测试。
 *
 * 覆盖三条需求：
 *   · 搜索触发 + 余额 < ¥3 才讨
 *   · @ 最近互动最多的人
 *   · 每天最多 3 次、话术不重样
 *
 * 运行：node tests/check-beg.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  InteractionTracker,
  BegState,
  decideBeg,
  BEG_LINES,
  BEG_MAX_PER_DAY,
  todayKey,
} from '../src/qq/beg.js'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; console.log(`  ❌ ${name}  ${detail}`) }
}

console.log('=== 1. 互动统计 ===')
{
  const t = new InteractionTracker({ windowMs: 7 * 24 * 3600_000 })
  t.hit('111', '小李'); t.hit('111', '小李'); t.hit('111', '小李')
  t.hit('222', '小王'); t.hit('222', '小王')
  t.hit('333', '小张')

  const top = t.top({ limit: 3 })
  check('按次数排序', top[0].id === '111' && top[0].count === 3, JSON.stringify(top))
  check('第二名是 222', top[1].id === '222', JSON.stringify(top))
  check('第三名是 333', top[2].id === '333', JSON.stringify(top))
  check('top(1) 只返回 1 个', t.top({ limit: 1 }).length === 1)

  const excluded = t.top({ limit: 5, exclude: ['111'] })
  check('exclude 生效', excluded.every((x) => x.id !== '111'), JSON.stringify(excluded))
}

console.log('\n=== 2. 时间窗口 ===')
{
  const t = new InteractionTracker({ windowMs: 1000 })
  const old = Date.now() - 5000
  t.hit('999', '老消息', old)
  check('窗口外的旧互动不算', t.top({ limit: 5 }).length === 0, JSON.stringify(t.top({ limit: 5 })))

  t.hit('888', '新消息', Date.now())
  const top = t.top({ limit: 5 })
  check('窗口内的新互动算', top.length === 1 && top[0].id === '888', JSON.stringify(top))
}

console.log('\n=== 3. 序列化往返 ===')
{
  const t = new InteractionTracker({ windowMs: 7 * 24 * 3600_000 })
  t.hit('555', '阿五'); t.hit('555', '阿五')
  const json = t.toJSON()
  const t2 = InteractionTracker.fromJSON(json, { windowMs: 7 * 24 * 3600_000 })
  check('恢复后数据一致', t2.top({ limit: 1 })[0]?.count === 2, JSON.stringify(t2.top({ limit: 1 })))
}

console.log('\n=== 4. 容量上限 ===')
{
  const t = new InteractionTracker({ windowMs: 7 * 24 * 3600_000, cap: 5 })
  for (let i = 0; i < 10; i++) t.hit(`u${i}`, `用户${i}`, Date.now() + i)
  check('超过 cap 会自动淘汰', t.top({ limit: 100 }).length <= 5, String(t.top({ limit: 100 }).length))
  const top = t.top({ limit: 1 })
  check('保留的是最近的', top[0]?.id === 'u9', JSON.stringify(top))
}

console.log('\n=== 5. 余额判定 ===')
{
  const t = new InteractionTracker()
  t.hit('111', '甲')
  const mkState = () => new BegState({ file: null })

  check('余额 ¥10 → 不讨', decideBeg({ cny: 10, threshold: 3, state: mkState(), tracker: t }).beg === false)
  check('余额 ¥3.00 → 不讨（等于阈值不算低）', decideBeg({ cny: 3, threshold: 3, state: mkState(), tracker: t }).beg === false)
  check('余额 ¥2.99 → 讨', decideBeg({ cny: 2.99, threshold: 3, state: mkState(), tracker: t }).beg === true)
  check('余额 ¥0 → 讨', decideBeg({ cny: 0, threshold: 3, state: mkState(), tracker: t }).beg === true)
  check('余额未知 → 不讨', decideBeg({ cny: NaN, threshold: 3, state: mkState(), tracker: t }).beg === false)
}

console.log('\n=== 6. 每日 3 次上限 ===')
{
  const t = new InteractionTracker()
  t.hit('111', '甲')
  const st = new BegState({ file: null })
  check('初始剩 3 次', st.remaining() === BEG_MAX_PER_DAY, String(st.remaining()))

  const used = []
  for (let i = 0; i < 3; i++) {
    const d = decideBeg({ cny: 1, threshold: 3, state: st, tracker: t, rnd: () => i * 0.2 })
    if (d.beg) { st.commit(d.line); used.push(d.line.id) }
  }
  check('前 3 次都能讨', used.length === 3, JSON.stringify(used))
  check('3 次话术各不相同', new Set(used).size === 3, JSON.stringify(used))
  check('第 4 次被拒', decideBeg({ cny: 1, threshold: 3, state: st, tracker: t }).beg === false)
  check('剩余归零', st.remaining() === 0, String(st.remaining()))
}

console.log('\n=== 7. 跨天重置 ===')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beg-'))
  const file = path.join(dir, 'beg.json')
  const t = new InteractionTracker()
  t.hit('111', '甲')

  const st = new BegState({ file })
  for (let i = 0; i < 3; i++) {
    const d = decideBeg({ cny: 1, threshold: 3, state: st, tracker: t, rnd: () => i * 0.2 })
    if (d.beg) st.commit(d.line)
  }
  check('文件已落盘', fs.existsSync(file), file)

  // 手工把日期改成昨天，模拟跨天
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  j.day = '2000-01-01'
  fs.writeFileSync(file, JSON.stringify(j), 'utf8')

  const st2 = new BegState({ file })
  check('跨天后剩余次数恢复', st2.remaining() === BEG_MAX_PER_DAY, String(st2.remaining()))
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('\n=== 8. 没有互动对象时不讨 ===')
{
  const empty = new InteractionTracker()
  const d = decideBeg({ cny: 1, threshold: 3, state: new BegState({ file: null }), tracker: empty })
  check('无人互动 → 不讨（不知道该 @ 谁）', d.beg === false, JSON.stringify(d))
  check('理由说得清', /没有说话|不知道该找谁/.test(d.reason), d.reason)
}

console.log('\n=== 9. 话术模板 ===')
{
  check('模板数 ≥ 每天上限（够用不重样）', BEG_LINES.length >= BEG_MAX_PER_DAY, `${BEG_LINES.length} vs ${BEG_MAX_PER_DAY}`)
  check('每条都有 id', BEG_LINES.every((l) => typeof l.id === 'string' && l.id.length > 0))
  check('每条都有 {cny} 占位符', BEG_LINES.every((l) => l.text.includes('{cny}')))
  check('id 不重复', new Set(BEG_LINES.map((l) => l.id)).size === BEG_LINES.length)

  const st = new BegState({ file: null })
  const d = decideBeg({
    cny: 1.234, threshold: 3, state: st,
    tracker: (() => { const t = new InteractionTracker(); t.hit('1', '测试人'); return t })(),
    rnd: () => 0,
  })
  check('{cny} 被替换成两位小数', d.text.includes('1.23') && !d.text.includes('{cny}'), d.text)
  check('{who} 被替换成昵称', d.text.includes('测试人') && !d.text.includes('{who}'), d.text)
}

console.log('\n=== 10. 目标选择 ===')
{
  const t = new InteractionTracker()
  t.hit('a', 'A'); t.hit('a', 'A'); t.hit('a', 'A')   // 3 次
  t.hit('b', 'B'); t.hit('b', 'B')                    // 2 次
  t.hit('c', 'C')                                     // 1 次

  // rnd=0 → 选第一名
  const d0 = decideBeg({ cny: 1, threshold: 3, state: new BegState({ file: null }), tracker: t, rnd: () => 0 })
  check('rnd=0 选互动最多的', d0.target?.id === 'a', JSON.stringify(d0.target))

  // rnd=0.99 → 在前 3 名里挑最后那个
  const d9 = decideBeg({ cny: 1, threshold: 3, state: new BegState({ file: null }), tracker: t, rnd: () => 0.99 })
  check('rnd 大时仍在前 3 名内', ['a', 'b', 'c'].includes(d9.target?.id), JSON.stringify(d9.target))
}

console.log(`\n${'='.repeat(40)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
