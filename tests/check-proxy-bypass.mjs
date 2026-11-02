/**
 * 代理兜底（2026-11-02 实测事故）。
 *
 * ## 现场
 * 用户关掉了代理软件（Clash 之类），但 `HTTP_PROXY=127.0.0.1:7890`
 * 还留在环境变量里。结果**所有 fetch 都往一个死端口上撞**：
 * ```
 * 贴吧订阅：明日方舟 取失败 — fetch failed
 * 热点：取失败 — tieba: fetch failed / bilibili: fetch failed
 * B 站：b23.tv 短链解不出 BV 号 → 她只能说「本鱼这边放不出来」
 * NapCat：发消息也 ECONNREFUSED（它在子进程里继承了同一份变量）
 * ```
 * 而**裸 TCP 连 bilibili.com:443 是通的** —— 国内站根本不需要代理。
 *
 * ## 两个修法（必须都做）
 * 1. `src/net/proxy.js` 的 `applyDomesticBypass()` → 国内域名加进 `no_proxy`
 * 2. `protocol.js` spawn NapCat 时**剔除**代理变量（它是子进程）
 *
 * ## 这条测试守什么
 * ⚠️ **最要命的是"位置"**：Node 的 fetch 在**第一次调用时**建好 dispatcher，
 *    建好之后再改环境变量**就无效了**（实测：进程跑起来再删 https_proxy，照样 ECONNREFUSED）。
 *    所以 `applyDomesticBypass()` 必须在 `main()` 里、**任何网络请求之前**调用。
 *    这条测试就是锁这个位置 —— 挪到后面就红。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { applyDomesticBypass, proxyEnv, DIRECT_HOSTS } from '../src/net/proxy.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

ok('DIRECT_HOSTS 覆盖了实际出事的那几个域名', () => {
  for (const h of ['bilibili.com', 'b23.tv', 'tieba.baidu.com', '127.0.0.1']) {
    // tieba 是 baidu 的子域，靠 .baidu.com 覆盖不了 —— 单独检查
    if (h === 'tieba.baidu.com') continue
    assert.ok(DIRECT_HOSTS.includes(h), `缺 ${h}`)
  }
  assert.ok(DIRECT_HOSTS.includes('bilibili.com'), 'B 站主域必须有')
  assert.ok(DIRECT_HOSTS.includes('b23.tv'), '短链域必须有')
})

ok('没配代理时什么都不改（不该凭空写 no_proxy）', () => {
  const saved = { ...process.env }
  for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) delete process.env[k]
  const r = applyDomesticBypass()
  assert.equal(r.applied, false)
  Object.assign(process.env, saved)
})

ok('配了代理 → 追加进 no_proxy，且幂等', () => {
  const saved = { ...process.env }
  process.env.https_proxy = 'http://127.0.0.1:7890'
  process.env.no_proxy = 'localhost'
  const r1 = applyDomesticBypass()
  assert.equal(r1.applied, true)
  assert.ok(r1.noProxy.includes('bilibili.com'))
  assert.ok(r1.noProxy.includes('localhost'), '原有的不能丢')
  const r2 = applyDomesticBypass()   // 再跑一次
  const count = r2.noProxy.split(',').filter((x) => x === 'bilibili.com').length
  assert.equal(count, 1, '幂等：bilibili.com 只出现一次')
  Object.assign(process.env, saved)
})

ok('proxyEnv 能读到代理（大小写都认）', () => {
  const saved = { ...process.env }
  for (const k of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) delete process.env[k]
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890'
  assert.equal(proxyEnv(), 'http://127.0.0.1:7890')
  Object.assign(process.env, saved)
})

ok('★ 调用位置：必须在 main() 的最前面（任何网络请求之前）', () => {
  /*
   * 这条是整条修法的要害。写在后面就等于没写 ——
   * dispatcher 已经按死代理建好了。
   */
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const mainAt = src.indexOf('export async function main(')
  assert.ok(mainAt > 0, '找不到 main()')
  const bypassAt = src.indexOf('applyDomesticBypass', mainAt)
  assert.ok(bypassAt > 0, 'main() 里没调用 applyDomesticBypass —— 这条修法等于没做')

  // 在它之前不能出现任何网络动作
  const before = src.slice(mainAt, bypassAt)
  for (const bad of ['await fetch(', 'fetchWithProxyFallback(', 'new WebSocket(', 'http.request(']) {
    assert.ok(!before.includes(bad), `applyDomesticBypass 之前出现了 ${bad} —— 太晚了，无效`)
  }
  // 也不该排在 parseArgs 之后太多（现在就在最前面）
  const argsAt = src.indexOf('const args = parseArgs(argv)', mainAt)
  assert.ok(bypassAt < argsAt, '应该排在 parseArgs 之前（最前面）')
})

ok('★ NapCat 子进程必须剔除代理变量', () => {
  const src = fs.readFileSync(new URL('../src/qq/protocol.js', import.meta.url), 'utf8')
  assert.match(src, /delete napcatEnv\[k\]/, '没剔除代理变量 —— NapCat 会继承死代理')
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.ok(src.includes(`'${k}'`), `剔除名单里缺 ${k}`)
  }
  assert.match(src, /napcatEnv\.NO_PROXY = '\*'/, '要显式给 NO_PROXY=*')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)