@echo off
setlocal
cd /d "%~dp0"

rem Ensure the venv exists; first run will create it.
if not exist ".venv\Scripts\pythonw.exe" (
    echo Initializing virtual environment...
    uv sync
)

if not exist ".venv\Scripts\pythonw.exe" (
    echo [ERROR] Failed to set up .venv. Run "uv sync" manually.
    pause
    exit /b 1
)

rem pythonw.exe has no console window, so the cmd that launched run.bat
rem can exit immediately. Any stdout/stderr is redirected to
rem %USERPROFILE%\.jav_scribe\gui.log by app.py.
start "" ".venv\Scripts\pythonw.exe" -m jav_scribe gui
endlocal
