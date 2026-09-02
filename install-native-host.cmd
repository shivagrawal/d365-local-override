@echo off
setlocal

if "%~1"=="" (
  echo Usage: install-native-host.cmd ^<chrome-extension-id^>
  echo.
  echo 1. Open chrome://extensions
  echo 2. Enable Developer mode
  echo 3. Load unpacked -^> select the "extension" folder in this repo
  echo 4. Copy the ID shown on the extension's card and pass it here
  exit /b 1
)

set "EXT_ID=%~1"
set "HOST_DIR=%~dp0helper"
set "TEMPLATE=%HOST_DIR%\native-host-manifest.template.json"
set "MANIFEST=%HOST_DIR%\native-host-manifest.json"
set "CMD_PATH=%HOST_DIR%\native-host.cmd"

if not exist "%TEMPLATE%" (
  echo ERROR: Template not found: %TEMPLATE%
  exit /b 1
)

powershell -NoProfile -Command ^
  "$cmdPath = '%CMD_PATH%' -replace '\\', '\\\\';" ^
  "(Get-Content -Raw '%TEMPLATE%')" ^
  " -replace '__NATIVE_HOST_CMD_PATH__', $cmdPath" ^
  " -replace '__EXTENSION_ID__', '%EXT_ID%'" ^
  " | Set-Content -NoNewline '%MANIFEST%'"
if errorlevel 1 (
  echo ERROR: Failed to generate manifest.
  exit /b 1
)

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pcf_local_override.native_host" /ve /d "%MANIFEST%" /f
if errorlevel 1 (
  echo ERROR: Failed to register native messaging host in the registry.
  exit /b 1
)

echo.
echo Registered native messaging host for extension %EXT_ID%.
echo Manifest written to: %MANIFEST%
echo Reload the extension at chrome://extensions, then use "Start helper" in the popup.
exit /b 0
