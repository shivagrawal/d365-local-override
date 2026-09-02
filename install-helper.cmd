@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not available in PATH.
  echo Install Node.js 22 or later and run this file again.
  exit /b 1
)

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 22 (
  echo ERROR: Node.js 22 or later is required. Current version:
  node --version
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm is not available in PATH.
  exit /b 1
)

echo Installing PCF Local Override helper from:
echo   %~dp0
pushd "%~dp0"
call npm install -g .
set "INSTALL_RESULT=%ERRORLEVEL%"
popd
if not "%INSTALL_RESULT%"=="0" (
  echo ERROR: Helper installation failed with exit code %INSTALL_RESULT%.
  exit /b %INSTALL_RESULT%
)

where pcf-local-override >nul 2>nul
if errorlevel 1 (
  echo ERROR: Installation completed but pcf-local-override is not available in PATH.
  echo Restart the terminal and try: pcf-local-override --help
  exit /b 1
)

echo.
echo PCF Local Override helper installed successfully.
pcf-local-override --help
exit /b 0
