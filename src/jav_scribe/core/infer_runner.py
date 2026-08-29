from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, QThread, Signal

try:
    import winpty
except ImportError:
    winpty = None  # type: ignore

from .log_parser import LogParser


# ConPTY emits ANSI escape sequences (cursor / mode setting). Strip them so
# they don't pollute the log view or break our parser.
_ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])")


class _PtyReader(QObject):
    """Background-thread worker that reads from the pseudo-terminal."""

    line = Signal(str)
    finished = Signal(int)  # exit code

    def __init__(self, proc) -> None:
        super().__init__()
        self.proc = proc
        self._stop = False

    def run(self) -> None:
        buf = ""
        while not self._stop:
            try:
                chunk = self.proc.read(4096)
            except EOFError:
                break
            except Exception:
                break
            if not chunk:
                # process likely ended
                if not self.proc.isalive():
                    break
                continue
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8", errors="replace")
            buf += chunk
            while "\n" in buf:
                idx = buf.index("\n")
                raw_line = buf[:idx].rstrip("\r")
                buf = buf[idx + 1 :]
                cleaned = _ANSI_RE.sub("", raw_line).rstrip()
                if cleaned:
                    self.line.emit(cleaned)

        # Flush any tail
        if buf:
            cleaned = _ANSI_RE.sub("", buf).rstrip()
            if cleaned:
                self.line.emit(cleaned)

        # exitstatus might be None if not yet collected — wait briefly
        code = 0
        try:
            self.proc.wait()
        except Exception:
            pass
        code = getattr(self.proc, "exitstatus", None)
        if code is None:
            code = 1 if self._stop else 0
        self.finished.emit(int(code))

    def stop(self) -> None:
        self._stop = True


class InferRunner(QObject):
    """Wraps one `infer.exe` invocation via ConPTY (pywinpty).

    Why ConPTY instead of QProcess:
      `infer.exe` is a PyInstaller-frozen Python app that prints ⚠️ (U+26A0)
      to stdout. When stdout is a plain pipe (QProcess), Python uses the
      system ANSI codepage (GBK / CP936 on zh-CN Windows), which can't
      encode that emoji and crashes the script. PYTHONUTF8 / PYTHONIOENCODING
      env vars are NOT honored by this PyInstaller build. ConPTY gives the
      child a real pseudo-TTY, so Python detects a console and uses the
      pseudo-console's codepage (UTF-8 by default for pywinpty).
    """

    log_line = Signal(str)
    file_started = Signal(int, int, str)  # idx, total, path
    file_progress = Signal(str, float)  # path, 0-1
    file_written = Signal(str, str)  # output_path, format
    file_done = Signal(str, bool, str)  # path, success, message
    finished = Signal(int)  # exit code
    error = Signal(str)
    status_text = Signal(str)

    def __init__(self, infer_exe: Path, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.infer_exe = Path(infer_exe)
        self.parser = LogParser()
        self.pty = None
        self.thread: QThread | None = None
        self.worker: _PtyReader | None = None

    def is_running(self) -> bool:
        return self.pty is not None and self.pty.isalive()

    def start(self, files: list[Path], cli_args: dict[str, Any]) -> None:
        if winpty is None:
            self.error.emit(
                "未安装 pywinpty。请运行 `uv sync` 安装依赖（仅支持 Windows）。"
            )
            return
        if self.is_running():
            self.error.emit("已有任务在运行")
            return
        if not self.infer_exe.exists():
            self.error.emit(f"找不到 infer.exe：{self.infer_exe}")
            return
        if not files:
            self.error.emit("没有待处理的文件")
            return

        self.parser = LogParser()
        cmdline = [str(self.infer_exe)] + self._build_args(files, cli_args)

        try:
            self.pty = winpty.PtyProcess.spawn(
                cmdline,
                cwd=str(self.infer_exe.parent),
                # Big enough window that infer.exe doesn't try to wrap lines
                dimensions=(50, 250),
            )
        except Exception as e:
            self.error.emit(f"启动子进程失败：{e}")
            self.pty = None
            return

        self.thread = QThread(self)
        self.worker = _PtyReader(self.pty)
        self.worker.moveToThread(self.thread)
        self.worker.line.connect(self._on_line)
        self.worker.finished.connect(self._on_finished)
        self.thread.started.connect(self.worker.run)
        self.thread.start()

    def stop(self) -> None:
        if self.worker is not None:
            self.worker.stop()
        if self.pty is not None and self.pty.isalive():
            try:
                self.pty.terminate(force=True)
            except Exception:
                pass
        # Block until the reader thread actually exits, otherwise the QThread
        # will be destroyed while still running (Qt then asserts / crashes).
        self._teardown_thread()

    # ------------------------------------------------------------------
    def _build_args(self, files: list[Path], cli_args: dict[str, Any]) -> list[str]:
        out: list[str] = []
        for k, v in cli_args.items():
            if v is None or v == "":
                continue
            if isinstance(v, bool):
                if v:
                    out.append(f"--{k}")
                continue
            out.append(f"--{k}={v}")
        out.extend(str(f) for f in files)
        return out

    def _on_line(self, line: str) -> None:
        self.log_line.emit(line)
        evt = self.parser.feed(line)
        if evt.kind == "file_start" and evt.file_path:
            self.file_started.emit(
                evt.file_idx or 0,
                evt.file_total or 0,
                evt.file_path,
            )
        elif evt.kind == "file_progress" and evt.file_path and evt.progress is not None:
            self.file_progress.emit(evt.file_path, evt.progress)
        elif evt.kind == "file_written" and evt.file_path:
            self.file_written.emit(evt.file_path, evt.output_format or "")
        elif evt.kind == "model_load":
            self.status_text.emit("加载模型中…")
        elif evt.kind == "info" and evt.detail:
            self.status_text.emit(evt.detail)

    def _on_finished(self, code: int) -> None:
        if self.parser.current_file:
            ok = code == 0
            self.file_done.emit(
                self.parser.current_file,
                ok,
                "" if ok else f"退出码 {code}",
            )
        self.finished.emit(code)
        # Tear down thread. quit() is thread-safe — calling it directly here
        # avoids the deadlock where wait() blocks the main event loop before
        # the queued worker.finished -> thread.quit() slot can dispatch.
        self._teardown_thread()

    def _teardown_thread(self) -> None:
        if self.thread is not None:
            self.thread.quit()
            self.thread.wait(5000)
            self.thread = None
        self.worker = None
        self.pty = None
