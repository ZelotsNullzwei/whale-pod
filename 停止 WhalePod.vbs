' ============================================================
'  WhalePod —— 停止
'
'  结束所有 WhalePod 进程（含它托管的协议端子进程）。
'  不碰你自己的 DSH Desktop。
' ============================================================

Option Explicit

Dim shell, fso, here, ps, cmd, answer
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

answer = MsgBox("确定要停止 WhalePod 吗？" & vbCrLf & vbCrLf & _
                "（不会影响你自己的 DSH Desktop）", 4 + 32, "WhalePod")
If answer <> 6 Then WScript.Quit 0

here = fso.GetParentFolderName(WScript.ScriptFullName)

' 用 PowerShell 精确匹配命令行里含 whale-pod\src\index 的进程
ps = "$ErrorActionPreference='SilentlyContinue';" & _
     "$hit = Get-CimInstance Win32_Process -Filter ""Name='DSH Desktop.exe'"" | " & _
     "Where-Object { $_.CommandLine -match 'whale-pod\\\\src\\\\index' };" & _
     "if (-not $hit) { $hit = Get-CimInstance Win32_Process -Filter ""Name='node.exe'"" | " & _
     "Where-Object { $_.CommandLine -match 'whale-pod[\\\\/]src[\\\\/]index' } };" & _
     "if ($hit) { $hit | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; " & _
     "Write-Output ('stopped ' + $hit.Count) } else { Write-Output 'not-running' }"

cmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command """ & Replace(ps, """", "\""") & """"

Dim out
On Error Resume Next
out = shell.Run("cmd /c " & cmd, 0, True)
On Error Goto 0

MsgBox "WhalePod 已停止。" & vbCrLf & vbCrLf & _
       "如果之前没在运行，这条消息可以直接关掉。", 64, "WhalePod"
