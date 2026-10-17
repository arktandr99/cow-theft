# Cow Theft - Server + Cloudflare Quick Tunnel starten (Windows PowerShell 5.1 oder neuer)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$port = 3000
$serverProc = $null
$tunnelProc = $null

function Say($t, $c = 'White') { Write-Host $t -ForegroundColor $c }

try {
  Say ''
  Say '=== Cow Theft: Online-Start ===' Cyan

  # 1) Node.js vorhanden?
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Say 'Node.js wurde nicht gefunden. Bitte von https://nodejs.org installieren (LTS) und dieses Skript noch einmal starten.' Red
    exit 1
  }

  # 2) Pakete installieren, falls noetig
  if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Say 'Erster Start: Pakete werden installiert ...' Yellow
    & npm install
    if ($LASTEXITCODE -ne 0) { Say 'npm install ist fehlgeschlagen.' Red; exit 1 }
  }

  # 3) cloudflared finden oder herunterladen
  $cf = $null
  $found = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($found) { $cf = $found.Source }
  $local = Join-Path $root 'tools\cloudflared.exe'
  if (-not $cf -and (Test-Path $local)) { $cf = $local }
  if (-not $cf) {
    Say 'cloudflared wird einmalig heruntergeladen (ca. 40 MB) ...' Yellow
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'tools') | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $local
    $cf = $local
    Say 'Download fertig.' Green
  }

  # 4) Spiel-Server starten (falls auf Port 3000 noch nichts laeuft)
  $busy = $false
  try { $busy = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) } catch { $busy = $false }
  if ($busy) {
    Say "Auf Port $port laeuft schon ein Server - der wird benutzt." Yellow
  } else {
    Say 'Spiel-Server wird gestartet ...' White
    $serverProc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'title Cow Theft Server && npm start' -WorkingDirectory $root -PassThru
    $ok = $false
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Milliseconds 500
      try { if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break } } catch { }
    }
    if (-not $ok) { Say 'Der Server ist nicht angesprungen. Siehe das Server-Fenster.' Red; exit 1 }
  }

  # 5) Tunnel starten und Adresse aus dem Log lesen
  $log = Join-Path $root 'tunnel.log'
  $log2 = Join-Path $root 'tunnel.out.log'
  Remove-Item $log, $log2 -ErrorAction SilentlyContinue
  Say 'Tunnel wird aufgebaut ...' White
  $tunnelProc = Start-Process -FilePath $cf -ArgumentList 'tunnel', '--url', "http://localhost:$port" -RedirectStandardError $log -RedirectStandardOutput $log2 -WindowStyle Hidden -PassThru

  $url = $null
  for ($i = 0; $i -lt 90 -and -not $url; $i++) {
    Start-Sleep -Milliseconds 500
    foreach ($f in @($log, $log2)) {
      if (-not (Test-Path $f)) { continue }
      try {
        $fs = [System.IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
        $sr = New-Object System.IO.StreamReader($fs)
        $txt = $sr.ReadToEnd(); $sr.Close(); $fs.Close()
        $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($m.Success) { $url = $m.Value; break }
      } catch { }
    }
    if ($tunnelProc.HasExited) { break }
  }
  if (-not $url) { Say 'Es konnte keine Tunnel-Adresse ermittelt werden (siehe tunnel.log).' Red; exit 1 }

  try { Set-Clipboard -Value $url } catch { }
  Say ''
  Say '==============================================================' Green
  Say '  FERTIG! Diese Adresse an deine Mitspieler schicken:' Green
  Say ''
  Say "  $url" Yellow
  Say ''
  Say '  (ist schon in der Zwischenablage - einfach Strg+V)' Green
  Say '  Du selbst kannst auch http://localhost:3000 benutzen.' Green
  Say '==============================================================' Green
  Say ''
  Say 'Dieses Fenster offen lassen, solange gespielt wird.' White
  Say 'Zum Beenden: Taste druecken (Server und Tunnel werden dann geschlossen).' White
  [void][System.Console]::ReadKey($true)
}
finally {
  $ErrorActionPreference = 'Continue'
  if ($tunnelProc -and -not $tunnelProc.HasExited) { try { & taskkill /PID $tunnelProc.Id /T /F | Out-Null } catch { } }
  if ($serverProc -and -not $serverProc.HasExited) { try { & taskkill /PID $serverProc.Id /T /F | Out-Null } catch { } }
}
