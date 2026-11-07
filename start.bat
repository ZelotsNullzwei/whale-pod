@echo off
REM ============================================================
REM  WhalePod launcher
REM
REM  ASCII-only on purpose: cmd.exe parses .bat files with the
REM  system ANSI codepage (GBK on Simplified-Chinese Windows),
REM  so UTF-8 text here would become mojibake and be executed
REM  as commands.
REM
REM  Why this exists: WhalePod needs Node 22+.
REM
REM  RUNTIME PRIORITY (2026-11-07, user request):
REM    1. DSH's BUNDLED node   (~/.dsh/dsh-runtimes/*/dependencies/node/bin/node.exe)
REM    2. a node on PATH
REM    3. DSH's Electron with ELECTRON_RUN_AS_NODE=1
REM  The bundled runtime comes FIRST on purpose: WhalePod is hosted
REM  by DSH, so it should run on DSH's own runtime instead of
REM  whatever node happens to be installed system-wide.
REM  (2026-11-07 note: "dir /b /s" with a wildcard in a directory
REM  component finds NOTHING -- use "for /d" to walk the runtimes.)
REM ============================================================

setlocal
chcp 65001 >nul 2>nul

set "HERE=%~dp0"

REM -- 1. DSH's bundled node ------------------------------------
set "BUNDLED_NODE="
for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if not defined BUNDLED_NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "BUNDLED_NODE=%%~fD\dependencies\node\bin\node.exe"
)
if defined BUNDLED_NODE (
  echo   using DSH bundled node: %BUNDLED_NODE%
  "%BUNDLED_NODE%" "%HERE%src\index.js" %*
  goto :done
)

REM -- 2. a real node on PATH -----------------------------------
where node >nul 2>nul
if %ERRORLEVEL%==0 (
  echo   using node from PATH
  node "%HERE%src\index.js" %*
  goto :done
)

REM -- 3. DSH's bundled Electron as node ------------------------
set "DSHEXE="
if exist "D:\DSH Next\DSH NEXT.exe" set "DSHEXE=D:\DSH Next\DSH NEXT.exe"
if not defined DSHEXE if exist "D:\DSH Desktop\DSH Desktop.exe" set "DSHEXE=D:\DSH Desktop\DSH Desktop.exe"
if not defined DSHEXE if exist "C:\Program Files\DSH Next\DSH NEXT.exe" set "DSHEXE=C:\Program Files\DSH Next\DSH NEXT.exe"
if not defined DSHEXE if exist "C:\Program Files\DSH Desktop\DSH Desktop.exe" set "DSHEXE=C:\Program Files\DSH Desktop\DSH Desktop.exe"
if not defined DSHEXE if exist "%LOCALAPPDATA%\Programs\DSH Next\DSH NEXT.exe" set "DSHEXE=%LOCALAPPDATA%\Programs\DSH Next\DSH NEXT.exe"
if not defined DSHEXE if exist "%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe" set "DSHEXE=%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe"

if not defined DSHEXE (
  echo.
  echo   ERROR: no DSH bundled node, no node on PATH, no DSH runtime.
  echo   Install DSH Desktop, or Node.js 22+ from https://nodejs.org
  echo.
  goto :done
)

echo   using DSH runtime: %DSHEXE%
set "ELECTRON_RUN_AS_NODE=1"
"%DSHEXE%" "%HERE%src\index.js" %*

:done
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" echo   (exit code %CODE%)
echo.
echo   Press any key to close this window...
pause >nul
endlocal
