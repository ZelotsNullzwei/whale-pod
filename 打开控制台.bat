@echo off
REM ============================================================
REM  Open the WhalePod console in your default browser.
REM
REM  Why this exists: /api/* needs a token, and typing the URL by
REM  hand easily loses it. This reads host/port/token straight from
REM  config.json and builds the correct URL.
REM
REM  ASCII-only on purpose: cmd.exe parses .bat files with the
REM  system ANSI codepage (GBK here), so UTF-8 Chinese in a .bat
REM  would be read as mojibake and executed as commands.
REM ============================================================

setlocal EnableExtensions

set "GDIR=%USERPROFILE%\.whale-pod"
set "CFG=%GDIR%\config.json"

if not exist "%CFG%" (
  echo.
  echo   WhalePod has not run yet: config.json not found.
  echo   Expected at: %CFG%
  echo.
  echo   Start WhalePod first, then run this again.
  echo.
  pause
  exit /b 1
)

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

set "URL="
for /f "usebackq delims=" %%u in (`%PS% -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-Content -Raw -LiteralPath '%CFG%' | ConvertFrom-Json; $h = [string]$c.web.host; if (-not $h -or $h -eq '0.0.0.0') { $h = '127.0.0.1' }; 'http://{0}:{1}/?token={2}' -f $h, $c.web.port, $c.web.token"`) do set "URL=%%u"

if not defined URL (
  echo.
  echo   Could not read the web address from config.json.
  echo   Try opening: http://127.0.0.1:18898/  and add ?token= manually.
  echo.
  pause
  exit /b 1
)

echo.
echo   Opening: %URL%
echo.

start "" "%URL%"
endlocal
