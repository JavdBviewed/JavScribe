from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont, QTextCursor
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QPlainTextEdit,
    QPushButton,
    QSizePolicy,
    QToolButton,
    QVBoxLayout,
    QWidget,
)


class LogView(QWidget):
    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._auto_scroll = True
        self._expanded = False
        self._build_ui()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)

        self.toggle_btn = QToolButton()
        self.toggle_btn.setText("▶ 日志")
        self.toggle_btn.setCheckable(True)
        self.toggle_btn.setChecked(False)
        self.toggle_btn.setStyleSheet(
            "QToolButton { border: none; font-weight: bold; padding: 4px; "
            "text-align: left; background: transparent; color: #a0a0a8; }"
        )
        self.toggle_btn.clicked.connect(self._on_toggle)

        self._content = QWidget()
        self._content.setVisible(False)
        content_layout = QVBoxLayout(self._content)
        content_layout.setContentsMargins(0, 4, 0, 0)
        content_layout.setSpacing(4)

        toolbar = QHBoxLayout()
        toolbar.setContentsMargins(0, 0, 0, 0)
        toolbar.addStretch(1)
        self.btn_clear = QPushButton("清空")
        self.btn_save = QPushButton("保存…")
        self.btn_clear.clicked.connect(self.clear_log)
        self.btn_save.clicked.connect(self._save_log)
        toolbar.addWidget(self.btn_clear)
        toolbar.addWidget(self.btn_save)

        self.text = QPlainTextEdit()
        self.text.setReadOnly(True)
        self.text.setMaximumBlockCount(5000)
        mono = QFont("Consolas")
        if not mono.exactMatch():
            mono = QFont("Cascadia Mono")
        if not mono.exactMatch():
            mono = QFont("Courier New")
        mono.setPointSize(9)
        self.text.setFont(mono)
        self.text.setLineWrapMode(QPlainTextEdit.WidgetWidth)
        self.text.verticalScrollBar().valueChanged.connect(self._on_scroll)

        content_layout.addLayout(toolbar)
        content_layout.addWidget(self.text)

        layout.addWidget(self.toggle_btn)
        layout.addWidget(self._content)

    def _on_toggle(self) -> None:
        self._expanded = self.toggle_btn.isChecked()
        self._content.setVisible(self._expanded)
        self.toggle_btn.setText("▼ 日志" if self._expanded else "▶ 日志")

    def _on_scroll(self, value: int) -> None:
        sb = self.text.verticalScrollBar()
        self._auto_scroll = value >= sb.maximum() - 2

    def append_line(self, line: str) -> None:
        self.text.appendPlainText(line)
        if self._auto_scroll:
            cursor = self.text.textCursor()
            cursor.movePosition(QTextCursor.End)
            self.text.setTextCursor(cursor)

    def clear_log(self) -> None:
        self.text.clear()

    def _save_log(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "保存日志", "log.txt", "文本文件 (*.txt);;所有文件 (*.*)"
        )
        if path:
            with open(path, "w", encoding="utf-8") as f:
                f.write(self.text.toPlainText())
