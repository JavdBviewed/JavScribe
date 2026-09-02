"""Audio track extraction (identical params to the JavScribe CLI upload flow).

16kHz mono opus @32kbps: ~35MB per 2.5h movie. Only the track crosses the
network to a workshop; the video itself never leaves this service.
"""
from __future__ import annotations

import asyncio
import subprocess
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


async def extract_audio_progress(
    src: Path,
    dest: Path,
    on_progress: Callable[[float], None] | None = None,
) -> int:
    """Extract the track to ``dest``; report progress as fractions in [0, 1].

    Progress is ffmpeg ``out_time_us`` relative to the probed container
    duration; when the duration is unknown the callback is only invoked
    with 0.0 (start) and 1.0 (finish). Raises AudioError on failure.
    Returns the output size in bytes.
    """
    duration = probe_duration(src)
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
    while line := await proc.stdout.readline():
        if not line.startswith(b"out_time_us="):
            continue
        if duration <= 0:
            continue
        frac = min(1.0, int(line.strip()[12:]) / (duration * 1_000_000))
        if frac - last >= 0.01:  # throttle: at most ~100 callbacks
            last = frac
            if on_progress is not None:
                on_progress(frac)
    _out, err = await proc.communicate()
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
