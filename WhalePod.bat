@echo off
REM ============================================================
REM  WhalePod —— QQ 机器人运行时 + 免费优先的 LLM 网关
REM
REM  ASCII-only on purpose: cmd.exe parses .bat files with the
REM  system ANSI codepage (GBK on Simplified-Chinese Windows),
REM  so UTF-8 text here would become mojibake and be executed
REM  as commands. All UI text is emitted via PowerShell with an
REM  explicit UTF-8 console encoding.
REM ============================================================

setlocal EnableExtensions
chcp 65001 >nul 2>nul

set "HERE=%~dp0"
set "GUARDIAN_HOME=%HERE%"

REM ── 找运行时：优先系统 node，其次 DSH 自带的 Electron ──────
set "NODE_EXE="
set "DSH_EXE="

where node >nul 2>nul
if %ERRORLEVEL%==0 for /f "delims=" %%i in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%i"

if not defined NODE_EXE (
  if exist "D:\DSH Desktop\DSH Desktop.exe" set "DSH_EXE=D:\DSH Desktop\DSH Desktop.exe"
)
if not defined DSH_EXE if not defined NODE_EXE (
  if exist "C:\Program Files\DSH Desktop\DSH Desktop.exe" set "DSH_EXE=C:\Program Files\DSH Desktop\DSH Desktop.exe"
)
if not defined DSH_EXE if not defined NODE_EXE (
  if exist "%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe" set "DSH_EXE=%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe"
)

if not defined NODE_EXE if not defined DSH_EXE (
  echo.
  echo   [x] Node.js or DSH Desktop not found.
  echo.
  echo       WhalePod needs one of them:
  echo         - Node.js 22+      https://nodejs.org
  echo         - DSH Desktop      https://github.com/deepseek-ai/deepseek-harness
  echo.
  echo   Press any key to close...
  pause >nul
  exit /b 1
)

REM ── 环境变量 ────────────────────────────────────────────────
set "NO_PROXY=127.0.0.1,localhost"
REM 若本机有本地代理，可通过 GUARDIAN_PROXY 传入（默认不设，避免误用）
if defined GUARDIAN_PROXY (
  set "HTTP_PROXY=%GUARDIAN_PROXY%"
  set "HTTPS_PROXY=%GUARDIAN_PROXY%"
)

REM ── 启动 ────────────────────────────────────────────────────
if defined NODE_EXE (
  "%NODE_EXE%" "%HERE%src\index.js" %*
) else (
  set "ELECTRON_RUN_AS_NODE=1"
  "%DSH_EXE%" "%HERE%src\index.js" %*
)

set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo   [x] WhalePod exited with code %CODE%
)
echo.
echo   Press any key to close...
pause >nul
endlocal
exit /b %CODE%
