Option Explicit
Dim shell, files, root, executable
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
executable = root & "\node_modules\electron\dist\electron.exe"
If Not files.FileExists(executable) Then
  MsgBox "Please run npm install in the Luma Piano project first.", 48, "Luma Piano"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
shell.Run Chr(34) & executable & Chr(34) & " " & Chr(34) & root & Chr(34), 1, False
