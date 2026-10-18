' ============================================================
'  WhalePod —— 静默启动（无控制台窗口）
'
'  双击这个文件时不会弹出黑窗口，WhalePod 在后台运行。
'  日志写在 %USERPROFILE%\.whale-pod\whale-pod.log。
'
'  想停止：双击「停止 WhalePod.vbs」
'  想看界面：双击「打开控制台.url」或用托盘菜单
' ============================================================

Option Explicit

Dim shell, fso, here, bat
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
bat = here & "\WhalePod.bat"

If Not fso.FileExists(bat) Then
  MsgBox "找不到 WhalePod.bat" & vbCrLf & "请确认文件完整。", 16, "WhalePod"
  WScript.Quit 1
End If

' 0 = 隐藏窗口，False = 不等待
shell.CurrentDirectory = here
shell.Run """" & bat & """ --no-tray", 0, False
