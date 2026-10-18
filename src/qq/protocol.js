/**
 * 协议端管理：内置下载 + 托管运行。
 *
 * ## 设计原则（合规优先）
 *
 * 「内置下载」与「打包分发」是**两件不同的事**：
 *
 *   下载官方 Release → 用户主动从上游获取，**不是我们再分发** ✅
 *   打进 WhalePod 发行包 → 属于再分发，受各自许可约束 ⚠️
 *
 * 所以本模块**只做下载器 + 进程托管**，不把协议端代码放进 WhalePod 仓库。
 *
 * ## 各后端的实际情况
 *
 * | 后端 | 许可 | 是否支持自动下载 |
 * |---|---|---|
 * | NapCat | Limited Redistribution License（禁止商用；再分发须附完整许可） | ✅ 下载官方 Release |
 * | AstrBot | AGPL-3.0（真开源） | ⚠️ 需要 Python 3.12+，走官方安装器 |
 * | SnowLuma | 源码可见非商业许可（核心是专有二进制，**禁止自动化部署**） | ❌ **不支持** |
 *
 * SnowLuma 被刻意排除：它的 EULA 明确要求「并入第三方安装包或通过自动化脚本
 * 部署」须事先取得书面授权。同类项目 qq-bridge 也因此移除过该功能。
 *
 * ## 下载前必须做的事
 *
 * 1. 显示许可名称与官方仓库链接
 * 2. 显示完整许可文本（或链接到它）
 * 3. 用户显式确认
 * 4. 下载后把 LICENSE 一起存下来（满足 NapCat 的「附完整许可」要求）
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import * as rt from './runtime.js'

/**
 * 解析带单层通配的相对路径，返回第一个真实存在的绝对路径。
 *
 * 为什么需要：NapCat 的 Shell 目录名带构建号（`NapCat.52230.Shell`），
 * 每次升级都会变。写死路径必然在某次升级后失效，所以用
 * `NapCat.*.Shell/napcat.bat` 这种形式，由这里展开。
 *
 * 只支持**一层** `*`（够用了）；目录不存在或有多个匹配时取名字
 * 最大的那个（构建号通常递增，取最新）。
 */
function resolveWildcard(baseDir, rel) {
  const parts = String(rel).split('/')
  let cur = baseDir
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]
    const isLast = i === parts.length - 1
    if (!seg.includes('*')) {
      cur = path.join(cur, seg)
      if (isLast) return fs.existsSync(cur) ? cur : null
      if (!fs.existsSync(cur)) return null
      continue
    }
    // 通配段：在 cur 下找匹配的条目
    let entries = []
    try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { return null }
    const re = new RegExp('^' + seg.split('*').map(escapeRe).join('.*') + '$', 'i')
    const hits = entries.filter((e) => re.test(e.name))
    if (hits.length === 0) return null
    // 多个匹配时取名字最大的（构建号递增 → 最新）
    hits.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    if (isLast) {
      for (const h of hits) {
        const p = path.join(cur, h.name)
        if (fs.existsSync(p)) return p
      }
      return null
    }
    cur = path.join(cur, hits[0].name)
    if (!fs.existsSync(cur)) return null
  }
  return null
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 同步探测本机某个端口是否有进程在监听。
 *
 * 用 `netstat -ano` 而不是自己连一下：连接有超时，而 netstat 是即时的，
 * 适合在同步的 getter 里调用。只看 `LISTENING` 行，避免把 TIME_WAIT
 * 之类的残留状态误判成"在跑"。
 *
 * ⚠️ 每次调用都起一个子进程有开销，所以调用方（ProtocolSupervisor.status）
 *    只对"子进程已死"的后端做这一步，热路径不受影响。
 */
function isPortListening(port) {
  try {
    // execFileSync 从 node:child_process 顶部已 import，直接用
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', timeout: 3000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, 'i')
    return re.test(out)
  } catch {
    return false
  }
}

/**
 * 读取协议端**自己的管理界面**信息（地址 + 登录 token）。
 *
 * ⚠️ 这是**模块级导出**（不是 ProtocolSupervisor 的方法）—— 因为 Web 层
 *    拿到的是 `import * as protocols` 这个模块命名空间，而不是 supervisor
 *    实例（见 index.js）。做成方法会导致 `protocols.webInfo` 不存在，
 *    接口里 web 字段永远是 null。
 *
 * 为什么要读文件而不是抓日志：
 *   NapCat 启动时会把 WebUI token 打印到控制台，但它的启动器
 *   （NapCatWinBootMain.exe）注入完就退出，stdout 未必被我们接住
 *   —— 实测 supervisor 捕获 0 行，用户"在日志里看不见 token"。
 *   而 token 同时写在它的 config/webui.json 里，直接读文件稳定得多。
 *
 * @param {string} home 数据目录
 * @param {string} backendId
 * @returns {{url:string, token:string|null, port:number|null}|null}
 */
export function webInfo(home, backendId) {
  const b = BACKENDS[backendId]
  if (!b?.webUrl) return null
  const out = { url: b.webUrl, token: null, port: null }

  // 从 URL 里取默认端口
  try { out.port = Number(new URL(b.webUrl).port) || null } catch { /* ignore */ }

  if (backendId !== 'napcat') return out

  // NapCat 独立模式（完整包 v4.x）：<protocol>/napcat/napcat/config/webui.json
  // NapCat 注入模式（Shell 目录）：<protocol>/napcat/NapCat.*.Shell/versions/*/resources/app/napcat/config/webui.json
  const root = path.join(home, 'protocol', 'napcat')
  const candidates = []
  // 独立模式优先（完整包实际用的就是这个布局）
  candidates.push(path.join(root, 'napcat', 'config', 'webui.json'))
  try {
    for (const shell of fs.readdirSync(root)) {
      if (!/^NapCat\..*\.Shell$/i.test(shell)) continue
      const versionsDir = path.join(root, shell, 'versions')
      let versions = []
      try { versions = fs.readdirSync(versionsDir) } catch { continue }
      for (const v of versions) {
        candidates.push(path.join(versionsDir, v, 'resources', 'app', 'napcat', 'config', 'webui.json'))
      }
    }
  } catch { /* 目录不存在就只返回默认 URL */ }

  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue
      const j = JSON.parse(fs.readFileSync(f, 'utf8'))
      if (j?.token) {
        out.token = String(j.token)
        if (j.port) out.port = Number(j.port)
        // 用配置里的实际端口，别硬编码
        out.url = `http://127.0.0.1:${out.port ?? 6099}/webui`
        break
      }
    } catch { /* 换下一个候选 */ }
  }
  return out
}

/**
 * 列出属于某个后端的进程（**不依赖 supervisor**）。
 *
 * 用途：进程不是我们启动的时候（用户手动开的、上一轮 WhalePod 留下的），
 * supervisor 里没有 entry，界面上就只剩一个"运行中"三个字 ——
 * pid、内存、启动时间全空，用户看不到"后台到底在跑什么"。
 * 这里按可执行文件路径反查，把这些信息补上。
 *
 * ⚠️ 实现上避开 PowerShell 的字符串转义地狱：用 `tasklist` 拿
 *    PID+内存（CSV，好解析），再用 `wmic`/CIM 补路径会不稳（wmic 已被移除）。
 *    干脆只用 tasklist 按**进程名**筛，路径特征交给调用方的
 *    `_killBySignature` 去精确校验 —— 展示场景不需要那么严。
 *
 * @param {string} home 数据目录
 * @param {string} backendId
 * @returns {Array<{pid:number, name:string, memBytes:number}>}
 */
export function listProcesses(home, backendId) {
  const out = []
  // 各后端可能出现的进程名
  const NAMES = {
    napcat: ['QQ.exe', 'NapCatWinBootMain.exe'],
    astrbot: ['astrbot.exe', 'python.exe', 'uv.exe'],
    snowluma: ['SnowLuma.exe'],
  }[backendId] ?? []
  if (NAMES.length === 0) return out

  // ⚠️ 光按进程名筛会**把你自己的 QQ 也算进来**（实测：12 个里混了
  //    用户 D:\Tencent\QQ 的那个，470MB）。必须再校验可执行文件路径
  //    是否落在该后端的安装目录下。
  const prefix = path.join(home, 'protocol', backendId).replace(/\//g, '\\').toLowerCase()

  try {
    const raw = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const candidates = []
    for (const line of raw.split(/\r?\n/)) {
      // "QQ.exe","1234","Console","1","123,456 K"
      const m = /^"([^"]+)","(\d+)","[^"]*","\d+","([\d,.\s]+)\s*K"/i.exec(line)
      if (!m) continue
      const [, name, pid, memRaw] = m
      if (!NAMES.some((n) => n.toLowerCase() === name.toLowerCase())) continue
      candidates.push({
        pid: Number(pid),
        name,
        // "123,456 K" → 字节
        memBytes: Number(String(memRaw).replace(/[^\d]/g, '')) * 1024 || 0,
      })
    }

    // 逐个校验路径（这一步是"别把你自己的 QQ 算进去"的关键）
    for (const c of candidates) {
      const full = procPathOf(c.pid)
      if (!full) continue
      if (!full.replace(/\//g, '\\').toLowerCase().startsWith(prefix)) continue
      out.push({ ...c, exe: full })
    }
  } catch { /* 查不到就返回空 —— 界面降级显示 */ }
  return out.sort((a, b) => b.memBytes - a.memBytes)
}

/**
 * 取进程的可执行文件完整路径（拿不到返回 null）。
 *
 * 用 PowerShell 的 CIM 查询：命令里**只插数字**（pid），
 * 不插路径 —— 避免反斜杠进到命令串里引起转义问题（实测踩过）。
 */
export function procPathOf(pid) {
  try {
    const ps = 'Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) +
      '" | Select-Object -ExpandProperty ExecutablePath'
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const s = out.trim()
    return s && !/^\s*$/.test(s) ? s : null
  } catch { return null }
}

/** 支持的协议端/机器人框架清单。 */
export const BACKENDS = {
  napcat: {
    id: 'napcat',
    name: 'NapCat',
    kind: 'protocol',          // 协议端：把 QQ 变成 OneBot v11
    summary: '基于 NTQQ 的 OneBot v11 协议端。国内最主流，维护活跃。',
    repo: 'https://github.com/NapNeko/NapCatQQ',
    license: {
      name: 'Limited Redistribution License',
      spdx: null,
      url: 'https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE',
      commercialUse: false,
      redistributable: true,       // 有条件：须附完整许可 + 标注来源
      requiresLicenseShip: true,   // 下载后必须一并保存 LICENSE
      note: '禁止商用。再分发须附带完整许可全文并标注来源与版权。',
    },
    /** 下载策略：GitHub Release 资产 */
    install: {
      mode: 'github-release',
      /**
       * 资产名匹配（按优先级）。
       *
       * NapCat 提供 4 种资产：
       *   NapCat.Framework.zip              36 MB  —— 给已有 QQ 框架用
       *   NapCat.Shell.Windows.Node.zip    118 MB  —— 带 Node 运行时的完整版
       *   NapCat.Shell.Windows.OneKey.zip   0.9 MB —— 一键包（**需要再跑 NapCatInstaller.exe 联网拉 QQ 主体**）
       *   NapCat.Shell.zip                  34 MB  —— 跨平台 Shell（无 Windows QQ 主体）
       *
       * ⚠️ 必须选 Windows.Node 完整版，不能选 OneKey：OneKey 只有 0.9 MB，
       *    解压出来是 `NapCatInstaller.exe + bootmain 引导器`，**没有 QQ.exe**
       *    （实测：启动立即退出，日志 `Usage: ...NapCatWinBootMain.exe <quickLogin>`
       *    + `Process Path: "...\bootmain\QQ.exe"` —— 因为 QQ.exe 不存在）。
       *    我们的 installBackend 只做「下载 + 解压」，没有跑交互式安装器，
       *    所以 OneKey 必然得到一个跑不起来的残缺安装，却被 detectInstalled
       *    误判为"已安装"。完整包解压即可用，符合当前安装流程。
       */
      assetPatterns: [
        /^NapCat\.Shell\.Windows\.Node\.zip$/i,
        /Windows.*Node.*\.zip$/i,
        /^NapCat\.Shell\.Windows\.OneKey\.zip$/i,
        /Windows.*OneKey.*\.zip$/i,
        /\.Shell\.Windows.*\.zip$/i,
        /NapCat.*Windows.*\.zip$/i,
        /NapCat\.Shell\.zip$/i,
      ],
      /**
       * 解压后要跑的可执行文件（相对路径，按优先级找）。
       *
       * ⚠️ 这里有个**关键坑**：OneKey 包解压出来有两处
       *    `NapCatWinBootMain.exe`，但只有一处能用：
       *
       *      protocol/napcat/bootmain/NapCatWinBootMain.exe   ← 引导器
       *      protocol/napcat/NapCat.XXXX.Shell/NapCatWinBootMain.exe  ← 真正能跑的
       *
       *    前者需要**同目录有 QQ.exe** 才能注入（它把 NapCatWinBootHook.dll
       *    注入进 QQ.exe）。bootmain/ 下没有 QQ.exe，直接跑会报
       *    "Error Code: 2 / Process Path: ...bootmain\QQ.exe"。
       *    后者所在目录里有 QQ.exe（安装器下载的 300MB 那份），才跑得起来。
       *
       *    而且 Shell 目录名带构建号（NapCat.52230.Shell），版本升级会变，
       *    所以下面用 `**` 通配由 _findExe 展开，不能写死。
       */
      runCandidates: [
        // 首选：独立模式入口（自带 node.exe + wrapper.node，不需要系统装 QQ、
        // 不需要管理员权限）。实测 v4.18.38：`node index.js` 直接起，
        // 2 秒内 WebUi 就监听 6099 并打印带 token 的登录 URL。
        'index.js',
        // 注入模式：需要系统装 QQ（读注册表 UninstallString）+ 管理员权限
        'NapCat.*.Shell/NapCatWinBootMain.exe',
        'NapCat.*.Shell/napcat.bat',
        'NapCatWinBootMain.exe',
        'napcat.bat',
        'launcher.bat',
      ],
    },
    /** 该协议端需要的运行时前提 */
    requires: ['qq-nt', 'windows'],
    homepage: 'https://napneko.github.io/',
    /**
     * 它自己的管理界面地址（给"打开主页"按钮用）。
     *
     * NapCat 的 WebUI 默认在 6099。注意它监听的是 `::`（所有网卡），
     * 但 WhalePod 只应给回环地址 —— 本机浏览器访问 127.0.0.1 即可。
     */
    webUrl: 'http://127.0.0.1:6099/webui',
  },

  astrbot: {
    id: 'astrbot',
    name: 'AstrBot',
    kind: 'framework',         // 机器人框架：消费 OneBot，提供插件生态
    summary: '开源全能 Agent 机器人平台，AGPL-3.0，插件生态上千。由 WhalePod 自动装 Python。',
    repo: 'https://github.com/AstrBotDevs/AstrBot',
    license: {
      name: 'GNU AGPL-3.0',
      spdx: 'AGPL-3.0',
      url: 'https://github.com/AstrBotDevs/AstrBot/blob/master/LICENSE',
      commercialUse: true,
      redistributable: true,
      requiresLicenseShip: true,
      note: '真开源（AGPL-3.0）。若修改并以网络服务形式提供，需公开源码。',
    },
    install: {
      mode: 'uv-tool',         // 用自带的 uv 装（uv 会自动下载 Python）
      /** uv 会把这些装到 <home>/runtime/uv/ 下 */
      package: 'astrbot',
      pythonVersion: '3.12',
      /** uv tool 的安装目录（相对 <home>） */
      toolDir: 'runtime/uv-tools',
      /** Python 安装目录（uv 自动下载到这里） */
      pythonDir: 'runtime/python',
      /** 启动命令 */
      runArgs: ['astrbot', 'run'],
      /** 首次初始化 */
      initArgs: ['astrbot', 'init'],
      /** AstrBot 自己的 WebUI 端口（默认值，实际以它的配置为准） */
      defaultWebPort: 6185,
      /** 它监听 OneBot 反向 WS 的默认端口 */
      defaultOneBotPort: 6199,
    },
    /**
     * AstrBot 是"框架"，WhalePod 提供两种模式：
     *   whale-pod 模式 —— AstrBot 不参与，WhalePod 自己当框架
     *   astrbot  模式 —— AstrBot 当框架，WhalePod 退为 LLM 网关
     * 所以这里的 requires 不再是"必须装 Python"，而是"选了该模式才需要，
     * 且 WhalePod 会自己把 Python 装上"。
     */
    requires: ['uv-bundled'],
    homepage: 'https://astrbot.app/',
    /** AstrBot 的 WebUI（它自己的管理面板，默认 6185） */
    webUrl: 'http://127.0.0.1:6185',
  },

  snowluma: {
    id: 'snowluma',
    name: 'SnowLuma',
    kind: 'protocol',
    summary: 'NapCat 官方推荐的 GUI 替代品。但许可限制自动化部署，WhalePod 不提供自动下载。',
    repo: 'https://github.com/SnowLuma/SnowLuma',
    license: {
      name: 'SnowLuma Source-Available Non-Commercial License',
      spdx: null,
      url: 'https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE',
      commercialUse: false,
      redistributable: false,
      requiresLicenseShip: true,
      note: '核心为专有二进制；明确禁止通过自动化脚本部署与并入第三方安装包。',
    },
    install: {
      mode: 'manual',          // 只能用户自己装
      reason: 'EULA 禁止自动化部署（§5.4）。请自行从其官方仓库下载安装，然后在这里填路径。',
    },
    requires: ['manual'],
    homepage: 'https://github.com/SnowLuma/SnowLuma',
    webUrl: 'http://127.0.0.1:6099/webui',
  },
}

/** 列出所有后端（供 Web UI）。 */
export function listBackends() {
  return Object.values(BACKENDS).map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind,
    summary: b.summary,
    repo: b.repo,
    homepage: b.homepage,
    /** 它自己的管理界面（UI 上用"打开主页"按钮） */
    webUrl: b.webUrl ?? null,
    license: b.license,
    autoInstallable: b.install.mode !== 'manual',
    installMode: b.install.mode,
    requires: b.requires,
    manualReason: b.install.mode === 'manual' ? b.install.reason : null,
  }))
}

/**
 * 探测本机已装的后端。
 *
 * ## 两种安装形态要分别判断
 *
 *   github-release（NapCat）—— 文件解压在 `protocol/<id>/` 下，找可执行文件
 *   uv-tool（AstrBot）      —— 真正的程序在 `runtime/uv-tools/bin/<name>.exe`，
 *                              `protocol/<id>/` 只放来源说明与版本标记
 *
 * ⚠️ 早期版本只看 `protocol/<id>/` 目录是否存在，导致用 `uv tool install`
 * 装好 AstrBot 后界面仍显示"未安装"。所以这里两种都查。
 */
export function detectInstalled(home) {
  const root = path.join(home, 'protocol')
  const result = {}
  for (const b of Object.values(BACKENDS)) {
    const dir = path.join(root, b.id)
    const info = { installed: false, dir, version: null, exe: null, source: null }

    // ── 形态一：uv 工具（AstrBot）────────────────────────────
    if (b.install.mode === 'uv-tool' && b.install.package) {
      const exe = rt.toolExePath(home, b.install.package)
      if (fs.existsSync(exe)) {
        info.installed = true
        info.exe = exe
        info.source = 'whale-pod-uv'
      }
    }

    // ── 形态二：解压到 protocol/<id>/（NapCat）───────────────
    //
    // ⚠️ 不能只判"目录存在"：OneKey 包解压后目录一定存在，但里面**没有**
    //    QQ.exe，NapCatWinBootMain.exe 起来立刻报 `Error Code: 2` 退出
    //    （实测踩过：界面显示"已安装"，点启动 50ms 就死）。所以必须
    //    解析出可执行文件、并且对引导器额外要求同目录有 QQ.exe。
    if (!info.installed && fs.existsSync(dir)) {
      for (const rel of (b.install.runCandidates ?? [])) {
        const p = resolveWildcard(dir, rel)
        if (p) { info.exe = p; break }
      }
      // 引导器必须同目录有 QQ.exe 才算装好（OneKey 残缺安装正是缺它）
      const bootMain = info.exe && /NapCatWinBootMain\.exe$/i.test(info.exe)
      const hasQQ = bootMain ? fs.existsSync(path.join(path.dirname(info.exe), 'QQ.exe')) : true
      if (info.exe && hasQQ) {
        info.installed = true
        info.source = 'whale-pod'
      } else if (info.exe && !hasQQ) {
        // 残缺安装：报告"未安装"，让界面引导重新安装（会覆盖旧目录）
        info.incomplete = true
      }
    }

    // ── 版本标记（两种形态共用）─────────────────────────────
    const vf = path.join(dir, '.whale-pod-version.json')
    if (fs.existsSync(vf)) {
      try {
        const j = JSON.parse(fs.readFileSync(vf, 'utf8'))
        info.version = j.tag ?? (j.package ? `${j.package} (Python ${j.pythonVersion})` : null)
        if (!info.exe && j.exe && fs.existsSync(j.exe)) info.exe = j.exe
      } catch { /* ignore */ }
    }
    // uv 装的工具没有 tag，退回从 `uv tool list` 读真实版本
    if (info.installed && !info.version && b.install.mode === 'uv-tool' && b.install.package) {
      info.version = uvToolVersion(home, b.install.package) ?? '已安装（uv tool）'
    }

    result[b.id] = info
  }
  return result
}

/**
 * 从 uv 的安装目录里读某个工具的版本。
 *
 * 为什么不用 `uv tool list`：那是子进程调用，而 `detectInstalled` 是同步的
 * （Web API 每次刷新都会调）。uv 的目录布局是确定的，直接读文件更快：
 *
 *   runtime/uv-tools/
 *     <pkg>/uv-receipt.toml        ← 记录 python 版本与 entrypoint（无版本号）
 *     <pkg>/lib/python3.12/site-packages/<pkg>-<ver>.dist-info/METADATA
 *                                  ← 真正的版本在这里
 */
function uvToolVersion(home, pkg) {
  const toolDir = rt.runtimePaths(home).toolDir
  const pkgDir = path.join(toolDir, pkg)

  // 1. 从 dist-info 目录名解析（最可靠）
  try {
    const libDir = path.join(pkgDir, 'lib')
    if (fs.existsSync(libDir)) {
      for (const py of fs.readdirSync(libDir)) {
        const sp = path.join(libDir, py, 'site-packages')
        if (!fs.existsSync(sp)) continue
        for (const it of fs.readdirSync(sp)) {
          const m = new RegExp(`^${escapeRe(pkg)}-(.+)\\.dist-info$`, 'i').exec(it)
          if (m) return 'v' + m[1]
        }
      }
    }
  } catch { /* fallthrough */ }

  // 2. 退路：遍历目录找任意 <pkg>-*.dist-info
  try {
    const found = findDistInfo(pkgDir, pkg)
    if (found) return 'v' + found
  } catch { /* ignore */ }

  return null
}

/** 在目录树里找 <pkg>-<ver>.dist-info，返回版本号。 */
function findDistInfo(dir, pkg, depth = 0) {
  if (depth > 6) return null
  let items
  try { items = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const it of items) {
    if (!it.isDirectory()) continue
    const m = new RegExp(`^${escapeRe(pkg)}-(.+)\\.dist-info$`, 'i').exec(it.name)
    if (m) return m[1]
  }
  for (const it of items) {
    if (!it.isDirectory()) continue
    const r = findDistInfo(path.join(dir, it.name), pkg, depth + 1)
    if (r) return r
  }
  return null
}

/** 检查运行时依赖（python / uv / QQ 等）。 */
export async function checkRequires(ids) {
  const out = {}
  for (const id of ids) {
    out[id] = await probeRequirement(id)
  }
  return out
}

async function probeRequirement(id) {
  switch (id) {
    case 'windows':
      return { ok: process.platform === 'win32', detail: process.platform === 'win32' ? 'Windows' : '非 Windows' }
    case 'qq-nt':
      return await probeQQNT()
    case 'python312':
      return await probeCommand('python', ['--version'], /Python 3\.1[2-9]/)
    case 'uv':
      return await probeCommand('uv', ['--version'], /.+/)
    case 'manual':
      return { ok: true, detail: '需手动安装' }
    default:
      return { ok: true, detail: '无需额外依赖' }
  }
}

/** 探测 QQ NT 安装位置（NapCat 需要给它注入）。 */
async function probeQQNT() {
  const candidates = [
    'C:/Program Files/Tencent/QQNT/QQ.exe',
    'C:/Program Files (x86)/Tencent/QQNT/QQ.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Tencent', 'QQNT', 'QQ.exe') : null,
    'C:/Program Files/Tencent/QQ/QQ.exe',
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(c)) return { ok: true, detail: '已找到：' + c, path: c }
  }
  return {
    ok: false,
    detail: '未找到 QQ NT（NapCat 需要它的运行时来注入）。请先安装新版 QQ。',
  }
}

/** 跑一个命令并匹配输出。 */
function probeCommand(cmd, args, matcher) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return finish({ ok: false, detail: '未安装（' + String(e?.message ?? e).slice(0, 60) + '）' })
    }
    let buf = ''
    child.stdout?.on('data', (d) => { buf += d })
    child.stderr?.on('data', (d) => { buf += d })
    child.on('error', () => finish({ ok: false, detail: '未安装' }))
    child.on('close', (code) => {
      const text = buf.trim()
      const ok = code === 0 && matcher.test(text)
      finish({ ok, detail: text.slice(0, 80) || (ok ? 'ok' : '检测失败') })
    })
    setTimeout(() => { try { child.kill() } catch { /* ignore */ } finish({ ok: false, detail: '检测超时' }) }, 8000)
  })
}

/**
 * 查询某个后端的最新 Release（动态，不硬编码版本）。
 * @returns {Promise<{tag:string, assets:Array<{name:string,url:string,size:number}>}>}
 */
export async function fetchLatestRelease(backendId, opts = {}) {
  const b = BACKENDS[backendId]
  if (!b) throw new Error('未知后端：' + backendId)
  const repoPath = b.repo.replace(/^https?:\/\/github\.com\//, '')
  const api = `https://api.github.com/repos/${repoPath}/releases/latest`

  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'whale-pod-protocol-manager',
  }
  if (opts.token) headers.authorization = 'Bearer ' + opts.token

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20000)
  let res
  try {
    res = await fetch(api, { headers, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`查询 ${b.name} 版本失败：HTTP ${res.status}` +
      (res.status === 403 ? '（GitHub API 限流，稍后再试或配置 token）' : ''))
  }
  const j = await res.json()
  return {
    tag: j.tag_name,
    name: j.name,
    publishedAt: j.published_at,
    body: String(j.body ?? '').slice(0, 3000),
    assets: (j.assets ?? []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
      downloads: a.download_count,
    })),
  }
}

/** 从资产里挑一个最合适的（按 assetPatterns 优先级）。 */
export function pickAsset(backendId, assets) {
  const b = BACKENDS[backendId]
  const patterns = b?.install?.assetPatterns ?? []
  for (const re of patterns) {
    const hit = assets.find((a) => re.test(a.name))
    if (hit) return hit
  }
  return null
}

/**
 * 下载并解压一个后端。
 *
 * @param {object} opts
 * @param {string} opts.backendId
 * @param {string} opts.home            数据目录（装到 <home>/protocol/<id>）
 * @param {string} [opts.assetUrl]      指定资产 URL（默认自动挑）
 * @param {string} [opts.proxy]         下载代理
 * @param {string} [opts.mirror]        GitHub 下载镜像前缀（可选）
 * @param {(msg:string)=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok:true, dir:string, tag:string, asset:string, files:number}>}
 */
export async function installBackend(opts) {
  const { backendId, home } = opts
  const b = BACKENDS[backendId]
  if (!b) throw new Error('未知后端：' + backendId)
  if (b.install.mode === 'manual') {
    throw new Error(`${b.name} 不支持自动安装：${b.install.reason}`)
  }
  // 走 uv 的后端（AstrBot）：自带 uv + 自动装 Python，不碰系统环境
  if (b.install.mode === 'uv-tool') {
    return installViaUv(opts, b)
  }
  if (b.install.mode !== 'github-release') {
    throw new Error(`${b.name} 的安装方式（${b.install.mode}）暂未实现，请按官方文档安装。`)
  }

  const log = opts.onProgress ?? (() => {})
  const destDir = path.join(home, 'protocol', backendId)

  // ── 1. 查版本 ──────────────────────────────────────────────
  log('查询最新版本…')
  const rel = await fetchLatestRelease(backendId, { token: opts.githubToken })
  log(`最新版本：${rel.tag}（${rel.assets.length} 个资产）`)

  // ── 2. 挑资产 ──────────────────────────────────────────────
  let asset = opts.assetUrl
    ? rel.assets.find((a) => a.url === opts.assetUrl) ?? { name: 'custom', url: opts.assetUrl, size: 0 }
    : pickAsset(backendId, rel.assets)
  if (!asset) {
    const names = rel.assets.map((a) => a.name).join(', ')
    throw new Error(`没有找到适配当前平台的资产。可用：${names || '（无）'}`)
  }
  log(`选中资产：${asset.name}（${(asset.size / 1024 / 1024).toFixed(1)} MB）`)

  // ── 3. 下载 ────────────────────────────────────────────────
  const tmpDir = path.join(home, 'protocol', '.download')
  await fsp.mkdir(tmpDir, { recursive: true })
  const tmpFile = path.join(tmpDir, asset.name)
  const url = applyMirror(asset.url, opts.mirror)
  log(`开始下载：${url}`)
  await download(url, tmpFile, {
    proxy: opts.proxy,
    signal: opts.signal,
    onProgress: (got, total) => {
      if (total > 0) {
        const pct = Math.round((got / total) * 100)
        if (pct % 10 === 0) log(`下载中 ${pct}%（${(got / 1024 / 1024).toFixed(1)} MB）`)
      }
    },
  })
  log('下载完成，正在解压…')

  // ── 4. 解压（覆盖旧版本）──────────────────────────────────────
  await fsp.rm(destDir, { recursive: true, force: true })
  await fsp.mkdir(destDir, { recursive: true })
  await extract(tmpFile, destDir)
  await fsp.rm(tmpFile, { force: true })

  // ── 5. 落地许可与来源（NapCat 的再分发条件）──────────────────
  const notice = [
    `# ${b.name} — 来源与许可`,
    '',
    `- 项目主页：${b.homepage}`,
    `- 源码仓库：${b.repo}`,
    `- 许可：${b.license.name}`,
    `- 许可全文：${b.license.url}`,
    `- 下载版本：${rel.tag}`,
    `- 下载资产：${asset.name}`,
    `- 下载时间：${new Date().toISOString()}`,
    `- 由谁下载：WhalePod 的协议端管理器（用户主动触发）`,
    '',
    '## 许可要点',
    '',
    `- 商业用途：${b.license.commercialUse ? '允许' : '**禁止**'}`,
    `- 再分发：${b.license.redistributable ? '允许（须附完整许可并标注来源）' : '**禁止**'}`,
    `- 说明：${b.license.note}`,
    '',
    '## 注意',
    '',
    '本目录下的文件由 WhalePod 从上游官方 Release 下载，**未做任何修改**。',
    'WhalePod 不再分发这些文件 —— 它们只存在于你自己的机器上。',
    '使用前请自行阅读上面的许可全文与《QQ 用户协议》。',
  ].join('\n')
  await fsp.writeFile(path.join(destDir, 'WHALE-POD-NOTICE.md'), notice, 'utf8')

  await fsp.writeFile(path.join(destDir, '.whale-pod-version.json'), JSON.stringify({
    backend: backendId,
    tag: rel.tag,
    asset: asset.name,
    installedAt: Date.now(),
    license: b.license.name,
  }, null, 2) + '\n', 'utf8')

  // 顺手把上游 LICENSE 也拉一份（若资产里没有）
  try {
    const licPath = path.join(destDir, 'LICENSE')
    if (!fs.existsSync(licPath) && b.license.url) {
      const raw = b.license.url
        .replace('github.com', 'raw.githubusercontent.com')
        .replace('/blob/', '/')
      const r = await fetch(raw, { headers: { 'user-agent': 'whale-pod' } })
      if (r.ok) await fsp.writeFile(licPath, await r.text(), 'utf8')
    }
  } catch { /* 许可下载失败不阻塞 */ }

  const count = await countFiles(destDir)
  log(`安装完成：${destDir}（${count} 个文件）`)
  return { ok: true, dir: destDir, tag: rel.tag, asset: asset.name, files: count, notice }
}

// ── 下载与解压 ────────────────────────────────────────────────

/**
 * 走 uv 的后端安装（AstrBot）。
 *
 * 链路：WhalePod 下载 uv（14.6 MB 单文件）→ uv 自动下载 Python 3.12 →
 * uv tool install astrbot。全程隔离在 ~/.whale-pod/runtime/ 下，
 * 不碰用户系统的 Python / pip / PATH。
 */
async function installViaUv(opts, b) {
  const { home } = opts
  const log = opts.onProgress ?? (() => {})

  // ── 1. 确保 uv ─────────────────────────────────────────────
  let uv = await rt.findUv(home)
  if (!uv) {
    log('未检测到 uv，开始下载自带的 uv（约 14.6 MB）…')
    await rt.installUv({ home, proxy: opts.proxy, mirror: opts.mirror, onProgress: log, signal: opts.signal })
    uv = await rt.findUv(home)
    if (!uv) throw new Error('uv 安装后仍找不到可执行文件')
  } else {
    log(`使用已有的 uv（${uv.source === 'bundled' ? 'WhalePod 自带' : '系统 PATH'}）`)
  }

  // ── 2. 确保 Python（uv 自动下载，不需要用户装）────────────
  const py = b.install.pythonVersion ?? '3.12'
  await rt.ensurePython({ home, pythonVersion: py, onProgress: log })

  // ── 3. 装包 ────────────────────────────────────────────────
  await rt.uvToolInstall({
    home,
    package: b.install.package,
    pythonVersion: py,
    onProgress: log,
  })

  // ── 4. 落地来源与许可（AGPL 也要求保留声明）────────────────
  const destDir = path.join(home, 'protocol', b.id)
  await fsp.mkdir(destDir, { recursive: true })
  const exe = rt.toolExePath(home, b.install.package)
  await fsp.writeFile(path.join(destDir, '.whale-pod-version.json'), JSON.stringify({
    backend: b.id,
    installMode: 'uv-tool',
    package: b.install.package,
    pythonVersion: py,
    uvSource: uv.source,
    exe: fs.existsSync(exe) ? exe : null,
    installedAt: Date.now(),
    license: b.license.name,
  }, null, 2) + '\n', 'utf8')

  await fsp.writeFile(path.join(destDir, 'WHALE-POD-NOTICE.md'), [
    `# ${b.name} — 来源与许可`,
    '',
    `- 项目主页：${b.homepage}`,
    `- 源码仓库：${b.repo}`,
    `- 许可：${b.license.name}（${b.license.spdx}）`,
    `- 许可全文：${b.license.url}`,
    `- 安装方式：uv tool install ${b.install.package} --python ${py}`,
    `- 安装时间：${new Date().toISOString()}`,
    '',
    '## 许可要点',
    '',
    `- 商业用途：${b.license.commercialUse ? '允许' : '禁止'}`,
    `- 再分发：${b.license.redistributable ? '允许' : '禁止'}`,
    `- 说明：${b.license.note}`,
    '',
    '## 隔离说明',
    '',
    'WhalePod 使用自带的 uv 把 AstrBot 与其 Python 运行时装在了',
    '`~/.whale-pod/runtime/` 下，**没有修改系统 Python 或 PATH**。',
    '删掉 `~/.whale-pod/runtime/` 即可完整卸载。',
  ].join('\n'), 'utf8')

  const stat = await rt.uvStatus(home)
  log(`安装完成。uv 管理的工具：${(stat.tools ?? []).join(', ') || '(空)'}`)
  return {
    ok: true,
    dir: destDir,
    installMode: 'uv-tool',
    package: b.install.package,
    python: py,
    exe: fs.existsSync(exe) ? exe : null,
    uvTools: stat.tools ?? [],
    pythonList: stat.python ?? [],
  }
}

/** 套用 GitHub 下载镜像（国内加速）。 */
export function applyMirror(url, mirror) {
  if (!mirror) return url
  const base = String(mirror).replace(/\/$/, '')
  // 常见镜像形如 https://ghproxy.example/  —— 前缀式
  return `${base}/${url}`
}

/** 流式下载到文件，带进度与代理支持。 */
async function download(url, destFile, opts = {}) {
  const ctl = new AbortController()
  const onAbort = () => ctl.abort()
  opts.signal?.addEventListener('abort', onAbort)

  // Node 的 fetch 不读系统代理，需要显式 dispatcher —— 但 undici 未在此环境导出。
  // 退路：设置进程级 HTTP(S)_PROXY 由 fetch 读取（Node 20+ 支持这个变量）。
  const prevProxy = process.env.HTTPS_PROXY
  if (opts.proxy) process.env.HTTPS_PROXY = process.env.HTTP_PROXY = opts.proxy

  let res
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'whale-pod-protocol-manager', accept: '*/*' },
      signal: ctl.signal,
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`)

    const total = Number(res.headers.get('content-length') ?? 0)
    const out = fs.createWriteStream(destFile)
    let got = 0
    const reader = res.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        got += value.length
        opts.onProgress?.(got, total)
        if (!out.write(Buffer.from(value))) {
          await new Promise((r) => out.once('drain', r))
        }
      }
    } finally {
      await new Promise((r) => out.end(r))
    }
    if (total > 0 && got !== total) {
      throw new Error(`下载不完整：期望 ${total} 字节，实际 ${got} 字节`)
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    if (opts.proxy) {
      if (prevProxy === undefined) { delete process.env.HTTPS_PROXY; delete process.env.HTTP_PROXY }
      else { process.env.HTTPS_PROXY = process.env.HTTP_PROXY = prevProxy }
    }
  }
}

/** 解压（Windows 10+ 自带 tar.exe，能处理 zip）。 */
async function extract(archive, destDir) {
  const lower = archive.toLowerCase()
  if (lower.endsWith('.zip')) {
    // Windows: tar.exe 能解 zip；其他平台先试 unzip
    if (process.platform === 'win32') {
      await run('tar', ['-xf', archive, '-C', destDir])
    } else {
      await run('unzip', ['-q', '-o', archive, '-d', destDir])
    }
    return
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await run('tar', ['-xzf', archive, '-C', destDir])
    return
  }
  if (lower.endsWith('.7z')) {
    throw new Error('.7z 需要 7-Zip，请手动解压到目标目录。')
  }
  throw new Error('不支持的压缩格式：' + path.basename(archive))
}

/** 跑一个进程并等待完成（继承输出到日志）。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts })
    let err = ''
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => reject(new Error(`执行 ${cmd} 失败：${e.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} 退出码 ${code}${err ? '：' + err.slice(0, 200) : ''}`))
    })
  })
}

async function countFiles(dir) {
  let n = 0
  async function walk(d) {
    for (const it of await fsp.readdir(d, { withFileTypes: true })) {
      if (it.isDirectory()) await walk(path.join(d, it.name))
      else n++
    }
  }
  try { await walk(dir) } catch { /* ignore */ }
  return n
}

// ── 进程托管 ──────────────────────────────────────────────────

/**
 * 找 NapCat 的配置目录。
 *
 * 独立模式（v4.x 完整包）：protocol/napcat/napcat/config
 * 注入模式（旧 Shell 布局）：protocol/napcat/NapCat.<构建号>.Shell/versions/.../resources/app/napcat/config
 *
 * @param {string} home
 * @returns {string|null}
 */
export function findNapCatConfigDir(home) {
  const root = path.join(home, 'protocol', 'napcat')
  const direct = path.join(root, 'napcat', 'config')
  if (fs.existsSync(direct)) return direct
  try {
    for (const shell of fs.readdirSync(root)) {
      if (!/^NapCat\..*\.Shell$/i.test(shell)) continue
      const versionsDir = path.join(root, shell, 'versions')
      let versions = []
      try { versions = fs.readdirSync(versionsDir) } catch { continue }
      for (const v of versions) {
        const p = path.join(versionsDir, v, 'resources', 'app', 'napcat', 'config')
        if (fs.existsSync(p)) return p
      }
    }
  } catch { /* 不存在 */ }
  return null
}

/**
 * 找出 NapCat 已经登录过的账号（uin）。
 *
 * 判据：配置目录里有 `onebot11_<uin>.json` 或 `napcat_<uin>.json`
 * —— 这些是**登录后才生成**的 per-account 文件，所以它们存在
 * 就说明该账号登录过，可以用 `-q <uin>` 免扫码快速登录。
 *
 * 按文件修改时间倒序（最近登录的排前面）。
 *
 * @param {string} home
 * @returns {string[]} uin 列表
 */
export function listNapCatAccounts(home) {
  const dir = findNapCatConfigDir(home)
  if (!dir) return []
  const seen = new Map()
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(?:onebot11|napcat|napcat_protocol)_(\d{5,})\.json$/i.exec(f)
      if (!m) continue
      const uin = m[1]
      let t = 0
      try { t = fs.statSync(path.join(dir, f)).mtimeMs } catch { /* ignore */ }
      seen.set(uin, Math.max(seen.get(uin) ?? 0, t))
    }
  } catch { /* ignore */ }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([uin]) => uin)
}

/**
 * 把 OneBot ws + http server 写进 NapCat 的 per-account 配置。
 *
 * ⚠️ 这两件事都是**必做**，不是可选优化：NapCat 新建账号配置时
 *    `network` 里所有数组都是空的（httpServers/websocketServers…），
 *    它自己**不会**监听任何端口。
 *
 *    ① websocketServers（3001）：WhalePod 桥接是 forward 模式连它，
 *       没有就永远连不上 —— "NapCat 起来了但不回消息"。
 *    ② httpServers（3000）：WhalePod 发消息**优先走 HTTP**（有返回值、
 *       比 WS 可靠），缺了就只能每次 `HTTP send_xxx 失败（尝试 WS）`
 *       降级重试；更关键的是**图片**：`get_image` 返回的地址是由
 *       NapCat 的 HTTP 服务托管的，没有它 → 图片下载失败 → 模型
 *       `看不见图片`（用户反馈过）。
 *    ③ enableLocalFile2Url：让图片段直接带上可访问的 URL，
 *       省一次 get_image 往返，是最稳的图片通路。
 *
 * 幂等：已经存在同端口的 server 就不重复加（尊重用户手改的配置）。
 *
 * @param {string} home
 * @param {object} oneBot  WhalePod 的 cfg.qq.onebot
 * @param {object} [log]
 * @returns {{patched:string[], skipped:string[], accounts:string[]}}
 */
export function ensureOneBotServers(home, oneBot = {}, log = {}) {
  const out = { patched: [], skipped: [], accounts: [] }
  const dir = findNapCatConfigDir(home)
  if (!dir) return out

  // 从 wsUrl 解析出要监听的 host/port（WhalePod 连哪个，就让 NapCat 听哪个）
  let host = '127.0.0.1'
  let port = 3001
  try {
    const u = new URL(oneBot.wsUrl ?? 'ws://127.0.0.1:3001')
    host = u.hostname || host
    port = Number(u.port) || (u.protocol === 'wss:' ? 443 : 80)
  } catch { /* 用默认 */ }
  // HTTP API 端口（WhalePod 发消息/取图片用）
  let httpPort = 3000
  try {
    const u = new URL(oneBot.httpUrl ?? 'http://127.0.0.1:3000')
    httpPort = Number(u.port) || 80
  } catch { /* 用默认 */ }
  const token = String(oneBot.accessToken ?? '')

  const files = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^onebot11_\d{5,}\.json$/i.test(f)) files.push(f)
    }
  } catch { return out }
  // 还没有 per-account 文件（从没登录过）→ 写一份全局 onebot11.json 当模板，
  // NapCat 首次登录创建账号配置时会带上它。
  if (files.length === 0) {
    const j = {
      network: {
        httpServers: [httpServerEntry(host, httpPort, token)],
        httpSseServers: [],
        httpClients: [],
        websocketServers: [wsServerEntry(host, port, token)],
        websocketClients: [],
        plugins: [],
      },
      enableLocalFile2Url: true,
    }
    try {
      fs.writeFileSync(path.join(dir, 'onebot11.json'), JSON.stringify(j, null, 2), 'utf8')
      out.patched.push('onebot11.json (模板)')
      log.info?.(`协议端：已写入 OneBot 模板配置（ws ${host}:${port} / http ${host}:${httpPort}）`)
    } catch (e) {
      log.warn?.(`协议端：写 OneBot 模板失败 — ${String(e?.message ?? e)}`)
    }
    return out
  }

  for (const f of files) {
    const full = path.join(dir, f)
    const uin = /^onebot11_(\d+)\.json$/i.exec(f)?.[1] ?? ''
    if (uin) out.accounts.push(uin)
    let j
    try { j = JSON.parse(fs.readFileSync(full, 'utf8')) } catch { continue }
    if (typeof j !== 'object' || j === null) continue
    j.network = j.network ?? {}

    // ws 与 http **各自独立判定**：老配置里可能已有 ws 但没有 http
    // （早期版本只补了 ws），一起 continue 会漏掉 http 而图片继续坏。
    let changed = false

    const wsList = Array.isArray(j.network.websocketServers) ? j.network.websocketServers : []
    if (!wsList.some((s) => Number(s?.port) === port && s?.enable !== false)) {
      wsList.push(wsServerEntry(host, port, token))
      j.network.websocketServers = wsList
      changed = true
      log.info?.(`协议端：已为账号 ${uin || '?'} 写入 OneBot ws（${host}:${port}）`)
    }

    const httpList = Array.isArray(j.network.httpServers) ? j.network.httpServers : []
    if (!httpList.some((s) => Number(s?.port) === httpPort && s?.enable !== false)) {
      httpList.push(httpServerEntry(host, httpPort, token))
      j.network.httpServers = httpList
      changed = true
      log.info?.(`协议端：已为账号 ${uin || '?'} 写入 OneBot http（${host}:${httpPort}，发消息与取图片用）`)
    }

    // 图片段直接带可访问 URL（省一次 get_image 往返）
    if (j.enableLocalFile2Url !== true) {
      j.enableLocalFile2Url = true
      changed = true
    }

    if (!changed) { out.skipped.push(f); continue }
    try {
      fs.writeFileSync(full, JSON.stringify(j, null, 2), 'utf8')
      out.patched.push(f)
    } catch (e) {
      log.warn?.(`协议端：写 ${f} 失败 — ${String(e?.message ?? e)}`)
    }
  }
  return out
}

/** OneBot ws server 条目的统一形状（NapCat v4 字段）。 */
function wsServerEntry(host, port, token) {
  return {
    name: 'dsh-whale-pod',
    enable: true,
    host,
    port,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    token: token ?? '',
    enableForcePushEvent: true,
    debug: false,
  }
}

/**
 * OneBot http server 条目。
 *
 * 为什么必须有：WhalePod 发消息优先走 HTTP（call() 里先 fetch httpUrl，
 * 失败才降级 WS），更重要的是 `get_image` 返回的图片地址由这个 HTTP
 * 服务托管 —— 没有它图片下载必然失败，模型"看不见图片"。
 */
function httpServerEntry(host, port, token) {
  return {
    name: 'dsh-whale-pod-http',
    enable: true,
    host,
    port,
    messagePostFormat: 'array',
    enableForcePushEvent: true,
    token: token ?? '',
    debug: false,
  }
}

/**
 * 协议端进程托管：启动、看日志、停止。
 *
 * ⚠️ 与 DSH 的差异：DSH 用 KILL_ON_JOB_CLOSE 把子进程绑死在自己身上；
 * WhalePod 是独立进程，所以这里的子进程随 WhalePod 退出而终止
 * （进程退出时统一 kill），但**不会**被系统的 Job 对象牵连。
 */
export class ProtocolSupervisor {
  /**
   * @param {object} opts
   * @param {string} opts.home
   * @param {object} opts.log
   */
  constructor(opts = {}) {
    this.home = opts.home
    this.log = opts.log ?? {}
    /**
     * OneBot 连接配置（来自 WhalePod 的 cfg.qq.onebot）。
     *
     * 用途：NapCat 的 per-account 配置里 network 默认**全空**
     * （websocketServers: []），它自己不会监听任何端口 —— 必须由我们
     * 把 ws server 写进 `onebot11_<uin>.json`，否则 3001 永远 closed、
     * 桥接连不上、机器人不回消息（实测踩过）。
     */
    this.oneBot = opts.oneBot ?? {}
    /** @type {Map<string, {child:import('node:child_process').ChildProcess, startedAt:number, lines:string[], exit:object|null}>} */
    this.procs = new Map()
    /** 配置补写定时器（每个 backend 一个），stop 时要清掉 */
    this._provisionTimers = new Map()
  }

  /**
   * 某个后端是否在跑。
   *
   * ⚠️ 不能只看"我的子进程还活着"。NapCat 的启动器
   *    （NapCatWinBootMain.exe）在把 NapCatWinBootHook.dll 注入进
   *    QQ.exe **之后就会退出** —— 此时子进程已死，但 NapCat 实际
   *    正在 QQ 里跑着，OneBot 端口也开着。
   *
   *    只按子进程判定会出现：「QQ 桥接连得上、能收发消息，但组件页
   *    显示『启动』按钮」这种自相矛盾的状态（用户反馈过）。
   *
   *    所以补一条**端口判据**：NapCat 起没起，看它的 OneBot 端口
   *    有没有在监听，那才是真正对外可见的状态。
   */
  running(backendId) {
    const p = this.procs.get(backendId)
    if (p && p.child && !p.child.killed && p.exit === null) return true
    // 子进程没了（或从没由我们启动）→ 看端口
    return this._portAlive(backendId)
  }

  /**
   * 探测该后端的监听端口。
   *
   * 只探测**本机回环**上已知的端口，不做端口扫描：
   *   napcat  → 3001（OneBot 反向 WS）、6099（WebUI）
   *   astrbot → 6185（它的 WebUI / 默认端口）
   *
   * @returns {boolean} 有任一端口在监听 → 认为在运行
   */
  _portAlive(backendId) {
    const PORTS = {
      napcat: [3001, 6099],
      astrbot: [6185, 6199],
      snowluma: [],
    }[backendId] ?? []
    if (PORTS.length === 0) return false
    for (const port of PORTS) {
      if (isPortListening(port)) return true
    }
    return false
  }

  /** 取最近日志（环形）。 */
  logs(backendId, n = 200) {
    const p = this.procs.get(backendId)
    if (!p) return []
    return p.lines.slice(-n)
  }

  /** 状态快照（供 Web UI）。 */
  status() {
    const out = {}
    for (const b of Object.values(BACKENDS)) {
      const p = this.procs.get(b.id)
      out[b.id] = {
        running: this.running(b.id),
        startedAt: p?.startedAt ?? null,
        pid: p?.child?.pid ?? null,
        lastExit: p?.exit ?? null,
        logLines: p?.lines.length ?? 0,
      }
    }
    return out
  }

  /**
   * 启动一个后端。
   * @param {string} backendId
   * @param {object} [opts]
   * @param {string[]} [opts.args]
   * @param {object} [opts.env]
   */
  start(backendId, opts = {}) {
    const b = BACKENDS[backendId]
    if (!b) throw new Error('未知后端：' + backendId)
    if (b.install.mode === 'manual') {
      throw new Error(`${b.name} 需手动启动：${b.install.reason}`)
    }
    if (this.running(backendId)) throw new Error(`${b.name} 已在运行`)

    const dir = path.join(this.home, 'protocol', backendId)
    const exe = this._findExe(backendId, dir)
    if (!exe) {
      throw new Error(`找不到 ${b.name} 的可执行文件（已安装？目录：${dir}）`)
    }

    // 默认启动参数：uv 工具式（AstrBot）需要子命令，解压式（NapCat）不需要
    const defaultArgs = b.install.mode === 'uv-tool'
      ? (b.install.runArgs ?? []).slice(1)   // exe 已是 `astrbot`，只要后面的 `run`
      : []

    this.log.info?.(`协议端：启动 ${b.name}（${exe}）`)
    // 入口是 .js（NapCat 独立模式 index.js）→ 必须交给 node 跑；
    // 直接 spawn .js 在 Windows 上会报 EINVAL（没有可执行关联）。
    const isJs = /\.m?js$/i.test(exe)
    const spawnExe = isJs ? process.execPath : exe
    let spawnArgs = isJs ? [exe] : (opts.args ?? defaultArgs)

    // ── NapCat 专有：写 OneBot 配置 + 免扫码快速登录 ──────────────
    //
    // 两件事都必须做，缺一个都会表现为"NapCat 起来了但不回消息"：
    //   ① per-account 配置里的 network 默认全空 → 没人监听 3001
    //      → 桥接永远连不上。所以启动前先把 ws server 写进去。
    //   ② 不带 `-q <uin>` 时 NapCat 每次都要求扫码；带上就直接
    //      快速登录（前提是该账号登录过，配置文件在）。
    if (backendId === 'napcat') {
      try {
        ensureOneBotServers(this.home, this.oneBot, this.log)
      } catch (e) {
        this.log.warn?.(`协议端：预写 OneBot 配置失败 — ${String(e?.message ?? e)}`)
      }
      if (isJs && !spawnArgs.includes('-q')) {
        const accounts = listNapCatAccounts(this.home)
        if (accounts.length > 0) {
          spawnArgs = [...spawnArgs, '-q', accounts[0]]
          this.log.info?.(`协议端：使用快速登录账号 ${accounts[0]}（免扫码）`)
        } else {
          this.log.info?.('协议端：没有已登录账号，将走扫码登录')
        }
      }
    }

    const child = spawn(spawnExe, spawnArgs, {
      cwd: path.dirname(exe),
      env: { ...process.env, ...(opts.env ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // 首次登录时 NapCat 才创建 onebot11_<uin>.json —— 启动前那次补写
    // 覆盖不到它，所以再挂一个短时轮询：登录一完成就把 ws/http 补上。
    // 两个端口都监听了才停（最多 3 分钟）。
    if (backendId === 'napcat') {
      const wsPort = (() => {
        try { return Number(new URL(this.oneBot.wsUrl ?? 'ws://127.0.0.1:3001').port) || 3001 } catch { return 3001 }
      })()
      const httpPort = (() => {
        try { return Number(new URL(this.oneBot.httpUrl ?? 'http://127.0.0.1:3000').port) || 3000 } catch { return 3000 }
      })()
      let tries = 0
      const timer = setInterval(() => {
        tries++
        try {
          // ws 有了但 http 还没有时不能提前退出（否则图片继续坏）
          if (isPortListening(wsPort) && isPortListening(httpPort)) {
            clearInterval(timer)
            this._provisionTimers.delete(backendId)
            return
          }
          ensureOneBotServers(this.home, this.oneBot, this.log)
        } catch { /* ignore */ }
        if (tries >= 36) {   // 36 × 5s = 3 分钟
          clearInterval(timer)
          this._provisionTimers.delete(backendId)
        }
      }, 5000)
      timer.unref?.()
      this._provisionTimers.set(backendId, timer)
    }

    const entry = { child, startedAt: Date.now(), lines: [], exit: null, loginHinted: false }
    const push = (stream, buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue
        entry.lines.push({ at: Date.now(), stream, text: line.slice(0, 500) })
        if (entry.lines.length > 500) entry.lines.shift()
        // ── 登录被踢的诊断提示（只提一次，避免刷屏）──────────────
        //
        // NapCat 登上后立刻掉线并反复 `Login Error ErrCode: 3`，最常见原因
        // 不是配置错误，而是**同一 QQ 号已在官方 QQ 客户端登录**：腾讯限制
        // 一个账号在同一设备只能一处在线，两边互踢。日志里只有一行
        // "账号已离线，正在重启 Worker"，用户完全看不出该做什么。
        if (backendId === 'napcat' && !entry.loginHinted
          && /账号已离线|Login Error|ErrCode:\s*3/i.test(line)) {
          entry.loginHinted = true
          this.log.warn?.(
            '协议端：NapCat 登录被拒/被踢（ErrCode 3）—— 通常是**同一 QQ 号已在官方 QQ 客户端登录**，'
            + '腾讯只允许一处在线。请先退出官方 QQ（或换一个账号扫码），然后在 NapCat 面板重新登录。',
          )
        }
      }
    }
    child.stdout?.on('data', (d) => push('out', d))
    child.stderr?.on('data', (d) => push('err', d))
    child.on('exit', (code, signal) => {
      entry.exit = { code, signal, at: Date.now() }
      this.log.warn?.(`协议端：${b.name} 已退出（code=${code} signal=${signal}）`)
    })
    child.on('error', (e) => {
      entry.exit = { code: null, signal: null, at: Date.now(), error: String(e?.message ?? e) }
      this.log.warn?.(`协议端：${b.name} 启动失败 — ${e.message}`)
    })

    this.procs.set(backendId, entry)
    return { ok: true, pid: child.pid, exe }
  }

  /**
   * 找到该后端可执行文件（兼容解压式与 uv 工具式两种安装）。
   *
   * 支持 runCandidates 里带 `*` 的单层通配（如 `NapCat.*.Shell/napcat.bat`）——
   * NapCat 的 Shell 目录名带构建号，每次升级都会变，写死必然失效。
   */
  _findExe(backendId, dir) {
    const b = BACKENDS[backendId]
    // uv 工具（AstrBot）：真实可执行在 runtime/uv-tools/bin/
    if (b.install.mode === 'uv-tool' && b.install.package) {
      const exe = rt.toolExePath(this.home, b.install.package)
      if (fs.existsSync(exe)) return exe
    }
    for (const rel of (b.install.runCandidates ?? [])) {
      const hit = resolveWildcard(dir, rel)
      if (hit) return hit
    }
    // 退路：目录下找同名 exe
    try {
      const hit = fs.readdirSync(dir).find((f) => /\.(exe|bat|cmd)$/i.test(f))
      if (hit) return path.join(dir, hit)
    } catch { /* ignore */ }
    return null
  }

  /**
   * 停止一个后端。
   *
   * ⚠️ 两种来源都要能停：
   *   ① 我们 spawn 的子进程（this.procs 里有 entry）→ 直接 kill
   *   ② **不是我们启动的**（用户手动开的、或上一轮 WhalePod 留下的）
   *      → this.procs 里没有 entry，但端口探测判定它"在运行"。
   *        原来这里直接返回 `{ok:false, reason:'未在运行'}` —— 而界面
   *        显示的却是「运行中」，于是点「停止」毫无反应，用户完全
   *        看不出发生了什么（实测反馈过）。
   *
   *   ②的情况下只能**按进程特征找并结束**：NapCat 的进程树有明显特征
   *   （可执行文件在 <home>/protocol/napcat/ 下），可以精确定位，
   *   不会误伤用户自己的 QQ。
   */
  async stop(backendId, { timeoutMs = 5000 } = {}) {
    // 停掉可能还在跑的 OneBot 配置补写轮询（否则它会在进程死后继续写文件）
    const timer = this._provisionTimers.get(backendId)
    if (timer) { clearInterval(timer); this._provisionTimers.delete(backendId) }
    const entry = this.procs.get(backendId)

    if (entry && entry.child) {
      const child = entry.child
      try { child.kill() } catch { /* ignore */ }
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          resolve()
        }, timeoutMs)
        child.once('exit', () => { clearTimeout(t); resolve() })
      })
      this.procs.delete(backendId)
      this.log.info?.(`协议端：已停止 ${BACKENDS[backendId]?.name ?? backendId}`)
      // 有时候 kill 了子进程但真正的 NapCat 还挂在 QQ 进程里（启动器提前退出），
      // 所以再兜一次：如果端口还在监听，按进程特征清掉
      if (this._portAlive(backendId)) {
        const n = this._killBySignature(backendId)
        if (n > 0) this.log.info?.(`协议端：另按进程特征结束了 ${n} 个残留进程`)
      }
      return { ok: true, stopped: 'child' }
    }

    // 不是我们启动的 —— 按进程特征结束
    if (!this._portAlive(backendId)) return { ok: false, reason: '未在运行' }
    const n = this._killBySignature(backendId)
    if (n === 0) {
      return {
        ok: false,
        reason: '它不是你启动的，且没找到可结束的进程。请手动关掉 NapCat 窗口。',
      }
    }
    this.log.info?.(`协议端：已按进程特征停止 ${BACKENDS[backendId]?.name ?? backendId}（${n} 个进程）`)
    return { ok: true, stopped: 'signature', count: n }
  }

  /**
   * 按**可执行文件路径特征**结束某个后端的进程。
   *
   * 为什么安全：先按进程名粗筛（QQ.exe / NapCatWinBootMain.exe），
   * 再**逐个校验可执行文件路径**是否落在该后端安装目录里
   * （`<home>/protocol/<id>/…`）。
   *
   * 用户自己的 QQ 装在别处（如 `D:\Tencent\QQ\QQ.exe`），
   * 而 NapCat 自带的在 `…/protocol/napcat/NapCat.XXXX.Shell/QQ.exe`，
   * 路径不同 ⇒ 不会被误杀。
   *
   * @returns {number} 结束掉的进程数
   */
  _killBySignature(backendId) {
    let killed = 0
    try {
      const procs = listProcesses(this.home, backendId)
      // 逐个校验路径（tasklist 拿不到路径，用 taskkill 之前先验一次）
      for (const p of procs) {
        const full = this._procPath(p.pid)
        if (!full) continue
        const norm = full.replace(/\//g, '\\').toLowerCase()
        const prefix = path.join(this.home, 'protocol', backendId).replace(/\//g, '\\').toLowerCase()
        if (!norm.startsWith(prefix)) {
          this.log.debug?.(`协议端：跳过 pid ${p.pid}（路径不在 ${backendId} 目录下：${full}）`)
          continue
        }
        try {
          execFileSync('taskkill', ['/PID', String(p.pid), '/F', '/T'], {
            encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
          })
          killed++
        } catch { /* 已退出或没权限，忽略 */ }
      }
    } catch (e) {
      this.log.warn?.(`协议端：按特征结束失败 — ${String(e?.message ?? e)}`)
    }
    return killed
  }

  /**
   * 取进程的可执行文件完整路径（拿不到返回 null）。
   * 复用模块级的 procPathOf（见那里的说明）。
   */
  _procPath(pid) {
    return procPathOf(pid)
  }

  /** 退出时清理所有子进程。 */
  async stopAll() {
    for (const id of [...this.procs.keys()]) {
      try { await this.stop(id) } catch { /* ignore */ }
    }
  }
}
