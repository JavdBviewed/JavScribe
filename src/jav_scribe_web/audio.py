"""Audio track extraction (identical params to the JavScribe CLI upload flow).

16kHz mono opus @32kbps: ~35MB per 2.5h movie. Only the track crosses the
network to a workshop; the video itself never leaves this service.
"""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

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


async def extract_audio(src: Path) -> tuple[Path, int]:
    """Extract the track into a temp file; return (path, size). Caller unlinks."""
    fd, name = tempfile.mkstemp(suffix=".opus", prefix="javweb_")
    import os

    os.close(fd)
    tmp = Path(name)
    proc = await asyncio.create_subprocess_exec(
        *audio_args(src, tmp),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _out, err = await proc.communicate()
    if proc.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
        tmp.unlink(missing_ok=True)
        raise AudioError(f"ffmpeg failed: {err.decode(errors='replace')[-300:]}")
    return tmp, tmp.stat().st_size
