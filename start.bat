@echo off
REM ============================================================
REM  WhalePod launcher
REM
REM  ASCII-only on purpose: cmd.exe parses .bat files with the
REM  system ANSI codepage (GBK on Simplified-Chinese Windows),
REM  so UTF-8 text here would become mojibake and be executed
REM  as commands.
REM
REM  Why this exists: WhalePod needs Node 22+. If the machine
REM  has no standalone node, we reuse DSH Desktop's bundled
REM  Electron runtime by setting ELECTRON_RUN_AS_NODE=1 --
REM  the same trick DSH's own dsh.cmd uses.
REM ============================================================

setlocal
chcp 65001 >nul 2>nul

set "HERE=%~dp0"

REM ── 1. prefer a real node on PATH ────────────────────────────
where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%HERE%src\index.js" %*
  goto :done
)

REM ── 2. fall back to DSH's bundled runtime ────────────────────
set "DSHEXE="
if exist "D:\DSH Desktop\DSH Desktop.exe" set "DSHEXE=D:\DSH Desktop\DSH Desktop.exe"
if not defined DSHEXE if exist "C:\Program Files\DSH Desktop\DSH Desktop.exe" set "DSHEXE=C:\Program Files\DSH Desktop\DSH Desktop.exe"
if not defined DSHEXE if exist "%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe" set "DSHEXE=%LOCALAPPDATA%\Programs\DSH Desktop\DSH Desktop.exe"

if not defined DSHEXE (
  echo.
  echo   ERROR: neither node nor DSH Desktop found.
  echo   Install Node.js 22+ from https://nodejs.org
  echo   or install DSH Desktop.
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
