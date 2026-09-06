"""Inbox 缓存清理（storage.retention_days）测试。

Run:  python3 tests/test_retention.py
Covers: 超期音轨/字幕删除、保留期内不动、非缓存扩展名/子目录不碰、
活跃任务文件保护、retention<=0 不清理、释放字节数、inbox 缺失容错、
retention_loop 读 cfg 热生效。
"""
from __future__ import annotations

import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.retention import cleanup_inbox, retention_loop  # noqa: E402
from jav_scribe.core.task import Job, Task, TaskStatus  # noqa: E402

DAY = 86400


def _age(p: Path, days: float) -> None:
    p.write_bytes(b"x" * 100)
    ts = time.time() - days * DAY
    import os
    os.utime(p, (ts, ts))


class FakeEngine:
    def __init__(self, cfg: dict, jobs: list | None = None) -> None:
        self.cfg = cfg
        self.jobs = jobs or []
        self.logs: list[str] = []

    def log(self, msg: str) -> None:
        self.logs.append(msg)


def test_basic_cleanup() -> None:
    with tempfile.TemporaryDirectory() as td:
        inbox = Path(td)
        old_opus = inbox / "A.mp4.opus"      # 超期音轨 → 删
        old_srt = inbox / "A.mp4.zh.srt"     # 超期字幕 → 删
        old_vtt = inbox / "B.mp4.zh.vtt"     # 超期 vtt → 删
        new_opus = inbox / "C.mp4.opus"      # 保留期内 → 留
        new_srt = inbox / "C.mp4.zh.srt"     # 保留期内 → 留
        video = inbox / "C.mp4"              # 非缓存扩展名 → 留
        log = inbox / "serve.log"            # 非缓存扩展名 → 留
        _age(old_opus, 8)
        _age(old_srt, 8)
        _age(old_vtt, 30)
        _age(new_opus, 0.1)
        _age(new_srt, 0.1)
        _age(video, 8)
        _age(log, 8)
        sub = inbox / "subdir"               # 子目录不递归
        sub.mkdir()
        old_in_sub = sub / "D.mp4.opus"
        _age(old_in_sub, 8)

        engine = FakeEngine({"storage": {"retention_days": 7}})
        deleted, freed = cleanup_inbox(inbox, 7, set(), engine.log)

        assert deleted == 3, deleted
        assert freed == 300, freed
        assert not old_opus.exists() and not old_srt.exists() and not old_vtt.exists()
        assert new_opus.exists() and new_srt.exists() and video.exists() and log.exists()
        assert old_in_sub.exists(), "子目录内文件不得触碰"
        assert any("清理超期缓存" in m for m in engine.logs)
    print("test_basic_cleanup PASSED")


def test_active_files_protected() -> None:
    with tempfile.TemporaryDirectory() as td:
        inbox = Path(td)
        busy_opus = inbox / "BUSY.mp4.opus"   # 超期但属于活跃任务 → 留
        busy_srt = inbox / "BUSY.mp4.zh.srt"
        done_opus = inbox / "DONE.mp4.opus"   # 超期且任务已完成 → 删
        _age(busy_opus, 8)
        busy_srt.write_bytes(b"y" * 50)
        import os
        ts = time.time() - 8 * DAY
        os.utime(busy_srt, (ts, ts))
        _age(done_opus, 8)

        busy_task = Task(path=busy_opus, status=TaskStatus.RUNNING,
                         restored_path=busy_opus, output_files=[busy_srt])
        done_task = Task(path=done_opus, status=TaskStatus.DONE)
        engine = FakeEngine(
            {"storage": {"retention_days": 7}},
            jobs=[Job(id="j1", files=[busy_task, done_task])],
        )
        from jav_scribe.core.retention import active_source_paths
        active = active_source_paths(engine)
        assert str(busy_opus) in active and str(busy_srt) in active
        assert str(done_opus) not in active

        deleted, _ = cleanup_inbox(inbox, 7, active, engine.log)
        assert deleted == 1, deleted
        assert busy_opus.exists() and busy_srt.exists()
        assert not done_opus.exists()
        assert any("跳过活跃任务文件" in m for m in engine.logs)
    print("test_active_files_protected PASSED")


def test_zero_or_negative_days_noop() -> None:
    with tempfile.TemporaryDirectory() as td:
        inbox = Path(td)
        old = inbox / "A.mp4.opus"
        _age(old, 8)
        deleted, freed = cleanup_inbox(inbox, 0, set(), None)
        assert (deleted, freed) == (0, 0) and old.exists()
        deleted, freed = cleanup_inbox(inbox, -3, set(), None)
        assert (deleted, freed) == (0, 0) and old.exists()
    print("test_zero_or_negative_days_noop PASSED")


def test_missing_inbox_no_raise() -> None:
    deleted, freed = cleanup_inbox(Path("/nonexistent/inbox/xyz"), 7, set(), None)
    assert (deleted, freed) == (0, 0)
    print("test_missing_inbox_no_raise PASSED")


def test_loop_reads_cfg_and_hot_applies() -> None:
    with tempfile.TemporaryDirectory() as td:
        inbox = Path(td)
        old = inbox / "A.mp4.opus"
        _age(old, 8)
        fresh = inbox / "B.mp4.opus"
        _age(fresh, 0.1)

        engine = FakeEngine({"storage": {"retention_days": 3650}})  # 先不删
        t = threading.Thread(
            target=retention_loop,
            args=(engine, inbox),
            kwargs={"initial_delay_s": 0.02, "interval_s": 0.05},
            daemon=True,
        )
        t.start()
        time.sleep(0.25)
        assert old.exists() and fresh.exists(), "3650 天保留期内不得删除"
        engine.cfg["storage"]["retention_days"] = 7  # 热调 → 下一轮删除
        time.sleep(0.25)
        assert not old.exists(), "热调后应删除超期文件"
        assert fresh.exists()
        t.join(timeout=2)
    print("test_loop_reads_cfg_and_hot_applies PASSED")


if __name__ == "__main__":
    test_basic_cleanup()
    test_active_files_protected()
    test_zero_or_negative_days_noop()
    test_missing_inbox_no_raise()
    test_loop_reads_cfg_and_hot_applies()
    print("ALL RETENTION TESTS PASSED")
