# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for jav-scribe.

Build: `uv run pyinstaller --noconfirm jav-scribe.spec`
Output: dist/JavScribe.exe (single file, no console).

pywinpty ships native helpers (conpty.dll, winpty.dll, OpenConsole.exe,
winpty-agent.exe) next to its compiled extension. The C extension loads
them via LoadLibrary / CreateProcess at runtime, so they must be bundled
in the same relative layout. `collect_all` handles that.
"""

from PyInstaller.utils.hooks import collect_all

winpty_datas, winpty_binaries, winpty_hiddenimports = collect_all("winpty")

a = Analysis(
    ["launcher.py"],
    pathex=["src"],
    binaries=winpty_binaries,
    datas=winpty_datas + [
        ("src/jav_scribe/theme.qss", "jav_scribe"),
    ],
    hiddenimports=["winpty", "jav_scribe", *winpty_hiddenimports],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="JavScribe",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    icon=None,
)
