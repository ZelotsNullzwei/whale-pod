@echo off
setlocal EnableExtensions
start "whale-pod-restart" /min "C:\Program Files\nodejs\node.exe" "D:\DSH WorkSpace\whale-pod\src\index.js" --daemon --hosted --no-tray --home C:\Users\Null_zwei\.dsh\whale-pod
endlocal