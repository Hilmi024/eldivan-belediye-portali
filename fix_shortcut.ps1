$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath "Belediye Takvimi.lnk"

if (Test-Path $ShortcutPath) {
    Remove-Item $ShortcutPath -Force
}

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = '"%USERPROFILE%\.gemini\antigravity\scratch\belediye-takvimi\launch_silent.vbs"'
$Shortcut.WorkingDirectory = "%USERPROFILE%\.gemini\antigravity\scratch\belediye-takvimi"
$Shortcut.IconLocation = "%USERPROFILE%\.gemini\antigravity\scratch\belediye-takvimi\icon.png"
$Shortcut.Description = "T.C. Belediye Önemli Günler ve Etkinlik Takvimi v2.0"
$Shortcut.Save()

Write-Host "Kısayol %USERPROFILE% ortam değişkeni ile sorunsuz yeniden oluşturuldu!"
