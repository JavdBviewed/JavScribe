from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from PySide6.QtCore import QAbstractTableModel, QModelIndex, Qt


class TaskStatus(Enum):
    PENDING = "等待"
    RUNNING = "处理中"
    DONE = "完成"
    ERROR = "错误"
    CANCELED = "已取消"
    SKIPPED = "跳过"


class TaskPhase(Enum):
    WAITING = "等待"
    RESTORING = "修复中"
    RESTORED = "已修复"
    SUBTITLING = "字幕中"
    DONE = "完成"


@dataclass
class Task:
    path: Path
    status: TaskStatus = TaskStatus.PENDING
    phase: TaskPhase = TaskPhase.WAITING
    progress: float = 0.0
    message: str = ""
    output_files: list[Path] = field(default_factory=list)
    restored_path: Path | None = None


class TaskTableModel(QAbstractTableModel):
    COLS = ["文件", "状态", "进度", "说明"]

    COL_FILE = 0
    COL_STATUS = 1
    COL_PROGRESS = 2
    COL_MESSAGE = 3

    def __init__(self) -> None:
        super().__init__()
        self.tasks: list[Task] = []

    # Qt model API ----------------------------------------------------
    def rowCount(self, parent: QModelIndex = QModelIndex()) -> int:
        return 0 if parent.isValid() else len(self.tasks)

    def columnCount(self, parent: QModelIndex = QModelIndex()) -> int:
        return len(self.COLS)

    def data(self, index: QModelIndex, role: int = Qt.DisplayRole) -> Any:
        if not index.isValid():
            return None
        task = self.tasks[index.row()]
        col = index.column()
        if role == Qt.DisplayRole:
            if col == self.COL_FILE:
                return task.path.name
            if col == self.COL_STATUS:
                if task.status == TaskStatus.RUNNING:
                    return task.phase.value
                return task.status.value
            if col == self.COL_PROGRESS:
                return f"{int(task.progress * 100)}%"
            if col == self.COL_MESSAGE:
                return task.message
        elif role == Qt.ToolTipRole:
            if col == self.COL_FILE:
                return str(task.path)
            if col == self.COL_MESSAGE:
                return task.message
        elif role == Qt.UserRole:
            return task
        return None

    def headerData(self, section: int, orientation: Qt.Orientation, role: int = Qt.DisplayRole) -> Any:
        if role == Qt.DisplayRole and orientation == Qt.Horizontal:
            return self.COLS[section]
        return None

    # Public helpers --------------------------------------------------
    def add_paths(self, paths: list[Path]) -> int:
        existing = {t.path.resolve() for t in self.tasks}
        new = []
        for p in paths:
            p = Path(p).resolve()
            if p in existing:
                continue
            new.append(Task(path=p))
            existing.add(p)
        if not new:
            return 0
        first = len(self.tasks)
        last = first + len(new) - 1
        self.beginInsertRows(QModelIndex(), first, last)
        self.tasks.extend(new)
        self.endInsertRows()
        return len(new)

    def clear_all(self) -> None:
        if not self.tasks:
            return
        self.beginResetModel()
        self.tasks.clear()
        self.endResetModel()

    def remove_row(self, row: int) -> None:
        if 0 <= row < len(self.tasks):
            self.beginRemoveRows(QModelIndex(), row, row)
            del self.tasks[row]
            self.endRemoveRows()

    def reset_to_pending(self) -> None:
        for i, t in enumerate(self.tasks):
            if t.status in (TaskStatus.RUNNING, TaskStatus.CANCELED):
                t.status = TaskStatus.PENDING
                t.phase = TaskPhase.WAITING
                t.progress = 0.0
                t.message = ""
                self._notify_row(i)

    def find_by_path(self, path: str | Path) -> int:
        target = Path(path).resolve()
        for i, t in enumerate(self.tasks):
            if t.path.resolve() == target:
                return i
        name = Path(path).name
        for i, t in enumerate(self.tasks):
            if t.path.name == name:
                return i
        return -1

    def update_task(self, row: int, **kwargs: Any) -> None:
        if not (0 <= row < len(self.tasks)):
            return
        task = self.tasks[row]
        for k, v in kwargs.items():
            if hasattr(task, k):
                setattr(task, k, v)
        self._notify_row(row)

    def pending_paths(self) -> list[Path]:
        return [t.path for t in self.tasks if t.status == TaskStatus.PENDING]

    def mark_all_running_as(self, status: TaskStatus, message: str = "") -> None:
        for i, t in enumerate(self.tasks):
            if t.status == TaskStatus.RUNNING:
                t.status = status
                t.message = message
                self._notify_row(i)

    def _notify_row(self, row: int) -> None:
        top = self.index(row, 0)
        bot = self.index(row, len(self.COLS) - 1)
        self.dataChanged.emit(top, bot)
