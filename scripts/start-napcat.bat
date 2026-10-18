@echo off
REM ============================================================
REM  NapCat launcher for WhalePod (visible console).
REM
REM  Why a .bat:
REM    · NapCatWinBootMain.exe injects NapCatWinBootHook.dll into
REM      its own QQ.exe. It must run with its own directory as CWD.
REM    · We keep the console visible on purpose: NapCat prints the
REM      WebUI login token there, and the QQ login window needs to
REM      be seen so the user can scan the QR code.
REM    · Started via `start` so it escapes DSH's job object
REM      (otherwise it dies the moment the tool call returns).
REM
REM  ASCII-only: cmd reads .bat with the ANSI codepage (GBK here).
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"
start "NapCat" cmd /k NapCatWinBootMain.exe
endlocal
