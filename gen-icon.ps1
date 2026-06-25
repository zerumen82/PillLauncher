Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

# Transparent background
$g.Clear([System.Drawing.Color]::Transparent)

# ── Capsule dimensions ──
$pillW = 420
$pillH = 640
$rx = $pillW / 2
$cx = $size / 2
$cy = $size / 2

# ── Outer capsule (fluorescent gradient) ──
$c1 = [System.Drawing.Color]::FromArgb(255, 0, 212, 255)   # cyan
$c2 = [System.Drawing.Color]::FromArgb(255, 0, 255, 136)   # green

$gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, ($cy - $pillH/2))),
    (New-Object System.Drawing.PointF(0, ($cy + $pillH/2))),
    $c1, $c2
)

# Create capsule path
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(([int]($cx - $rx)), ([int]($cy - $pillH/2)), $pillW, $pillW, 180, 180)
$path.AddArc(([int]($cx - $rx)), ([int]($cy + $pillH/2 - $pillW)), $pillW, $pillW, 0, 180)
$path.CloseAllFigures()

$g.FillPath($gradBrush, $path)

# ── Glow effect (blurred larger capsule behind) ──
$glowW = $pillW + 80
$glowH = $pillH + 80
$glowRx = $glowW / 2
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddArc(([int]($cx - $glowRx)), ([int]($cy - $glowH/2)), $glowW, $glowW, 180, 180)
$glowPath.AddArc(([int]($cx - $glowRx)), ([int]($cy + $glowH/2 - $glowW)), $glowW, $glowW, 0, 180)
$glowPath.CloseAllFigures()

$glowC = [System.Drawing.Color]::FromArgb(30, 0, 212, 255)
$glowBrush = New-Object System.Drawing.SolidBrush($glowC)
$g.FillPath($glowBrush, $glowPath)

# ── Inner highlight (shiny reflection on left side) ──
$innerW = $pillW - 40
$innerH = $pillH - 30
$innerRx = $innerW / 2
$innerPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$innerPath.AddArc(([int]($cx - $innerRx)), ([int]($cy - $innerH/2)), $innerW, $innerW, 180, 180)
$innerPath.AddArc(([int]($cx - $innerRx)), ([int]($cy + $innerH/2 - $innerW)), $innerW, $innerW, 0, 180)
$innerPath.CloseAllFigures()

$hC1 = [System.Drawing.Color]::FromArgb(80, 255, 255, 255)
$hC2 = [System.Drawing.Color]::FromArgb(0, 255, 255, 255)
$hlGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, ($cy - $innerH/2))),
    (New-Object System.Drawing.PointF(0, ($cy + $innerH/2))),
    $hC1, $hC2
)
$g.FillPath($hlGrad, $innerPath)

# ── Divider line (capsule halves) ──
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(40, 255, 255, 255))
$pen.Width = 3
$g.DrawLine($pen, ($cx - $rx + 20), $cy, ($cx + $rx - 20), $cy)

$g.Save()
$bmp.Save("$PSScriptRoot\icon-source.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Host "OK: icon-source.png created"
