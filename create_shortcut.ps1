$WshShell = New-Object -ComObject WScript.Shell
$ProjectDir = "C:\Users\Hilmi Çelikel\.gemini\antigravity\scratch\belediye-takvimi"
$VbsPath = Join-Path $ProjectDir "launch_silent.vbs"
$IconPath = Join-Path $ProjectDir "icon.png"

# Desktop Shortcut
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath "Belediye Takvimi.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = "`"$VbsPath`""
$Shortcut.WorkingDirectory = $ProjectDir
$Shortcut.IconLocation = $IconPath
$Shortcut.Description = "T.C. Belediye Önemli Günler, Evrak & Randevu Takvim Programı v2.0"
$Shortcut.Save()

# Project Folder Direct Launcher BAT
$BatContent = @"
@echo off
cd /d "$ProjectDir"
wscript.exe "$VbsPath"
exit
"@
Set-Content -Path (Join-Path $ProjectDir "start-app.bat") -Value $BatContent -Encoding UTF8

Write-Host "Kısayollar başarıyla güncellendi."
