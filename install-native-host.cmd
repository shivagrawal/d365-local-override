@echo off
setlocal enabledelayedexpansion

if "%~1"=="" (
  echo Usage: install-native-host.cmd ^<extension-id^> [more-extension-ids...]
  echo.
  echo Chrome and Edge derive DIFFERENT ids for the same unpacked extension,
  echo so pass both if you want native features ^(Connect, Browse, build watch^)
  echo in both browsers:
  echo.
  echo   install-native-host.cmd chromeIdHere edgeIdHere
  echo.
  echo To find each id:
  echo   1. Open chrome://extensions  ^(or edge://extensions^)
  echo   2. Enable Developer mode
  echo   3. Load unpacked -^> select the "extension" folder in this repo
  echo   4. Copy the ID shown on the extension's card
  exit /b 1
)

set "HOST_DIR=%~dp0helper"
set "TEMPLATE=%HOST_DIR%\native-host-manifest.template.json"
set "MANIFEST=%HOST_DIR%\native-host-manifest.json"
set "CMD_PATH=%HOST_DIR%\native-host.cmd"
set "HOST_NAME=com.pcf_local_override.native_host"

if not exist "%TEMPLATE%" (
  echo ERROR: Template not found: %TEMPLATE%
  exit /b 1
)

rem Collect every id passed, building a JSON array of chrome-extension
rem origins. Edge is Chromium-based and uses the chrome-extension:// scheme.
set "ORIGINS="
set "IDLIST="
:collect
if "%~1"=="" goto collected
if defined ORIGINS set "ORIGINS=!ORIGINS!, "
set "ORIGINS=!ORIGINS!\"chrome-extension://%~1/\""
set "IDLIST=!IDLIST! %~1"
shift
goto collect
:collected

powershell -NoProfile -Command ^
  "$cmdPath = '%CMD_PATH%' -replace '\\', '\\\\';" ^
  "(Get-Content -Raw '%TEMPLATE%')" ^
  " -replace '__NATIVE_HOST_CMD_PATH__', $cmdPath" ^
  " -replace '__ALLOWED_ORIGINS__', '[!ORIGINS!]'" ^
  " | Set-Content -NoNewline '%MANIFEST%'"
if errorlevel 1 (
  echo ERROR: Failed to generate manifest.
  exit /b 1
)

rem Register for Chrome and Edge. Each browser reads only its own registry
rem key - a Chrome-only registration is exactly why Connect worked in Chrome
rem but not Edge. Registering both is harmless if a browser isn't installed.
set /a REGISTERED=0

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /d "%MANIFEST%" /f >nul 2>nul
if errorlevel 1 (
  echo WARNING: Could not register for Chrome.
) else (
  echo Registered for Chrome.
  set /a REGISTERED+=1
)

reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /d "%MANIFEST%" /f >nul 2>nul
if errorlevel 1 (
  echo WARNING: Could not register for Edge.
) else (
  echo Registered for Edge.
  set /a REGISTERED+=1
)

if !REGISTERED! EQU 0 (
  echo ERROR: Registration failed for every browser.
  exit /b 1
)

echo.
echo Allowed extension ids:!IDLIST!
echo Manifest written to: %MANIFEST%
echo.
echo Reload the extension in each browser, then use "Connect" in the popup.
echo If a browser says the native host is missing, its id is probably not
echo listed above - re-run this with every id included.
exit /b 0
