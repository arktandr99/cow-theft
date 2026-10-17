@echo off
rem Cow Theft: Server UND Cloudflare-Tunnel mit einem Doppelklick starten.
rem Die Adresse fuer deine Mitspieler wird angezeigt und automatisch in die Zwischenablage kopiert.
title Cow Theft - online starten
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_online.ps1"
if errorlevel 1 (
  echo.
  echo Es ist ein Fehler aufgetreten - siehe Meldungen oben.
  pause
)
