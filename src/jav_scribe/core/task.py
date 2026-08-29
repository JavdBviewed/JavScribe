"""Plain (Qt-free) task model for the headless engine.

The GUI keeps its own QAbstractTableModel (task_model.py); this module is the
canonical state container used by core/engine.py and the progress API.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path


class TaskStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"
    SKIPPED = "skipped"
    CANCELED = "canceled"


class TaskPhase(Enum):
    QUEUED = "queued"
    RESTORING = "restoring"
    RESTORED = "restored"
    SUBTITLING = "subtitling"
    FINALIZING = "finalizing"
    POLISHING = "polishing"
    DONE = "done"


@dataclass
class Task:
    path: Path
    status: TaskStatus = TaskStatus.PENDING
    phase: TaskPhase = TaskPhase.QUEUED
    progress: float = 0.0
    message: str = ""
    restored_path: Path | None = None
    output_files: list[Path] = field(default_factory=list)
    duration_s: float | None = None  # media duration of current source
    position_s: float | None = None  # processed up to (timeline position)
    started: float | None = None
    finished: float | None = None

    @property
    def source(self) -> Path:
        return self.restored_path or self.path

    def to_dict(self) -> dict:
        return {
            "path": str(self.path),
            "name": self.path.name,
            "status": self.status.value,
            "phase": self.phase.value,
            "progress": round(self.progress, 4),
            "message": self.message,
            "duration_s": self.duration_s,
            "position_s": self.position_s,
            "position": _fmt_ts(self.position_s),
            "output_files": [str(p) for p in self.output_files],
            "started": self.started,
            "finished": self.finished,
        }


@dataclass
class Job:
    id: str
    files: list[Task]
    created: float = field(default_factory=time.time)
    finished: float | None = None
    source_kind: str = "local"  # local | watch | remote
    label: str = ""

    @property
    def done(self) -> bool:
        return all(t.status in (TaskStatus.DONE, TaskStatus.SKIPPED, TaskStatus.CANCELED) for t in self.files)

    @property
    def finished_ts(self) -> float | None:
        if self.finished is not None:
            return self.finished
        return max((t.finished or 0) for t in self.files) if any(t.finished for t in self.files) else None

    def current(self) -> Task | None:
        for t in self.files:
            if t.status == TaskStatus.RUNNING:
                return t
        return None

    def to_dict(self, detail: bool = False) -> dict:
        d = {
            "id": self.id,
            "created": self.created,
            "finished": self.finished_ts,
            "source_kind": self.source_kind,
            "label": self.label,
            "total": len(self.files),
            "done": sum(1 for t in self.files if t.status == TaskStatus.DONE),
            "skipped": sum(1 for t in self.files if t.status == TaskStatus.SKIPPED),
            "failed": sum(1 for t in self.files if t.status == TaskStatus.ERROR),
            "state": "running" if not self.done else "finished",
        }
        cur = self.current()
        if cur is not None:
            d["current"] = cur.to_dict()
        if detail:
            d["files"] = [t.to_dict() for t in self.files]
        return d


def new_job_id() -> str:
    return time.strftime("%Y%m%d-") + uuid.uuid4().hex[:6]


def _fmt_ts(s: float | None) -> str:
    if s is None:
        return ""
    s = int(s)
    return f"{s // 60:02d}:{s % 60:02d}"
