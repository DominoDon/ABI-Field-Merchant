' Creates a Desktop shortcut to Launch-ABI-Companion.exe in the folder this script is in.
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
strAppDir = fso.GetParentFolderName(WScript.ScriptFullName)
strExe = strAppDir & "\Launch-ABI-Companion.exe"

If Not fso.FileExists(strExe) Then
  WScript.Echo "Launch-ABI-Companion.exe was not found next to this script." & vbCrLf & _
               "Extract the whole zip into a folder first, then run this again."
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
