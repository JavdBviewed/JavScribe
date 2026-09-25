"""Audio track extraction (identical params to the JavScribe CLI upload flow).

16kHz mono opus @32kbps: ~35MB per 2.5h movie. Only the track crosses the
network to a subtitle service; the video itself never leaves this service.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import subprocess
import time
import tempfile
from pathlib import Path
from typing import Callable

AUDIO_KBITRATE = 32  # must stay in sync with JavScribe constants.REMOTE_AUDIO_KBITRATE
AUDIO_EXTS = {
    ".mp4", ".mkv", ".ts", ".m2ts", ".avi", ".mov", ".flv", ".mpg", ".mpeg",
    ".webm", ".wmv", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".mp3", ".wav",
}


class AudioError(RuntimeError):
    """ffmpeg could not produce an audio track from the source."""


def audio_args(src: Path, dest: Path) -> list[str]:
    return [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(src),
        "-vn", "-c:a", "libopus", "-ar", "16000", "-ac", "1",
        "-b:a", f"{AUDIO_KBITRATE}k",
        str(dest),
    ]


def supports_audio(src: Path) -> bool:
    return src.suffix.lower() in AUDIO_EXTS


def probe_duration(src: Path) -> float:
    """Container duration in seconds (0.0 when unknown/undecodable)."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return float(r.stdout.strip() or 0)
    except Exception:
        return 0.0


def _extract_stall_s() -> float:
    """无 ffmpeg 进度输出多久判定提取停滞（默认 10 分钟）。"""
    with contextlib.suppress(ValueError):
        return float(os.environ.get("JAVWEB_EXTRACT_STALL_S", "600"))
    return 600.0


def _extract_max_s() -> float:
    """提取总时长兜底上限（默认 3h，防 duration=0 且 IO 极慢的无限等待）。"""
    with contextlib.suppress(ValueError):
        return float(os.environ.get("JAVWEB_EXTRACT_MAX_S", "10800"))
    return 10800.0


async def extract_audio_progress(
    src: Path,
    dest: Path,
    on_progress: Callable[[float], None] | None = None,
) -> int:
    """Extract the track to ``dest``; report progress as fractions in [0, 1].

    Progress is ffmpeg ``out_time_us`` relative to the probed container
    duration; when the duration is unknown the callback is only invoked
    with 0.0 (start) and 1.0 (finish). Raises AudioError on failure.
    看门狗：ffmpeg 长时间无任何进度输出（IO 挂死/futex 死锁）或总时长
    超限 → kill 进程并抛 AudioError，避免永久占用在途槽拖死整条队列。
    Returns the output size in bytes.
    """
    duration = probe_duration(src)
    stall_s = _extract_stall_s()
    max_s = _extract_max_s()
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *audio_args(src, dest),
        "-progress", "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdout is not None
    last = -1.0
    if on_progress is not None:
        on_progress(0.0)
    try:
        while True:
            remaining = max_s - (time.monotonic() - started)
            if remaining <= 0:
                raise AudioError(f"提取总时长超限（>{max_s / 3600:.1f}h）")
            try:
                line = await asyncio.wait_for(
                    proc.stdout.readline(), timeout=min(stall_s, remaining)
                )
            except asyncio.TimeoutError:
                elapsed = time.monotonic() - started
                if elapsed >= max_s:
                    raise AudioError(f"提取总时长超限（>{max_s / 3600:.1f}h）")
                raise AudioError(
                    f"提取停滞超时（{stall_s / 60:.0f} 分钟无 ffmpeg 进度输出，"
                    f"已强制结束；可重试，若反复停滞请检查影片文件/IO）"
                )
            if not line:
                break
            if not line.startswith(b"out_time_us="):
                continue
            if duration <= 0:
                continue
            v = line.strip()[12:]
            if not v.isdigit():  # ffmpeg 可能输出 N/A（无输出时间戳）
                continue
            frac = min(1.0, int(v) / (duration * 1_000_000))
            if frac - last >= 0.01:  # throttle: at most ~100 callbacks
                last = frac
                if on_progress is not None:
                    on_progress(frac)
        _out, err = await proc.communicate()
    except AudioError:
        # 看门狗触发：杀 ffmpeg 防孤儿进程，保留错误信息
        with contextlib.suppress(BaseException):
            proc.kill()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), 3)
        raise
    except asyncio.CancelledError:
        # 任务被取消（用户暂停/工作台停机）：先杀 ffmpeg 防孤儿进程，再传播
        with contextlib.suppress(BaseException):
            proc.kill()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(proc.wait(), 3)
        raise
    if proc.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        dest.unlink(missing_ok=True)
        raise AudioError(f"ffmpeg failed: {err.decode(errors='replace')[-300:]}")
    if on_progress is not None:
        on_progress(1.0)
    return dest.stat().st_size


async def extract_audio(src: Path) -> tuple[Path, int]:
    """Extract the track into a temp file; return (path, size). Caller unlinks.

    Backward-compatible wrapper around :func:`extract_audio_progress`.
    """
    fd, name = tempfile.mkstemp(suffix=".opus", prefix="javweb_")
    import os

    os.close(fd)
    tmp = Path(name)
    size = await extract_audio_progress(src, tmp)
    return tmp, size
