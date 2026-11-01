/**
 * **每天搜索次数的限额**（2026-11-01 新加）。
 *
 * ## 起因（用户原话）
 * > 「**这样看了，每天限额搜索是不是没有生效**」
 *
 * 查下来答案是：**根本没这个功能**。
 * 配置里有个 `maxUses`，面板上写着「最多搜几次」，但它在 `webSearch()` 里
 * **只出现在 JSDoc，零处实现** —— 传进去就没人读了。
 * ```
 * o.maxUses 在 search.js 里出现   1 次   ← 只有注释
 * 某天 24 小时触发联网           12 次   （配置写着"最多 3"）
 * 找 maxPerDay / 搜索计数 / 超限  0 处
 * ```
 *
 * 而**一次搜索实际约 ¥0.02**（大头是 `tool-search` 返回内容的 token，
 * 按条数线性涨；那个 ¥0.005 只是接口费）。没有上限 = 账单没有上限。
 *
 * ## 三条设计决定（都不是随便定的）
 * 1. **按"天"不按"每次对话"** —— 一天能聊几百条，按会话计数等于没上限
 * 2. **计数写盘** —— ⚠️ 内存计数会被重启清零，而开发期一天重启几十次，
 *    那样等于没限额。落 `<data>/search-usage.json`，**跨天自动归零**
 * 3. **填 0/负数 = 不限** —— 别把"关掉这个功能"理解成"一次都不许搜"
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SearchQuota } from '../src/gateway/search.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-quota-'))

console.log('=== ① 计数与判门 ===')

ok('★ 初始是不满的（used=0）', () => {
  const q = new SearchQuota({ home: tmp() })
  assert.deepEqual(q.check(3), { ok: true, used: 0, max: 3 })
})

ok('★ 搜到上限后 `ok` 要变 false', () => {
  const q = new SearchQuota({ home: tmp() })
  q.take(); q.take()
  assert.deepEqual(q.check(3), { ok: true, used: 2, max: 3 }, '第 2 次之后还能搜')
  q.take()
  assert.deepEqual(q.check(3), { ok: false, used: 3, max: 3 }, '★ 第 3 次之后就该拦住')
})

ok('★ 填 0 / 负数 / 没填 = 不限（别理解成"一次都不许"）', () => {
  const q = new SearchQuota({ home: tmp() })
  q.take(); q.take(); q.take()
  for (const v of [0, -1, undefined, null, NaN]) {
    assert.equal(q.check(v).ok, true, `maxPerDay=${v} 应该视为不限`)
  }
})

ok('`usedToday()` 单独也能读', () => {
  const q = new SearchQuota({ home: tmp() })
  q.take()
  q.take()
  assert.equal(q.usedToday(), 2)
})

console.log('\n=== ② 落盘 / 跨重启 / 跨天 ===')

ok('★ 计数要写盘（内存计数在重启后等于没限额）', () => {
  const home = tmp()
  const q = new SearchQuota({ home })
  q.take()
  const f = path.join(home, 'search-usage.json')
  assert.ok(fs.existsSync(f), '要落 search-usage.json')
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.equal(j.count, 1)
  assert.match(j.day, /^\d{4}-\d{2}-\d{2}$/, '要记本地日期')
})

ok('★ 重启后计数还在（换个实例读同一个目录）', () => {
  /*
   * ⚠️ 这条是关键 —— 开发期一天重启几十次，如果计数在内存里，
   * 每次重启都归零 = 限额形同虚设。
   */
  const home = tmp()
  const a = new SearchQuota({ home })
  a.take(); a.take()
  const b = new SearchQuota({ home })
  assert.equal(b.usedToday(), 2, '★ 新实例要读到 2')
  assert.deepEqual(b.check(3), { ok: true, used: 2, max: 3 })
})

ok('★ 跨天自动归零（并且会写盘）', () => {
  const home = tmp()
  const q = new SearchQuota({ home })
  // 伪造"昨天已经搜了 99 次"
  q.data = { day: '2000-01-01', count: 99 }
  fs.writeFileSync(path.join(home, 'search-usage.json'), JSON.stringify(q.data), 'utf8')
  const q2 = new SearchQuota({ home })
  assert.equal(q2.usedToday(), 0, '★ 昨天的 99 不该算到今天')
  assert.deepEqual(q2.check(3), { ok: true, used: 0, max: 3 })
  const j = JSON.parse(fs.readFileSync(path.join(home, 'search-usage.json'), 'utf8'))
  assert.equal(j.count, 0, '归零后要写回盘（不然每次读都重算）')
})

ok('日期用的是**本地**时区，不是 UTC', () => {
  /*
   * 按 UTC 切的话，东八区的"今天 08:00 之前"会被算成昨天 ——
   * 限额会在早上 8 点莫名其妙重置。
   */
  const d = new Date(2026, 10, 1, 0, 30)   // 本地 11-01 00:30
  assert.equal(SearchQuota.todayKey(d), '2026-11-01')
})

ok('文件损坏 / 不存在 / 没传 home 都不抛', () => {
  const home = tmp()
  fs.writeFileSync(path.join(home, 'search-usage.json'), '{{{ 坏 json', 'utf8')
  const q = new SearchQuota({ home })
  assert.equal(q.usedToday(), 0, '坏文件当 0 处理')
  assert.equal(new SearchQuota({}).check(3).ok, true, '没传 home 也不抛')
})

console.log('\n=== ③ 接线锁（防止又出现"传了没人读"）===')

ok('★ bridge 调用搜索前要真的检查限额', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /this\.searchQuota = opts\.searchQuota/, '要接收 searchQuota')
  const at = src.indexOf('const quota = this.searchQuota?.check')
  assert.ok(at > 0, '★ 要有 check() 调用')
  const seg = src.slice(at, at + 500)
  assert.match(seg, /if \(!quota\.ok\)/, '超限要拦')
  assert.match(seg, /this\.searchQuota\?\.take\(\)/, '★ 通过后才计数（被拦下的那次不该算）')
})

ok('★ `maxUses` 这个死参数要彻底消失', () => {
  /*
   * 它有三种互相矛盾的说明、零处实现。留着只会再骗一次人。
   */
  for (const f of ['src/gateway/search.js', 'src/qq/bridge.js', 'src/config/store.js', 'src/gateway/server.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
    // 允许出现在"说明为什么删掉"的注释里，但**不能出现在代码里**
    const code = src.split('\n').filter((l) => !/^\s*(?:\*|\/\/)/.test(l)).join('\n')
    assert.ok(!/maxUses/.test(code), `★ ${f} 的代码里不该再有 maxUses`)
  }
})

ok('配置默认值是 `maxPerDay: 20`', () => {
  const src = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8')
  assert.match(src, /maxPerDay: 20/)
})

ok('面板文案说的是"每天"而不是"每次"（原来那句是错的）', () => {
  const src = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  assert.match(src, /'search\.maxPerDay': '每天最多搜几次'/, '中文文案')
  assert.match(src, /'search\.maxPerDay': 'Max searches per day'/, '英文文案')
  assert.ok(!/search\.maxUses/.test(src), '旧的 maxUses 文案要清干净')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)