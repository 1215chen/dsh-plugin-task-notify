@echo off
rem Build the DSH task-notify APK without changing the machine execution policy.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-apk.ps1" %*
set code=%errorlevel%
endlocal & exit /b %code%
