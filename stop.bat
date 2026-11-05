@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ClipperIQ Studio - Stop
cd /d "%~dp0"

echo ===========================================
echo   Stopping ClipperIQ Studio
echo ===========================================
echo.

set CLIQ_PORT=3000
if exist ".env" (
    for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
        if /i "%%a"=="PORT" if not "%%b"=="" set CLIQ_PORT=%%b
    )
)

set FOUND=0
for /f "tokens=5" %%p in ('netstat -aon ^| findstr /r /c:":%CLIQ_PORT% .*LISTENING"') do (
    echo Stopping server process %%p on port %CLIQ_PORT%...
    taskkill /F /PID %%p >nul 2>nul
    set FOUND=1
)

rem Also close the launcher window if it's still open (harmless if not found).
taskkill /F /FI "WINDOWTITLE eq ClipperIQ Studio - Server*" >nul 2>nul

if "%FOUND%"=="1" (
    echo.
    echo Server stopped.
) else (
    echo.
    echo No ClipperIQ Studio server was found running on port %CLIQ_PORT%.
)
echo.
pause
endlocal
