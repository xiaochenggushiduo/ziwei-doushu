@echo off
chcp 65001 >nul
title Ziwei Doushu - local dev server
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies, please wait...
  call npm install --no-audit --no-fund
)
echo Starting at http://localhost:3000  (Ctrl+C to stop)
start "" http://localhost:3000
call npm run dev
