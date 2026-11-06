@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ClipperIQ Studio - Launcher
cd /d "%~dp0"

echo ===========================================
echo   ClipperIQ Studio
echo ===========================================
echo.

rem --- 1. Node.js present? -------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found on this computer.
    echo         Install it from https://nodejs.org ^(the LTS version^), then run this again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=1" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%
echo.

rem --- 2. First-run setup: .env and dependencies ---------------------------
if not exist ".env" (
    if exist ".env.example" (
        copy /y ".env.example" ".env" >nul
        echo [SETUP] Created .env from the template. Edit it any time to change
        echo         settings such as the port or platform API keys.
        echo.
    )
)

if not exist "server\node_modules" (
    echo [SETUP] First run detected - installing dependencies ^(this can take a
    echo         couple of minutes, mainly for ffmpeg^)...
    echo.
    pushd server
    call npm install
    if errorlevel 1 (
        popd
        echo.
        echo [ERROR] npm install failed. Check the messages above, fix them, and
        echo         run start.bat again.
        pause
        exit /b 1
    )
    popd
    echo.
    echo [OK] Dependencies installed.
    echo.
)

rem --- 3. Environment check --------------------------------------------------
echo [CHECK] Verifying ffmpeg and the environment...
pushd server
call npm run doctor
set DOCTOR_RC=%ERRORLEVEL%
popd
echo.
if not "%DOCTOR_RC%"=="0" (
    echo [ERROR] The environment check above found a problem that would stop the
    echo         server from working correctly. Fix it and run start.bat again.
    echo.
    pause
    exit /b 1
)

rem --- 4. Read the configured port (defaults to 3000) -----------------------
set CLIQ_PORT=3000
if exist ".env" (
    for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
        if /i "%%a"=="PORT" if not "%%b"=="" set CLIQ_PORT=%%b
    )
)

rem --- 5. Free the port if a previous run is still holding it ---------------
for /f "tokens=5" %%p in ('netstat -aon ^| findstr /r /c:":%CLIQ_PORT% .*LISTENING"') do (
    echo [SETUP] Port %CLIQ_PORT% is in use by process %%p - stopping it...
    taskkill /F /PID %%p >nul 2>nul
)

rem --- 6. Start the backend in its own window --------------------------------
echo [START] Launching the ClipperIQ Studio server...
start "ClipperIQ Studio - Server (close this window to stop)" cmd /k "cd /d "%~dp0server" && node index.js"

rem --- 7. Wait for it to come up, then open the browser ----------------------
set CLIQ_URL=http://localhost:%CLIQ_PORT%
powershell -NoProfile -Command ^
    "Start-Sleep -Milliseconds 800; $ok=$false; for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest -Uri '%CLIQ_URL%/healthz' -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok=$true; break}catch{Start-Sleep -Milliseconds 500}}; if($ok){exit 0}else{exit 1}"
if errorlevel 1 (
    echo [WARN] The server did not respond yet - check the "ClipperIQ Studio - Server"
    echo        window for errors. It may still be starting.
) else (
    echo [OK] Server is up at %CLIQ_URL%
    start "" "%CLIQ_URL%"
)

echo.
echo ===========================================
echo  ClipperIQ Studio is running at %CLIQ_URL%
echo  - The server keeps running in its own window.
echo  - Run stop.bat to shut it down.
echo ===========================================
echo.
pause
endlocal
