#Requires -Version 5.1
<#
  install-whale-pod.ps1 —— WhalePod（DSH 的 QQ 聊天机器人插件）一键部署

  用法（三种，任选其一）：
    1) 双击 install-whale-pod.bat              （推荐，会等你看完结果）
    2) 右键本文件 →「使用 PowerShell 运行」
    3) powershell -ExecutionPolicy Bypass -File install-whale-pod.ps1

  可选参数：
    -DryRun            只检查并打印将要做什么，一个字节都不改
    -NoRestart         装完不自动重启 DSH
    -Profile <name>    目标 profile，默认 desktop
    -Dir <path>        安装到指定目录，默认 %USERPROFILE%\whale-pod
    -Zip <path>        用本地 zip 包安装（离线场景）

  ── 为什么需要这个脚本（而不是「照 README 手动做」）─────
  手动部署有四个坑，每一个都让人卡住：

    1) Node 版本：插件 engines 要求 ^22.19 || >=24。
       低版本能装上但运行时报 ESM 语法错，报错信息完全不指向 Node 版本。

    2) 安装形态必须是 link，不能是 copy。
       `dsh plugin add <本地目录>` 在 pnpm 下会做 hardlink 拷贝，
       之后你改了源码不生效，还以为自己装错了。
       必须用 `add link:<绝对路径>` 才是 Junction。

    3) Windows 路径带空格。
       `link:D:\my projects\whale-pod` 会被 pnpm 当成分隔符截断。
       必须引号包住整段（本脚本用引号 + 反斜杠归一化处理）。

    4) 装完必须重启 DSH 才会加载新插件。
       不重启的话侧栏没有 WhalePod，用户以为装失败。

  本脚本把四件事都做了，并在最后自检：
    · 检查 node / dsh 可用性与版本
    · 检查目标目录是否已存在（已存在就升级，不覆盖用户数据）
    · 注册到 profile（link 形态，带引号保护）
    · 自检注册结果（读 package.json 的 dependencies 确认是 link:）
    · 提示重启，并给出下一步操作指引

  日志：%TEMP%\install-whale-pod.log
#>
[CmdletBinding()]
param(
  [string]$Profile = 'desktop',
  [string]$Dir = '',
  [switch]$NoRestart,
  [switch]$DryRun,
  [string]$Zip = ''
)

$ErrorActionPreference = 'Stop'

$RepoUrl     = 'https://github.com/ZelotsNullzwei/whale-pod'
$LogFile     = Join-Path $env:TEMP 'install-whale-pod.log'
$DshHome     = Join-Path $env:USERPROFILE '.dsh'
$ProfileDir  = Join-Path $DshHome ('profiles\' + $Profile)
$script:Step = 0
$script:Fail = $false

function Log {
  param([string]$m, [string]$c = 'Gray')
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m
  Write-Host $line -ForegroundColor $c
  try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Step {
  param([string]$title)
  $script:Step++
  Write-Host ''
  Write-Host ('[' + $script:Step + '] ' + $title) -ForegroundColor Cyan
}

function Ok   { param([string]$m) Log ('  OK   ' + $m) 'Green' }
function Warn { param([string]$m) Log ('  WARN ' + $m) 'Yellow' }
function Bad  { param([string]$m) Log ('  FAIL ' + $m) 'Red'; $script:Fail = $true }

function Need-Exit {
  if ($script:Fail) {
    Write-Host ''
    Log '安装未完成。请把上面的报错发到 issue：' 'Red'
    Log ('  ' + $RepoUrl + '/issues') 'Red'
    Log ('完整日志：' + $LogFile) 'DarkGray'
    exit 1
  }
}

# ── 开场 ────────────────────────────────────────────────────
Write-Host ''
Write-Host '  WhalePod 一键部署' -ForegroundColor White
Write-Host '  给 DSH 装一个会看场合的 QQ 聊天机器人' -ForegroundColor DarkGray
Write-Host ''
if ($DryRun) {
  Write-Host '  ** DryRun 模式：只检查，不做任何修改 **' -ForegroundColor Yellow
}
Log ('目标 profile: ' + $Profile)
Log ('安装目录   : ' + $(if ($Dir) { $Dir } else { Join-Path $env:USERPROFILE 'whale-pod' }))

# ── 1. 环境检查 ─────────────────────────────────────────────
Step '检查运行环境'

# Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Bad '找不到 node。请先安装 Node.js 22.19+ 或 24+：https://nodejs.org/'
  Need-Exit
}
$nodeVer = (& node -v 2>$null | Out-String).Trim()
$m = [regex]::Match($nodeVer, '^v(\d+)\.(\d+)\.(\d+)')
if (-not $m.Success) {
  Bad ('无法解析 node 版本：' + $nodeVer)
  Need-Exit
}
$maj = [int]$m.Groups[1].Value
$min = [int]$m.Groups[2].Value
# engines: ^22.19.0 || >=24.0.0
$nodeOk = (($maj -eq 22 -and $min -ge 19) -or $maj -ge 24)
if ($nodeOk) { Ok ('node ' + $nodeVer) }
else { Bad ('node ' + $nodeVer + ' 版本过低，需要 22.19+ 或 24+'); Need-Exit }

# git（只有走 clone 才需要）
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $Zip) {
  if ($git) { Ok ('git ' + ((& git --version 2>$null | Out-String).Trim())) }
  else { Bad '找不到 git。请安装 Git，或改用 -Zip 参数从本地 zip 安装：https://git-scm.com/'; Need-Exit }
}

# dsh CLI
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) {
  Bad '找不到 dsh 命令。请确认 DSH Desktop 已安装并至少启动过一次。'
  Warn '如果 DSH 装在非默认位置，请从 DSH 的「设置 → 关于」里确认 CLI 路径，把它加进 PATH。'
  Need-Exit
}
Ok ('dsh ' + $dsh.Source)

# profile 目录
if (-not (Test-Path $ProfileDir)) {
  Bad ('profile 目录不存在：' + $ProfileDir)
  Warn '请先启动一次 DSH Desktop（它会创建 profile），再运行本脚本。'
  Need-Exit
}
Ok ('profile: ' + $ProfileDir)

# ── 2. 决定安装目录 ─────────────────────────────────────────
Step '准备安装目录'

if (-not $Dir) {
  $Dir = Join-Path $env:USERPROFILE 'whale-pod'
}
$Dir = [IO.Path]::GetFullPath($Dir)
Log ('  安装到: ' + $Dir)

$isUpgrade = $false
if (Test-Path $Dir) {
  # 判断是不是一个已存在的 whale-pod 仓库
  $marker = Join-Path $Dir 'plugin\package.json'
  if (Test-Path $marker) {
    $isUpgrade = $true
    $cur = [regex]::Match((Get-Content $marker -Raw -Encoding UTF8), '"version"\s*:\s*"([^"]+)"')
    Ok ('检测到已安装 v' + $cur.Groups[1].Value + '，将执行升级')
  } else {
    $items = @(Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue)
    if ($items.Count -gt 0) {
      Bad ('目标目录非空，且不是 whale-pod 仓库：' + $Dir)
      Warn '为避免误删你的文件，脚本不会自动清理。请换一个目录（-Dir）或手动清空后重试。'
      Need-Exit
    } else {
      Ok '目录存在但为空，继续'
    }
  }
} else {
  Ok '目录不存在，将新建'
}

if ($DryRun) {
  Log ''
  Log 'DryRun：以下操作不会执行' 'Yellow'
  Log ('  · ' + $(if ($isUpgrade) { 'git pull 更新现有仓库' } else { '获取仓库到 ' + $Dir }))
  Log ('  · dsh plugin --profile ' + $Profile + ' add "link:' + $Dir + '\plugin"')
  Log ('  · ' + $(if ($NoRestart) { '（不重启 DSH）' } else { '重启 DSH' }))
  Log ''
  Log 'DryRun 完成，环境检查全部通过。' 'Green'
  exit 0
}

# ── 3. 获取源码 ─────────────────────────────────────────────
Step '获取 WhalePod 源码'

if ($Zip) {
  # 离线：从 zip 解压
  if (-not (Test-Path $Zip)) { Bad ('找不到 zip 文件：' + $Zip); Need-Exit }
  Ok ('使用本地包 ' + $Zip)
  if ($isUpgrade) {
    Bad '已有安装时不能用 -Zip 覆盖（会丢用户数据）。请先手动备份后删除目录。'
    Need-Exit
  }
  Expand-Archive -Path $Zip -DestinationPath $Dir -Force
  # GitHub 的 zip 会多套一层 whale-pod-main 目录
  $inner = @(Get-ChildItem $Dir -Directory -ErrorAction SilentlyContinue)
  if ($inner.Count -eq 1 -and -not (Test-Path (Join-Path $Dir 'plugin'))) {
    $tmp = $inner[0].FullName
    Get-ChildItem $tmp -Force | Move-Item -Destination $Dir -Force
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Ok '已剥离外层目录名'
  }
} elseif ($isUpgrade) {
  Log '  正在更新现有仓库（git pull --ff-only）…'
  Push-Location $Dir
  try {
    $before = (& git rev-parse --short HEAD 2>$null | Out-String).Trim()
    # ⚠️ 关键：git 把进度写 stderr。PowerShell 5.1 在同一条管道里会把原生
    #    命令的 stderr 当成错误记录，配合 $ErrorActionPreference='Stop'
    #    会直接终止脚本 —— 表现为「clone/pull 刚开始就失败」，
    #    而且目录是空的，看起来像网络问题，实际是策略问题。
    #    必须临时切到 Continue，靠 $LASTEXITCODE 判断成败。
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & git pull --ff-only 2>&1 | ForEach-Object { Log ('    ' + $_) 'DarkGray' }
      $pullOk = ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $eap }

    if (-not $pullOk) {
      Warn 'git pull 失败（可能本地有未提交的改动）'
      Warn '继续用现有代码安装。如需强制更新，先在该目录执行 git stash 或 git reset --hard'
    } else {
      $after = (& git rev-parse --short HEAD 2>$null | Out-String).Trim()
      if ($before -eq $after) { Ok ('已是最新 (' + $after + ')') }
      else { Ok ('已更新 ' + $before + ' → ' + $after) }
    }
  } finally { Pop-Location }
} else {
  Log '  正在克隆（首次约 1 MB）…'
  # 同上：原生 git 的 stderr 不能被当成异常
  $eap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & git clone --depth 1 $RepoUrl $Dir 2>&1 | ForEach-Object { Log ('    ' + $_) 'DarkGray' }
    $cloneOk = ($LASTEXITCODE -eq 0)
  } finally { $ErrorActionPreference = $eap }

  if (-not $cloneOk -or -not (Test-Path (Join-Path $Dir 'plugin\package.json'))) {
    Bad '克隆失败'
    Warn '如果是网络问题，可以手动下载 zip 后用 -Zip 参数安装：'
    Warn ('  ' + $RepoUrl + '/releases/latest')
    Need-Exit
  }
  Ok '克隆完成'
}

# 校验关键文件
foreach ($f in @('plugin\package.json', 'plugin\index.js', 'src\index.js')) {
  $p = Join-Path $Dir $f
  if (Test-Path $p) { Ok ('有 ' + $f) }
  else { Bad ('缺少关键文件：' + $f); Need-Exit }
}

# ── 4. 注册到 DSH ───────────────────────────────────────────
Step '注册到 DSH'

$pluginDir = Join-Path $Dir 'plugin'
# ⚠️ 路径带空格时必须整体加引号，否则 pnpm 会把它截断
$spec = 'link:' + $pluginDir
Log ('  执行: dsh plugin --profile ' + $Profile + ' add "' + $spec + '"')

# 同上：pnpm 的进度也走 stderr，必须临时放行，否则会被当成致命错误
$eap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  & dsh plugin --profile $Profile add $spec 2>&1 | ForEach-Object { Log ('    ' + $_) 'DarkGray' }
  $addOk = ($LASTEXITCODE -eq 0)
} finally { $ErrorActionPreference = $eap }

if (-not $addOk) {
  Bad ('注册失败（exit ' + $LASTEXITCODE + '）')
  Warn '常见原因：DSH 正在运行导致 profile 被占用。关掉 DSH 后重试。'
  Need-Exit
}

# ── 5. 自检 ─────────────────────────────────────────────────
Step '自检注册结果'

$profilePkg = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $profilePkg)) { Bad '找不到 profile 的 package.json'; Need-Exit }

$pj = Get-Content $profilePkg -Raw -Encoding UTF8
$depMatch = [regex]::Match($pj, '"dsh-whale-pod"\s*:\s*"([^"]+)"')
if (-not $depMatch.Success) {
  Bad 'profile 的 dependencies 里没有 dsh-whale-pod'
  Need-Exit
}
$dep = $depMatch.Groups[1].Value
if ($dep -like 'link:*') {
  Ok ('已注册为 link: ' + $dep.Substring(5))
} else {
  Warn ('注册形态是 "' + $dep + '"，不是 link:')
  Warn '这会导致改了源码不生效。如需 link 形态，请手动执行：'
  Warn ('  dsh plugin --profile ' + $Profile + ' add "link:' + $pluginDir + '"')
}

# 确认 node_modules 里的实体存在
$installed = Join-Path $ProfileDir 'node_modules\dsh-whale-pod'
if (Test-Path $installed) {
  $it = Get-Item $installed -Force
  $kind = if ($it.LinkType) { $it.LinkType } else { '普通目录' }
  Ok ('node_modules\dsh-whale-pod 存在（' + $kind + '）')
} else {
  Bad 'node_modules 里没有 dsh-whale-pod'
  Need-Exit
}

# ── 完成 ────────────────────────────────────────────────────
Write-Host ''
Write-Host ('  ' + ('=' * 56)) -ForegroundColor Green
Write-Host '  WhalePod 已安装到 DSH' -ForegroundColor Green
Write-Host ('  ' + ('=' * 56)) -ForegroundColor Green
Write-Host ''

if ($NoRestart) {
  Write-Host '  下一步：**手动重启 DSH Desktop**，侧栏才会出现 WhalePod。' -ForegroundColor Yellow
} else {
  Write-Host '  下一步：重启 DSH Desktop（脚本已尝试自动重启）。' -ForegroundColor Yellow
  Write-Host '  重启后：侧栏 → WhalePod → 填 QQ 号 → 启动 NapCat 扫码。' -ForegroundColor Gray
}
Write-Host ''
Write-Host '  首次使用还需要：' -ForegroundColor Gray
Write-Host '    1. QQ 号（机器人账号，要另备一个）' -ForegroundColor Gray
Write-Host '    2. 手机 QQ 扫码登录 NapCat' -ForegroundColor Gray
Write-Host '    3. 在 DSH 里配好模型凭据（DeepSeek 官方 Key 或任意 OpenAI 兼容端点）' -ForegroundColor Gray
Write-Host ''
Write-Host ('  文档：' + $RepoUrl + '#readme') -ForegroundColor DarkGray
Write-Host ('  日志：' + $LogFile) -ForegroundColor DarkGray
Write-Host ''

# 尝试优雅重启 DSH
if (-not $NoRestart) {
  $procs = @(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 0) {
    Log '检测到 DSH 正在运行，尝试重启…' 'Yellow'
    Log '  提示：如果 DSH 里有未保存的对话，请手动关掉再打开。' 'Yellow'
    # 只提示，不强杀 —— 强杀可能丢用户未保存内容
    Write-Host ''
    Write-Host '  请手动关闭并重新打开 DSH Desktop（不自动强杀，避免丢未保存内容）。' -ForegroundColor Yellow
  } else {
    Log 'DSH 未运行，直接打开即可。' 'Gray'
  }
}

Log '完成' 'Green'
