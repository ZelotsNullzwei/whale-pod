/**
 * 一次性登录工具：用**链接兜底同一份持久 profile** 打开有界面的浏览器，
 * 你手动登录后按回车关闭。之后无头渲染就会带上这份 cookie。
 *
 * 用法：
 *   node scripts/login-site.mjs                        # 默认打开小黑盒首页
 *   node scripts/login-site.mjs https://www.xiaoheihe.cn/app/bbs/link/183753665
 *
 * ⚠️ 同一个 profile 同一时刻只能开一个浏览器：
 *    守护进程正在做「链接渲染兜底」时别跑这个脚本（等几秒再跑，或先停鲸舱）。
 */
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { openBrowser, newPage, closePage } from '../src/gateway/browser.js'

const HOME = process.env.WHALE_POD_HOME
  ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'whale-pod')
const profileDir = path.join(HOME, 'browser-profile')
// ⚠️ 参数里可能带 --auto：网址取**第一个不以 -- 开头**的
const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'https://www.xiaoheihe.cn/'

console.log(`profile: ${profileDir}`)
console.log(`打开: ${url}\n`)

const bot = await openBrowser({
  headless: false,
  profileDir,
  width: 1200,
  height: 900,
  log: (lv, m) => console.log(`  [${lv}] ${m}`),
})
if (!bot) {
  console.error('❌ 没找到 Chrome / Edge —— 装一个再试')
  process.exit(1)
}

let page = null
try {
  // ★ 直接带着网址开标签页（headed + 新 profile 时，先开 blank 再 goto 会停在黑页）
  page = await newPage(bot.cdp, url)
  const ok = await page.goto(url, 30_000)
  console.log('导航结果:', ok, '| 当前地址:', await page.eval('location.href'))
  if (!ok) console.log('⚠️ 页面加载超时，但窗口还在 —— 你自己刷新一下也行')
  console.log('\n浏览器窗口已打开。请在里面完成登录（扫码/账号密码都行）。')

  if (process.argv.includes('--auto')) {
    /*
     * ★ 自动模式：每 2 秒查一次 cookie / 页面文案，登录成功就自动关。
     *   不用回车（用户可能不在终端前，或者窗口是 agent 帮着开的）。
     */
    console.log('（自动模式：检测到登录后会自动关闭，最多等 5 分钟）\n')
    const t0 = Date.now()
    for (;;) {
      if (Date.now() - t0 > 5 * 60_000) { console.log('⚠️ 等太久，先关了（没检测到登录）'); break }
      try {
        const got = await bot.cdp.send('Network.getAllCookies', {})
        const list = Array.isArray(got?.cookies) ? got.cookies : []
        const hit = list.filter((c) => /xiaoheihe|heybox/i.test(String(c.domain ?? ''))
          && /id|token|session|auth|login/i.test(String(c.name ?? ''))
          && String(c.value ?? '').length > 8)
        if (hit.length > 0) { console.log(`✅ 检测到登录 cookie：${hit.map((c) => c.name).join(', ')}`); break }
      } catch { /* 下一轮再试 */ }
      try {
        const marker = await page.eval('/退出|个人中心|我的主页|消息中心/.test(document.body ? document.body.innerText : "")')
        if (marker === true) { console.log('✅ 页面出现已登录标记（退出/个人中心）'); break }
      } catch { /* 下一轮再试 */ }
      await new Promise((r) => setTimeout(r, 2000))
    }
  } else {
    console.log('登录完成后，回到这个终端按回车关闭浏览器。\n')
    await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question('登录好了就按回车 > ', () => { rl.close(); resolve() })
    })
  }

  try {
    const got = await bot.cdp.send('Network.getAllCookies', {})
    const list = Array.isArray(got?.cookies) ? got.cookies : []
    const target = list.filter((c) => /xiaoheihe|heybox/i.test(String(c.domain ?? '')))
    console.log(`\n✅ 已保存 cookie：小黑盒域 ${target.length} 个（值不打印）`)
    if (target.length === 0) {
      console.log('⚠️ 没抓到小黑盒 cookie —— 可能没登录成功，或者登录的是别的站')
    }
  } catch (e) {
    console.log(`\n（cookie 检查失败，不影响保存：${String(e?.message ?? e).slice(0, 60)}）`)
  }
} finally {
  if (page) await closePage(bot.cdp, page).catch(() => {})
  await bot.close().catch(() => {})
}
console.log(`\nprofile 已留在：${profileDir}`)
console.log('以后链接兜底会自动带上这份登录态。')
process.exit(0)