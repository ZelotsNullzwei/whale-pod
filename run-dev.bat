@echo off
REM ============================================================
REM  WhalePod launcher (local dev).
REM
REM  Why a .bat + cmd /c start: launching directly from a tool call
REM  puts the process inside that call's job object, and DSH's job
REM  has KILL_ON_JOB_CLOSE -> the process dies the moment the call
REM  returns. Going through `start` detaches it into its own job.
REM
REM  ASCII-only: cmd reads .bat with the ANSI codepage (GBK here).
REM ============================================================
setlocal EnableExtensions
set "ELECTRON_RUN_AS_NODE=1"
set "NO_PROXY=127.0.0.1,localhost"
start "whale-pod" /min "D:\DSH Desktop\DSH Desktop.exe" "D:\DSH WorkSpace\whale-pod\src\index.js" --no-tray
endlocal
