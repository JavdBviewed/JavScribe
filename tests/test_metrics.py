"""/metrics（Prometheus text format）单测：registry 渲染 + HTTP 路由。

Run: python3 tests/test_metrics.py
覆盖：
- gauge 值（jobs_total/files_total/file_progress/engine_batch/model_loaded）
- Counter 单调 + 终态去重（重复渲染不重复计；job 弹出后不丢）
- Histogram 桶/count/sum
- label 转义（文件名含引号）
- upload/scan/config 计数埋点
- GET /metrics 路由（无鉴权，text/plain 0.0.4）
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core import metrics as M  # noqa: E402
from jav_scribe.core.task import Job, Task, TaskPhase, TaskStatus  # noqa: E402


class FakeEngine:
    def __init__(self, jobs=None, cfg=None, model_loaded=False) -> None:
        self.jobs = jobs or []
        self.cfg = cfg or {"infer": {"max_batch_size": 8}}
        self.model_loaded = model_loaded


def _task(name: str, status: TaskStatus, progress: float = 0.0,
          started: float | None = None, finished: float | None = None,
          path: str = "/media/x") -> Task:
    t = Task(path=Path(path) / name, status=status, progress=progress)
    t.started = started
    t.finished = finished
    return t


def _parse(text: str) -> dict[str, str]:
    """metric name{labels} -> value（bucket 行带 label 原样）。"""
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        key, _, val = line.rpartition(" ")
        out[key] = val
    return out


def test_gauges_and_progress() -> None:
    now = time.time()
    running = Job(id="j-run", files=[
        _task("a.mp4", TaskStatus.RUNNING, progress=0.42),
        _task("b.mp4", TaskStatus.RUNNING, progress=0.1),
        _task("c.mp4", TaskStatus.PENDING),
    ])
    done_job = Job(id="j-done", files=[
        _task("d.mp4", TaskStatus.DONE, started=now - 10, finished=now),
    ])
    done_job.finished = now
    reg = M.MetricsRegistry()
    out = _parse(reg.render(FakeEngine(jobs=[running, done_job], model_loaded=True)))
    assert out['javscribe_jobs_total{status="running"}'] == "1"
    assert out['javscribe_jobs_total{status="finished"}'] == "1"
    assert out['javscribe_files_total{status="running"}'] == "2"
    assert out['javscribe_files_total{status="pending"}'] == "1"
    assert out['javscribe_files_total{status="done"}'] == "1"
    assert 'javscribe_file_progress{job_id="j-run",file="a.mp4"}' in out
    assert out['javscribe_file_progress{job_id="j-run",file="a.mp4"}'] == "0.42"
    assert out["javscribe_engine_batch_active"] == "2"
    assert out["javscribe_engine_batch_max"] == "8"
    assert out["javscribe_model_loaded"] == "1"


def test_counters_monotonic_and_dedup() -> None:
    now = time.time()
    j = Job(id="j1", files=[
        _task("d.mp4", TaskStatus.DONE, started=now - 5, finished=now),
        _task("s.mp4", TaskStatus.SKIPPED, started=now - 2, finished=now - 1),
        _task("f.mp4", TaskStatus.ERROR, started=now - 9, finished=now - 8),
    ])
    j.finished = now
    reg = M.MetricsRegistry()
    e = FakeEngine(jobs=[j])
    r1 = _parse(reg.render(e))
    assert r1['javscribe_files_completed_total{result="done"}'] == "1"
    assert r1['javscribe_files_completed_total{result="skipped"}'] == "1"
    assert r1['javscribe_files_completed_total{result="failed"}'] == "1"
    r2 = _parse(reg.render(e))  # 重复渲染不重复计
    assert r2['javscribe_files_completed_total{result="done"}'] == "1"
    e.jobs = []  # job 被弹出（200 上限）
    r3 = _parse(reg.render(e))
    assert r3['javscribe_files_completed_total{result="done"}'] == "1"


def test_histogram_buckets() -> None:
    now = time.time()
    def _fin(name, dur):
        return _task(name, TaskStatus.DONE, started=now - dur, finished=now)
    j = Job(id="jh", files=[_fin("fast.mp4", 0.2), _fin("mid.mp4", 2.0), _fin("slow.mp4", 45.0)])
    j.finished = now
    reg = M.MetricsRegistry()
    out = _parse(reg.render(FakeEngine(jobs=[j])))
    assert out['javscribe_file_duration_seconds_bucket{le="0.5"}'] == "1"
    assert out['javscribe_file_duration_seconds_bucket{le="5"}'] == "2"
    assert out['javscribe_file_duration_seconds_bucket{le="60"}'] == "3"
    assert out['javscribe_file_duration_seconds_bucket{le="+Inf"}'] == "3"
    assert out["javscribe_file_duration_seconds_count"] == "3"
    assert abs(float(out["javscribe_file_duration_seconds_sum"]) - 47.2) < 0.05


def test_label_escaping() -> None:
    now = time.time()
    j = Job(id='j"q', files=[
        _task('we"ird.mp4', TaskStatus.RUNNING, progress=0.5),
        _task("d.mp4", TaskStatus.DONE, started=now - 1, finished=now),
    ])
    j.finished = now
    reg = M.MetricsRegistry()
    text = reg.render(FakeEngine(jobs=[j]))
    assert 'job_id="j\\"q"' in text
    assert 'file="we\\"ird.mp4"' in text


def test_upload_scan_config_counters() -> None:
    reg = M.MetricsRegistry()
    reg.add_upload_bytes(1234)
    reg.add_upload_bytes(100)
    reg.inc_scan_requests()
    reg.inc_config_changes(2)
    out = _parse(reg.render(FakeEngine()))
    assert out["javscribe_upload_bytes_total"] == "1334"
    assert out["javscribe_scan_requests_total"] == "1"
    assert out["javscribe_config_changes_total"] == "2"


def test_http_route_no_auth_text_format() -> None:
    # 复用 test_progress_api_config 的起步法：FakeEngine + 真 HTTP
    from jav_scribe.core.progress_api import ProgressHTTP

    class _FE(FakeEngine):
        def log(self, *_a): pass
        def job_by_id(self, _i): return None
        def result_srt_bytes(self, _j): return None
        def submit_remote_files(self, *_a, **_k): raise AssertionError
        def submit(self, *_a, **_k): raise AssertionError
        def retry_job(self, _i): return None

    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        http = ProgressHTTP(_FE(), host="127.0.0.1", port=0, profile="server",
                            inbox_dir=td / "inbox", config_path=None)
        http.start()
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            req = urllib.request.Request(base + "/metrics")
            with urllib.request.urlopen(req, timeout=5) as resp:
                ctype = resp.headers.get("Content-Type", "")
                body = resp.read().decode()
            assert resp.status == 200
            assert "text/plain" in ctype and "0.0.4" in ctype
            assert "# TYPE javscribe_jobs_total gauge" in body
            assert "javscribe_engine_batch_max 8" in body
            assert "javscribe_model_loaded 0" in body
        finally:
            http.stop()


# ---------------------------------------------------------------------------
# LiveSampler（0.2.4+）：GPU/调度采样 + /metrics/json 路由
# ---------------------------------------------------------------------------

def _fake_nvidia(tmp: Path) -> str:
    """伪 nvidia-smi：固定输出一行 CSV（csv,noheader,nounits 语义）。"""
    exe = tmp / "nvidia-smi"
    exe.write_text(
        "#!/bin/sh\necho \"Test GPU 0,12,3000,8192\"\n",
        encoding="utf-8",
    )
    exe.chmod(0o755)
    return str(exe)


def test_live_sampler_no_gpu() -> None:
    e = FakeEngine(jobs=[Job(id="j1", files=[
        _task("a.mp4", TaskStatus.RUNNING),
        _task("b.mp4", TaskStatus.PENDING),
    ])])
    s = M.LiveSampler(e, interval_s=60)
    s._nvidia = None  # 强制无 GPU 分支
    s._tick()
    snap = s.snapshot(M.MetricsRegistry())
    assert snap["ok"] is True
    assert snap["gpu"] is None
    assert snap["jobs"]["running"] == 1
    assert snap["jobs"]["queued"] == 1
    assert snap["jobs"]["done"] == 0
    h0 = snap["history"][0]
    assert h0["gpu_util"] is None and h0["running"] == 1 and h0["queued"] == 1
    assert snap["uptime_s"] >= 0


def test_live_sampler_fake_gpu_and_ring() -> None:
    td = tempfile.TemporaryDirectory()
    try:
        fake = _fake_nvidia(Path(td.name))
        e = FakeEngine(jobs=[])
        s = M.LiveSampler(e, interval_s=60, maxlen=10)
        s._nvidia = fake
        for _ in range(13):
            s._tick()
        snap = s.snapshot(M.MetricsRegistry())
        g = snap["gpu"]
        assert g is not None and g["present"] is True
        assert g["name"] == "Test GPU 0"
        assert g["util_pct"] == 12.0
        assert g["mem_used_mb"] == 3000.0
        assert g["mem_total_mb"] == 8192.0
        # 环形缓冲：13 次采样 → 只留 maxlen(10) 个
        assert len(snap["history"]) == 10
        assert snap["history"][-1]["gpu_util"] == 12.0
        assert all(h["ts"] <= snap["history"][-1]["ts"] for h in snap["history"])
    finally:
        td.cleanup()


def test_http_route_metrics_json() -> None:
    from jav_scribe.core.progress_api import ProgressHTTP

    class _FE(FakeEngine):
        def log(self, *_a): pass
        def job_by_id(self, _i): return None
        def result_srt_bytes(self, _j): return None
        def submit_remote_files(self, *_a, **_k): raise AssertionError
        def submit(self, *_a, **_k): raise AssertionError
        def retry_job(self, _i): return None

    with tempfile.TemporaryDirectory() as td_s:
        http = ProgressHTTP(_FE(), host="127.0.0.1", port=0, profile="server",
                            inbox_dir=Path(td_s) / "inbox", config_path=None)
        http.start()
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            # /metrics/json 与 /metrics?fmt=json 等价
            for path in ("/metrics/json", "/metrics?fmt=json"):
                with urllib.request.urlopen(base + path, timeout=5) as resp:
                    assert resp.status == 200
                    assert "application/json" in resp.headers.get("Content-Type", "")
                    d = json.loads(resp.read().decode())
                assert d["ok"] is True
                assert d["gpu"] is None  # 测试机无 nvidia-smi 或采样为 None
                assert set(d["jobs"]) >= {"running", "queued", "paused", "done", "skipped", "failed", "canceled"}
                assert isinstance(d["history"], list)
            # 纯 /metrics 仍是 Prometheus text（老客户端/采集器兼容）
            with urllib.request.urlopen(base + "/metrics", timeout=5) as resp:
                assert "text/plain" in resp.headers.get("Content-Type", "")
        finally:
            http.stop()
