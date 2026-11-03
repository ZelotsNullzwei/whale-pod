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
REM ⚠️ This used to be named GUARDIAN_HOME (the project's old name).
REM    NOTHING reads GUARDIAN_HOME -- src/config/store.js and
REM    src/config/credentials.js both read WHALE_POD_HOME, with the
REM    default being %USERPROFILE%\.whale-pod.
REM    So the old line silently did nothing: launching via this .bat
REM    kept the data dir at the default instead of %HERE%.
REM    Fixed 2026-11-03.
set "WHALE_POD_HOME=%HERE%"

REM ── Find a runtime: system node first, then DSH's bundled Electron ──
REM DSH renamed Desktop -> "DSH Next" (new install dir + "DSH NEXT.exe").
REM Old paths are kept as fallbacks so older installs still work.
set "NODE_EXE="
set "DSH_EXE="

where node >nul 2>nul
if %ERRORLEVEL%==0 for /f "delims=" %%i in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%i"

if not defined NODE_EXE (
  if exist "D:\DSH Next\DSH NEXT.exe" set "DSH_EXE=D:\DSH Next\DSH NEXT.exe"
)
if not defined DSH_EXE if not defined NODE_EXE (
  if exist "D:\DSH Desktop\DSH Desktop.exe" set "DSH_EXE=D:\DSH Desktop\DSH Desktop.exe"
)
if not defined DSH_EXE if not defined NODE_EXE (
  if exist "C:\Program Files\DSH Next\DSH NEXT.exe" set "DSH_EXE=C:\Program Files\DSH Next\DSH NEXT.exe"
)
if not defined DSH_EXE if not defined NODE_EXE (
  if exist "C:\Program Files\DSH Desktop\DSH Desktop.exe" set "DSH_EXE=C:\Program Files\DSH Desktop\DSH Desktop.exe"
)
if not defined DSH_EXE if not defined NODE_EXE (
  if exist "%LOCALAPPDATA%\Programs\DSH Next\DSH NEXT.exe" set "DSH_EXE=%LOCALAPPDATA%\Programs\DSH Next\DSH NEXT.exe"
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

REM ── Environment variables ─────────────────────────────────────
set "NO_PROXY=127.0.0.1,localhost"
REM Optional local proxy. Renamed GUARDIAN_PROXY -> WHALE_POD_PROXY
REM (2026-11-03, project rename). The old name is still honored so
REM existing shortcuts keep working.
if not defined WHALE_POD_PROXY if defined GUARDIAN_PROXY set "WHALE_POD_PROXY=%GUARDIAN_PROXY%"
if defined WHALE_POD_PROXY (
  set "HTTP_PROXY=%WHALE_POD_PROXY%"
  set "HTTPS_PROXY=%WHALE_POD_PROXY%"
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
