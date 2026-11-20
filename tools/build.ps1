# Builds the single-file app: ABI-Field-Merchant.exe (web files + icon compiled in).
# Usage: powershell -ExecutionPolicy Bypass -File tools\build.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root
if (-not (Test-Path app.ico)) { & (Join-Path $PSScriptRoot 'make-icon.ps1') | Out-Null }

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$web = 'index.html', 'mini.html', 'app.js', 'audioListener.js', 'audioWorker.js', 'screen.js', 'merchantData.js', 'data.js'
$resArgs = $web | ForEach-Object { "/resource:$_,web/$_" }
$common = @('/nologo', '/target:winexe', '/optimize+', '/win32icon:app.ico',
            '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:Microsoft.CSharp.dll', '/r:System.Core.dll',
            # Windows built-in OCR (WinRT)
            '/r:C:\Windows\System32\WinMetadata\Windows.Media.winmd', '/r:C:\Windows\System32\WinMetadata\Windows.Foundation.winmd',
            '/r:C:\Windows\System32\WinMetadata\Windows.Graphics.winmd', '/r:C:\Windows\System32\WinMetadata\Windows.Globalization.winmd',
            '/r:C:\Windows\System32\WinMetadata\Windows.Storage.winmd', '/r:C:\Windows\System32\WinMetadata\Windows.Security.winmd',
            '/r:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Runtime.dll',
            '/r:C:\Windows\Microsoft.NET\Framework64\v4.0.30319\System.Runtime.WindowsRuntime.dll') + $resArgs

# Compile to a temp file first, so a failed build never breaks the working exe
& $csc @common '/out:ABI-Field-Merchant.new.exe' Launcher.cs
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

# A running copy locks the exe: ask it to step aside (the app window reloads onto the new build)
$wasRunning = $false
try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 http://127.0.0.1:5173/api/quit | Out-Null; $wasRunning = $true } catch { }
foreach ($n in 'ABI-Field-Merchant', 'Launch-ABI-Companion') { Get-Process $n -ErrorAction SilentlyContinue | ForEach-Object { $wasRunning = $true; $_.Kill(); $_.WaitForExit(3000) | Out-Null } }
Start-Sleep -Milliseconds 300

Move-Item ABI-Field-Merchant.new.exe ABI-Field-Merchant.exe -Force
# Same build under the old name, for older shortcuts
try { Copy-Item ABI-Field-Merchant.exe Launch-ABI-Companion.exe -Force } catch { }
'{0}: {1:N0} KB' -f 'ABI-Field-Merchant.exe', ((Get-Item ABI-Field-Merchant.exe).Length / 1KB)
if ($wasRunning -and -not $env:ABI_NO_RESTART) { Start-Process .\ABI-Field-Merchant.exe -ArgumentList '--server-only'; 'restarted the running app on the new build' }
