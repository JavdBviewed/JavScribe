from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import QCoreApplication
from PySide6.QtWidgets import QApplication

from .constants import APP_NAME, APP_ORG, APP_VERSION
from .main_window import MainWindow


def _redirect_io_when_headless() -> None:
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_dir = Path.home() / ".jav_scribe"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        f = open(log_dir / "gui.log", "a", encoding="utf-8", buffering=1)
    except OSError:
        return
    if sys.stdout is None:
        sys.stdout = f
    if sys.stderr is None:
        sys.stderr = f


def _load_theme() -> str:
    qss_path = Path(__file__).parent / "theme.qss"
    try:
        return qss_path.read_text(encoding="utf-8")
    except OSError:
        return ""


def main() -> int:
    _redirect_io_when_headless()

    QCoreApplication.setOrganizationName(APP_ORG)
    QCoreApplication.setApplicationName(APP_NAME)
    QCoreApplication.setApplicationVersion(APP_VERSION)

    app = QApplication(sys.argv)
    app.setStyleSheet(_load_theme())

    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
