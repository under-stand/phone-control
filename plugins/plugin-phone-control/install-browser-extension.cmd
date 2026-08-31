@echo off
setlocal
set "EXTENSION_DIR=%~dp0extensions\chrome"

if not exist "%EXTENSION_DIR%\manifest.json" (
  echo Phone Control browser extension was not found:
  echo %EXTENSION_DIR%
  pause
  exit /b 1
)

set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

echo 1. Turn on Developer mode in the Chrome extensions page.
echo 2. Click Load unpacked.
echo 3. Select the extensions\chrome folder opened in Explorer.
echo.
start "" explorer.exe /select,"%EXTENSION_DIR%\manifest.json"
if exist "%CHROME_EXE%" (
  start "" "%CHROME_EXE%" "chrome://extensions/"
) else (
  start "" "chrome://extensions/"
)

pause
