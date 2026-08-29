from __future__ import annotations

from PySide6.QtCore import QModelIndex, QRectF, Qt, Signal
from PySide6.QtGui import QAction, QColor, QFont, QPainter
from PySide6.QtWidgets import (
    QAbstractItemView,
    QHeaderView,
    QMenu,
    QStyledItemDelegate,
    QTableView,
)

from ..core.task_model import TaskTableModel


class ProgressDelegate(QStyledItemDelegate):
    """Render the progress column as a custom-drawn progress bar."""

    def paint(self, painter: QPainter, option, index: QModelIndex) -> None:
        task = index.data(Qt.UserRole)
        if task is None:
            super().paint(painter, option, index)
            return
        progress = max(0, min(100, int(task.progress * 100)))

        painter.save()
        painter.setRenderHint(QPainter.Antialiasing)

        r = QRectF(option.rect.adjusted(4, 6, -4, -6))

        # Background
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor("#2a2a32"))
        painter.drawRoundedRect(r, 4, 4)

        # Filled portion
        if progress > 0:
            fill_r = QRectF(r)
            fill_r.setWidth(r.width() * progress / 100.0)
            painter.setBrush(QColor("#007acc"))
            painter.drawRoundedRect(fill_r, 4, 4)

        # Text
        painter.setPen(QColor("#e3e3e6"))
        font = QFont(option.font)
        font.setPointSize(8)
        painter.setFont(font)
        painter.drawText(r, Qt.AlignCenter, f"{progress}%")

        painter.restore()


class TaskTableView(QTableView):
    open_output_requested = Signal(int)  # row
    open_source_requested = Signal(int)
    remove_requested = Signal(int)

    def __init__(self, model: TaskTableModel, parent=None) -> None:
        super().__init__(parent)
        self.setModel(model)
        self.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.setAlternatingRowColors(True)
        self.verticalHeader().setVisible(False)
        self.setItemDelegateForColumn(TaskTableModel.COL_PROGRESS, ProgressDelegate(self))

        header = self.horizontalHeader()
        header.setStretchLastSection(True)
        header.setSectionResizeMode(TaskTableModel.COL_FILE, QHeaderView.Stretch)
        header.setSectionResizeMode(TaskTableModel.COL_STATUS, QHeaderView.Interactive)
        header.setSectionResizeMode(TaskTableModel.COL_PROGRESS, QHeaderView.Fixed)
        self.setColumnWidth(TaskTableModel.COL_STATUS, 56)
        self.setColumnWidth(TaskTableModel.COL_PROGRESS, 160)

        self.setContextMenuPolicy(Qt.CustomContextMenu)
        self.customContextMenuRequested.connect(self._on_menu)

    def _on_menu(self, pos) -> None:
        idx = self.indexAt(pos)
        if not idx.isValid():
            return
        row = idx.row()
        menu = QMenu(self)
        act_open_out = QAction("打开输出位置", self)
        act_open_src = QAction("打开源文件位置", self)
        act_remove = QAction("从队列移除", self)
        act_open_out.triggered.connect(lambda: self.open_output_requested.emit(row))
        act_open_src.triggered.connect(lambda: self.open_source_requested.emit(row))
        act_remove.triggered.connect(lambda: self.remove_requested.emit(row))
        menu.addAction(act_open_out)
        menu.addAction(act_open_src)
        menu.addSeparator()
        menu.addAction(act_remove)
        menu.exec(self.viewport().mapToGlobal(pos))
