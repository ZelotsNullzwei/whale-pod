' Launch WhalePod silently -- no console window at all.
'
' Why this exists (2026-11-07):
'   run-dev.bat starts the whale with `start "whale-pod" /min ...`, which
'   creates a *minimized but visible* console window titled "whale-pod".
'   The user saw it and asked "why is my node window back?". The runtime was
'   fine (the bundled DSH node), only the window was unwanted.
'
'   wscript.exe is a GUI-subsystem host (no console of its own), and
'   WScript.Shell.Run with window style 0 starts the child hidden.
'   Third arg False = don't wait, so wscript exits immediately and the whale
'   keeps running on its own.
'
' Usage:
'   wscript //nologo run-hidden.vbs
'
' ASCII only: cmd/wscript read .vbs in the ANSI codepage (GBK here).
Option Explicit

Dim sh, fso, proc, rt, f, p, node, repo, home_, app_, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

home_ = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\whale-pod"
repo = "D:\DSH WorkSpace\whale-pod"
app_ = "D:/DSH Next/resources"

' -- DSH's bundled node: %USERPROFILE%\.dsh\dsh-runtimes\*\dependencies\node\bin\node.exe
node = ""
rt = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.dsh\dsh-runtimes"
If fso.FolderExists(rt) Then
  For Each f In fso.GetFolder(rt).SubFolders
    If node = "" Then
      p = f.Path & "\dependencies\node\bin\node.exe"
      If fso.FileExists(p) Then node = p
    End If
  Next
End If
If node = "" Then
  WScript.Echo "bundled node not found under " & rt
  WScript.Quit 1
End If

' -- refill a missing data dir argument with the live one
If Not fso.FolderExists(home_) Then
  WScript.Echo "data dir not found: " & home_
  WScript.Quit 1
End If

sh.CurrentDirectory = repo
cmd = """" & node & """" _
    & " """ & repo & "\src\index.js""" _
    & " --daemon --hosted --no-tray" _
    & " --home """ & home_ & """" _
    & " --dsh-app """ & app_ & """"

' 0 = hidden window, False = do not wait for it
sh.Run cmd, 0, False
