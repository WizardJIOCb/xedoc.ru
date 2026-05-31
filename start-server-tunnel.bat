@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PAUSE_AFTER=1"
if /I "%~1"=="/nopause" (
  set "PAUSE_AFTER=0"
  shift
)

cd /d "%SCRIPT_DIR%"
set "REPO_ROOT=%CD%"

echo Starting xedoc.ru server tunnel...
echo Repo root: %REPO_ROOT%
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO_ROOT%\scripts\ensure-server-openai-tunnel.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo Tunnel check completed successfully.
) else (
  echo Tunnel check failed with exit code %EXIT_CODE%.
)

if "%PAUSE_AFTER%"=="1" pause
exit /b %EXIT_CODE%
