@echo off
setlocal
title Panel Anime-Sama
cd /d "%~dp0"

rem Cherche un Python utilisable : lanceur officiel, puis python, puis python3.
set "PY="
where py       >nul 2>&1 && set "PY=py -3"
if not defined PY where python  >nul 2>&1 && set "PY=python"
if not defined PY where python3 >nul 2>&1 && set "PY=python3"

if not defined PY (
  echo.
  echo   Python est introuvable.
  echo   Installe-le depuis https://www.python.org/downloads/
  echo   en cochant "Add Python to PATH", puis relance ce fichier.
  echo.
  pause
  exit /b 1
)

%PY% serve.py %*
if errorlevel 1 pause
endlocal
