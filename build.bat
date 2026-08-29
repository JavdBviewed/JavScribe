@echo off
setlocal
cd /d "%~dp0"

echo === Installing build deps (PyInstaller) ===
uv sync --group build
if errorlevel 1 (
    echo [ERROR] uv sync failed.
    pause
    exit /b 1
)

echo.
echo === Cleaning previous build ===
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo.
echo === Running PyInstaller ===
uv run pyinstaller --noconfirm --clean jav-scribe.spec
if errorlevel 1 (
    echo [ERROR] PyInstaller failed.
    pause
    exit /b 1
)

echo.
echo === Build done ===
echo Output: %CD%\dist\JavScribe.exe
echo.
pause
endlocal
