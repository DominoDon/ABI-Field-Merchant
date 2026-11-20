' Creates a Desktop shortcut to ABI-Field-Merchant.exe in the folder this script is in.
' (Falls back to Launch-ABI-Companion.exe, the name used by older downloads.)
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strAppDir = fso.GetParentFolderName(WScript.ScriptFullName)
strExe = strAppDir & "\ABI-Field-Merchant.exe"
If Not fso.FileExists(strExe) Then strExe = strAppDir & "\Launch-ABI-Companion.exe"

If Not fso.FileExists(strExe) Then
  WScript.Echo "ABI-Field-Merchant.exe was not found next to this script." & vbCrLf & _
               "Put this script in the same folder as ABI-Field-Merchant.exe, then run it again."
  WScript.Quit 1
End If

Set oShortcut = WshShell.CreateShortcut(WshShell.SpecialFolders("Desktop") & "\ABI Field Merchant.lnk")
oShortcut.TargetPath = strExe
oShortcut.WorkingDirectory = strAppDir
oShortcut.WindowStyle = 1
oShortcut.Description = "ABI Field Merchant Companion - mystery cargo sound decoder"
oShortcut.IconLocation = strExe & ", 0"
oShortcut.Save

WScript.Echo "Shortcut 'ABI Field Merchant' created on your Desktop."
