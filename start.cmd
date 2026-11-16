@echo off
setlocal
pushd "%~dp0" || exit /b 1
set "STUDIO_NODE="
set "PATH=%SystemRoot%\System32\WindowsPowerShell\v1.0;%PATH%"
for /f "delims=" %%I in ('powershell.exe -NoProfile -NonInteractive -Command "foreach ($package in (Get-AppxPackage 'OpenAI.CodexPrimaryRuntime*')) { Join-Path $package.InstallLocation 'dependencies\node\bin\node.exe' }"') do if not defined STUDIO_NODE if exist "%%I" set "STUDIO_NODE=%%I"
if defined STUDIO_NODE goto run
"%SystemRoot%\System32\where.exe" /q node.exe
if errorlevel 1 (
  echo Node.js 24 or later is required.
  popd
  pause
  exit /b 1
)
set "STUDIO_NODE=node.exe"
:run
"%STUDIO_NODE%" server.mjs
set "STUDIO_RESULT=%errorlevel%"
popd
if not "%STUDIO_RESULT%"=="0" pause
exit /b %STUDIO_RESULT%
