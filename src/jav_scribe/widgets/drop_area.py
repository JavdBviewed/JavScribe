from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QEvent, QMimeData, Qt, Signal
from PySide6.QtGui import QDragEnterEvent, QDragLeaveEvent, QDragMoveEvent, QDropEvent
from PySide6.QtWidgets import (
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
)

from ..constants import ALL_EXTS_SET


def scan_paths(paths: list[Path]) -> list[Path]:
    out: list[Path] = []
    seen: set[Path] = set()
    for p in paths:
        p = Path(p)
        if p.is_dir():
            for child in sorted(p.rglob("*")):
                if child.is_file() and child.suffix.lower() in ALL_EXTS_SET:
                    rp = child.resolve()
                    if rp not in seen:
                        out.append(rp)
                        seen.add(rp)
        elif p.is_file() and p.suffix.lower() in ALL_EXTS_SET:
            rp = p.resolve()
            if rp not in seen:
                out.append(rp)
                seen.add(rp)
    return out


class DropArea(QFrame):
    paths_added = Signal(list)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setAcceptDrops(True)
        self.setObjectName("DropArea")
        self.setMinimumHeight(80)
        self.installEventFilter(self)
        self.setToolTip("支持格式: mp3, wav, flac, m4a, aac, ogg, wma, mp4, mkv, avi, mov, webm, flv, wmv")
        self._build_ui()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(10)

        self.label = QLabel("拖入音视频文件或文件夹，或点击浏览")
        self.label.setAlignment(Qt.AlignCenter)
        font = self.label.font()
        font.setPointSize(11)
        self.label.setFont(font)

        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        self.btn_files = QPushButton("选择文件…")
        self.btn_folder = QPushButton("选择文件夹…")
        self.btn_files.clicked.connect(self._pick_files)
        self.btn_folder.clicked.connect(self._pick_folder)
        btn_row.addWidget(self.btn_files)
        btn_row.addWidget(self.btn_folder)
        btn_row.addStretch(1)

        layout.addWidget(self.label)
        layout.addLayout(btn_row)

    def eventFilter(self, obj, event) -> bool:
        if obj is not self and event.type() in (
            QEvent.DragEnter, QEvent.DragMove, QEvent.DragLeave, QEvent.Drop
        ):
            if event.type() == QEvent.DragEnter:
                self.dragEnterEvent(event)
            elif event.type() == QEvent.DragMove:
                self.dragMoveEvent(event)
            elif event.type() == QEvent.DragLeave:
                self.dragLeaveEvent(event)
            elif event.type() == QEvent.Drop:
                self.dropEvent(event)
            return True
        return super().eventFilter(obj, event)

    def _set_active_style(self, active: bool) -> None:
        border = "#0098ff" if active else "#3f3f4c"
        bg = "rgba(0, 152, 255, 0.06)" if active else "transparent"
        self.setStyleSheet(
            f"#DropArea {{ border: 2px dashed {border}; border-radius: 8px; "
            f"background: {bg}; }}"
        )

    def _accepts(self, data: QMimeData) -> bool:
        return data.hasUrls()

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:
        if self._accepts(event.mimeData()):
            event.acceptProposedAction()
            self._set_active_style(True)
        else:
            event.ignore()

    def dragMoveEvent(self, event: QDragMoveEvent) -> None:
        if self._accepts(event.mimeData()):
            event.acceptProposedAction()
        else:
            event.ignore()

    def dragLeaveEvent(self, event: QDragLeaveEvent) -> None:
        self._set_active_style(False)

    def dropEvent(self, event: QDropEvent) -> None:
        if not self._accepts(event.mimeData()):
            event.ignore()
            return
        paths = [Path(url.toLocalFile()) for url in event.mimeData().urls()]
        files = scan_paths(paths)
        if files:
            self.paths_added.emit(files)
        event.acceptProposedAction()
        self._set_active_style(False)

    def _pick_files(self) -> None:
        ext_pattern = " ".join(f"*{e}" for e in sorted(ALL_EXTS_SET))
        files, _ = QFileDialog.getOpenFileNames(
            self, "选择音视频文件", "",
            f"媒体文件 ({ext_pattern});;所有文件 (*.*)",
        )
        if files:
            paths = scan_paths([Path(f) for f in files])
            if paths:
                self.paths_added.emit(paths)

    def _pick_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "选择文件夹")
        if folder:
            paths = scan_paths([Path(folder)])
            if paths:
                self.paths_added.emit(paths)
