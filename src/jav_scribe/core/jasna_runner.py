from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, QThread, Signal

try:
    import winpty
except ImportError:
    winpty = None  # type: ignore


_ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])")
_TQDM_PROGRESS_RE = re.compile(r"(\d+)%\|")


class _JasnaPtyReader(QObject):
    """Background-thread worker that reads jasna-cli.exe output from ConPTY."""

    line = Signal(str)
    progress = Signal(float)
    finished = Signal(int)

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
                if not self.proc.isalive():
                    break
                continue
            if isinstance(chunk, bytes):
                chunk = chunk.decode("utf-8", errors="replace")
            # tqdm writes \r to update the same line; convert to \n so each
            # progress update is emitted as a separate log line in real time.
            chunk = chunk.replace("\r\n", "\n").replace("\r", "\n")
            buf += chunk
            while "\n" in buf:
                idx = buf.index("\n")
                raw_line = buf[:idx].rstrip("\r")
                buf = buf[idx + 1:]
                cleaned = _ANSI_RE.sub("", raw_line).rstrip()
                if cleaned:
                    self.line.emit(cleaned)
                    m = _TQDM_PROGRESS_RE.search(cleaned)
                    if m:
                        self.progress.emit(int(m.group(1)) / 100.0)

        if buf:
            cleaned = _ANSI_RE.sub("", buf).rstrip()
            if cleaned:
                self.line.emit(cleaned)
                m = _TQDM_PROGRESS_RE.search(cleaned)
                if m:
                    self.progress.emit(int(m.group(1)) / 100.0)

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


class JasnaRunner(QObject):
    """Wraps one `jasna-cli.exe` invocation via ConPTY (pywinpty).

    Processes one file at a time. The main window orchestrates sequential
    invocations for batch processing.
    """

    log_line = Signal(str)
    progress = Signal(float)       # 0-1
    status_text = Signal(str)
    finished = Signal(int)         # exit code
    error = Signal(str)

    def __init__(self, jasna_cli_exe: Path, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.jasna_cli_exe = Path(jasna_cli_exe)
        self.pty = None
        self.thread: QThread | None = None
        self.worker: _JasnaPtyReader | None = None

    def is_running(self) -> bool:
        return self.pty is not None and self.pty.isalive()

    def start(self, input_file: Path, output_file: Path, cli_args: dict[str, Any]) -> None:
        if winpty is None:
            self.error.emit(
                "未安装 pywinpty。请运行 `uv sync` 安装依赖（仅支持 Windows）。"
            )
            return
        if self.is_running():
            self.error.emit("已有修复任务在运行")
            return
        if not self.jasna_cli_exe.exists():
            self.error.emit(f"找不到 jasna-cli.exe：{self.jasna_cli_exe}")
            return

        cmdline = [
            str(self.jasna_cli_exe),
            "--input", str(input_file),
            "--output", str(output_file),
        ] + self._build_args(cli_args)

        self.status_text.emit(f"修复中：{input_file.name}")

        try:
            self.pty = winpty.PtyProcess.spawn(
                cmdline,
                cwd=str(self.jasna_cli_exe.parent),
                dimensions=(50, 250),
            )
        except Exception as e:
            self.error.emit(f"启动 jasna-cli 子进程失败：{e}")
            self.pty = None
            return

        self.thread = QThread(self)
        self.worker = _JasnaPtyReader(self.pty)
        self.worker.moveToThread(self.thread)
        self.worker.line.connect(self.log_line)
        self.worker.progress.connect(self.progress)
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
        self._teardown_thread()

    def _build_args(self, cli_args: dict[str, Any]) -> list[str]:
        out: list[str] = []
        for k, v in cli_args.items():
            if v is None or v == "":
                continue
            if isinstance(v, bool):
                if v:
                    out.append(f"--{k}")
                else:
                    out.append(f"--no-{k}")
                continue
            out.append(f"--{k}={v}")
        return out

    def _on_finished(self, code: int) -> None:
        self.finished.emit(code)
        self._teardown_thread()

    def _teardown_thread(self) -> None:
        if self.thread is not None:
            self.thread.quit()
            self.thread.wait(5000)
            self.thread = None
        self.worker = None
        self.pty = None
