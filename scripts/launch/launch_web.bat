@echo off
REM Double-clickable wrapper. -ExecutionPolicy Bypass is scoped to this one process,
REM so it does not change the machine's policy.
REM
REM pwsh is PowerShell 7; powershell is the 5.1 that ships with Windows. Which one is
REM present is decided up front rather than by retrying on failure -- retrying would
REM run the script a second time whenever it legitimately failed.

REM No IF/ELSE block on purpose. The paths below sit inside `%~dp0`, and an absolute path
REM containing parentheses breaks cmd's parser inside a parenthesised block. Setting a
REM variable instead removes the class of problem.
setlocal
set "PSEXE=pwsh"
where /q pwsh || set "PSEXE=powershell"

"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch_web.ps1" %*
exit /b %ERRORLEVEL%
