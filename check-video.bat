@echo off
setlocal
cd /d "%~dp0server"
if "%~1"=="" (
  echo Drag a video file onto this .bat file, or run:  check-video.bat "C:\path\video.mp4"
  pause
  exit /b 1
)
node scripts\check-video.js "%~1" %2
echo.
pause
