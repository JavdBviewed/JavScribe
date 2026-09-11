"""Live progress / RTF / download-name tests (serve side).

Covers:
  A. log_parser v1.9 English lines (Processing (1/1), Duration with speech,
     negative-start segments, batch_probe, transcribe_start, Writing)
  B. RtfHistory record/estimate/persistence
  C. ProgressAPI._result_disposition (source-video download names)
  D. Engine: v1.9 English log sequence -> smooth per-file progress,
     per-file RTF samples, multi-file isolation, live ticker math

Run:  .venv/bin/python tests/test_live_progress.py
"""
from __future__ import annotations

import sys
import tempfile
import textwrap
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.engine import Engine, LIVE_PHASES  # noqa: E402
from jav_scribe.core.log_parser import LogParser  # noqa: E402
from jav_scribe.core.progress_api import _Handler  # noqa: E402
from jav_scribe.core.rtf import RtfHistory  # noqa: E402
from jav_scribe.core.task import Job, Task, TaskPhase, TaskStatus  # noqa: E402

PASSED = 0


def ok(name: str) -> None:
    global PASSED
    PASSED += 1
    print(f"  ok - {name}")


# ---------------------------------------------------------------------------
# A. log_parser
# ---------------------------------------------------------------------------
def test_log_parser_v19() -> None:
    lp = LogParser()
    e = lp.feed("Processing (translate) (1/1): /opt/inbox/abc.opus")
    assert e.kind == "file_start" and e.file_idx == 1 and e.file_total == 1
    assert e.file_path == "/opt/inbox/abc.opus"
    ok("file_start EN (Processing (1/1): path)")

    e = lp.feed("Duration: 2h 59m 27s → 1h 19m 13s (44.1% speech detected)")
    assert e.kind == "duration"
    assert abs(e.duration_s - 10767.0) < 0.01, e.duration_s
    assert abs(e.speech_s - 4753.0) < 0.01, e.speech_s
    assert abs(e.speech_pct - 44.1) < 0.01
    ok("duration EN (hms + speech pct)")

    e = lp.feed("[00:36.28 --> 00:40.22] 诶？")
    assert e.kind == "file_progress" and abs(e.progress - 40.22 / 10767.0) < 1e-6
    ok("segment progress maps onto duration")

    e = lp.feed("[-12:39.66 --> 01:27.64] 负值起始伪影")
    assert e.kind == "file_progress" and abs(e.progress - 87.64 / 10767.0) < 1e-6
    ok("negative-start segment still parsed (end time drives progress)")

    assert lp.feed("Using batched inference with batch size: 8").kind == "batch_probe"
    assert lp.feed("Attempting transcription with batch_size=8").kind == "transcribe_start"
    ok("batch_probe / transcribe_start")

    e = LogParser().feed("Writing: /opt/inbox/abc.srt")
    assert e.kind == "file_written" and e.file_path == "/opt/inbox/abc.srt"
    ok("file_written EN")

    # CN legacy still works
    lp2 = LogParser()
    lp2.feed("正在翻译（1/2）：/media/a.mp4")
    lp2.feed("时长：1小时 → 30分钟")
    e = lp2.feed("[1:30 --> 2:00] 再见")
    assert e.kind == "file_progress" and abs(e.progress - 120 / 3600) < 1e-6
    ok("CN legacy patterns untouched")


# ---------------------------------------------------------------------------
# B. RtfHistory
# ---------------------------------------------------------------------------
def test_rtf_history() -> None:
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "rtf-history.json"
        h = RtfHistory(p)
        est, basis = h.estimate("cuda", "", media_s=3000, speech_s=1500)
        assert abs(est - 100.0) < 0.01 and "默认" in basis and "15" in basis
        ok("default cuda 15x (no history)")

        est, basis = RtfHistory(Path(td) / "nope.json").estimate("cpu", "", media_s=100, speech_s=None)
        assert abs(est - 125.0) < 0.01 and "0.8" in basis
        ok("default cpu 0.8x not rounded to 1x")

        h.record("cuda", "m1", media_s=3600, speech_s=1800, wall_s=120)
        est, basis = h.estimate("cuda", "m1", media_s=3600, speech_s=1800)
        assert abs(est - 120.0) < 0.01 and "同配置" in basis, (est, basis)
        ok("same-config history used (15x measured)")

        est, basis = h.estimate("cuda", "other-model", media_s=3600, speech_s=1800)
        assert "cuda" in basis  # device-only fallback
        ok("device fallback when model differs")

        h2 = RtfHistory(p)  # persistence
        assert h2.estimate("cuda", "m1", media_s=1800, speech_s=900)[0] == 60.0
        ok("history persists across instances")

        h.record("cuda", "m1", media_s=0, speech_s=None, wall_s=10)  # invalid
        n = len(h._entries)
        h.record("cuda", "m1", media_s=10, speech_s=None, wall_s=0)  # invalid
        assert len(h._entries) == n
        ok("invalid samples not recorded")


# ---------------------------------------------------------------------------
# C. Content-Disposition download names
# ---------------------------------------------------------------------------
class _FakeEngine:
    cfg = {"subtitle": {"lang_tag": "zh"}}


class _FakeSelf:
    engine = _FakeEngine()


def _disp(job: Job) -> str:
    return _Handler._result_disposition(_FakeSelf(), job)  # type: ignore[arg-type]


def test_result_disposition() -> None:
    sha1 = "078cd9fffa4bcc809b8702ce6db69883293547ce"
    with tempfile.TemporaryDirectory() as td:
        inbox = Path(td) / f"{sha1}.opus"
        inbox.write_text("")

        j = Job(id="20260911-abc123", files=[Task(path=inbox)], source_kind="remote",
                label="AKDL-342.mp4")
        d = _disp(j)
        assert 'filename="AKDL-342.zh.srt"' in d, d
        assert "filename*=UTF-8''AKDL-342.zh.srt" in d
        ok("upload job: source video name wins over sha1 inbox name")

        j2 = Job(id="20260911-def456", files=[Task(path=inbox)], source_kind="remote", label="")
        d2 = _disp(j2)
        assert f'filename="20260911-def456.zh.srt"' in d2, d2
        ok("sha1 inbox without source name falls back to job id")

        video = Path(td) / "PJAM-045.mp4"
        video.write_text("")
        j3 = Job(id="20260911-ghi789", files=[Task(path=video)], source_kind="local",
                 label="文件夹扫描 · 1 项")
        d3 = _disp(j3)
        assert 'filename="PJAM-045.zh.srt"' in d3, d3
        ok("scan job: first video path name")

        j4 = Job(id="20260911-jkl012", files=[Task(path=inbox)], source_kind="remote",
                 label="日本語.mp4")
        d4 = _disp(j4)
        assert "filename*=UTF-8''%E6%97%A5%E6%9C%AC%E8%AA%9E.zh.srt" in d4, d4
        ok("non-ascii name: RFC5987 filename* + ascii fallback")


# ---------------------------------------------------------------------------
# D. Engine live progress (fake ChickenRice v1.9 English output)
# ---------------------------------------------------------------------------
def _fake_en_script(seg_step_s: float) -> str:
    """Fake ChickenRice v1.9: per-file Processing/Duration/segments/Writing."""
    script = textwrap.dedent("""
        import sys, pathlib, time
        try:
            sys.stdout.reconfigure(line_buffering=True)
        except Exception:
            pass
        files = [a for a in sys.argv[1:] if not a.startswith('-')]
        print("Logging to file: /tmp/latest.log")
        print("Program version: v1.9")
        print("Model running with precision: bfloat16 on device: cuda")
        time.sleep(0.2)
        print("Batch size 8 successful")
        print("Using batched inference with batch size: 8")
        for i, f in enumerate(files, 1):
            p = pathlib.Path(f)
            print(f"Processing (translate) ({i}/{len(files)}): {f}")
            time.sleep(0.15)
            print("Attempting transcription with batch_size=8")
            print("Duration: 0h 1m 0s \u2192 0h 0m 30s (50.0% speech detected)")
            for k in range(20):
                t = 30 + (30 * k / 20)
                print(f"[0:{int(t):02d}.{int((t % 1) * 100):02d} --> 0:{int(t + 1):02d}.00] seg{k}")
                time.sleep(@STEP@)
            out = p.with_suffix('.srt')
            out.write_text("1\\n00:00:30,000 --> 00:01:00,000\\nhello\\n", encoding="utf-8")
            print(f"Writing: {out}")
        print("VAD injection deactivated")
    """)
    return script.replace("@STEP@", repr(seg_step_s))


def _cfg(td: Path, fake: Path) -> dict:
    return {
        "infer": {
            "command": f"{sys.executable} {fake}",
            "model": "models", "device": "cuda", "log_level": "DEBUG",
        },
        "subtitle": {
            "formats": ["srt"], "lang_tag": "zh", "naming": "rename",
            "output_dir": None, "skip_if_exists": True, "overwrite": False,
            "tag_formats": ["srt"],
        },
        "polish": {"enabled": False},
        "emby": {"enabled": False},
        "jasna": {"enabled": False},
    }


def test_engine_v19_single_file() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_en.py"
        # 20 segments * 0.26s = 5.2s of live transcribing (also > 5s => RTF sample recorded)
        fake.write_text(_fake_en_script(0.26), encoding="utf-8")
        src = td / "abc.opus"
        src.write_text("x")
        # Seed machine history at the fake script's real speed (30s speech / 5.2s wall)
        # so the RTF estimate ~= actual duration and the ticker interpolates over the whole run.
        hist = td / "data" / "rtf-history.json"
        hist.parent.mkdir(parents=True, exist_ok=True)
        RtfHistory(hist).record("cuda", "models", media_s=60, speech_s=30, wall_s=5.2)
        eng = Engine(_cfg(td, fake), data_dir=td / "data")
        job = eng.submit([src], source_kind="remote", label="AKDL-342.mp4")
        t = job.files[0]
        samples: list[float] = []
        deadline = time.time() + 25
        while time.time() < deadline:
            samples.append(t.progress)
            if t.status in (TaskStatus.DONE, TaskStatus.ERROR):
                break
            time.sleep(0.1)
        assert t.status == TaskStatus.DONE, (t.status, t.message)
        assert t.duration_s == 60.0 and t.speech_s == 30.0
        assert abs(samples[-1] - 1.0) < 1e-9
        mids = [p for p in samples if 0.40 < p < 0.96]
        assert mids, f"no intermediate progress observed: {sorted(set(round(p,3) for p in samples))}"
        assert len(set(round(p, 3) for p in mids)) >= 3, f"progress not smooth: {sorted(set(round(p,3) for p in mids))}"
        assert all(b >= a - 1e-9 for a, b in zip(samples, samples[1:])), "progress went backwards"
        assert (td / "data" / "rtf-history.json").exists()
        ok(f"v1.9 EN single file: DONE, smooth progress ({len(mids)} mid samples), rtf recorded")
        eng.stop()


def test_engine_v19_multi_file_isolation() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_en2.py"
        fake.write_text(_fake_en_script(0.05), encoding="utf-8")
        a, b = td / "a.opus", td / "b.opus"
        a.write_text("x"); b.write_text("x")
        eng = Engine(_cfg(td, fake), data_dir=td / "data")
        job = eng.submit([a, b], source_kind="remote", label="批量.mp4")
        ta, tb = job.files[0], job.files[1]
        # Window: A has seen its own Duration (transcribe_started set) but B has NOT
        # (its Duration line only appears after A's segments finish). During the whole
        # window B may only sit in the vad band (< 0.40) — never the transcribing band.
        window: list[float] = []
        deadline = time.time() + 30
        while time.time() < deadline:
            if ta.status == TaskStatus.DONE and tb.status == TaskStatus.DONE:
                break
            if ta.transcribe_started is not None and tb.transcribe_started is None:
                window.append(tb.progress)
            time.sleep(0.02)
        assert ta.status == TaskStatus.DONE and tb.status == TaskStatus.DONE, (ta.message, tb.message)
        assert window, "isolation window never observed (A transcribing before B's Duration)"
        b_max = max(window)
        assert b_max < 0.41, f"file B jumped into transcribing band before its own Duration: {b_max}"
        ok(f"multi-file: B stayed out of transcribing band until its own Duration (max {b_max:.3f} over {len(window)} samples)")
        eng.stop()


def test_live_ticker_math() -> None:
    with tempfile.TemporaryDirectory() as td:
        eng = Engine({"infer": {}, "subtitle": {"lang_tag": "zh"}}, data_dir=Path(td))
        job = Job(id="t", files=[Task(path=Path(td) / "x.opus")])
        t = job.files[0]
        now = time.time()
        t.status = TaskStatus.RUNNING
        t.phase = TaskPhase.SUBTITLING
        t.live_phase = "transcribing"
        t.live_phase_started = now - 50
        t.transcribe_started = now - 50
        t.est_transcribe_s = 100.0
        t.duration_s = 60.0
        eng.jobs.append(job)
        eng._live_tick()
        assert abs(t.progress - (0.40 + 0.55 * 0.5)) < 1e-4, t.progress  # 墙钟微差
        assert t.eta_s and abs(t.eta_s - (100.0 * 0.5 + 20.0)) < 1.0, t.eta_s
        ok("ticker: transcribing band interpolates by RTF frac, ETA ticks")

        t2 = Task(path=Path(td) / "y.opus")
        t2.status = TaskStatus.RUNNING
        t2.phase = TaskPhase.SUBTITLING
        t2.live_phase = "preparing"
        t2.live_phase_started = now - 180.0
        job.files.append(t2)
        eng._live_tick()
        assert abs(t2.progress - 0.25) < 1e-9, t2.progress
        lo, hi, _e, det = LIVE_PHASES["preparing"]
        assert t2.phase_detail == det
        ok("ticker: preparing phase capped at 0.25 with phase detail")
        eng.stop()


if __name__ == "__main__":
    test_log_parser_v19()
    test_rtf_history()
    test_result_disposition()
    test_engine_v19_single_file()
    test_engine_v19_multi_file_isolation()
    test_live_ticker_math()
    print(f"ALL {PASSED} LIVE-PROGRESS TESTS PASSED")
