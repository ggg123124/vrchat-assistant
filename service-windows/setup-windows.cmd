@echo off
rem ============================================================
rem  vrc-monitor resident service: one-click setup (Windows)
rem
rem  This script is deliberately PURE ASCII with English messages.
rem  cmd.exe parses a batch file using the console code page (CP936
rem  on Chinese Windows, CP1252/CP932 elsewhere); a non-ASCII byte
rem  sequence can make the parser swallow the following ASCII bytes
rem  and run broken fragments of the same line. Measured evidence is
rem  in service-windows/README.md (section about the code page).
rem  Chinese documentation: service-windows/README.md
rem
rem  Usage: setup-windows.cmd [python exe path]
rem    - no argument: python is looked up on PATH
rem  Creates:
rem    1) VrcMonWatchdog  scheduled task (health check every minute,
rem       restarts the service when it dies; runs silently)
rem    2) VrcMonLauncher logon autostart (onlogon task; if the caller
rem       lacks the privilege it falls back to writing a VBS into the
rem       current user's Startup folder, which is equivalent)
rem  Uninstall: schtasks /delete /tn VrcMonWatchdog /f
rem             schtasks /delete /tn VrcMonLauncher /f
rem             (or delete the Startup\VrcMon_Launcher.vbs fallback)
rem ============================================================
setlocal
cd /d "%~dp0"

set "PYTHON=%~1"
if "%PYTHON%"=="" (
  for /f "delims=" %%i in ('where python 2^>nul') do (
    if not defined PYTHON set "PYTHON=%%i"
  )
)
if "%PYTHON%"=="" (
  echo [ERROR] python not found. Pass the interpreter path: setup-windows.cmd C:\path\to\python.exe
  exit /b 1
)

set "PYTHONW="
for %%f in ("%PYTHON%") do (
  if exist "%%~dpfpythonw.exe" set "PYTHONW=%%~dpfpythonw.exe"
)
if "%PYTHONW%"=="" (
  for /f "delims=" %%i in ('where pythonw 2^>nul') do (
    if not defined PYTHONW set "PYTHONW=%%i"
  )
)
if "%PYTHONW%"=="" set "PYTHONW=%PYTHON%"

echo [1/3] Creating the VrcMonWatchdog scheduled task (health check every minute, silent)...
schtasks /create /tn "VrcMonWatchdog" /tr "\"%PYTHONW%\" \"%CD%\vrcmon_watchdog.py\"" /sc minute /mo 1 /f

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo [2/3] Creating the VrcMonLauncher logon autostart (onlogon)...
schtasks /create /tn "VrcMonLauncher" /tr "\"%PYTHONW%\" \"%CD%\vrcmon_service_launcher.py\"" /sc onlogon /f
if errorlevel 1 (
  echo       onlogon needs privileges the caller does not have; falling back to the Startup folder...
  (
    echo Set sh = CreateObject^("WScript.Shell"^)
    echo sh.Run """%PYTHONW%"" ""%CD%\vrcmon_service_launcher.py""", 0, False
  ) > "%STARTUP%\VrcMon_Launcher.vbs"
  echo       wrote "%STARTUP%\VrcMon_Launcher.vbs"
)

echo [3/3] Starting the service (skipped when it is already running)...
"%PYTHONW%" "%CD%\vrcmon_service_launcher.py"

echo.
echo Done. Optional: daily repair report (09:00 every day, prints only when a repair happened):
echo   Hermes: point a cron no_agent task at vrcmon_daily_report.py (empty output = silent)
echo   Windows: schtasks /create /tn VrcMonDailyReport /tr "\"%PYTHONW%\" \"%CD%\vrcmon_daily_report.py\"" /sc daily /st 09:00 /f
endlocal
