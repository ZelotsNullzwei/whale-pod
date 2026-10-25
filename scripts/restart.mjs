/**
 * 无窗口重启 WhalePod。
 *
 * 用法：node scripts/restart.mjs
 *
 * ## 为什么要写这个脚本
 *
 * 2026-10-24 手动重启用错了方式，在用户桌面上留下了两个控制台窗口
 * （一个标题是 "WhalePod"）。踩过的三种错误方式：
 *
 *   ✗ Start-Process WhalePod.bat            → .bat 会拉起自己的控制台
 *   ✗ cmd start "WhalePod" /MIN cmd /c ...  → /MIN 就是「最小化窗口」，必然留窗
 *   ✗ ensureRunning()（daemon.js）           → detached:false，父进程退出时
 *                                              Windows 连带杀整棵树 → 机器人跟着死
 *
 * ## 正确方式（本脚本）
 *
 *   spawn(node, [...], {
 *     detached: true,        // 脱离父进程，pwsh 退出后自己活着
 *     windowsHide: true,     // 不创建窗口
 *     stdio: ['ignore', fd, fd],  // 输出重定向到日志文件，不占用控制台
 *   })
 *   child.unref()            // 不等待
 *
 * 三者缺一不可：
 *   · 少了 detached → 父进程退出时被连带杀掉
 *   · 少了 windowsHide → 弹窗
 *   · 少了 stdio 重定向 → node 因 stdout 管道断开而退出
 */

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(here, '..')
const HOME = process.env.WHALE_POD_HOME
  ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'whale-pod')
const WEB_PORT = 18898
const LOG = path.join(HOME, 'whale-pod.log')

/** 18898 是否在监听（= 后端活着）。 */
function isAlive(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: WEB_PORT })
    const done = (v) => { try { sock.destroy() } catch {} ; resolve(v) }
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
    sock.setTimeout(timeoutMs, () => done(false))
  })
}

/** 找系统 node —— 不能用 process.execPath（在 DSH 宿主里它是 electron）。 */
function findNode() {
  const candidates = [
    'C:/Program Files/nodejs/node.exe',
    'C:/Program Files (x86)/nodejs/node.exe',
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first && fs.existsSync(first)) return first
  } catch { /* 落到下一行 */ }
  throw new Error('找不到 node.exe')
}

/** 杀掉当前后端（按端口反查 PID，避免误伤别的 node 进程）。
 *
 * ⚠️ 用 taskkill /T 而不是手写递归收集子进程。
 *    踩过的坑（2026-10-24）：PowerShell 里 `$queue[1..0]` 在 Count=1 时
 *    返回**两个**元素（倒序索引），队列永远不空 → 死循环。
 *    taskkill 的 /T 是原生行为，直接杀整棵树，可靠且不会写错。
 */
function killExisting() {
  try {
    const ps = `(Get-NetTCPConnection -LocalPort ${WEB_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    }).trim()
    const pid = Number(out)
    if (!pid || Number.isNaN(pid)) return '没有在运行'

    // /T 杀进程树（含 NapCat 子进程），/F 强制
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return `已停止 PID ${pid} 及其子树（taskkill /T /F）`
  } catch (e) {
    // taskkill 在进程已退出时会返回非零，不算失败
    const msg = String(e.message ?? e)
    if (/not found|没有找到|already/i.test(msg)) return '进程已自行退出'
    return `清理异常: ${msg.slice(0, 100)}`
  }
}

const force = process.argv.includes('--force')

console.log('=== WhalePod 无窗口重启 ===')
console.log(`  仓库: ${REPO}`)
console.log(`  数据: ${HOME}`)

if (await isAlive()) {
  if (!force) {
    console.log('\n  后端已在运行。要强制重启请加 --force')
    process.exit(0)
  }
  console.log('\n  停掉现有进程…')
  console.log(`  ${killExisting()}`)
  // 等端口释放，最多 10s
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (!(await isAlive(300))) break
  }
  if (await isAlive(300)) { console.error('  ❌ 端口仍被占用，放弃'); process.exit(1) }
  console.log('  端口已释放')
}

const node = findNode()
const entry = path.join(REPO, 'src', 'index.js')
if (!fs.existsSync(entry)) { console.error(`❌ 入口不存在：${entry}`); process.exit(1) }

/**
 * 找 DSH 安装目录。
 *
 * ⚠️ 2026-10-25 踩的坑：不传 `--dsh-app` 时，index.js 里的
 *    `findDshAppDir(undefined)` 自动探测**会失败**（它只认几种固定位置），
 *    结果是拿不到 DSH 的渠道包 → 日志里没有「DSH：<路径>」那行 →
 *    接着报「还没有配置供应商 / 没有可用的 LLM 渠道」→ 启动失败。
 *
 *    症状极具误导性：看着像用户的 API Key 没了，其实是路径没传。
 *    成功启动的日志里一定有 `DSH：D:/DSH Desktop/resources/app` 这一行。
 */
function findDshApp() {
  const candidates = [
    process.env.DSH_APP_DIR,
    'D:/DSH Desktop/resources/app',
    'C:/Program Files/DSH Desktop/resources/app',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs/DSH Desktop/resources/app'),
  ].filter(Boolean)
  for (const c of candidates) {
    // 认 resources/app 下的 package.json，光有目录不够
    if (c && fs.existsSync(path.join(c, 'package.json'))) return c
  }
  return null
}

const dshApp = findDshApp()
if (dshApp) console.log(`  DSH: ${dshApp}`)
else console.log('  ⚠️ 没找到 DSH 安装目录 —— LLM 渠道可能挂不上（可用 DSH_APP_DIR 环境变量指定）')

// 输出追加到日志文件（和程序自身的日志同一个文件）
const fd = fs.openSync(LOG, 'a')

console.log('\n  启动（detached + windowsHide + stdio 重定向）…')
const args = [
  entry,
  '--daemon', '--hosted', '--no-tray',
  '--home', HOME,
]
// 只有真的找到了才传，传个不存在的路径会让 findDshAppDir 直接返回空
if (dshApp) args.push('--dsh-app', dshApp)

const child = spawn(node, args, {
  cwd: REPO,
  detached: true,
  windowsHide: true,          // ← 窗口问题的关键
  stdio: ['ignore', fd, fd],  // ← 不占控制台，也不因管道断开而死
})
child.unref()
console.log(`  pid ${child.pid}`)

// 等就绪
let ready = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  if (await isAlive()) { ready = true; console.log(`  ✅ 18898 就绪（${i + 1}s）`); break }
}
fs.closeSync(fd)

if (!ready) {
  console.error('  ❌ 40s 内未就绪，检查日志：')
  console.error(`     ${LOG}`)
  process.exit(1)
}

// 确认进程真的脱离了（父进程已退出但自己还活着）
await new Promise((r) => setTimeout(r, 3000))
const stillUp = await isAlive()
console.log(`  脱离验证: ${stillUp ? '✅ 父进程退出后仍存活' : '❌ 已退出'}`)
console.log('\n完成。窗口不会出现。')
process.exit(stillUp ? 0 : 1)