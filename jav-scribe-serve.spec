# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the headless serve exe（无 GUI）。

Build（仓库根目录）:
    pyinstaller --noconfirm --clean jav-scribe-serve.spec
Output:
    Windows: dist/JavScribeServe.exe（单文件、无控制台，双击即 serve）
    Linux:   dist/jav-scribe-serve（单文件）

Windows 上 pywinpty 的原生辅助库（conpty.dll / winpty.dll / winpty-agent.exe）
必须与扩展同布局，`collect_all` 负责收集；headless runner 靠 ConPTY 驱动
ChickenRice infer（GBK 管道下 tqdm 会乱码）。Linux 无 winpty，条件跳过。
"""
import sys

from PyInstaller.utils.hooks import collect_all

IS_WIN = sys.platform == "win32"

winpty_datas, winpty_binaries, winpty_hiddenimports = [], [], []
if IS_WIN:
    winpty_datas, winpty_binaries, winpty_hiddenimports = collect_all("winpty")

a = Analysis(
    ["serve_launcher.py"],
    pathex=["src"],
    binaries=winpty_binaries,
    datas=winpty_datas,
    hiddenimports=["jav_scribe", *winpty_hiddenimports],
    hookspath=[],
    runtime_hooks=[],
    excludes=["PySide6"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="JavScribeServe" if IS_WIN else "jav-scribe-serve",
    debug=False,
    bootloader_ignore_signals=False,
    strip=not IS_WIN,
    upx=False,
    runtime_tmpdir=None,
    console=not IS_WIN,
    disable_windowed_traceback=False,
    icon=None,
)
