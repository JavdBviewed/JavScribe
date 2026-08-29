"""Cross-platform subprocess runner for external engines (ChickenRice infer, JASNA).

Windows: uses ConPTY (pywinpty) when available — required because the
PyInstaller-frozen infer.exe prints non-ASCII (⚠) and crashes on a plain
pipe under the GBK console codepage (same reason JAVSubTool used ConPTY).
Linux/macOS: plain Popen with incremental UTF-8 decoding.
"""
from __future__ import annotations

import codecs
import os
import re
import shlex
import subprocess
import sys
import threading
from typing import Callable, Optional

try:
    import winpty  # type: ignore
except ImportError:
    winpty = None  # type: ignore

_ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])")
_TQDM_RE = re.compile(r"(\d+)%\|")


class ProcRunner:
    def __init__(
        self,
        command: str,
        files: list[str] | None = None,
        cwd: str | None = None,
        on_line: Callable[[str], None] | None = None,
        on_progress_pct: Callable[[float], None] | None = None,
        on_exit: Callable[[int], None] | None = None,
        use_pty: bool = True,
        env: dict[str, str] | None = None,
    ) -> None:
        self.command = command
        self.files = [str(f) for f in (files or [])]
        self.cwd = cwd
        self.on_line = on_line
        self.on_progress_pct = on_progress_pct
        self.on_exit = on_exit
        self.use_pty = use_pty and sys.platform == "win32" and winpty is not None
        self._env = env
        self._proc: subprocess.Popen | None = None
        self._pty = None
        self._thread: threading.Thread | None = None
        self._stop = False

    @property
    def running(self) -> bool:
        if self._thread is None or not self._thread.is_alive():
            return False
        if self._pty is not None:
            return self._pty.isalive()
        if self._proc is not None:
            return self._proc.poll() is None
        return False

    def _cmdline(self) -> list[str]:
        if self.command.startswith(" ") or "\n" in self.command:
            # allow leading env assignments: "CUDA_VISIBLE_DEVICES=0 cmd..."
            parts: list[str] = []
            for tok in self.command.split():
                if "=" in tok and not any(c in tok for c in "\\\"'"):
                    parts.append(tok)
            return parts
        return shlex.split(self.command) + self.files

    def start(self) -> bool:
        cmdline = self._cmdline()
        if self._pty is not None or self._proc is not None:
            return False
        try:
            if self.use_pty:
                env = dict(os.environ)
                if self._env:
                    env.update(self._env)
                self._pty = winpty.PtyProcess.spawn(
                    cmdline,
                    cwd=self.cwd or os.path.dirname(cmdline[0]) or None,
                    env=env,
                    dimensions=(50, 250),
                )
            else:
                self._proc = subprocess.Popen(
                    cmdline,
                    cwd=self.cwd,
                    env=self._env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                )
        except (OSError, ValueError) as e:
            if self.on_line:
                self.on_line(f"[ERROR] 启动失败: {e}")
            self._pty = None
            self._proc = None
            if self.on_exit:
                self.on_exit(127)
            return False
        self._stop = False
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop = True
        if self._pty is not None and self._pty.isalive():
            try:
                self._pty.terminate(force=True)
            except Exception:
                pass
        if self._proc is not None and self._proc.poll() is None:
            try:
                self._proc.kill()
            except OSError:
                pass

    def wait(self, timeout: float | None = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    # ------------------------------------------------------------------
    def _read_loop(self) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")()
        buf = ""
        try:
            if self._pty is not None:
                while not self._stop:
                    try:
                        chunk = self._pty.read(4096)
                    except (EOFError, OSError):
                        break
                    except Exception:
                        break
                    if not chunk:
                        if not self._pty.isalive():
                            break
                        continue
                    buf += self._decode(decoder, chunk)
                    lines, buf = self._drain(buf)
                    for line in lines:
                        self._emit(line)
                buf += decoder.decode(b"", True)
                lines, buf = self._drain(buf)
                for line in lines:
                    self._emit(line)
                code = 0
                try:
                    self._pty.wait()
                except Exception:
                    pass
                code = getattr(self._pty, "exitstatus", 0) or 0
            else:
                assert self._proc is not None and self._proc.stdout is not None
                for raw in iter(self._proc.stdout.readline, b""):
                    if self._stop:
                        break
                    buf += self._decode(decoder, raw)
                    lines, buf = self._drain(buf)
                    for line in lines:
                        self._emit(line)
                buf += decoder.decode(b"", True)
                lines, buf = self._drain(buf)
                for line in lines:
                    self._emit(line)
                code = self._proc.wait()
        except Exception as e:  # pragma: no cover - defensive
            if self.on_line:
                self.on_line(f"[ERROR] 读取输出失败: {e}")
            code = 1
        finally:
            if self.on_exit:
                self.on_exit(int(code))

    @staticmethod
    def _decode(decoder: codecs.IncrementalDecoder, chunk: bytes) -> str:
        if isinstance(chunk, bytes):
            return decoder.decode(chunk, False)
        return str(chunk)

    @staticmethod
    def _drain(buf: str) -> tuple[list[str], str]:
        out: list[str] = []
        buf = buf.replace("\r\n", "\n").replace("\r", "\n")
        while "\n" in buf:
            idx = buf.index("\n")
            line = buf[:idx]
            buf = buf[idx + 1 :]
            cleaned = _ANSI_RE.sub("", line).rstrip()
            if cleaned:
                out.append(cleaned)
        return out, buf

    def _emit(self, line: str) -> None:
        if self.on_line:
            self.on_line(line)
        if self.on_progress_pct:
            m = _TQDM_RE.search(line)
            if m:
                self.on_progress_pct(int(m.group(1)) / 100.0)
