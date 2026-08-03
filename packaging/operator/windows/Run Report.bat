@echo off
REM TEGG Report Tool - Run Report
REM
REM Double-click this file. It runs "Run Report.ps1" next to it.
REM -ExecutionPolicy Bypass applies to this one run only and changes
REM nothing about this PC: it is what lets a downloaded script run at all.
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%~dp0Run Report.ps1" %*
set "TEGG_EXIT=%ERRORLEVEL%"
endlocal & exit /b %TEGG_EXIT%
