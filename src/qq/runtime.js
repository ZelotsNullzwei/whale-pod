/**
 * 自带运行时：uv + Python。
 *
 * ## 为什么能"内置 Python"
 *
 * `uv`（astral-sh）是**单个约 14.6 MB 的二进制**，而且它的核心能力之一
 * 就是「自动下载并管理独立的 Python 解释器」：
 *
 *     uv python install 3.12        → 把 Python 装到指定目录
 *     uv tool install astrbot       → 在隔离环境里装 AstrBot
 *     uv tool run astrbot run       → 跑起来
 *
 * 所以 WhalePod 只要下载那一个 uv 二进制，剩下的（Python、依赖隔离）
 * 全交给 uv。用户**不需要装任何系统级 Python**，也**不会污染系统**。
 *
 * ## 目录布局（都在 ~/.whale-pod 下，删目录即卸载）
 *
 *     runtime/
 *       uv/
 *         uv.exe                    ← 唯一需要下载的东西
 *       python/                     ← uv 下载的 Python 3.12
 *       uv-tools/                   ← uv 装的命令行工具（astrbot）
 *       uv-cache/                   ← 下载缓存
 *
 * ## 环境隔离
 *
 * uv 默认会读 `UV_PYTHON_INSTALL_DIR` / `UV_TOOL_DIR` / `UV_CACHE_DIR`。
 * 我们全部指向 WhalePod 自己的目录，这样：
 *   - 不碰用户已有的 Python / pip / venv
 *   - 卸载只需删 `runtime/`
 *   - 换机拷贝整个 `~/.whale-pod` 即可搬走
 *
 * ## 平台
 *
 * uv 提供各平台预编译二进制。这里只实现 Windows x64 与 Linux x64
 * / macOS（arm64+x64）的 URL 映射；其它平台给出明确报错而不是静默失败。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** uv 的下载地址（官方 release 资产，按平台）。 */
export const UV_ASSETS = {
  'win32-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip',
  'linux-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz',
  'linux-arm64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz',
  'darwin-arm64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz',
  'darwin-x64': 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz',
}

/** 当前平台对应的 uv 资产。 */
export function uvAssetFor(platform = process.platform, arch = process.arch) {
  const key = platform + '-' + arch
  const url = UV_ASSETS[key]
  if (!url) {
    throw new Error(
      `uv 没有为 ${key} 提供预编译包。支持：${Object.keys(UV_ASSETS).join(', ')}。` +
      `\n请手动安装 uv（https://docs.astral.sh/uv/），WhalePod 会优先使用 PATH 里的 uv。`,
    )
  }
  return { key, url }
}

/** uv 相关目录布局。 */
export function runtimePaths(home) {
  const rt = path.join(home, 'runtime')
  const uvDir = path.join(rt, 'uv')
  return {
    runtime: rt,
    uvDir,
    uvExe: process.platform === 'win32' ? path.join(uvDir, 'uv.exe') : path.join(uvDir, 'uv'),
    pythonDir: path.join(rt, 'python'),
    toolDir: path.join(rt, 'uv-tools'),
    cacheDir: path.join(rt, 'uv-cache'),
    homeDir: path.join(rt, 'uv-home'),
  }
}

/**
 * 找 uv：优先自带，其次 PATH。
 * @returns {Promise<{exe:string, source:'bundled'|'path'}|null>}
 */
export async function findUv(home) {
  const p = runtimePaths(home)
  if (fs.existsSync(p.uvExe)) return { exe: p.uvExe, source: 'bundled' }
  const onPath = await which('uv')
  if (onPath) return { exe: onPath, source: 'path' }
  return null
}

/** 在 PATH 里找可执行文件。 */
export async function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, cmd + ext)
      try { if (fs.statSync(p).isFile()) return p } catch { /* next */ }
    }
  }
  return null
}

/**
 * 构造 uv 的隔离环境变量。
 *
 * 这是"不污染系统"的关键：所有 uv 的存储位置都指向 WhalePod 目录。
 */
export function uvEnv(home, extra = {}) {
  const p = runtimePaths(home)
  fs.mkdirSync(p.pythonDir, { recursive: true })
  fs.mkdirSync(p.toolDir, { recursive: true })
  fs.mkdirSync(p.cacheDir, { recursive: true })
  return {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: p.pythonDir,
    UV_TOOL_DIR: p.toolDir,
    UV_TOOL_BIN_DIR: path.join(p.toolDir, 'bin'),
    UV_CACHE_DIR: p.cacheDir,
    // 让 uv 别去碰用户的全局配置，行为可预测
    UV_NO_CONFIG: '1',
    UV_PYTHON_DOWNLOADS: 'automatic',
    ...extra,
  }
}

/**
 * 下载并安装自带的 uv。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} [opts.proxy]
 * @param {string} [opts.mirror]   GitHub 下载镜像（国内加速）
 * @param {(msg:string)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function installUv(opts) {
  const { home } = opts
  const log = opts.onProgress ?? (() => {})
  const p = runtimePaths(home)
  const { key, url: rawUrl } = uvAssetFor()
  const url = opts.mirror ? `${String(opts.mirror).replace(/\/$/, '')}/${rawUrl}` : rawUrl

  await fsp.mkdir(p.uvDir, { recursive: true })
  const fileName = path.basename(new URL(rawUrl).pathname)
  const tmpFile = path.join(p.uvDir, fileName)

  log(`下载 uv（${key}）…`)
  await downloadTo(url, tmpFile, { proxy: opts.proxy, signal: opts.signal, onProgress: log })

  log('解压 uv…')
  await extractArchive(tmpFile, p.uvDir)
  await fsp.rm(tmpFile, { force: true })

  if (process.platform !== 'win32') {
    try { fs.chmodSync(p.uvExe, 0o755) } catch { /* ignore */ }
  }
  if (!fs.existsSync(p.uvExe)) {
    // 有的资产解压出来是嵌套目录，找一下 uv 可执行文件
    const found = findExecutable(p.uvDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (!found) throw new Error('uv 解压后找不到可执行文件')
    await fsp.rename(found, p.uvExe).catch(async () => { await fsp.copyFile(found, p.uvExe) })
  }

  log('验证 uv…')
  const v = await runCapture(p.uvExe, ['--version'], { env: uvEnv(home) })
  log(`uv 就绪：${v.trim()}`)
  return { ok: true, exe: p.uvExe, version: v.trim() }
}

/** 在目录里递归找某个文件名。 */
function findExecutable(dir, name) {
  let hit = null
  const walk = (d) => {
    if (hit) return
    let items
    try { items = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      const q = path.join(d, it.name)
      if (it.isDirectory()) walk(q)
      else if (it.name.toLowerCase() === name.toLowerCase()) { hit = q; return }
    }
  }
  walk(dir)
  return hit
}

/**
 * 确保 Python 可用（uv 会自动下载）。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} [opts.pythonVersion='3.12']
 * @param {(msg:string)=>void} [opts.onProgress]
 */
export async function ensurePython(opts) {
  const { home } = opts
  const log = opts.onProgress ?? (() => {})
  const uv = await findUv(home)
  if (!uv) throw new Error('uv 未就绪，先调用 installUv()')
  const ver = opts.pythonVersion ?? '3.12'
  const env = uvEnv(home, opts.env)

  log(`检查 Python ${ver}…`)
  const listed = await runCapture(uv.exe, ['python', 'list', '--only-installed'], { env })
  if (listed.includes(ver)) {
    log(`Python ${ver} 已就绪`)
    return { ok: true, already: true, version: ver }
  }

  log(`下载 Python ${ver}（uv 自动管理，约 30 MB）…`)
  await runStream(uv.exe, ['python', 'install', ver], {
    env,
    onLine: (l) => { if (l.trim()) log(l.trim()) },
  })
  log(`Python ${ver} 安装完成`)
  return { ok: true, already: false, version: ver }
}

/**
 * 用 uv 装一个命令行工具（如 astrbot）。
 *
 * @param {object} opts
 * @param {string} opts.home
 * @param {string} opts.package     包名
 * @param {string} [opts.pythonVersion]
 * @param {(msg:string)=>void} [opts.onProgress]
 */
export async function uvToolInstall(opts) {
  const { home, package: pkg } = opts
  const log = opts.onProgress ?? (() => {})
  const uv = await findUv(home)
  if (!uv) throw new Error('uv 未就绪')
  const env = uvEnv(home, opts.env)

  const args = ['tool', 'install', pkg, '--python', opts.pythonVersion ?? '3.12']
  log(`安装 ${pkg}（uv tool install）…`)
  let tail = []
  await runStream(uv.exe, args, {
    env,
    onLine: (l) => {
      const t = l.trim()
      if (!t) return
      tail.push(t)
      if (tail.length > 40) tail.shift()
      log(t)
    },
  })
  return { ok: true, package: pkg, tail: tail.join('\n') }
}

/** uv tool 装出来的可执行文件路径。 */
export function toolExePath(home, name) {
  const p = runtimePaths(home)
  if (process.platform === 'win32') {
    return path.join(p.toolDir, 'bin', `${name}.exe`)
  }
  return path.join(p.toolDir, 'bin', name)
}

/** 查 uv 环境概况（供 Web UI 显示）。 */
export async function uvStatus(home) {
  const p = runtimePaths(home)
  const uv = await findUv(home)
  const out = {
    uv: uv ? { installed: true, exe: uv.exe, source: uv.source } : { installed: false },
    dirs: {
      runtime: p.runtime,
      python: p.pythonDir,
      tools: p.toolDir,
      cache: p.cacheDir,
    },
    python: [],
    tools: [],
  }
  if (!uv) return out
  const env = uvEnv(home)
  try {
    const list = await runCapture(uv.exe, ['python', 'list', '--only-installed'], { env })
    out.python = list.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch { /* ignore */ }
  try {
    const tools = await runCapture(uv.exe, ['tool', 'list'], { env })
    out.tools = tools.split('\n').map((l) => l.trim()).filter(Boolean)
  } catch { /* ignore */ }
  return out
}

// ── 进程辅助 ──────────────────────────────────────────────────

/** 跑命令并捕获输出。 */
export function runCapture(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, env: opts.env, ...opts.spawn })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => reject(new Error(`执行失败：${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${path.basename(exe)} 退出码 ${code}${err ? '：' + err.slice(0, 300) : ''}`))
    })
    if (opts.timeoutMs) {
      setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, opts.timeoutMs)
    }
  })
}

/** 跑命令并逐行回调（用于长任务）。 */
export function runStream(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, env: opts.env, ...opts.spawn })
    const onData = (d) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (line) opts.onLine?.(line)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => reject(new Error(`执行失败：${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(exe)} 退出码 ${code}`))
    })
  })
}

// ── 下载 / 解压（与 protocol.js 共用逻辑，这里独立一份避免循环依赖）──

/**
 * 下载到文件。
 *
 * ## 为什么不用 createWriteStream + reader.read()
 *
 * 早期版本用流式写入，在 Windows 上出现过 `fetch failed` —— 排查后
 * 定位到两件事：
 *   1. `redirect: 'follow'` 时，fetch 会跨域跳到
 *      `release-assets.githubusercontent.com`；这一步本身没问题，
 *      但流式读取 + 背压处理稍有差池就静默中断。
 *   2. `fs.createWriteStream` 的错误没被 await 到，失败被吞掉。
 *
 * 现在的做法：**先整块读进内存再落盘**。uv 才 14.6 MB、Python 约 30 MB，
 * 完全放得下内存，换来的是「不可能出现半截文件」的确定性。
 * 进度靠读 chunk 时累加，用户体验不变。
 */
async function downloadTo(url, destFile, opts = {}) {
  const prevH = process.env.HTTPS_PROXY
  const prevL = process.env.HTTP_PROXY
  if (opts.proxy) {
    process.env.HTTPS_PROXY = opts.proxy
    process.env.HTTP_PROXY = opts.proxy
  }
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'user-agent': 'whale-pod-runtime',
        accept: '*/*',
      },
      signal: opts.signal,
    })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`)

    const total = Number(res.headers.get('content-length') ?? 0)
    const chunks = []
    let got = 0
    let lastPct = -1

    if (res.body) {
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const buf = Buffer.from(value)
        chunks.push(buf)
        got += buf.length
        if (total > 0) {
          const pct = Math.floor((got / total) * 100)
          if (pct >= lastPct + 10) { lastPct = pct; opts.onProgress?.(`下载 ${pct}%`) }
        }
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer())
      chunks.push(buf)
      got = buf.length
    }

    if (total > 0 && got !== total) {
      throw new Error(`下载不完整：期望 ${total} 字节，实收 ${got} 字节`)
    }

    await fsp.mkdir(path.dirname(destFile), { recursive: true })
    await fsp.writeFile(destFile, Buffer.concat(chunks))
    opts.onProgress?.(`下载完成（${(got / 1024 / 1024).toFixed(1)} MB）`)
  } finally {
    if (opts.proxy) {
      if (prevH === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = prevH
      if (prevL === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = prevL
    }
  }
}

async function extractArchive(archive, destDir) {
  const lower = archive.toLowerCase()
  if (lower.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await runCapture('tar', ['-xf', archive, '-C', destDir])
    } else {
      await runCapture('unzip', ['-q', '-o', archive, '-d', destDir])
    }
    return
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await runCapture('tar', ['-xzf', archive, '-C', destDir])
    return
  }
  throw new Error('不支持的压缩格式：' + path.basename(archive))
}
