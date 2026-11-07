@echo off
REM ============================================================
REM  WhalePod launcher (console).
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
REM The project used to be named GUARDIAN. Nothing reads
REM GUARDIAN_HOME -- src/config/store.js and src/config/credentials.js
REM both read WHALE_POD_HOME, with the default being
REM %USERPROFILE%\.whale-pod. The old line silently did nothing:
REM launching via this .bat kept the data dir at the default
REM instead of %HERE%. Fixed 2026-11-03.
set "WHALE_POD_HOME=%HERE%"

REM -- Find a runtime.
REM RUNTIME PRIORITY (2026-11-07, user request):
REM   1. DSH's BUNDLED node  (~/.dsh/dsh-runtimes/*/dependencies/node/bin/node.exe)
REM   2. a node on PATH
REM   3. DSH's Electron (ELECTRON_RUN_AS_NODE=1)
REM WhalePod is hosted by DSH, so it should run on DSH's own runtime
REM rather than on whatever node is installed system-wide.
REM ("dir /b /s" with a wildcard in a directory component finds
REM  nothing -- use "for /d" to walk the runtimes.)
set "NODE_EXE="
set "DSH_EXE="

for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if not defined NODE_EXE if exist "%%~fD\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fD\dependencies\node\bin\node.exe"
)

if not defined NODE_EXE (
  where node >nul 2>nul
  if %ERRORLEVEL%==0 for /f "delims=" %%i in ('where node') do if not defined NODE_EXE set "NODE_EXE=%%i"
)

if not defined NODE_EXE if not defined DSH_EXE (
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
  echo   [x] No DSH bundled node, no node on PATH, no DSH runtime.
  echo.
  echo       WhalePod needs one of them:
  echo         - DSH Desktop      https://github.com/deepseek-ai/deepseek-harness
  echo         - Node.js 22+      https://nodejs.org
  echo.
  echo   Press any key to close...
  pause >nul
  exit /b 1
)

REM -- Environment variables -------------------------------------
set "NO_PROXY=127.0.0.1,localhost"
REM Optional local proxy. Renamed GUARDIAN_PROXY -> WHALE_POD_PROXY
REM (2026-11-03, project rename). The old name is still honored so
REM existing shortcuts keep working.
if not defined WHALE_POD_PROXY if defined GUARDIAN_PROXY set "WHALE_POD_PROXY=%GUARDIAN_PROXY%"
if defined WHALE_POD_PROXY (
  set "HTTP_PROXY=%WHALE_POD_PROXY%"
  set "HTTPS_PROXY=%WHALE_POD_PROXY%"
)

REM -- launch ----------------------------------------------------
if defined NODE_EXE (
  echo   runtime: %NODE_EXE%
  "%NODE_EXE%" "%HERE%src\index.js" %*
) else (
  echo   runtime: %DSH_EXE% (ELECTRON_RUN_AS_NODE=1)
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
