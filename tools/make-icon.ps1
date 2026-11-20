# Generates app.ico (multi-size, PNG-compressed entries) - a yellow mystery crate on a dark tile.
param([string]$Out = (Join-Path $PSScriptRoot '..\app.ico'))
Add-Type -AssemblyName System.Drawing

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}

function Draw-Icon([int]$s) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.Clear([System.Drawing.Color]::Transparent)
  $k = $s / 256.0
  $bg = New-RoundRect (4*$k) (4*$k) (248*$k) (248*$k) (52*$k)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 26, 31))), $bg)
  $yellow = [System.Drawing.Color]::FromArgb(255, 245, 197, 66)
  $dark = [System.Drawing.Color]::FromArgb(255, 22, 26, 31)
  # crate body + lid
  $body = New-RoundRect (46*$k) (92*$k) (164*$k) (122*$k) (14*$k)
  $g.FillPath((New-Object System.Drawing.SolidBrush $yellow), $body)
  $lid = New-RoundRect (36*$k) (56*$k) (184*$k) (46*$k) (12*$k)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 214, 102))), $lid)
  if ($s -ge 32) {
    $pen = New-Object System.Drawing.Pen $dark, ([float](7*$k))
    $g.DrawLine($pen, [float](36*$k), [float](102*$k), [float](220*$k), [float](102*$k))
  }
  # question mark
  $fs = [float](104*$k)
  $font = New-Object System.Drawing.Font 'Segoe UI', $fs, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF ([float](46*$k)), ([float](96*$k)), ([float](164*$k)), ([float](122*$k))
  $g.DrawString('?', $font, (New-Object System.Drawing.SolidBrush $dark), $rect, $sf)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  return ,$ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 256
$pngs = foreach ($s in $sizes) { ,(Draw-Icon $s) }
$fsOut = [System.IO.File]::Create($Out); $bw = New-Object System.IO.BinaryWriter $fsOut
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $pngs[$i].Length
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$len); $bw.Write([uint32]$offset); $offset += $len
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close()
"wrote $Out"
