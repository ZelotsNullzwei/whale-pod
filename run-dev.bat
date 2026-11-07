@echo off
REM ============================================================
REM  WhalePod launcher (detached, local dev).
REM
REM  Why a .bat + cmd /c start: launching directly from a tool call
REM  puts the process inside that call's job object, and DSH's job
REM  has KILL_ON_JOB_CLOSE -> the process dies the moment the call
REM  returns. Going through `start` detaches it into its own job.
REM
REM  Runtime: DSH's BUNDLED node
REM  (~/.dsh/dsh-runtimes/*/dependencies/node/bin/node.exe).
REM  2026-11-07 user request: "start/restart the whale with the
REM  built-in node, not the external one".
REM  ("dir /b /s" with a wildcard in a directory component finds
REM  nothing -- use "for /d" to walk the runtimes.)
REM
REM  ASCII-only: cmd reads .bat with the ANSI codepage (GBK here).
REM
REM  ⚠️ This launcher shows a CONSOLE WINDOW titled "whale-pod"
REM     (`start /min` only minimizes it -- it is still on the desktop).
REM     2026-11-07 the user noticed it and asked why the node window was
REM     back. For day-to-day / silent restarts use run-hidden.vbs instead:
REM         wscript //nologo run-hidden.vbs
REM     It runs the same bundled node with window style 0 (hidden).
REM     Keep this .bat for when you actually WANT to watch the log.
REM ============================================================
setlocal EnableExtensions
set "NO_PROXY=127.0.0.1,localhost"

REM -- DSH's bundled node ----------------------------------------
set "BUNDLED_NODE="
for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if not defined BUNDLED_NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "BUNDLED_NODE=%%~fD\dependencies\node\bin\node.exe"
)
if not defined BUNDLED_NODE (
  echo ERROR: DSH bundled node not found under %USERPROFILE%\.dsh\dsh-runtimes
  exit /b 1
)

REM -- DSH app dir (for --dsh-app) ------------------------------
set "DSH_APP="
if exist "D:\DSH Next\resources\app.asar" set "DSH_APP=D:\DSH Next\resources"
if not defined DSH_APP if exist "D:\DSH Desktop\resources\app.asar" set "DSH_APP=D:\DSH Desktop\resources"
if not defined DSH_APP if exist "%LOCALAPPDATA%\Programs\DSH Next\resources\app.asar" set "DSH_APP=%LOCALAPPDATA%\Programs\DSH Next\resources"

REM -- data dir ----------------------------------------------------
REM The live instance keeps everything under %USERPROFILE%\.dsh\whale-pod
REM (config.json / persona / memory / generated). Point it there so
REM a detached start shares the same state as the hosted one.
if not defined WHALE_POD_HOME set "WHALE_POD_HOME=%USERPROFILE%\.dsh\whale-pod"

start "whale-pod" /min "%BUNDLED_NODE%" "%~dp0src\index.js" --daemon --hosted --no-tray --home "%WHALE_POD_HOME%" --dsh-app "%DSH_APP%"
endlocal
