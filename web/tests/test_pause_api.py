"""Web 侧暂停/继续/重试 API 测试（引擎方法 monkeypatch，无真实网络）。"""
from __future__ import annotations

import asyncio
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from jav_scribe_web import api as api_mod  # noqa: E402
from jav_scribe_web.api import build_app  # noqa: E402
from jav_scribe_web.config import EngineStore  # noqa: E402
from jav_scribe_web.engines.base import EngineInfo  # noqa: E402
from jav_scribe_web.engines.javscribe import JavScribeEngine  # noqa: E402
from jav_scribe_web.poller import Poller  # noqa: E402

RUNNING_JOB = {
    "id": "j-run", "created": 1000.0, "finished": None, "source_kind": "remote",
    "label": "PJAM-045.mp4", "total": 1, "done": 0, "skipped": 0, "failed": 0,
    "state": "running",
    "files": [
        {"path": "x", "name": "PJAM-045.opus", "status": "running", "phase": "subtitling",
         "progress": 0.36, "message": "", "duration_s": 6180.0, "position_s": 2224.8,
         "position": "37:04", "output_files": [], "started": 1010.0, "finished": None},
    ],
}


def _make_client(td: str):
    store = EngineStore(td)
    store.add("车间A", "http://127.0.0.1:18301")
    store.add("车间B", "http://10.0.0.2:8300")
    poller = Poller(store)
    poller.engines = {
        "车间A": EngineInfo("车间A", "http://127.0.0.1:18301", online=True, device="cuda",
                            version="0.2.3", jobs_running=1),
        "车间B": EngineInfo("车间B", "http://10.0.0.2:8300", online=False, error="boom"),
    }
    poller.jobs = {"车间A": [RUNNING_JOB], "车间B": []}
    return TestClient(build_app(store, poller)), store, poller


def _wait_phase(client, task_id: str, phases: set[str], timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        d = client.get(f"/api/uploads/{task_id}").json()
        if d.get("phase") in phases:
            return d
        time.sleep(0.05)
    raise AssertionError(f"task {task_id} 未进入 {phases}: {d}")


def test_pause_endpoint_proxies_engines() -> None:
    calls: list[str] = []

    async def fake_pause(self):
        calls.append(f"pause:{self.name}")
        return {"ok": True, "paused": True, "changed": True}

    async def fake_resume(self):
        calls.append(f"resume:{self.name}")
        return {"ok": True, "paused": False, "changed": True}

    orig_p, orig_r = JavScribeEngine.pause_queue, JavScribeEngine.resume_queue
    JavScribeEngine.pause_queue = fake_pause  # type: ignore[method-assign]
    JavScribeEngine.resume_queue = fake_resume  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, _ = _make_client(td)
            with client:
                r = client.post("/api/pause", json={"paused": True})
                assert r.status_code == 200, r.text
                b = r.json()
                assert b["ok"] and b["paused"] is True
                by_engine = {e["engine"]: e for e in b["engines"]}
                assert by_engine["车间A"]["ok"] is True
                assert by_engine["车间B"]["ok"] is False and "离线" in by_engine["车间B"]["error"]
                assert calls == ["pause:车间A"], calls  # 离线服务不代理
                s = client.get("/api/jobs/summary").json()
                assert s["paused_all"] is True
                assert s["engines_paused"] == {"车间A": False, "车间B": False}
                # 幂等 + 恢复
                r = client.post("/api/pause", json={"paused": False})
                assert r.json()["paused"] is False
                assert calls[-1] == "resume:车间A"
                assert client.get("/api/jobs/summary").json()["paused_all"] is False
    finally:
        JavScribeEngine.pause_queue, JavScribeEngine.resume_queue = orig_p, orig_r
    print("  test_pause_endpoint_proxies_engines OK")


def test_pause_endpoint_old_serve_404() -> None:
    async def fake_pause_404(self):
        req = httpx.Request("POST", f"{self.url}/jobs/pause")
        raise httpx.HTTPStatusError(
            "not found", request=req, response=httpx.Response(404, request=req))

    orig_p = JavScribeEngine.pause_queue
    JavScribeEngine.pause_queue = fake_pause_404  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, _ = _make_client(td)
            with client:
                r = client.post("/api/pause", json={"paused": True})
                assert r.status_code == 200
                b = r.json()
                assert b["paused"] is True  # 本机仍暂停
                e = next(x for x in b["engines"] if x["engine"] == "车间A")
                assert e["ok"] is False and "版本过旧" in e["error"]
                client.post("/api/pause", json={"paused": False})
    finally:
        JavScribeEngine.pause_queue = orig_p
    print("  test_pause_endpoint_old_serve_404 OK")


def test_local_task_paused_row_and_resume() -> None:
    """暂停中提交的本地任务：行=已暂停；恢复后继续提取。"""
    async def fake_pause(self):
        return {"ok": True, "paused": True, "changed": True}

    orig_p, orig_r = JavScribeEngine.pause_queue, JavScribeEngine.resume_queue
    JavScribeEngine.pause_queue = fake_pause  # type: ignore[method-assign]
    JavScribeEngine.resume_queue = fake_resume = fake_pause  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            video = Path(td) / "FAKE-001.mp4"
            video.write_bytes(b"fake")
            client, _, _ = _make_client(td)
            with client:
                assert client.post("/api/pause", json={"paused": True}).status_code == 200
                r = client.post("/api/scan/local/submit",
                                json={"engine": "车间A", "files": [str(video)]})
                assert r.status_code == 200, r.text
                tid = r.json()["upload_ids"][0]
                d = _wait_phase(client, tid, {"paused"})
                assert d["phase"] == "paused"
                # 任务行：已暂停
                rows = client.get("/api/jobs").json()
                row = next(x for x in rows if x.get("job_id") in ("", None) and x["file"] == "FAKE-001.mp4")
                assert row["status"] == "paused" and "已暂停" in row["phase_detail"], row
                # 统计：paused 计数 + 全局标志
                s = client.get("/api/jobs/summary").json()
                assert s["paused"] == 1 and s["paused_all"] is True, s
                # 恢复：任务继续走管线（假视频 → 提取失败 error，证明闸已放行）
                client.post("/api/pause", json={"paused": False})
                d = _wait_phase(client, tid, {"error"})
                assert "提取音频失败" in (d["error"] or ""), d
    finally:
        JavScribeEngine.pause_queue, JavScribeEngine.resume_queue = orig_p, orig_r
    print("  test_local_task_paused_row_and_resume OK")


def test_rerun_local_paused_task() -> None:
    """paused 任务「继续」= 重提取重提交；进行中 409；不存在 404。"""
    extract_evt = asyncio.Event()

    async def fake_pause(self):
        return {"ok": True, "paused": True, "changed": True}

    async def blocking_extract(video, out, on_progress=None):
        await extract_evt.wait()
        return 1024.0

    orig_p, orig_r = JavScribeEngine.pause_queue, JavScribeEngine.resume_queue
    orig_extract = api_mod.extract_audio_retrying
    JavScribeEngine.pause_queue = fake_pause  # type: ignore[method-assign]
    JavScribeEngine.resume_queue = fake_pause  # type: ignore[method-assign]
    api_mod.extract_audio_retrying = blocking_extract  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            video = Path(td) / "FAKE-002.mp4"
            video.write_bytes(b"fake")
            client, _, _ = _make_client(td)
            with client:
                client.post("/api/pause", json={"paused": True})
                r = client.post("/api/scan/local/submit",
                                json={"engine": "车间A", "files": [str(video)]})
                tid = r.json()["upload_ids"][0]
                _wait_phase(client, tid, {"paused"})
                # 404：不存在
                assert client.post("/api/local/nope/rerun").status_code == 404
                # 继续（暂停中 rerun：重置后仍停在暂停闸 → 再次 paused）
                r = client.post(f"/api/local/{tid}/rerun")
                assert r.status_code == 200 and r.json()["ok"], r.text
                _wait_phase(client, tid, {"paused"})
                # 恢复管线 → 提取中（blocking）→ 进行中 rerun 409
                client.post("/api/pause", json={"paused": False})
                _wait_phase(client, tid, {"extracting"})
                assert client.post(f"/api/local/{tid}/rerun").status_code == 409
                extract_evt.set()  # 放行提取；派发会因假服务失败 → error
                _wait_phase(client, tid, {"error"}, timeout=20)
    finally:
        JavScribeEngine.pause_queue, JavScribeEngine.resume_queue = orig_p, orig_r
        api_mod.extract_audio_retrying = orig_extract
    print("  test_rerun_local_paused_task OK")


def test_job_pause_resume_proxies() -> None:
    async def fake_pause_job(self, job_id):
        return {"ok": True, "job_id": job_id, "status": "paused"}

    async def fake_resume_job(self, job_id):
        return {"ok": True, "job_id": job_id, "status": "resumed"}

    async def fake_pause_409(self, job_id):
        req = httpx.Request("POST", f"{self.url}/jobs/{job_id}/pause")
        raise httpx.HTTPStatusError(
            "conflict", request=req,
            response=httpx.Response(
                409, request=req,
                json={"ok": False, "error": "任务运行中（仅排队任务可挂起，运行中请用取消）"}))

    orig_pj, orig_rj = JavScribeEngine.pause_job, JavScribeEngine.resume_job
    JavScribeEngine.pause_job = fake_pause_job  # type: ignore[method-assign]
    JavScribeEngine.resume_job = fake_resume_job  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, _ = _make_client(td)
            r = client.post("/api/jobs/车间A/j-run/pause")
            assert r.status_code == 200 and r.json()["status"] == "paused", r.text
            r = client.post("/api/jobs/车间A/j-run/resume")
            assert r.status_code == 200 and r.json()["status"] == "resumed", r.text
            # 409：透传服务侧错误文案
            JavScribeEngine.pause_job = fake_pause_409  # type: ignore[method-assign]
            r = client.post("/api/jobs/车间A/j-run/pause")
            assert r.status_code == 409 and "运行中" in r.json()["detail"], r.text
            # 404：服务不存在
            r = client.post("/api/jobs/不存在/j-x/pause")
            assert r.status_code == 404
    finally:
        JavScribeEngine.pause_job, JavScribeEngine.resume_job = orig_pj, orig_rj
    print("  test_job_pause_resume_proxies OK")


def main() -> None:
    test_pause_endpoint_proxies_engines()
    test_pause_endpoint_old_serve_404()
    test_local_task_paused_row_and_resume()
    test_rerun_local_paused_task()
    test_job_pause_resume_proxies()
    print("test_pause_api: all OK")


if __name__ == "__main__":
    main()
