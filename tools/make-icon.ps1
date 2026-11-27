# Builds app.ico (16-256 px, PNG entries) from icon.svg, the SlawBunny icon.
# Edge renders the SVG at each size (so small sizes stay crisp); System.Drawing cuts out each size.
param([string]$Out = (Join-Path $PSScriptRoot '..\app.ico'))
Add-Type -AssemblyName System.Drawing
$svg = (Resolve-Path (Join-Path $PSScriptRoot '..\icon.svg')).Path
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge is needed to render icon.svg' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('abi-icon-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
$svgUrl = 'file:///' + ($svg -replace '\\', '/')

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) {
  $html = Join-Path $tmp "icon$s.html"
  "<!doctype html><style>html,body{margin:0;background:transparent}</style><img src=`"$svgUrl`" width=`"$s`" height=`"$s`" style=`"display:block`">" |
    Set-Content $html -Encoding utf8
  $shot = Join-Path $tmp "shot$s.png"
  Start-Process $edge -Wait -WindowStyle Hidden -ArgumentList '--headless=new', '--disable-gpu', '--hide-scrollbars',
    "--user-data-dir=$tmp\profile", '--force-device-scale-factor=1', '--default-background-color=00000000',
    '--window-size=300,300', "--screenshot=$shot", ('file:///' + ($html -replace '\\', '/'))
  $full = [System.Drawing.Bitmap]::FromFile($shot)
  $crop = $full.Clone((New-Object System.Drawing.Rectangle 0, 0, $s, $s), [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $ms = New-Object System.IO.MemoryStream
  $crop.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose(); $full.Dispose()
  , $ms.ToArray()
}

# .ico: header, one directory entry per size, then the PNG data
$fsOut = [System.IO.File]::Create($Out); $bw = New-Object System.IO.BinaryWriter $fsOut
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $pngs[$i].Length; $b = [byte]($(if ($s -ge 256) { 0 } else { $s }))
  $bw.Write($b); $bw.Write($b); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$len); $bw.Write([uint32]$offset); $offset += $len
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close()
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
"wrote $Out"
