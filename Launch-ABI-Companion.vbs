' ABI Field Merchant Companion Silent Launcher
Set fso = CreateObject("Scripting.FileSystemObject")
strDir = fso.GetParentFolderName(WScript.ScriptFullName)
strExe = strDir & "\Launch-ABI-Companion.exe"

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = strDir

If fso.FileExists(strExe) Then
  WshShell.Run Chr(34) & strExe & Chr(34), 0, False
Else
  WshShell.Run Chr(34) & strDir & "\Launch-ABI-Companion.bat" & Chr(34), 0, False
End If

Set WshShell = Nothing
Set fso = Nothing
