/**
 * 验证 exe 启动器的**参数传递**是否正确。
 *
 * 用一个假的 entry 来测：造一个只打印 argv 的 src/index.js，
 * 然后看 exe 传过去的参数有没有被空格截断。
 *
 * ⚠️ 这个测试是必要的 —— 之前踩过坑：带空格的路径
 *    （"D:\DSH WorkSpace\..."）被截成 "D:\DSH"，
 *    导致 EPERM: mkdir 'D:\DSH'。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')) }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 放工作区外：工作区内的目录会被沙箱 ACL 接管（见 scripts/package.mjs）
const probe = path.join(process.env.TEMP ?? 'C:/Windows/Temp', 'whale-pod-launcher-probe')
fs.rmSync(probe, { recursive: true, force: true })
fs.mkdirSync(path.join(probe, 'src'), { recursive: true })

// 假的入口：把收到的参数写成 JSON
fs.writeFileSync(path.join(probe, 'src', 'index.js'), `
import fs from 'node:fs'
fs.writeFileSync(${JSON.stringify(path.join(probe, 'argv.json'))}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  entryDir: import.meta.dirname,
}, null, 2))
`)

// 单独编译一个指向本目录的启动器（复用 package.mjs 的 C# 源码）
const pkgSrc = fs.readFileSync(path.join(root, 'scripts', 'package.mjs'), 'utf8')
const m = /const LAUNCHER_CS = String\.raw`([\s\S]*?)`\r?\n/.exec(pkgSrc)
if (!m) { console.error('取不到 LAUNCHER_CS'); process.exit(1) }
const cs = path.join(probe, 'launcher.cs')
fs.writeFileSync(cs, m[1], 'utf8')

const csc = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
const exe = path.join(probe, 'WhalePod.exe')
execFileSync(csc, ['/nologo', '/target:exe', '/platform:anycpu', `/out:${exe}`,
  '/reference:System.dll', '/reference:System.Windows.Forms.dll', cs], { windowsHide: true })
console.log('  ✅ 编译出测试启动器')

// ── 0. 图标真的嵌进去了吗 ────────────────────────────────────
//
// ⚠️ 踩过的坑：package.mjs 里图标路径写成了 whale-pod.ico（实际是 icon.ico）→
//    文件不存在 → csc **不报错**、只是不嵌图标，于是"编译成功"但
//    exe 里一个图标资源都没有，资源管理器显示空白图标。
//    所以必须**独立校验**，不能靠"编译没报错"判断。
console.log('')
console.log('=== 0. exe 图标资源 ===')
{
  const assets = path.join(root, 'assets')
  const ico = ['icon.ico', 'whale-pod.ico', 'app.ico'].map((n) => path.join(assets, n)).find((p) => fs.existsSync(p))
  if (!ico) {
    console.log('  ⚠️ assets/ 下没有 .ico，跳过图标校验')
  } else {
    const exeIco = path.join(probe, 'WhalePod-icon.exe')
    execFileSync(csc, ['/nologo', '/target:exe', '/platform:anycpu', `/out:${exeIco}`,
      `/win32icon:${ico}`, '/reference:System.dll', '/reference:System.Windows.Forms.dll', cs], { windowsHide: true })
    const countPng = (p) => {
      const b = fs.readFileSync(p)
      let n = 0
      for (let i = 0; i + 8 < b.length; i++) {
        if (b[i] === 0x89 && b[i + 1] === 0x50 && b[i + 2] === 0x4e && b[i + 3] === 0x47) n++
      }
      return n
    }
    const withIcon = countPng(exeIco)
    const without = countPng(exe)
    check('图标没嵌进 exe（这是 bug）', withIcon > 0, `带图标=${withIcon} 不带=${without}`)
  }
}

// 关键场景：**带空格的路径**
const CASES = [
  ['简单参数', ['--home', 'C:/tmp/x', '--port', '1234']],
  ['★ 带空格的数据目录', ['--home', 'D:/DSH WorkSpace/whale-pod/.test-sp', '--web-port', '19910']],
  ['带空格 + 中文', ['--home', 'D:/我 的 目录/g', '--dsh-app', 'D:/DSH Desktop']],
  ['带引号的参数', ['--profile', 'a"b']],
  ['空参数', []],
]

console.log('')
for (const [label, args] of CASES) {
  fs.rmSync(path.join(probe, 'argv.json'), { force: true })
  try {
    execFileSync(exe, args, { timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    // 入口跑完就退，退出码非 0 也无所谓
  }
  let got = null
  try { got = JSON.parse(fs.readFileSync(path.join(probe, 'argv.json'), 'utf8')) } catch { /* */ }
  const same = got && JSON.stringify(got.argv) === JSON.stringify(args)
  check(`参数透传：${label}`, same,
    same ? '' : `期望 ${JSON.stringify(args)}；实得 ${JSON.stringify(got?.argv ?? '(没跑到入口)')}`)
}

console.log('')
console.log('=== cwd 与入口目录（必须是探测目录，不能被 cwd 影响）===')
try {
  const got = JSON.parse(fs.readFileSync(path.join(probe, 'argv.json'), 'utf8'))
  console.log('  cwd:', got.cwd)
  console.log('  entryDir:', got.entryDir)
  // ⚠️ 两边都要解析短名（%TEMP% 常是 NULL_Z~1，exe 报的是长名 Null_zwei）。
  //    用 realpathSync.native —— 普通 realpathSync 对短名不总解析。
  const norm = (p) => {
    try { return (fs.realpathSync.native ?? fs.realpathSync)(p).replace(/\\/g, '/').toLowerCase() }
    catch { return String(p).replace(/\\/g, '/').toLowerCase() }
  }
  const ok = norm(got.entryDir).startsWith(norm(probe))
  check('入口定位正确（用 exe 自己的目录，不受 cwd 影响）', ok, `entryDir=${got.entryDir} probe=${probe}`)
} catch { check('入口定位正确', false, '没拿到 argv.json') }

// 清理
fs.rmSync(probe, { recursive: true, force: true })
console.log('')
console.log('='.repeat(46))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
