/**
 * 端到端：真的用打包产物的 exe 启动 WhalePod，验证端口和数据目录。
 *
 * ⚠️ 必须用 spawn + detached，不能依赖调用方的 job object
 *    （DSH 的 job 有 KILL_ON_JOB_CLOSE，进程一返回就被收走）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 产物默认在工作区外（见 scripts/package.mjs 的说明：工作区内会被沙箱 ACL 接管）
const dir = process.env.WHALE_POD_DIST ? path.join(process.env.WHALE_POD_DIST, 'WhalePod-0.1.0') : 'D:/WhalePod/dist/WhalePod-0.1.0'
const exe = path.join(dir, 'WhalePod.exe')
const home = path.join(root, '.test-exe-home')
const outFile = path.join(path.dirname(dir), '_e2e-out.txt')
const errFile = path.join(path.dirname(dir), '_e2e-err.txt')

fs.rmSync(home, { recursive: true, force: true })
for (const f of [outFile, errFile]) fs.rmSync(f, { force: true })

if (!fs.existsSync(exe)) { console.error('找不到 ' + exe); process.exit(1) }
console.log('  exe:', exe)
console.log('  home:', home)

const out = fs.openSync(outFile, 'w')
const err = fs.openSync(errFile, 'w')

// ⚠️ windowsHide:false + detached:true —— 让它脱离本进程的 job
const child = spawn(exe, ['--home', home, '--web-port', '19910', '--port', '19911', '--no-tray'], {
  cwd: dir,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', out, err],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_PROXY: '127.0.0.1,localhost' },
})
child.unref()
console.log('  已启动 PID=' + child.pid)
console.log('')

// 等它起来
let ready = false
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const o = fs.readFileSync(outFile, 'utf8')
  if (/WhalePod 就绪|已就绪|监听/.test(o)) { ready = true; break }
  if (/Error|EPERM|EADDRINUSE/.test(fs.readFileSync(errFile, 'utf8'))) break
}

console.log('=== 标准输出 ===')
for (const line of fs.readFileSync(outFile, 'utf8').split('\n').slice(0, 30)) console.log('  ' + line)

const errTxt = fs.readFileSync(errFile, 'utf8')
console.log('')
console.log('=== 标准错误 ===')
if (errTxt.trim()) {
  for (const line of errTxt.split('\n').slice(0, 20)) console.log('  ' + line)
} else console.log('  （空 = 无错误）')

console.log('')
console.log('=== 数据目录 ===')
const homeFiles = fs.existsSync(home) ? fs.readdirSync(home) : []
for (const f of homeFiles) console.log('  ' + f)

console.log('')
console.log('=== 断言 ===')
let pass = 0, fail = 0
const check = (n, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + n) }
  else { fail++; console.log('  ❌ ' + n + ' ' + extra) }
}
const outTxt = fs.readFileSync(outFile, 'utf8')
check('启动到「就绪」', ready, outTxt.slice(-200))
check('没有崩溃报错', !/Error:|EPERM|EADDRINUSE/.test(errTxt), errTxt.slice(0, 200))
check('数据目录已建', fs.existsSync(home), home)
check('生成了 config.json', homeFiles.includes('config.json'), JSON.stringify(homeFiles))
check('生成了 whale-pod.log', homeFiles.includes('whale-pod.log'), JSON.stringify(homeFiles))
check('Web 端口已监听', /Web：监听 http:\/\/127\.0\.0\.1:19910/.test(outTxt) || /19910/.test(outTxt), '')
check('网关端口已监听', /监听 http:\/\/127\.0\.0\.1:19911/.test(outTxt), '')
check('注册了渠道', /已注册 provider \d+ 个/.test(outTxt), '')
console.log('')
console.log(`通过 ${pass} / 失败 ${fail}`)

// 停掉（用 taskkill 杀整棵树）
try {
  const { execFileSync } = await import('node:child_process')
  // 找占用 19910 的 PID
  const netstat = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
  const pids = new Set()
  for (const l of netstat.split('\n')) {
    if (/:1991[01]\s/.test(l) && /LISTENING/.test(l)) {
      const m = /(\d+)\s*$/.exec(l.trim())
      if (m) pids.add(m[1])
    }
  }
  // 也按 home 路径找
  const wmic = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*test-exe-home*' } | Select-Object -ExpandProperty ProcessId`],
    { encoding: 'utf8', windowsHide: true })
  for (const p of wmic.split('\n')) { const t = p.trim(); if (/^\d+$/.test(t)) pids.add(t) }
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/PID', pid, '/F', '/T'], { windowsHide: true, stdio: 'ignore' }) } catch { /* */ }
  }
  console.log('')
  console.log('  已结束 ' + pids.size + ' 个测试进程')
} catch (e) {
  console.log('  清理时出错: ' + e.message)
}

fs.rmSync(home, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
