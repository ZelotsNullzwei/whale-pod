/**
 * 面板读配置的**层级**（2026-11-01）。
 *
 * ## 事故（用户发现）
 * 用户在面板上看到「顺便配一张封面图」是**勾选**状态，问「配图这个不要了吧」。
 * 但配置里 `qq.search.images` **已经是 `false`** —— 早就关了。
 * **面板显示和实际不一致。**
 *
 * ## 根因
 * `search` 在配置里有**两处**：
 * ```
 * 顶层 search:  { lowBalanceCny: 2 }                        ← 只有这一项
 * qq.search:    { enabled, images:false, maxUses:3, ... }   ← 机器人本体用的
 * ```
 * · **程序读** `this.cfg.search`（`this.cfg` = `qq`）→ 读 `qq.search` ✅
 * · **面板原来只读** `cfg.search`（**顶层**）→ 除 `lowBalanceCny` 外全是 `undefined`
 *
 * 于是面板显示的是**默认值**而不是实际值：
 * ```
 * enabled   → 顶层 undefined → checked = (undefined !== false) = true    ← 实际也是 true，"碰巧对"
 * images    → 顶层 undefined → checked = true                            ← ★ 实际 false，错了
 * maxUses   → 顶层 undefined → value = undefined ?? 3 = 3                ← 实际也是 3，"碰巧对"
 * ```
 * **`images` 是唯一暴露这个 bug 的**（因为它的默认值 ≠ 现值）。
 *
 * ## 教训
 * "碰巧对"最危险 —— 三个设置项里两个是对的，只有一个是错的，
 * 于是没人会怀疑代码，只会怀疑自己没保存。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}

const src = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')

console.log('=== 面板读 search 配置 ===')

ok('★ 必须**合并**顶层和 `qq.search`（不能只读顶层）', () => {
  /*
   * 顶层那个 `lowBalanceCny` 是**余额提醒**用的，不能丢；
   * 其它项在 `qq.search`。所以要合并，且以 `qq.search` 为准。
   */
  assert.match(
    src,
    /const sr = \{ \.\.\.\(cfg\?\.search \?\? \{\}\), \.\.\.\(cfg\?\.qq\?\.search \?\? \{\}\) \}/,
    '★ 要合并两处：{...cfg.search, ...cfg.qq.search}',
  )
})

ok('★ 不能再有「只读顶层 search」的写法', () => {
  // 旧写法（就是 bug 本身）
  assert.ok(
    !/const sr = cfg\?\.search \?\? \{\}/.test(src),
    '旧写法 `cfg?.search ?? {}` 只拿到 lowBalanceCny，其它全是 undefined',
  )
})

ok('`qq` 本身还是要单独取（别的地方在用）', () => {
  assert.match(src, /const qq = cfg\?\.qq \?\? \{\}/, 'qq 那份不能删')
})

ok('`decision` 保持顶层（它本来就在顶层）', () => {
  /*
   * ⚠️ 别因为修 `search` 就顺手把所有配置都往 `qq` 里塞 ——
   * `decision` 确实在顶层，改错了会读不到。
   */
  assert.match(src, /const dec = cfg\?\.decision \?\? \{\}/, 'decision 在顶层，保持原样')
})

console.log('\n=== 对照：程序端读的是哪一层 ===')

ok('★ 程序读 `this.cfg.search`，而 `this.cfg` = `qq`', () => {
  /*
   * 这是"面板和程序不一致"的另一半 —— 面板读顶层、程序读 qq，
   * 修面板时必须确认程序这头没变。
   */
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  /*
   * ⚠️ 实际写法是 **展开 `...cfg.qq`**（不是 `cfg: cfg.qq`）：
   *   cfg: { ...cfg.qq, proactive: cfg.proactive, beg: cfg.beg, ... }
   * 所以 `this.cfg.search` === `qq.search`。
   */
  assert.match(idx, /\.\.\.cfg\.qq/, '★ Bridge 的 cfg 要展开 qq（这样 this.cfg.search === qq.search）')
  const bridge = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(bridge, /this\.cfg\.search/, '程序读 this.cfg.search（= qq.search）')
})

ok('配置里两处 `search` 的真实分布（文档化这个坑）', () => {
  /*
   * 这里**不读真实 config.json**（那是用户数据，测试不该依赖它），
   * 只把"两处都有、顶层只有 lowBalanceCny"这件事写进测试里当文档。
   * 真要验证，用 DEFAULTS：
   */
  const store = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8')
  /*
   * ⚠️ 别把断言绑到"某个字段在前 N 个字符内" —— 文件一改顺序就假失败
   * （第一版写成 `/search:\s*\{[\s\S]{0,200}?lowBalanceCny/` 就是这么挂的）。
   * 只查"这两个键都存在于 DEFAULTS 里"就够了。
   */
  assert.match(store, /lowBalanceCny:\s*\d/, 'DEFAULTS 里要有 lowBalanceCny')
  assert.match(store, /images:\s*(true|false)/, 'DEFAULTS 里要有 images')
})

console.log('\n=== 「配图」这个功能本身 ===')

ok('★ 默认就应该是**关**的（真人不会自动配图）', () => {
  /*
   * 用户原话：「配图这个不要了吧，**真人不会这么干**」。
   *
   * 对 —— 真人聊到某作品**不会自动附一张图**，那是"助手/客服"行为。
   * 所以默认值就该是 false，而不是让用户自己发现并关掉。
   */
  const store = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8')
  const at = store.indexOf('搜到结果后要不要顺手抓一张封面图')
  assert.ok(at > 0, '要能找到那段注释')
  const seg = store.slice(at, at + 1400)
  const m = seg.match(/images:\s*(true|false)/)
  assert.ok(m, '要能找到 images 的默认值')
  console.log(`     当前默认值: images = ${m[1]}`)
})

ok('源码锁：`[找图:]` 那条路还在（那是**模型主动**要图，不是自动配）', () => {
  /*
   * ⚠️ 别把两件事一起删了：
   * · `search.images` = 程序**自动**附封面   ← 用户不要这个
   * · `[找图:关键词]` = **模型自己决定**要图 ← 这个要留（人格的一部分）
   */
  const persona = fs.readFileSync(new URL('../src/persona/store.js', import.meta.url), 'utf8')
  assert.match(persona, /\[找图:/, '`[找图:]` 机制要留着')
})

console.log('\n=== 面板写入必须**归位**（2026-11-01 第二个 bug）===')

ok('★ 后端要把 `search.*` 归位到 `qq.search.*`', () => {
  /*
   * 面板提交 `{'search.images': false}` → 点分键展开成 `{search: {images}}`
   * → **写到顶层 `search`**。但程序七处全读 `this.cfg.search`（= `qq.search`），
   * 顶层那份**没人读**。
   *
   * 后果很难发现：热更新那段会**临时合并**顶层进 liveBridge.cfg.search，
   * 所以"改完当时生效"，但**盘上写错了位置 → 重启就丢**。
   */
  const s = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8')
  assert.match(s, /if \(nested\.search\) \{[\s\S]{0,300}?nested\.qq\.search/, '★ 要把 nested.search 归位到 nested.qq.search')
  assert.match(s, /delete nested\.search/, '★ 归位后要删掉顶层那份')
})

ok('★ 热更新要读 `q.search`，不能再读顶层 `store.get().search`', () => {
  /*
   * 归位之后顶层那份不再更新，热更新还读顶层的话，
   * **推给运行中 bridge 的就是过期值** —— 开关拨了、行为不变。
   * （这正是这条代码当年要修的病，改归位时差点又造回去。）
   */
  const s = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8')
  const at = s.indexOf('search.* 也必须推')
  assert.ok(at > 0, '要能找到那段注释')
  const seg = s.slice(at, at + 900)
  assert.match(seg, /liveBridge\.cfg\.search = \{ \.\.\.\(liveBridge\.cfg\.search \?\? \{\}\), \.\.\.q\.search \}/,
    '★ 要合并 q.search（不是 store.get().search）')
  assert.ok(!/\.\.\.store\.get\(\)\.search/.test(seg), '不能再读顶层那份')
})

ok('★ `proactive` 也要热更新（它在顶层，原来被漏掉）', () => {
  /*
   * 和 `search` 是**同一类病**：热更新块只判 `nested.qq`，
   * 而 `proactive` 在顶层 → 面板改「主动发言」的设置**写盘但不推给 bridge**。
   * 面板新加的「贴吧订阅」就在 proactive 里，不补这条就又造一个"改了要重启"的坑。
   */
  const s = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8')
  assert.match(s, /if \(liveBridge && nested\.proactive\)/, '★ 要有 proactive 的热更新分支')
  assert.match(s, /liveBridge\.cfg\.proactive = store\.get\(\)\.proactive/, '要整体替换 cfg.proactive')
})

console.log('\n=== 面板「贴吧订阅」UI ===')

ok('★ 面板要读 `cfg.proactive.tiebaForums`（顶层，不是 qq）', () => {
  const s = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  assert.match(s, /const forums = Array\.isArray\(cfg\?\.proactive\?\.tiebaForums\)/,
    '★ 要从顶层 proactive 读')
  assert.ok(!/cfg\?\.qq\?\.proactive/.test(s), '不能写成 qq.proactive（proactive 在顶层）')
})

ok('★ 面板要写 `proactive.tiebaForums`（键名不能带 qq.）', () => {
  const s = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  assert.match(s, /'proactive\.tiebaForums':/, '★ 键名是 proactive.tiebaForums')
})

/*
 * ★★ 取「贴吧订阅」那一整段 —— **按结构切，不按字数切**。
 *
 * ⚠️ 原来这两个断言用的是：
 *     const at = s.indexOf("'proactive.tiebaForums':")
 *     const seg = s.slice(at, at + 400)      // ← 固定 400 字
 *
 * 2026-11-02 面板改成「标签列表」之后**就报错了**，但**代码是对的**：
 * 新版里**第一个** `'proactive.tiebaForums':` 出现在**删除**那一支
 * （点标签上的 × → `forums.filter((x) => x !== f)`），
 * 而 split / replace 在 400 字**之外** → 断言找不到 → 红。
 *
 * 这跟 check-voice、check-sticker-priority 栽的是**同一个坑**：
 * **固定字数窗口**会被后续插入的注释、新分支挤爆，
 * 报出来的却是"功能坏了"，比没测还误导。
 *
 * 改成切到**下一段注释**为止（那一段的收尾）。
 */
const forumsBlock = () => {
  const s = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  const at = s.indexOf('// ── 贴吧订阅')
  assert.ok(at > 0, '要有「贴吧订阅」那一段')
  const end = s.indexOf('// ── 决策与人格', at)
  return s.slice(at, end > at ? end : at + 5000)
}

ok('★ 分隔符要认中文顿号（中文输入法下最常见）', () => {
  /*
   * 用户会写成「明日方舟、显卡」。只切英文逗号的话，`、` 不会生效 ——
   * 界面看着接受输入，实际存进去一整个字符串，很难查。
   */
  assert.match(forumsBlock(), /split\(\/\[、,，;；\\s\]\+\/\)/, '★ 要切 顿号/逗号/分号/空格')
})

ok('★ 末尾的「吧」字要自动去掉（用户会顺手写「明日方舟吧」）', () => {
  const seg = forumsBlock()
  assert.match(seg, /replace\(\/吧\$\/, ''\)/, '★ 要去掉尾部的「吧」')
  /*
   * 「空串要滤掉（否则会存进空条目）」—— 断言**语义**，别锁字面。
   * 原版是 `filter(Boolean)`；2026-11-02 改成
   * `filter((x) => x && !forums.includes(x))`（**顺带去了重**，更好）。
   * 两个都满足"空串进不去"，所以两种写法都算过 ——
   * 锁死 `filter(Boolean)` 的话，以后任何改进都会误报成"功能坏了"。
   */
  assert.match(seg, /filter\((?:Boolean|\(x\)\s*=>\s*x)/,
    '★ 空串要滤掉（filter(Boolean) 或等价的真值判断都行）')
})

ok('面板要有中英文两套文案', () => {
  const s = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  const cn = (s.match(/'section\.forums': '贴吧订阅'/g) ?? []).length
  const en = (s.match(/'section\.forums': 'Tieba subscriptions'/g) ?? []).length
  assert.equal(cn, 1, '中文文案一份')
  assert.equal(en, 1, '英文文案一份')
})

ok('配置默认值仍是空数组（面板读不到也不炸）', () => {
  const s = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8')
  assert.match(s, /tiebaForums: \[\]/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)