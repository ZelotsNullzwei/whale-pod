/**
 * 零依赖 CDP 驱动（gateway/browser.js）。
 *
 * ## 它为什么存在
 * 「用真浏览器看一下网页」—— 有些页面**不用浏览器根本看不到内容**：
 * 图是 JS 拼出来的、还被 scramble 打乱、整页滚动按需加载。
 * 逆向前端 JS 能做但**一改就废**；真浏览器则全都免。
 *
 * ## 为什么自己写而不用 puppeteer
 * whale-pod 是**零依赖**的（package.json 里 dependencies 是空的），
 * 装 puppeteer 会拖进一两百兆。而 CDP 只要一个 WebSocket ——
 * **Node 22+ 自带 `WebSocket`** ✓
 *
 * ## ⚠️ 这个文件里有两次真实的翻车，测试把它们钉住
 *
 * ### ① 忘了带 `sessionId` → `'Runtime.evaluate' wasn't found`
 * 用 `Target.attachToTarget({flatten:true})` 建的会话，**页面级命令必须带
 * `sessionId`**。不带就被当成浏览器级命令，于是报"这个方法不存在" ——
 * **看着像 CDP 版本不支持，其实是会话没对上。**
 * 现在用 `PageHandle` 把 sessionId 藏起来，调用点写不出这个错。
 *
 * ### ② 只 `createTarget({url})` 不等于加载完
 * 拿到 `title: ''`、`imgs: 0`，看着像"页面是空的"，其实是**还没开始加载**。
 * 现在有 `goto()`：显式 `Page.navigate` + 轮询 `document.readyState`。
 *
 * ### ③ ★ 最严重的一次：**按进程名杀浏览器，把用户自己的 Edge 全关了**
 * 那不是这个文件里的代码，是我在 PowerShell 探针里写了
 * `Get-Process msedge | ... | Stop-Process` 想清自己的探针 ——
 * 而用户自己的 Edge 用的是同一个 exe，**被一起杀了**。
 * 现在收尾只走 `openBrowser().close()`：它**只 kill 自己 spawn 的 child**。
 * 下面有一条源码锁盯着"不许按进程名杀"。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { findBrowser } from '../src/gateway/browser.js'

const SRC = fs.readFileSync(new URL('../src/gateway/browser.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

ok('能找到一个 Chromium 内核浏览器（找不到也不许抛）', () => {
  const exe = findBrowser()
  // 这台机器上应有 Edge；但**别的机器没有也要能跑**，所以只断言返回类型
  assert.ok(exe === null || typeof exe === 'string', 'findBrowser 要么给路径要么给 null')
  console.log(`      （本机：${exe ?? '没找到'}）`)
})

ok('★★★ 源码锁：绝不允许**按进程名**杀浏览器', () => {
  /*
   * 这条是那次事故的直接教训：把用户的 Edge 全关了。
   * 收尾只能 kill 自己 spawn 的那个 child。
   */
  const danger = [
    [/taskkill/i, 'taskkill'],
    [/Stop-Process/i, 'Stop-Process'],
    [/Get-Process\s+\w*edge/i, 'Get-Process edge'],
    [/pkill\s/i, 'pkill'],
    [/killall\s/i, 'killall'],
  ]
  for (const [re, what] of danger) {
    assert.ok(!re.test(SRC), `不许出现 ${what} —— 那会杀掉用户自己的浏览器`)
  }
  assert.match(SRC, /child\.kill\(/, '收尾要 kill **自己 spawn 的那个 child**')
})

ok('★★ 源码锁：页面级命令必须带 sessionId（不然报 \'wasn\'t found\'）', () => {
  // PageHandle 必须把 sessionId 传下去
  assert.match(SRC, /class PageHandle/, '要有 PageHandle')
  assert.match(SRC, /send\(method, params = \{\}, timeoutMs = 30000, sessionId = null\)/,
    'Cdp.send 要收 sessionId 参数')
  assert.match(SRC, /payload\.sessionId = sessionId/, '要真的放进报文里')
  // enable 那两个也是页面级的
  assert.match(SRC, /cdp\.send\('Page\.enable', \{\}, 10000, sessionId\)/, 'Page.enable 要带 sessionId')
  assert.match(SRC, /cdp\.send\('Runtime\.enable', \{\}, 10000, sessionId\)/, 'Runtime.enable 要带 sessionId')
})

ok('★★ 源码锁：goto 必须等就绪，不能只 createTarget', () => {
  assert.match(SRC, /Page\.navigate/, '要显式导航')
  assert.match(SRC, /document\.readyState/, '要轮询就绪状态')
})

ok('★★ 「看完就扔」：临时 profile 必须删掉，删不掉要留标记而不是死等', () => {
  assert.match(SRC, /mkdtempSync/, '要用临时目录')
  assert.match(SRC, /rmSync\(profileDir/, '收尾要删掉它')
  // 删不掉时不许无限重试
  const m = /for \(let i = 0; i < (\d+); i\+\+\)/.exec(SRC)
  assert.ok(m, '删不掉要有重试上限')
  assert.ok(Number(m[1]) <= 10, `重试 ${m[1]} 次太多了 —— 会拖住关停`)
  assert.match(SRC, /delete-me/, '删不掉要留标记（下次再删），不能死等')
})

ok('★ 零依赖：不许引 puppeteer / playwright / ws', () => {
  for (const bad of ['puppeteer', 'playwright', 'chrome-remote-interface']) {
    assert.ok(!new RegExp(`from ['"]${bad}`, 'i').test(SRC), `不许引 ${bad}`)
  }
  assert.match(SRC, /new WebSocket\(/, '要用 Node **自带**的 WebSocket')
})

ok('★ 浏览器候选里必须有 Edge（这台机器只有 Edge，没装 Chrome）', () => {
  assert.match(SRC, /msedge\.exe/i, '候选里要有 Edge —— 实测这台机器只有它')
  assert.match(SRC, /WHALE_BROWSER_EXE/, '要能用环境变量指定')
})

// ── 能力上报 + 设置页写明依赖 ─────────────────────────────────
/*
 * ★★ 用户提的规矩（原话）：
 *    「在设置页面加功能就要写明需要其他插件」
 *
 * 有些功能**依赖本机装的东西**（不是 DSH 插件，是操作系统里的程序）。
 * 这类依赖必须：
 *   ① 后端**主动探测**并报出来（不能让界面猜）
 *   ② 设置页**如实显示**（缺就是缺，别美化、别静默失败）
 */
ok('★★★ 后端要主动探测浏览器能力并报出来', () => {
  const srv = fs.readFileSync(new URL('../src/web/server.js', import.meta.url), 'utf8')
  assert.match(srv, /function browserCapability\(/, '要有探测函数')
  assert.match(srv, /caps:\s*\{[\s\S]{0,80}browser:\s*browserCapability\(\)/,
    '/api/status 要报 caps.browser')
  // 探测只许 existsSync，**绝不许启动浏览器**（这接口调用很频繁）
  const at = srv.indexOf('function browserCapability()')
  const body = srv.slice(at, srv.indexOf('\n}', at))
  assert.ok(!/openBrowser|spawn\(/.test(body), '探测里不许启动浏览器 —— 接口会被频繁调用')
})

ok('★★★ 设置页必须有一节写明这个依赖，并显示实测结果', () => {
  const c = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  assert.match(c, /'section\.deps'/, '要有「功能依赖」那一节的标题')
  assert.match(c, /'deps\.browserHint'[^\n]*Edge|'deps\.browserHint'[^\n]*Chrome/,
    '提示里要**明写需要 Edge 或 Chrome**')
  assert.match(c, /status\?\.caps\?\.browser\?\.ok/, '要真读后端报的 caps')
  assert.match(c, /deps\.browserMissing/, '缺的时候要有明确的"用不了"')
})

ok('★★ 依赖的文案中英都要有（别只写中文）', () => {
  const c = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')
  for (const key of ['section.deps', 'deps.browser', 'deps.browserHint', 'deps.browserOk', 'deps.browserMissing']) {
    const n = (c.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) ?? []).length
    assert.ok(n >= 2, `${key} 要中英各一份（找到 ${n} 份）`)
  }
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)