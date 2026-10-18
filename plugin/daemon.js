/**
 * WhalePod 守护启动器（dsh-whale-pod 插件的运行时部件）。
 *
 * 职责只有一个：保证 `node whale-pod/src/index.js --daemon` 活着。
 *   · detached spawn —— 进程脱离 DSH，DSH 重启不掉线
 *   · 心跳检测 —— WhalePod 死了自动拉起（指数退避，防 crash loop）
 *   · 就绪探测 —— 等 HTTP 端口真的开始服务再报告
 *
 * 为什么不用 worker/fork：QQ 连接和 NapCat 子进程必须独立于 DSH 生命周期。
 *
 * @module daemon.js
 */

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 核心运行时的根目录（含 src/index.js 的那个）。
 *
 * ## 为什么要有回退
 *
 * 历史布局是「核心与插件是相邻的两个兄弟目录」：
 *
 *     D:\DSH WorkSpace\whale-pod\          ← 核心
 *     D:\DSH WorkSpace\whale-pod-plugin\   ← 插件
 *
 * 那时 `here/../whale-pod` 正好命中。现在插件搬进了核心仓库里：
 *
 *     D:\DSH WorkSpace\whale-pod\          ← 仓库根 = 核心根
 *     D:\DSH WorkSpace\whale-pod\plugin\   ← 插件
 *
 * 于是 `here/../whale-pod` 会解析成 `whale-pod/plugin/../whale-pod`
 * 即 `whale-pod/whale-pod`，**不存在** —— 插件会报「入口不存在」起不来。
 *
 * 所以按「谁真的含 src/index.js」来判断，两种布局都支持：
 *   1. 仓库内布局：here/..            → <repo>/src/index.js
 *   2. 兄弟目录布局：here/../whale-pod → <sibling>/src/index.js
 *
 * 这样既能在仓库里直接跑，也不破坏老的外部链接安装。
 */
const WHALE_POD_ROOT = (() => {
  const candidates = [
    path.resolve(here, '..'),                 // 仓库内：<repo>/plugin → <repo>
    path.resolve(here, '..', 'whale-pod'),    // 兄弟目录（历史布局）
  ]
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'src', 'index.js'))) return dir
    } catch { /* 下一个 */ }
  }
  return candidates[0]   // 都不命中时回退到仓库内布局，让报错信息更有指向性
})()

/** WhalePod 自己的 Web/API 端口（旧版默认 18898）。 */
export const WHALE_POD_WEB_PORT = 18898

let child = null
let starting = false
let failCount = 0
let lastStartAt = 0

/**
 * 找一个能跑脚本的 node 可执行文件。
 *
 * process.execPath 在 DSH 宿主里是 electron.exe —— 直接用它只会拉起
 * 另一个 GUI 实例。真实 node 按 this 顺序找：
 *   1. 系统 PATH 里的 node
 *   2. DSH Desktop 自带的 node（packages 里带 node.exe 的位置）
 *   3. 退回 process.execPath（总得试一个；独立测试环境里它就是 node）
 */
function findNodeExe() {
  const exe = process.execPath
  if (/node(?:\.exe)?$/i.test(exe)) return { exe, env: process.env }

  // In the packaged DSH host, PATH may not include the user's system Node.
  // Probe the normal Windows install locations before falling back to Electron.
  const candidates = process.platform === 'win32'
    ? [
        process.env.NODE_EXE,
        path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
        path.join(process.env.ProgramFiles_x86 ?? 'C:\\Program Files (x86)', 'nodejs', 'node.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs', 'node.exe'),
      ].filter(Boolean)
    : []
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { exe: candidate, env: process.env } } catch { /* try next */ }
  }

  // Last resort: Electron can run its embedded Node runtime when explicitly told.
  // Do not launch an Electron GUI accidentally; without this env flag the daemon entry
  // would be interpreted as app arguments instead of a JavaScript script.
  try {
    const where = process.platform === 'win32'
      ? execFileSync('where', ['node'], { encoding: 'utf8', timeout: 3000 }).split(/\r?\n/)[0].trim()
      : execFileSync('which', ['node'], { encoding: 'utf8', timeout: 3000 }).trim()
    if (where && fs.existsSync(where)) return { exe: where, env: process.env }
  } catch { /* PATH lookup unavailable */ }

  return { exe, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
}

/** WhalePod 的 HTTP 是否在服务。 */
export function isAlive(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: WHALE_POD_WEB_PORT })
    const done = (v) => { try { sock.destroy() } catch { /* ignore */ } resolve(v) }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/**
 * 列出后端相关进程（供侧栏的「后端进程」窗口展示）。
 *
 * ## 为什么必须在插件层做，不能转发给 WhalePod
 *
 * 这个窗口最常见的用途就是"WhalePod 挂了，看看还有什么残留"。
 * 如果它自己也依赖 WhalePod，那就跟启动按钮一样死锁 ——
 * 想看进程时恰好是进程不在的时候。
 *
 * ## 分类
 *
 * 按命令行特征区分三种：
 *   whale-pod —— `whale-pod/src/index.js`（守护进程本体）
 *   napcat    —— `whale-pod/protocol/napcat/*`（协议端，可能是 launcher + core 两个）
 *   other     —— 其它 node 进程里提到 whale-pod 的（少数情况）
 *
 * @returns {Promise<Array<{pid:number, kind:string, startedAt:string|null, memMB:number|null, cmd:string}>>}
 */
export async function listProcesses() {
  const out = []
  try {
    const { execFileSync } = await import('node:child_process')
    // 用 -EncodedCommand 太绕；这里只查 node 进程 + 命令行 + 启动时间 + 内存
    const raw = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'whale-pod' } | " +
      "Select-Object ProcessId,CommandLine,CreationDate,WorkingSetSize | " +
      'ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 15_000 }).trim()

    if (!raw) return out
    let list
    try { list = JSON.parse(raw) } catch { return out }
    if (!Array.isArray(list)) list = [list]

    for (const p of list) {
      const cmd = String(p.CommandLine ?? '')
      let kind = 'other'
      // 分类标签统一用 whale-pod / napcat，前端据此显示
      if (/whale-pod[\\/]src[\\/]index\.js/.test(cmd)) kind = 'whale-pod'
      else if (/whale-pod[\\/]protocol[\\/]napcat/.test(cmd)) kind = 'napcat'
      // CreationDate 是 CIM 的日期，可能已被 JSON 化成 /Date(...)/ 或 ISO 串
      let startedAt = null
      const cd = p.CreationDate
      if (typeof cd === 'string') {
        const m = /\/Date\((\d+)\)\//.exec(cd)
        startedAt = m ? new Date(Number(m[1])).toISOString() : (cd.includes('T') ? cd : null)
      }
      out.push({
        pid: Number(p.ProcessId),
        kind,
        startedAt,
        memMB: p.WorkingSetSize ? Math.round(Number(p.WorkingSetSize) / 1048576) : null,
        // 只回特征片段，别把整条命令行（可能含 token）发到前端
        cmd: cmd.replace(/--home\s+\S+/g, '--home <home>').slice(0, 160),
      })
    }
  } catch { /* 查询失败就当没有进程 */ }
  // whale-pod 在最前，napcat 次之
  out.sort((a, b) => (a.kind === 'whale-pod' ? 0 : a.kind === 'napcat' ? 1 : 2)
    - (b.kind === 'whale-pod' ? 0 : b.kind === 'napcat' ? 1 : 2))
  return out
}

/**
 * 确保 WhalePod 进程在跑。已在服务 → 立刻返回；没在 → 启动并等就绪。
 * @param {object} [opts]
 * @param {string} [opts.home]      WhalePod 数据目录
 * @param {object} [opts.log]
 * @param {number} [opts.readyTimeoutMs]
 * @returns {Promise<{started:boolean, already:boolean, pid:number|null}>}
 */
export async function ensureRunning(opts = {}) {
  const log = opts.log ?? {}
  if (await isAlive()) return { started: false, already: true, pid: child?.pid ?? null }
  if (starting) return { started: false, already: false, pid: null }

  const entry = path.join(WHALE_POD_ROOT, 'src', 'index.js')
  if (!fs.existsSync(entry)) throw new Error(`WhalePod 入口不存在：${entry}`)

  starting = true
  try {
    // ── 指数退避：1 分钟内崩 3 次以上就先歇 30 秒，防 crash loop ──
    const now = Date.now()
    if (now - lastStartAt < 60_000 && failCount >= 3) {
      log.warn?.(`WhalePod 短时间崩溃 ${failCount} 次，冷却 30 秒后再试`)
      await new Promise((r) => setTimeout(r, 30_000))
    }
    if (now - lastStartAt >= 60_000) failCount = 0
    lastStartAt = now

    const args = [entry, '--daemon', '--no-tray', '--home', opts.home ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh'), 'whale-pod')]
    // ⚠️ 不能用 process.execPath —— DSH 宿主里它是 electron.exe（不带 ELECTRON_RUN_AS_NODE
    //    时启动的是 GUI 而不是脚本，端口永远不监听 → 守护器误报"启动超时"）。
    //    优先系统 node；其次 DSH 自带的 node（desktop-runtime 里）。
    const node = findNodeExe()

    // ── 关于 detached：**必须是 false** ───────────────────────────
    //
    // 早期用 detached: true + unref()，意图是「DSH 重启时机器人不掉线」。
    // 实测发现这条路彻底走不通：
    //
    //   ① 宿主的退出有 5s 超时强杀（见 main.js 的 createDesktopShutdown），
    //      而 dispose 要串行跑完所有插件，我们的清理经常轮不上。
    //   ② 实测 2026-10-18 连续多次重启，`ctx.effect` 注册的清理函数
    //      **一次都没被调用**（宿主日志里连一行都没有）。
    //   ③ 于是 detached 的进程失去唯一的清理途径 —— 关了 DSH，
    //      机器人永远在线、18898/3001 一直占着。
    //
    // 改成 detached: false 后，后端作为宿主的**普通子进程**存在：
    // 宿主以任何方式退出（正常关闭 / 任务管理器 / 崩溃），Windows 都会
    // 连带结束整棵进程树。不依赖任何钩子，也不需要额外的监控逻辑。
    //
    // 代价是「机器人 24 小时在线」这个能力没有了 —— 但那本来就该由
    // 独立启动（双击 bat）承担，不该让 DSH 的子进程去兼。
    child = spawn(node.exe, args, {
      detached: false,
      windowsHide: true,
      stdio: 'ignore',
      cwd: WHALE_POD_ROOT,
      env: node.env,
    })
    log.info?.(`WhalePod 守护进程已启动（pid ${child.pid}）`)

    // ── 等就绪 ──────────────────────────────────────────────────
    const deadline = Date.now() + (opts.readyTimeoutMs ?? 25_000)
    while (Date.now() < deadline) {
      if (await isAlive(800)) {
        failCount = 0
        log.info?.('WhalePod 已就绪')
        return { started: true, already: false, pid: child.pid }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('WhalePod 启动超时（25 秒内端口未监听）')
  } finally {
    starting = false
  }
}

/**
 * 停止 WhalePod（给插件的退出钩子 / stop 按钮用）。
 *
 * ## 为什么不能只 kill `child`
 *
 * `child` 只指向**本进程启动的那一个** WhalePod。实际有好几种来源：
 *   · 用户手动双击 `启动 WhalePod（无窗口）.vbs`
 *   · 上一次 DSH 启动的（DSH 重启后 `child` 变量是空的）
 *   · 命令行直接跑的
 * 这些情况下 `child` 是 null，只 kill 它等于什么都没做 ——
 * 用户关了 DSH 发现 QQ 还在线、18898 还开着。
 *
 * 所以按**命令行特征**扫一遍：找 `whale-pod/src/index.js` 且带 `--daemon`
 * 的 node 进程，连它拉起的 NapCat 一起停。这正是"完全关闭"该做的事。
 *
 * @param {{log?:object, timeoutMs?:number}} [opts]
 * @returns {Promise<{stopped:boolean, count:number}>}
 */
export async function stopDaemon(opts = {}) {
  const log = opts.log
  let count = 0

  // ① 本进程持有的子进程
  if (child && !child.killed) {
    try { child.kill() } catch { /* ignore */ }
    count++
  }
  child = null

  // ② 按命令行特征找残余的 WhalePod / NapCat
  //    只认明确属于 WhalePod 的路径，避免误杀别人的 node 进程。
  try {
    const { execFileSync } = await import('node:child_process')
    const ps = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'whale-pod[\\\\/]src[\\\\/]index\\.js|whale-pod[\\\\/]protocol[\\\\/]napcat' } | " +
      "ForEach-Object { $_.ProcessId }"], { encoding: 'utf8', timeout: 15_000 })
    const pids = ps.trim().split(/\s+/).filter(Boolean)
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 })
        count++
        log?.info?.(`已结束 WhalePod 进程 pid ${pid}`)
      } catch { /* 可能已经退了 */ }
    }
  } catch (error) {
    log?.warn?.(`扫描 WhalePod 进程失败：${String(error?.message ?? error)}`)
  }

  // ③ 等端口真的释放（最多 5 秒），否则下次启动会撞 EADDRINUSE
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000)
  while (Date.now() < deadline) {
    if (!(await isAlive(600))) break
    await new Promise((r) => setTimeout(r, 300))
  }

  const still = await isAlive(800)
  return { stopped: !still, count }
}

/**
 * 同步版「彻底关闭」—— 专给宿主退出路径用。
 *
 * ## 为什么不能只 `child.kill()`
 *
 * `child` 只指向**本进程启动的那一个**。实际上后端可能是上一轮 DSH 起的、
 * 用户手动双击 bat 起的，这时 `child` 是空的，只 kill 它等于什么都没做。
 *
 * ## 为什么必须在**极短时间**内完成
 *
 * 宿主（DSH Desktop）的退出是有超时的：
 *
 *     function createDesktopShutdown(dispose, exit, timeoutMs = 5e3) {
 *       timeout = setTimeout(() => exitOnce(failureCode), timeoutMs)
 *       pending = Promise.resolve().then(dispose).then(() => exitOnce(code))
 *     }
 *
 * 也就是 **挂载 5 秒后无条件 exit**。而 `dispose` 要跑完**所有**插件的
 * cleanup，我们只是其中一个。所以本函数能用的时间远不到 5 秒 ——
 * 之前用同步 `taskkill` 逐个杀（每个约 1 秒、3 个进程 3 秒）会把它耗尽，
 * 结果就是"日志里一行都没有、进程还在"（19:29 那次实测）。
 *
 * 现在改成：
 *   ① 一次性把所有 PID 查出来（1 次 powershell）
 *   ② 用**一个** taskkill 命令同时结束它们（支持多 /PID）
 *   ③ 不等待、不校验、不轮询 —— 退出路径上没时间做这些
 *
 * 全程 2 个进程调用，通常 200–400ms 完成。
 *
 * @param {{log?:object}} [opts]
 * @returns {{killed:number, pids:number[]}}
 */
export function killDaemonSync(opts = {}) {
  const log = opts.log
  const pids = []

  // ① 我们 spawn 的那个 child（无论后面扫不扫得到，先杀掉）
  const ownPid = child?.pid
  if (child && !child.killed) {
    try { child.kill() } catch { /* ignore */ }
  }
  child = null

  // ② 一次查出所有相关 PID
  const found = []
  const push = (pid) => {
    const n = Number(pid)
    if (Number.isFinite(n) && n > 0 && !found.includes(n)) found.push(n)
  }
  if (ownPid) push(ownPid)

  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'whale-pod[\\\\/]src[\\\\/]index\\.js|whale-pod[\\\\/]protocol[\\\\/]napcat' } | " +
      "ForEach-Object { $_.ProcessId }",
    ], { encoding: 'utf8', timeout: 3000 })
    for (const pid of String(out).trim().split(/\s+/).filter(Boolean)) push(pid)
  } catch (error) {
    log?.warn?.(`扫描 WhalePod 进程失败：${String(error?.message ?? error)}`)
  }

  if (found.length === 0) return { killed: 0, pids: [] }

  // ③ 一条 taskkill 命令杀掉全部（/T 连带子进程树）
  //
  //    taskkill 支持重复 /PID：`taskkill /PID 1 /PID 2 /T /F`
  //    这比循环调用快得多，而且不会因为某一个卡住而拖慢整体。
  const args = []
  for (const pid of found) args.push('/PID', String(pid))
  args.push('/T', '/F')

  try {
    execFileSync('taskkill', args, { stdio: 'ignore', timeout: 3000 })
    return { killed: found.length, pids: found }
  } catch {
    // taskkill 在多 PID 时只要有一个失败就返回非 0，但通常其它已经杀了。
    // 退出路径没时间重试，如实报告尝试过的 PID 即可。
    return { killed: 0, pids: found }
  }
}

/** 守护进程的启动参数：--daemon 在旧版 index.js 中定义。 */
export const DAEMON_ARGS_NOTE = '--daemon: 无托盘、无独立窗口、Web UI 保留（DSH 插件透传用）'
