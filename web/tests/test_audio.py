"""ffmpeg extraction: 30s tone -> 16kHz mono opus @32kbps."""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe_web.audio import (  # noqa: E402
    AudioError,
    extract_audio,
    extract_audio_progress,
    probe_duration,
    supports_audio,
)


def _tone(path: Path, seconds: int = 30) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
         "-ar", "48000", str(path)],
        check=True,
    )


def test_supports_audio() -> None:
    assert supports_audio(Path("a.mp4"))
    assert supports_audio(Path("a.MKV"))
    assert supports_audio(Path("a.opus"))
    assert not supports_audio(Path("a.txt"))


def test_extract_tone() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        src = td / "tone.wav"
        _tone(src)
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


def test_probe_duration() -> None:
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "tone.wav"
        _tone(src, 2)
        d = probe_duration(src)
        assert 1.8 < d < 2.2, d
        assert probe_duration(Path(td) / "missing.wav") == 0.0


def test_extract_progress_callback() -> None:
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "tone.wav"
        _tone(src, 3)
        dest = Path(td) / "out.opus"
        seen: list[float] = []
        size = asyncio.run(extract_audio_progress(src, dest, on_progress=seen.append))
        try:
            assert size > 1000
            assert seen and seen[0] == 0.0 and seen[-1] == 1.0
            assert all(0.0 <= v <= 1.0 for v in seen)
            assert seen == sorted(seen), "progress must be monotonic"
            assert len(seen) >= 2, "expected intermediate progress ticks"
        finally:
            dest.unlink(missing_ok=True)


if __name__ == "__main__":
    test_supports_audio()
    test_extract_tone()
    test_extract_garbage_raises()
    test_probe_duration()
    test_extract_progress_callback()
    print("  test_audio OK")


class _FakeStuck:
    """extract_audio_progress 替身：前 n 次抛「提取卡死」，之后成功。"""

    def __init__(self, n_stuck: int, result: int = 4242) -> None:
        self.n_stuck = n_stuck
        self.result = result
        self.calls = 0
        self.progress_calls: list[float] = []

    async def __call__(self, src, dest, on_progress=None) -> int:
        self.calls += 1
        if on_progress is not None:
            on_progress(0.0)
        if self.calls <= self.n_stuck:
            raise AudioError("提取卡死（120 秒内 ffmpeg 无 CPU 活动…）")
        if on_progress is not None:
            on_progress(1.0)
        return self.result


def test_retrying_passes_first_try() -> None:
    from jav_scribe_web import audio
    fake = _FakeStuck(0)
    orig = audio.extract_audio_progress
    audio.extract_audio_progress = fake  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            size = asyncio.run(audio.extract_audio_retrying(Path(td), Path(td) / "o.opus"))
        assert size == 4242 and fake.calls == 1
    finally:
        audio.extract_audio_progress = orig


def test_retrying_retries_on_stuck_then_succeeds() -> None:
    from jav_scribe_web import audio
    fake = _FakeStuck(2)
    orig = audio.extract_audio_progress
    audio.extract_audio_progress = fake  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            seen: list[float] = []
            size = asyncio.run(
                audio.extract_audio_retrying(
                    Path(td), Path(td) / "o.opus",
                    on_progress=lambda f: seen.append(f),
                )
            )
        assert size == 4242 and fake.calls == 3
        # 每轮重提取进度从 0 重新开始
        assert seen.count(0.0) == 3 and seen.count(1.0) == 1
    finally:
        audio.extract_audio_progress = orig


def test_retrying_exhausts_and_reports_attempts() -> None:
    from jav_scribe_web import audio
    fake = _FakeStuck(99)  # 永远卡死
    orig = audio.extract_audio_progress
    audio.extract_audio_progress = fake  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            try:
                asyncio.run(audio.extract_audio_retrying(Path(td), Path(td) / "o.opus"))
                raise AssertionError("expected AudioError")
            except AudioError as ex:
                assert "已自动重试 2 次" in str(ex)
        assert fake.calls == 3  # 1 + 默认重试 2 次
    finally:
        audio.extract_audio_progress = orig


def test_retrying_no_retry_on_other_errors() -> None:
    from jav_scribe_web import audio

    async def boom(src, dest, on_progress=None) -> int:
        raise AudioError("ffmpeg failed: bad data")

    orig = audio.extract_audio_progress
    audio.extract_audio_progress = boom  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            try:
                asyncio.run(audio.extract_audio_retrying(Path(td), Path(td) / "o.opus"))
                raise AssertionError("expected AudioError")
            except AudioError as ex:
                assert "bad data" in str(ex) and "已自动重试" not in str(ex)
    finally:
        audio.extract_audio_progress = orig
