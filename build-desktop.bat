@echo off
setlocal EnableExtensions
title ClipperIQ Studio - Build installer
set "ROOT=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Install Node.js LTS on THIS build computer first: https://nodejs.org
  pause
  exit /b 1
)

echo [1/3] Installing server dependencies (includes ffmpeg)...
cd /d "%ROOT%server"
call npm install --omit=dev
if errorlevel 1 goto :fail

rem ffmpeg and ffprobe come in as "optional" packages: if their download failed, npm carries on without them and the installer would
rem be built WITHOUT video tools. Stop here instead, with a clear message.
if not exist "%ROOT%server\node_modules\@ffmpeg-installer\win32-x64\ffmpeg.exe" (
  echo [ERROR] ffmpeg was not downloaded ^(check the internet connection / antivirus^), so the installer would not work.
  echo         Delete the folder "%ROOT%server\node_modules" and run this file again.
  goto :fail
)
if not exist "%ROOT%server\node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe" (
  echo [ERROR] ffprobe was not downloaded. Delete the folder "%ROOT%server\node_modules" and run this file again.
  goto :fail
)

echo [2/3] Installing desktop builder...
cd /d "%ROOT%desktop"
if not exist package.json (
  echo [ERROR] The desktop folder is missing: %ROOT%desktop
  goto :fail
)
call npm install
if errorlevel 1 goto :fail

echo [3/3] Building the Windows installer (first time: downloads the captions engine, about 200 MB)...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo Done. Your installer is in "%ROOT%desktop\dist\"
echo ("ClipperIQ Studio Setup ... .exe" and a portable .exe).
echo Copy either to any Windows PC and run it. That PC does not need Node.js.
pause
exit /b 0

:fail
echo.
echo [ERROR] The build stopped. Copy the messages above and send them to Claude.
pause
exit /b 1
