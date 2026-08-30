"""ffmpeg extraction: 30s tone -> 16kHz mono opus @32kbps."""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe_web.audio import AudioError, extract_audio, supports_audio  # noqa: E402


def test_supports_audio() -> None:
    assert supports_audio(Path("a.mp4"))
    assert supports_audio(Path("a.MKV"))
    assert supports_audio(Path("a.opus"))
    assert not supports_audio(Path("a.txt"))


def test_extract_tone() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        src = td / "tone.wav"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
             "-ar", "48000", str(src)],
            check=True,
        )
        out, size = asyncio.run(extract_audio(src))
        try:
            assert out.suffix == ".opus" and 1000 < size < 1 * 1024 * 1024
            # verify stream params with ffprobe
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-select_streams", "a:0",
                 "-show_entries", "stream=codec_name,sample_rate,channels",
                 "-of", "csv=p=0", str(out)],
                capture_output=True, text=True, check=True,
            )
            # opus containers are nominally 48kHz (encoder rate); ASR resamples.
            assert probe.stdout.strip() in ("opus,16000,1", "opus,48000,1"), probe.stdout
        finally:
            out.unlink(missing_ok=True)


def test_extract_garbage_raises() -> None:
    with tempfile.TemporaryDirectory() as td:
        bad = Path(td) / "bad.mp4"
        bad.write_bytes(b"not a media file")
        try:
            asyncio.run(extract_audio(bad))
            raise AssertionError("expected AudioError")
        except AudioError:
            pass


if __name__ == "__main__":
    test_supports_audio()
    test_extract_tone()
    test_extract_garbage_raises()
    print("  test_audio OK")
