@echo off
REM ============================================================
REM  WhalePod 一键部署 —— 双击运行
REM
REM  ASCII-only on purpose: cmd.exe 用系统 ANSI 代码页解析 .bat
REM  （简体中文 Windows 上是 GBK），这里写 UTF-8 中文会变乱码
REM  被当成命令执行。所有中文提示都由 PowerShell 用 UTF-8 输出。
REM ============================================================

setlocal EnableExtensions
chcp 65001 >nul 2>nul

set "HERE=%~dp0"
set "PS1=%HERE%install-whale-pod.ps1"

if not exist "%PS1%" (
  echo.
  echo   [ERR] install-whale-pod.ps1 not found next to this .bat
  echo         Expected: %PS1%
  echo.
  pause
  exit /b 1
)

REM ── 找 PowerShell ─────────────────────────────────────────
set "PSEXE="
where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  for /f "delims=" %%i in ('where pwsh') do if not defined PSEXE set "PSEXE=%%i"
)
if not defined PSEXE (
  if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
    set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  )
)
if not defined PSEXE (
  echo.
  echo   [ERR] PowerShell not found.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting WhalePod installer...
echo   (Node.js 22.19+ or 24+, Git, and DSH Desktop are required)
echo.

REM -ExecutionPolicy Bypass 是必须的：默认 Restricted 策略会直接拦下 .ps1
"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*

set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo   Done.
) else (
  echo   Installer exited with code %RC%. See the log in %%TEMP%%\install-whale-pod.log
)
echo.
echo   Press any key to close this window.
pause >nul
exit /b %RC%
