# Runs the bot hidden with a system tray icon. Launched by Start Archeesepelago.bat with -Detach.
param([switch]$Detach)

# Relaunch hidden from the start. "-WindowStyle Hidden" only hides an already-open console, which
# Windows Terminal (the Windows 11 default) leaves on screen as an empty window.
if ($Detach) {
    Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`""
    exit
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# Only one tray (and so one bot) at a time
$mutex = New-Object System.Threading.Mutex($false, "Local\ArcheesepelagoBotTray")
if (-not $mutex.WaitOne(0)) {
    [System.Windows.Forms.MessageBox]::Show("Archeesepelago is already running in the system tray.", "Archeesepelago") | Out-Null
    exit
}

$dir = Split-Path $PSScriptRoot
$log = Join-Path $dir "data\bot.log"
$entry = Join-Path $dir "src\index.js"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$script:bot = $null
$script:cmd = $null

function Start-Bot {
    # A bot from this folder still running here was orphaned by a tray that died (only one tray
    # runs per folder). Stop it, or it keeps bot.log locked and the new bot exits immediately.
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName         = "cmd.exe"
    $psi.Arguments        = "/c node `"$entry`" > `"$log`" 2>&1"
    $psi.WorkingDirectory = $dir
    $psi.UseShellExecute  = $false
    $psi.CreateNoWindow   = $true
    $script:cmd = [System.Diagnostics.Process]::Start($psi)
    $script:bot = $script:cmd
    # Track node itself, not the cmd wrapper: cmd can exit while node keeps running
    for ($i = 0; $i -lt 40; $i++) {
        $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($script:cmd.Id) AND Name='node.exe'"
        if ($child) {
            $node = Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue
            if ($node) {
                $null = $node.Handle # Without an open handle, ExitCode is empty once node exits
                $script:bot = $node
            }
            break
        }
        if ($script:cmd.HasExited) { break }
        Start-Sleep -Milliseconds 250
    }
    $tray.Text = "Archeesepelago"
    $tray.Icon = $iconRunning
}

function Stop-Bot {
    # Kill node and the cmd wrapper (either may already be gone)
    foreach ($p in @($script:bot, $script:cmd)) {
        if ($p -and -not $p.HasExited) {
            & taskkill /PID $p.Id /T /F | Out-Null
            $p.WaitForExit(5000) | Out-Null
        }
    }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
try {
    # Bot logo if present, otherwise node's icon
    $png = Join-Path $dir "assets\icon.png"
    if (Test-Path $png) {
        $src = [System.Drawing.Image]::FromFile($png)
    } else {
        $src = [System.Drawing.Icon]::ExtractAssociatedIcon((Get-Command node).Source).ToBitmap()
    }
    $bmp = New-Object System.Drawing.Bitmap $src, 64, 64
    $src.Dispose() # Image.FromFile keeps icon.png locked until disposed
    $iconRunning = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

    # Stopped variant: same logo with a red dot in the bottom-right corner
    $bmpStopped = New-Object System.Drawing.Bitmap $bmp
    $g = [System.Drawing.Graphics]::FromImage($bmpStopped)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.FillEllipse([System.Drawing.Brushes]::White, 30, 30, 34, 34)
    $g.FillEllipse([System.Drawing.Brushes]::Red, 34, 34, 26, 26)
    $g.Dispose()
    $iconStopped = [System.Drawing.Icon]::FromHandle($bmpStopped.GetHicon())
} catch {
    $iconRunning = [System.Drawing.SystemIcons]::Application
    $iconStopped = [System.Drawing.SystemIcons]::Error
}
$tray.Icon = $iconRunning
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$showLog = $menu.Items.Add("Show log")
$restart = $menu.Items.Add("Restart bot")
$menu.Items.Add("-") | Out-Null
$quit    = $menu.Items.Add("Stop bot and exit")
$tray.ContextMenuStrip = $menu

$openLog = {
    $cmd = @"
`$Host.UI.RawUI.WindowTitle = 'Archeesepelago Bot log'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
''
'  ============================================'
'   Archeesepelago Discord Bot'
'  ============================================'
''
Get-Content -LiteralPath '$($log -replace "'", "''")' -Encoding UTF8 -Tail 200 -Wait
"@
    # Encoded so spacing and quotes survive Start-Process argument joining
    $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
    Start-Process powershell -ArgumentList "-NoProfile", "-NoExit", "-EncodedCommand", $enc
}
$showLog.add_Click($openLog)
$tray.add_DoubleClick($openLog)

$restart.add_Click({
    Stop-Bot
    Start-Bot
    $tray.ShowBalloonTip(2000, "Archeesepelago", "Bot restarted.", "Info")
})

$quit.add_Click({
    $timer.Stop()
    Stop-Bot
    $tray.Visible = $false
    $tray.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

# Notify if the bot dies on its own
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
    if ($script:bot -and $script:bot.HasExited -and $tray.Text -notlike "*Stopped*") {
        $tray.Text = "Archeesepelago - Stopped"
        $tray.Icon = $iconStopped
        $tray.ShowBalloonTip(5000, "Archeesepelago", "Bot stopped (exit code $($script:bot.ExitCode)). Right-click the tray icon to view the log or restart.", "Warning")
    }
})

Start-Bot
$timer.Start()
$tray.ShowBalloonTip(3000, "Archeesepelago", "Bot is running in the tray. Right-click for options.", "Info")
[System.Windows.Forms.Application]::Run()
