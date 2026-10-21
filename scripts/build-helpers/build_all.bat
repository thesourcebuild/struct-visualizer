@echo off
REM Builds everything. Forwards all arguments to build_all.ps1.
REM
REM   scripts\build-helpers\build_all.bat                        build
REM   scripts\build-helpers\build_all.bat -Clean -Verify -Smoke  release build with the full gate
REM   scripts\build-helpers\build_all.bat -Verify -BasePath /repo
REM
REM See launch_web.bat for why the shell is chosen up front rather than by retrying.

REM No IF/ELSE block on purpose. The paths below sit inside `%~dp0`, and an absolute path
REM containing parentheses breaks cmd's parser inside a parenthesised block. Setting a
REM variable instead removes the class of problem.
setlocal
set "PSEXE=pwsh"
where /q pwsh || set "PSEXE=powershell"

"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_all.ps1" %*
exit /b %ERRORLEVEL%
