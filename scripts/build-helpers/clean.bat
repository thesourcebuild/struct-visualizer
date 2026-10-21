@echo off
REM Deletes the caches and build output that pile up locally, and reports the space freed.
REM
REM   scripts\build-helpers\clean.bat           remove .next, out, .turbo and *.tsbuildinfo
REM   scripts\build-helpers\clean.bat -DryRun   list what would go, with sizes; delete nothing
REM   scripts\build-helpers\clean.bat -All      also remove node_modules (then run pnpm install)
REM
REM See launch_web.bat for why the shell is chosen up front rather than by retrying.

setlocal
set "PSEXE=pwsh"
where /q pwsh || set "PSEXE=powershell"

"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0clean.ps1" %*
exit /b %ERRORLEVEL%
