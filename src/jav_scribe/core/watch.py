"""Directory watcher for BT/PT download folders (pure polling, cross-platform).

BT/PT specifics handled here:
  - size stability: a file is only handed over when its size is unchanged
    across two consecutive scans (incomplete downloads keep growing);
  - catch-up: on the first scan, already-existing stable files can be queued
    too (config watch.process_existing) — the engine then skips any file
    that already has its .zh.srt next to it.

Each path is handed over at most once per lifetime: queued paths stay
tracked (marked queued) so a stable file is not re-queued on later scans;
paths that disappear are forgotten, so a fresh file at the same path can
be picked up again.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Callable, Optional

from ..constants import ALL_EXTS_SET

LogFn = Callable[[str], None]
NewFileFn = Callable[[list[Path]], None]


class Watcher:
    def __init__(
        self,
        dirs: list[str | Path],
        interval_s: float = 10.0,
        process_existing: bool = True,
        log: Optional[LogFn] = None,
        on_new_files: Optional[NewFileFn] = None,
    ) -> None:
        self.dirs = [Path(d).expanduser() for d in dirs]
        self.interval_s = interval_s
        self.process_existing = process_existing
        self.log = log or (lambda _s: None)
        self.on_new_files = on_new_files
        # path -> (size, mtime, first_seen_scan, queued)
        self._seen: dict[Path, tuple[int, float, int, bool]] = {}
        self._scan_no = 0
        self._stop_evt = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def valid_dirs(self) -> list[Path]:
        return [d for d in self.dirs if d.is_dir()]

    def _collect(self) -> dict[Path, tuple[int, float]]:
        out: dict[Path, tuple[int, float]] = {}
        for d in self.valid_dirs:
            try:
                for p in d.rglob("*"):
                    if p.is_file() and p.suffix.lower() in ALL_EXTS_SET and p.stat().st_size > 0:
                        st = p.stat()
                        out[p] = (st.st_size, st.st_mtime)
            except OSError as e:
                self.log(f"[watch] 扫描失败 {d}: {e}")
        return out

    def scan_once(self) -> list[Path]:
        """One scan. Returns files ready to be processed (new or caught-up)."""
        self._scan_no += 1
        current = self._collect()
        ready: list[Path] = []

        # Forget paths that no longer exist (downloaded file moved/deleted),
        # so a fresh file at the same path can be picked up again.
        for path in list(self._seen):
            if path not in current:
                del self._seen[path]

        for path, (size, mtime) in current.items():
            if path in self._seen:
                continue
            if self.process_existing and self._scan_no == 1:
                # Existing file: trust it (it predates the watcher).
                self._seen[path] = (size, mtime, self._scan_no, True)
                ready.append(path)
                self.log(f"[watch] 存量文件: {path.name}")
            else:
                # Newly appeared: track, but wait for size stability.
                self._seen[path] = (size, mtime, self._scan_no, False)
                self.log(f"[watch] 新文件(待稳定): {path.name}")

        for path, (size, mtime, first_scan, queued) in list(self._seen.items()):
            if queued:
                continue
            cur_size, cur_mtime = current[path]
            if cur_size == size and cur_mtime == mtime and self._scan_no > first_scan:
                # Stable across two scans -> hand over once, keep tracking.
                self._seen[path] = (cur_size, cur_mtime, first_scan, True)
                ready.append(path)
                self.log(f"[watch] 文件已稳定: {path.name}")
            else:
                self._seen[path] = (cur_size, cur_mtime, first_scan, False)
                self.log(f"[watch] 大小变化中(下载未完成?): {path.name}")

        if ready and self.on_new_files:
            self.on_new_files(ready)
        return ready

    def _loop(self) -> None:
        while not self._stop_evt.wait(self.interval_s):
            try:
                self.scan_once()
            except Exception as e:
                self.log(f"[watch] 扫描异常: {e}")

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        if not self.valid_dirs:
            self.log(f"[watch] 警告：监听目录不存在: {[str(d) for d in self.dirs]}")
        self._stop_evt.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_evt.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
