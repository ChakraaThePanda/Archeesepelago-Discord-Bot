@echo off
title Archeesepelago Discord Bot
pushd "%~dp0"

echo.
echo  ============================================
echo   Archeesepelago Discord Bot
echo  ============================================
echo.

:: ── Node.js check ────────────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    :: Node not in PATH. Check known install locations first (handles post-install PATH lag)
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
        goto node_ok
    )
    if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
        set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
        goto node_ok
    )

    echo  [!] Node.js not found. Installing...
    echo.

    :: Try winget via full path (Windows 10/11, avoids PATH lookup issues)
    set "WINGET=%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe"
    if exist "%WINGET%" (
        "%WINGET%" install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        if exist "%ProgramFiles%\nodejs\node.exe" (
            set "PATH=%ProgramFiles%\nodejs;%PATH%"
            echo.
            echo  Node.js installed successfully.
            echo.
            goto node_ok
        )
        echo.
        echo  [!] winget install failed, trying PowerShell download...
        echo.
    )

    :: Fallback: download and install LTS via PowerShell
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $v=((Invoke-WebRequest 'https://nodejs.org/dist/index.json' -UseBasicParsing).Content | ConvertFrom-Json | Where-Object{$_.lts -ne $false})[0].version; $d=$env:TEMP+'\node_setup.msi'; Write-Host ('  Downloading Node.js '+$v+'...'); (New-Object Net.WebClient).DownloadFile('https://nodejs.org/dist/'+$v+'/node-'+$v+'-x64.msi',$d); Write-Host '  Installing (a UAC prompt may appear)...'; Start-Process msiexec -ArgumentList @('/i',$d,'/quiet','/norestart') -Wait -Verb RunAs"

    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%ProgramFiles%\nodejs;%PATH%"
        echo.
        echo  Node.js installed successfully.
        echo.
        goto node_ok
    )
    if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
        set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
        echo.
        echo  Node.js installed successfully.
        echo.
        goto node_ok
    )

    echo.
    echo  [!] Automatic install failed.
    echo      Please install Node.js manually from https://nodejs.org/
    echo      Then run this file again.
    echo.
    pause
    exit /b 1
)

:node_ok

:: ── Config check ──────────────────────────────────────────────────────────────
if not exist "archeesepelago.conf" (
    echo  [!] archeesepelago.conf not found.
    echo.
    echo      It should be in the same folder as this file.
    echo.
    pause
    exit /b 1
)

:check_config
findstr /C:"FILL_ME_IN" archeesepelago.conf >nul 2>&1
if %errorlevel% equ 0 (
    echo  [!] archeesepelago.conf is not configured yet.
    echo.
    echo      Opening it for you now. Fill in the two values, save the file,
    echo      then press any key here to continue.
    echo.
    echo        CT_API_KEY:     from your CheeseTrackers profile page
    echo        DISCORD_TOKEN:  from discord.com/developers ^> your app ^> Bot
    echo.
    start notepad archeesepelago.conf
    pause
    goto check_config
)

:: ── Dependencies ─────────────────────────────────────────────────────────────
if not exist "node_modules" (
    echo  Installing dependencies ^(first run only^)...
    echo.
    npm install --no-audit
    if not exist "node_modules\discord.js" (
        echo.
        echo  [!] npm install failed. See errors above.
        echo.
        pause
        exit /b 1
    )
    echo.
    echo  Dependencies installed. Restarting to launch bot...
    echo.
    start "" "%~f0"
    exit
)

:: ── Start ─────────────────────────────────────────────────────────────────────
echo  Starting bot... ^(Ctrl+C to stop^)
echo.
node index.js
set "NODE_EXIT=%errorlevel%"
echo.
echo  ============================================
if %NODE_EXIT% neq 0 (
    echo  [!] Bot stopped with error code %NODE_EXIT%.
    echo      Check the output above for details.
) else (
    echo  Bot stopped cleanly.
)
echo  ============================================
echo.
pause
