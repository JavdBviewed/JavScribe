"""Web 侧主任务（batch）API 测试：fan-out / 本地冻结闸 / 取消 / 记录生命周期 / 行字段。
引擎方法 monkeypatch，无真实网络（与 test_pause_api 同构）。"""
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


def _make_client(td: str):
    store = EngineStore(td)
    store.add("车间A", "http://127.0.0.1:18301")
    store.add("车间B", "http://10.0.0.2:8300")
    poller = Poller(store)
    poller.engines = {
        "车间A": EngineInfo("车间A", "http://127.0.0.1:18301", online=True, device="cuda",
                            version="0.2.6", jobs_running=1),
        "车间B": EngineInfo("车间B", "http://10.0.0.2:8300", online=False, error="boom"),
    }
    poller.jobs = {"车间A": [], "车间B": []}
    return TestClient(build_app(store, poller)), store, poller


def _wait_phase(client, task_id: str, phases: set[str], timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        d = client.get(f"/api/uploads/{task_id}").json()
        if d.get("phase") in phases:
            return d
        time.sleep(0.05)
    raise AssertionError(f"task {task_id} 未进入 {phases}: {d}")


def _fake_batch_ops(calls: list):
    async def _bp(self, batch_id):
        calls.append(("pause", self.name, batch_id))
        return {"ok": True, "batch_id": batch_id}

    async def _br(self, batch_id):
        calls.append(("resume", self.name, batch_id))
        return {"ok": True, "batch_id": batch_id}

    async def _bc(self, batch_id):
        calls.append(("cancel", self.name, batch_id))
        return {"ok": True, "batch_id": batch_id, "canceled_jobs": 0, "canceled_files": 0}

    return _bp, _br, _bc


def test_batch_op_fanout_engines() -> None:
    """pause/resume/cancel：在线引擎代理、离线引擎标注；本地计数正确；恒 200。"""
    calls: list = []
    bp, br, bc = _fake_batch_ops(calls)
    orig = (JavScribeEngine.batch_pause, JavScribeEngine.batch_resume,
            JavScribeEngine.batch_cancel)
    JavScribeEngine.batch_pause, JavScribeEngine.batch_resume, JavScribeEngine.batch_cancel = bp, br, bc  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, _ = _make_client(td)
            with client:
                r = client.post("/api/batch/b-op1/pause")
                assert r.status_code == 200, r.text
                b = r.json()
                assert b["ok"] is True and b["batch_id"] == "b-op1" and b["action"] == "pause"
                assert b["local"] == {"frozen": True}
                by = {e["engine"]: e for e in b["engines"]}
                assert by["车间A"]["ok"] is True
                assert by["车间B"]["ok"] is False and "离线" in by["车间B"]["error"]
                r = client.post("/api/batch/b-op1/resume")
                b = r.json()
                assert b["action"] == "resume" and b["local"] == {"released": True}
                by2 = {e["engine"]: e for e in b["engines"]}
                assert by2["车间A"]["ok"] is True
                r = client.post("/api/batch/b-op1/cancel")
                b = r.json()
                assert b["action"] == "cancel" and b["local"]["canceled"] == 0
                # 仅在线引擎被代理（离线不代理）
                assert sorted(c for c in calls if c[0] == "pause") == [("pause", "车间A", "b-op1")], calls
                assert ("resume", "车间A", "b-op1") in calls and ("cancel", "车间A", "b-op1") in calls
    finally:
        (JavScribeEngine.batch_pause, JavScribeEngine.batch_resume,
         JavScribeEngine.batch_cancel) = orig
    print("  test_batch_op_fanout_engines OK")


def test_batch_op_old_serve_404() -> None:
    """旧镜像无 batch 端点 → 404：该引擎标 unsupported，整体仍 ok（不崩不 500）。"""
    async def _bp404(self, batch_id):
        req = httpx.Request("POST", f"{self.url}/jobs/batch/{batch_id}/pause")
        raise httpx.HTTPStatusError(
            "not found", request=req, response=httpx.Response(404, request=req))

    orig_bp, orig_br = JavScribeEngine.batch_pause, JavScribeEngine.batch_resume
    calls: list = []
    _, br, _ = _fake_batch_ops(calls)
    JavScribeEngine.batch_pause = _bp404  # type: ignore[assignment]
    JavScribeEngine.batch_resume = br  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, _ = _make_client(td)
            with client:
                r = client.post("/api/batch/b-404/pause")
                assert r.status_code == 200, r.text
                b = r.json()
                assert b["ok"] is True  # 整体不因单引擎 404 失败
                e = next(x for x in b["engines"] if x["engine"] == "车间A")
                assert e["ok"] is False and e.get("unsupported") is True
                assert "版本过旧" in e["error"]
                # 本地冻结标记仍生效（本机不受服务影响）
                assert b["local"] == {"frozen": True}
                client.post("/api/batch/b-404/resume")
    finally:
        JavScribeEngine.batch_pause, JavScribeEngine.batch_resume = orig_bp, orig_br
    print("  test_batch_op_old_serve_404 OK")


def _submit_local_batch(client, td: str, bid: str, n: int, label: str = "测试夹") -> list[str]:
    files = []
    for i in range(n):
        v = Path(td) / f"FAKE-{bid}-{i}.mp4"
        v.write_bytes(b"fake")
        files.append(str(v))
    r = client.post("/api/scan/local/submit",
                    json={"engine": "车间A", "files": files,
                          "batch_id": bid, "batch_label": label})
    assert r.status_code == 200, r.text
    return r.json()["upload_ids"]


def test_batch_local_freeze_gate() -> None:
    """先暂停后提交：任务停在本机冻结闸（queued，不进提取）；继续后放行。"""
    extract_evt = asyncio.Event()

    async def blocking_extract(video, out, on_progress=None):
        await extract_evt.wait()
        return 1024.0

    calls: list = []
    bp, br, bc = _fake_batch_ops(calls)
    orig_extract = api_mod.extract_audio_retrying
    orig = (JavScribeEngine.batch_pause, JavScribeEngine.batch_resume,
            JavScribeEngine.batch_cancel)
    api_mod.extract_audio_retrying = blocking_extract  # type: ignore[assignment]
    JavScribeEngine.batch_pause, JavScribeEngine.batch_resume, JavScribeEngine.batch_cancel = bp, br, bc  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, _ = _make_client(td)
            with client:
                assert client.post("/api/batch/b-f1/pause").status_code == 200
                tids = _submit_local_batch(client, td, "b-f1", 2)
                _wait_phase(client, tids[0], {"queued"})
                _wait_phase(client, tids[1], {"queued"})
                time.sleep(0.5)  # 若闸失效应立即进入 extracting（限流 2 并发不排队）
                for tid in tids:
                    d = client.get(f"/api/uploads/{tid}").json()
                    assert d["phase"] == "queued", d  # 冻结中：停闸前
                # 行字段：batch 三字段 + batch_paused=True
                rows = [x for x in client.get("/api/jobs").json() if x.get("task_id") in tids]
                assert len(rows) == 2, rows
                for row in rows:
                    assert row["batch_id"] == "b-f1" and row["batch_label"] == "测试夹"
                    assert row["batch_paused"] is True, row
                # 继续 → 放行进入提取
                b = client.post("/api/batch/b-f1/resume").json()
                assert b["local"] == {"released": True}
                for tid in tids:
                    _wait_phase(client, tid, {"extracting"})
                extract_evt.set()  # 放行提取 → 假服务不可达 → error（证明管线走通）
                for tid in tids:
                    _wait_phase(client, tid, {"error"}, timeout=20)
                assert ("pause", "车间A", "b-f1") in calls and ("resume", "车间A", "b-f1") in calls
    finally:
        api_mod.extract_audio_retrying = orig_extract
        (JavScribeEngine.batch_pause, JavScribeEngine.batch_resume,
         JavScribeEngine.batch_cancel) = orig
    print("  test_batch_local_freeze_gate OK")


def test_batch_local_cancel() -> None:
    """取消主任务：queued 无 job 任务终态（文案区分）+ 清冻结标记；再提交同批可走通。"""
    extract_evt = asyncio.Event()

    async def blocking_extract(video, out, on_progress=None):
        await extract_evt.wait()
        return 1024.0

    calls: list = []
    bp, br, bc = _fake_batch_ops(calls)
    orig_extract = api_mod.extract_audio_retrying
    orig = (JavScribeEngine.batch_pause, JavScribeEngine.batch_resume,
            JavScribeEngine.batch_cancel)
    api_mod.extract_audio_retrying = blocking_extract  # type: ignore[assignment]
    JavScribeEngine.batch_pause, JavScribeEngine.batch_resume, JavScribeEngine.batch_cancel = bp, br, bc  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, _ = _make_client(td)
            with client:
                assert client.post("/api/batch/b-c1/pause").status_code == 200
                tids = _submit_local_batch(client, td, "b-c1", 2)
                _wait_phase(client, tids[0], {"queued"})
                _wait_phase(client, tids[1], {"queued"})
                b = client.post("/api/batch/b-c1/cancel").json()
                assert b["ok"] is True and b["action"] == "cancel"
                assert b["local"]["canceled"] == 2, b
                for tid in tids:
                    d = _wait_phase(client, tid, {"error"})
                    assert d["error"] == "主任务已取消（未开始）", d
                    assert d["finished"] is not None
                # 冻结标记已清：同 batch 新任务直接放行（→extracting）
                tids2 = _submit_local_batch(client, td, "b-c1", 1)
                # 未被冻结：穿过闸直接进提取（queued 是瞬态，直接等 extracting）
                _wait_phase(client, tids2[0], {"extracting"})
                rows = [x for x in client.get("/api/jobs").json()
                        if x.get("task_id") in (tids + tids2)]
                assert all(x.get("batch_paused") is not True for x in rows), rows
                extract_evt.set()
                _wait_phase(client, tids2[0], {"error"}, timeout=20)
    finally:
        api_mod.extract_audio_retrying = orig_extract
        (JavScribeEngine.batch_pause, JavScribeEngine.batch_resume,
         JavScribeEngine.batch_cancel) = orig
    print("  test_batch_local_cancel OK")


def test_batches_record_lifecycle() -> None:
    """batches.json 记录：提交建记录 → 派发登记 services → 对账置 finished。"""
    uploads: list = []

    async def fake_upload(self, audio, source_name, batch_id=None, batch_label=None):
        uploads.append((self.name, source_name, batch_id, batch_label))
        return {"job_id": f"j{len(uploads)}", "cached": False}

    async def fast_extract(video, out, on_progress=None):
        return 1024.0

    orig_upload = JavScribeEngine.upload_audio
    orig_extract = api_mod.extract_audio_retrying
    JavScribeEngine.upload_audio = fake_upload  # type: ignore[assignment]
    api_mod.extract_audio_retrying = fast_extract  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, poller = _make_client(td)
            with client:
                tids = _submit_local_batch(client, td, "b-l1", 2, label="生命周期")
                for tid in tids:
                    _wait_phase(client, tid, {"done"})
                # 提交即建记录；派发成功后登记 services（AUTO 已解析=车间A）
                b = client.get("/api/batches").json()
                assert len(b) == 1, b
                rec = b[0]
                assert rec["batch_id"] == "b-l1" and rec["label"] == "生命周期"
                assert rec["created"] and rec["finished"] is None
                assert rec["services"] == {"车间A": ["j1", "j2"]}, rec
                assert uploads[0][2:] == ("b-l1", "生命周期"), uploads  # 透传到服务
                # 服务侧任务全部 finished → tick 对账置 finished
                poller.jobs["车间A"] = [
                    {"id": "j1", "state": "finished", "files": [{"status": "skipped"}]},
                    {"id": "j2", "state": "finished", "files": [{"status": "skipped"}]},
                ]
                client.portal.call(poller._on_jobs)  # 手动触发回写 tick（内含 batch 对账）
                rec = client.get("/api/batches").json()[0]
                assert rec["finished"] is not None, rec
    finally:
        JavScribeEngine.upload_audio = orig_upload
        api_mod.extract_audio_retrying = orig_extract
    print("  test_batches_record_lifecycle OK")


def test_job_rows_batch_fields() -> None:
    """/api/jobs 行字段：serve 行 batch_id/label + batch_paused 来自引擎快照。"""
    batch_job = {
        "id": "j-b1", "created": 1000.0, "finished": None, "source_kind": "remote",
        "label": "夹A", "total": 1, "done": 0, "skipped": 0, "failed": 0,
        "state": "running", "batch_id": "b-xx", "batch_label": "夹A",
        "files": [
            {"path": "x", "name": "A.opus", "status": "running", "phase": "subtitling",
             "progress": 0.3, "message": "", "duration_s": 100.0, "position_s": 30.0,
             "position": "00:30", "output_files": [], "started": 1010.0, "finished": None},
        ],
    }
    plain_job = dict(batch_job, id="j-plain", label="普通.mp4",
                     batch_id=None, batch_label=None,
                     files=[dict(batch_job["files"][0], name="B.opus")])
    with tempfile.TemporaryDirectory() as td:
        client, _, poller = _make_client(td)
        poller.engines["车间A"].batch_paused = ["b-xx"]
        poller.jobs["车间A"] = [batch_job, plain_job]
        with client:
            rows = client.get("/api/jobs").json()
            rb = [x for x in rows if x["job_id"] == "j-b1"]
            rp = [x for x in rows if x["job_id"] == "j-plain"]
            assert rb and rp
            assert rb[0]["batch_id"] == "b-xx" and rb[0]["batch_label"] == "夹A"
            assert rb[0]["batch_paused"] is True
            assert rp[0]["batch_id"] is None and rp[0]["batch_paused"] is False
        # 引擎暂停集合移除后 → False
        poller.engines["车间A"].batch_paused = []
        with client:
            rb = [x for x in client.get("/api/jobs").json() if x["job_id"] == "j-b1"]
            assert rb[0]["batch_paused"] is False
    print("  test_job_rows_batch_fields OK")


def test_upload_audio_batch_field() -> None:
    """/api/upload-audio 收 batch 表单参 → 任务带 batch 字段 + 提交即建记录。"""
    async def fake_upload(self, audio, source_name, batch_id=None, batch_label=None):
        return {"job_id": "j-u1", "cached": False}

    orig_upload = JavScribeEngine.upload_audio
    JavScribeEngine.upload_audio = fake_upload  # type: ignore[assignment]
    try:
        with tempfile.TemporaryDirectory() as td:
            client, _, _ = _make_client(td)
            with client:
                r = client.post(
                    "/api/upload-audio",
                    data={"engine": "车间A", "name": "音频.mp3", "size_mb": "1.2",
                          "duration_s": "60", "batch_id": "b-u1", "batch_label": "夹U"},
                    files={"audio": ("a.opus", b"fake-opus-bytes", "audio/ogg")},
                )
                assert r.status_code == 202, r.text
                uid = r.json()["upload_id"]
                d = _wait_phase(client, uid, {"done", "error"})
                assert d["batch_id"] == "b-u1" and d["batch_label"] == "夹U", d
                b = client.get("/api/batches").json()
                assert any(x["batch_id"] == "b-u1" and x["label"] == "夹U" for x in b), b
    finally:
        JavScribeEngine.upload_audio = orig_upload
    print("  test_upload_audio_batch_field OK")
