@echo off
rem Cow Theft nur auf diesem PC / im lokalen Netz starten (ohne Tunnel).
title Cow Theft - Server
cd /d "%~dp0"
if not exist node_modules (
  echo Erster Start: Pakete werden installiert ...
  call npm install
)
echo Spiel laeuft dann unter http://localhost:3000  (beenden mit Strg+C)
call npm start
pause
