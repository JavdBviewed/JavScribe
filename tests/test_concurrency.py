"""转译并发（worker 池 + 多模型实例）测试。

用「慢启动」假推理引擎（加载模型时 sleep）观测同一时刻 RUNNING 的任务数，
验证串行默认 / 并发派发 / 热调并发 / 挂起跳过 / 取消补位 / 模型 gauge / stop。

Run: python3 tests/test_concurrency.py  （或随 pytest 收集）
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.engine import Engine  # noqa: E402
from jav_scribe.core.progress_api import (  # noqa: E402
    ConfigError,
    validate_config_updates,
)
from jav_scribe.core.task import TaskStatus  # noqa: E402

# 假引擎：模型加载阶段 sleep 1.2s，给并发观测留窗口
FAKE_SLOW = (
    "import sys, pathlib, time\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    'print("正在加载 Whisper 模型")\n'
    "time.sleep(1.2)\n"
    "for f in files:\n"
    "    p = pathlib.Path(f)\n"
    '    print("正在翻译 (1/1)：%s" % f)\n'
    '    print("Duration: 30.00s")\n'
    "    out = p.with_suffix('.srt')\n"
    "    out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\n你好\\n', encoding='utf-8')\n"
    '    print("Writing: %s" % out)\n'
    'print("全部完成")\n'
)


def _write_fake(tmp: Path, code: str) -> Path:
    fake = tmp / "fake_infer_slow.py"
    fake.write_text(code, encoding="utf-8")
    return fake


def _base_cfg(fake: Path, concurrency: int | None = None) -> dict:
    cfg = {
        "infer": {
            "command": f"{sys.executable} {fake}",
            "model": "models",
            "device": "cpu",
            "log_level": "DEBUG",
        },
        "subtitle": {
            "formats": ["srt"],
            "lang_tag": "zh",
            "naming": "rename",
            "output_dir": None,
            "skip_if_exists": True,
            "overwrite": False,
            "tag_formats": ["srt"],
        },
        "polish": {"enabled": False},
        "emby": {"enabled": False},
        "jasna": {"enabled": False},
    }
    if concurrency is not None:
        cfg["infer"]["concurrency"] = concurrency
    return cfg


def _mk_video(tmp: Path, name: str) -> Path:
    v = tmp / name
    v.write_bytes(b"fake")
    return v


def _running_count(engine: Engine) -> int:
    n = 0
    for j in engine.jobs:
        for t in j.files:
            if t.status == TaskStatus.RUNNING:
                n += 1
    return n


def _wait_done(jobs, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if all(j.done for j in jobs):
            return
        time.sleep(0.05)
    raise AssertionError(f"超时：任务未完成 {[(j.id, [t.status for t in j.files]) for j in jobs]}")


def _observed_max_running(engine: Engine, stop_when, timeout: float = 60.0) -> int:
    """轮询直到 stop_when() 为真，返回期间观察到的最大并发 RUNNING 数。"""
    peak = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        peak = max(peak, _running_count(engine))
        if stop_when():
            return peak
        time.sleep(0.03)
    raise AssertionError("观测超时")


def test_default_serial() -> None:
    """未配置并发 → 串行：两任务任何时刻最多 1 个 RUNNING，且都完成。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv")
        engine = Engine(_base_cfg(fake), log=lambda s: None)
        try:
            assert engine.concurrency == 1
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            peak = _observed_max_running(engine, lambda: j1.done and j2.done)
            assert peak == 1, f"默认应串行，观察到峰值 {peak}"
            assert j1.files[0].status == TaskStatus.DONE
            assert j2.files[0].status == TaskStatus.DONE
        finally:
            engine.stop()
    print("  test_default_serial OK")


def test_parallel_two() -> None:
    """concurrency=2 → 两个慢任务真正并行（峰值 RUNNING=2）。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv")
        engine = Engine(_base_cfg(fake, concurrency=2), log=lambda s: None)
        try:
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            peak = _observed_max_running(engine, lambda: j1.done and j2.done)
            assert peak == 2, f"应并行 2，观察到峰值 {peak}"
            assert (v1.with_name("a.zh.srt")).is_file()
            assert (v2.with_name("b.zh.srt")).is_file()
        finally:
            engine.stop()
    print("  test_parallel_two OK")


def test_hot_concurrency_change() -> None:
    """运行中热调 1→2：首任务跑完后，后续两任务并行。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2, v3 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv"), _mk_video(tmp, "c.mkv")
        engine = Engine(_base_cfg(fake, concurrency=1), log=lambda s: None)
        try:
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            j3 = engine.submit([v3])
            # 首任务开跑后（模型加载期）把并发提到 2
            while not j1.files[0].started:
                time.sleep(0.02)
            engine.cfg["infer"]["concurrency"] = 2
            peak = _observed_max_running(engine, lambda: j1.done and j2.done and j3.done)
            assert peak == 2, f"热调后应观察到并行 2，峰值 {peak}"
            for j in (j1, j2, j3):
                assert j.files[0].status == TaskStatus.DONE, j.files[0].to_dict()
        finally:
            engine.stop()
    print("  test_hot_concurrency_change OK")


def test_paused_job_skipped_in_pool() -> None:
    """并发=1：队头任务被挂起时，worker 应越过它取下一个任务。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2, v3 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv"), _mk_video(tmp, "c.mkv")
        engine = Engine(_base_cfg(fake, concurrency=1), log=lambda s: None)
        try:
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            j3 = engine.submit([v3])
            # j1 已开跑（占满唯一槽位）时挂起 j2：此时 j2 必在排队，判定确定
            while j1.files[0].started is None:
                time.sleep(0.02)
            assert engine.pause_job(j2.id) == "paused", "j2 应处于排队可挂起状态"
            _wait_done([j1])
            # j1 结束后：j2 挂起被跳过，j3 开跑
            deadline = time.time() + 30
            while time.time() < deadline and j3.files[0].started is None:
                time.sleep(0.02)
            assert j3.files[0].started is not None, "j2 挂起不应阻塞 j3"
            assert j2.files[0].status == TaskStatus.PENDING, "挂起者保持排队"
            assert engine.resume_job(j2.id) == "resumed"
            _wait_done([j2, j3])
            assert j2.files[0].status == TaskStatus.DONE
        finally:
            engine.stop()
    print("  test_paused_job_skipped_in_pool OK")


def test_pause_commit_race() -> None:
    """竞态回归：pause 与开跑提交（committed）同锁互斥。

    j1 结束后，drain 弹出 j2 → 起线程 → _pipeline 开跑门提交，这个交接窗口
    只有微秒级。反复在窗口两侧抢 pause，断言不变式：
      - 返回 "paused"  → 任务必须保持 PENDING（绝不照常跑完）
      - 返回 "running" → 任务必须已真实开跑
    两种结局都是合法状态；「paused 成功但任务照跑」才是 bug。
    """
    fast = FAKE_SLOW.replace("time.sleep(1.2)", "time.sleep(0.15)")
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, fast)
        saw_paused = saw_running = False
        for _ in range(40):
            d = tmp / f"iter{time.time_ns()}"
            d.mkdir(parents=True, exist_ok=True)
            v1 = _mk_video(d, "a.mkv")
            v2 = _mk_video(d, "b.mkv")
            engine = Engine(_base_cfg(fake, concurrency=1), log=lambda s: None)
            try:
                j1 = engine.submit([v1])
                j2 = engine.submit([v2])
                res = None
                deadline = time.time() + 10
                while time.time() < deadline:
                    if j1.done:
                        res = engine.pause_job(j2.id)
                        if res == "paused":
                            assert j2.files[0].status == TaskStatus.PENDING, "paused 成功必须保持排队"
                            saw_paused = True
                        elif res == "running":
                            # 合法：已越过开跑门（预检阶段 started 可能未置），
                            # 契约是「绝不再可挂起」——下方等待其正常跑完即验证
                            saw_running = True
                        else:
                            raise AssertionError(f"意外返回: {res}")
                        break
                    time.sleep(0.001)
                assert res in ("paused", "running"), "窗口内未能观测到交接"
                if res == "paused":
                    assert engine.resume_job(j2.id) == "resumed"
                _wait_done([j1, j2])
                assert j2.files[0].status == TaskStatus.DONE
            finally:
                engine.stop()
        print(f"    （观测到 paused 交接 {saw_paused} / running 交接 {saw_running}）")
    print("  test_pause_commit_race OK")


def test_cancel_queued_releases_slot() -> None:
    """并发=1：取消排队任务后，其后的任务应立即补位（不等 worker 结束）。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2, v3 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv"), _mk_video(tmp, "c.mkv")
        engine = Engine(_base_cfg(fake, concurrency=1), log=lambda s: None)
        try:
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            j3 = engine.submit([v3])
            while not j1.files[0].started:
                time.sleep(0.02)
            assert engine.cancel_job(j2.id) == "canceled"
            # j1 仍在跑（1.2s 慢加载），j3 应已补位开跑
            deadline = time.time() + 5
            while time.time() < deadline and j3.files[0].started is None:
                time.sleep(0.02)
            assert j3.files[0].started is not None, "取消排队任务后 j3 应立即补位"
            _wait_done([j1, j3])
            assert j2.files[0].status == TaskStatus.CANCELED
        finally:
            engine.stop()
    print("  test_cancel_queued_releases_slot OK")


def test_model_gauge_tracks_instances() -> None:
    """model_loaded：进程在跑为 True，全部结束回落 False（并发 2）。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv")
        engine = Engine(_base_cfg(fake, concurrency=2), log=lambda s: None)
        try:
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            deadline = time.time() + 30
            seen_true = False
            while time.time() < deadline and not (j1.done and j2.done):
                if engine.model_loaded:
                    seen_true = True
                time.sleep(0.03)
            assert seen_true, "推理进程在跑期间 model_loaded 应为 True"
            assert engine.model_loaded is False, "全部结束后 gauge 应回落"
        finally:
            engine.stop()
    print("  test_model_gauge_tracks_instances OK")


def test_stop_kills_all_runners() -> None:
    """stop() 应终止全部在途推理子进程（并发 2 双任务场景）。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv")
        engine = Engine(_base_cfg(fake, concurrency=2), log=lambda s: None)
        j1 = engine.submit([v1])
        j2 = engine.submit([v2])
        deadline = time.time() + 30
        while time.time() < deadline and not (
            j1.files[0].started and j2.files[0].started
        ):
            time.sleep(0.02)
        assert j1.files[0].started and j2.files[0].started, "应双任务并行在途"
        engine.stop()
        _wait_done([j1, j2], timeout=30)
        assert j1.files[0].status == TaskStatus.CANCELED, j1.files[0].to_dict()
        assert j2.files[0].status == TaskStatus.CANCELED, j2.files[0].to_dict()
    print("  test_stop_kills_all_runners OK")


def test_concurrency_config_validation() -> None:
    """/config 校验：合法值通过，越界/非法拒绝。"""
    ok = validate_config_updates({"infer.concurrency": 2})
    assert ok == [("infer", "concurrency", 2)], ok
    for bad in (0, 5, "2", True):
        try:
            validate_config_updates({"infer.concurrency": bad})
        except ConfigError:
            pass
        else:
            raise AssertionError(f"{bad!r} 应被拒绝")
    print("  test_concurrency_config_validation OK")


def main() -> None:
    test_default_serial()
    test_parallel_two()
    test_hot_concurrency_change()
    test_paused_job_skipped_in_pool()
    test_pause_commit_race()
    test_cancel_queued_releases_slot()
    test_model_gauge_tracks_instances()
    test_stop_kills_all_runners()
    test_concurrency_config_validation()
    print("test_concurrency: all OK")


if __name__ == "__main__":
    main()
