"""Control room API with a canned poller snapshot (no network)."""
from __future__ import annotations

import asyncio
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient  # noqa: E402

import httpx  # noqa: E402

from jav_scribe_web.api import build_app  # noqa: E402
from jav_scribe_web.config import EngineStore  # noqa: E402
from jav_scribe_web.engines import javscribe as _jsm  # noqa: E402
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
DONE_JOB = {
    "id": "j-done", "created": 900.0, "finished": 990.0, "source_kind": "watch",
    "label": "PJAM-001.mp4", "total": 1, "done": 1, "skipped": 0, "failed": 0,
    "state": "finished",
    "files": [
        {"path": "x", "name": "PJAM-001.opus", "status": "done", "phase": "done",
         "progress": 1.0, "message": "完成", "duration_s": 60.0, "position_s": 60.0,
         "position": "1:00", "output_files": ["/m/PJAM-001.zh.srt"],
         "started": 910.0, "finished": 990.0},
    ],
}


def _make_store_and_poller(td: str):
    store = EngineStore(td)
    store.add("车间A", "http://10.0.0.1:8300")
    store.add("车间B", "http://10.0.0.2:8300")
    poller = Poller(store)
    poller.engines = {
        "车间A": EngineInfo("车间A", "http://10.0.0.1:8300", online=True, device="cuda",
                            version="0.1.0", jobs_running=1),
        "车间B": EngineInfo("车间B", "http://10.0.0.2:8300", online=False, error="boom"),
    }
    poller.jobs = {"车间A": [RUNNING_JOB, DONE_JOB], "车间B": []}
    return store, poller


def make_client():
    with tempfile.TemporaryDirectory() as td:
        store, poller = _make_store_and_poller(td)
        client = TestClient(build_app(store, poller))
        return client, store


def test_health_and_engines() -> None:
    client, _ = make_client()
    h = client.get("/api/health").json()
    assert h["ok"] and h["engines"] == 2 and h["online"] == 1
    names = [e["name"] for e in client.get("/api/engines").json()]
    assert names == ["车间A", "车间B"]
    b = next(e for e in client.get("/api/engines").json() if e["name"] == "车间B")
    assert not b["online"] and b["error"] == "boom"


def test_jobs_aggregated_and_sorted() -> None:
    client, _ = make_client()
    rows = client.get("/api/jobs").json()
    assert [r["job_id"] for r in rows] == ["j-run", "j-done"]  # running first
    run = rows[0]
    assert run["file"] == "PJAM-045.opus" and run["progress"] == 0.36
    assert run["position"] == "37:04" and run["duration_s"] == 6180.0
    assert run["engine"] == "车间A" and run["label"] == "PJAM-045.mp4"


def test_engine_crud() -> None:
    client, store = make_client()
    r = client.post("/api/engines", json={"name": "车间C", "url": "http://10.0.0.3:8300"})
    assert r.status_code == 201
    # same name + different url rejected
    assert client.post("/api/engines", json={"name": "车间C", "url": "http://1.1.1.1:1"}).status_code == 400
    # invalid url rejected
    assert client.post("/api/engines", json={"name": "bad", "url": "nope"}).status_code == 400
    # idempotent update
    assert client.post("/api/engines", json={"name": "车间C", "url": "http://10.0.0.3:8300"}).status_code == 201
    assert client.delete("/api/engines/车间C").status_code == 200
    assert client.delete("/api/engines/车间C").status_code == 404
    assert client.get("/api/engines").json() and store.get("车间C") is None


def test_static_index() -> None:
    client, _ = make_client()
    r = client.get("/")
    assert r.status_code == 200 and "字幕工作台" in r.text


def _wait_upload(client, upload_id: str, timeout: float = 30.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        d = client.get(f"/api/uploads/{upload_id}").json()
        if d["phase"] in ("done", "error"):
            return d
        time.sleep(0.1)
    raise AssertionError(f"upload {upload_id} stuck in phase {d['phase']}")


def test_upload_pipeline_dispatches_opus() -> None:
    """2s tone: upload -> extract (progress) -> fake workshop gets an ogg opus."""
    captured: dict = {}

    async def fake_upload_audio(self, audio_bytes: bytes, name: str) -> str:
        captured["bytes"] = audio_bytes
        captured["name"] = name
        return "job-fake-1"

    JavScribeEngine.upload_audio = fake_upload_audio  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            store, poller = _make_store_and_poller(td)
            client = TestClient(build_app(store, poller))
            src = Path(td) / "tone2.wav"
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                 "-ar", "48000", str(src)],
                check=True,
            )
            with client:  # single event loop so the background task survives
                with open(src, "rb") as fh:
                    r = client.post(
                        "/api/upload",
                        files={"file": ("tone2.wav", fh, "audio/wav")},
                        data={"engine": "车间A"},
                    )
                assert r.status_code == 202, r.text
                body = r.json()
                upload_id = body["upload_id"]
                assert body["engine"] == "车间A" and body["size_mb"] > 0
                assert 1.8 < body["duration_s"] < 2.2
                d = _wait_upload(client, upload_id)
                assert d["phase"] == "done", d
                assert d["job_id"] == "job-fake-1"
                assert d["progress"] == 1.0 and d["audio_mb"] is not None
        assert captured["name"] == "tone2.wav"
        assert captured["bytes"][:4] == b"OggS", "must be ogg/opus"
        assert len(captured["bytes"]) > 1000
    finally:
        del JavScribeEngine.upload_audio  # restore real method


def test_upload_error_no_audio() -> None:
    """Video-only file -> extraction fails -> phase error with message."""
    with tempfile.TemporaryDirectory() as td:
        store, poller = _make_store_and_poller(td)
        client = TestClient(build_app(store, poller))
        src = Path(td) / "noaudio.mp4"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
             "-c:v", "libx264", "-preset", "ultrafast", str(src)],
            check=True,
        )
        with client:  # single event loop so the background task survives
            with open(src, "rb") as fh:
                r = client.post(
                    "/api/upload",
                    files={"file": ("noaudio.mp4", fh, "video/mp4")},
                    data={"engine": "车间A"},
                )
            assert r.status_code == 202, r.text
            d = _wait_upload(client, r.json()["upload_id"])
            assert d["phase"] == "error", d
            assert d["error"] and "提取音频失败" in d["error"]
        # unknown upload id -> 404
        assert client.get("/api/uploads/nope").status_code == 404


def test_result_proxy_sanitizes_negative_srt() -> None:
    """下载代理：车间回传负时间戳 srt -> 代理出口必须已清洗。"""
    NEG = (
        "1\n-1:45:55,320 --> 00:00:23,880\n甲\n\n"
        "2\n00:00:09,300 --> 00:00:15,660\n乙\n\n"
    )

    async def fake_result(self, job_id: str):
        return NEG.encode("utf-8"), "PJAM-045.mp4.zh.srt"

    JavScribeEngine.result = fake_result  # type: ignore[method-assign]
    try:
        client, _ = make_client()
        r = client.get("/api/jobs/车间A/j-done/result")
        assert r.status_code == 200, r.text
        body = r.content.decode("utf-8")
        assert "-1:45:55" not in body, body
        # 负值 clamp 后与 9.3s 细 cue 重叠 → end 截断，输出零重叠
        assert "1\n00:00:00,000 --> 00:00:09,300" in body, body
        assert "2\n00:00:09,300 --> 00:00:15,660" in body, body
        assert "23,880" not in body, body
        assert 'filename="PJAM-001.zh.srt"' in r.headers.get("content-disposition", "")
        print("  test_result_proxy_sanitizes_negative_srt OK")
    finally:
        del JavScribeEngine.result  # restore real method



def test_retry_proxy() -> None:
    """跳过任务「仍要重新生成」：代理车间 POST /jobs/<id>/retry。"""
    import httpx

    calls: list[str] = []

    async def fake_retry(self, job_id: str) -> dict:
        calls.append(job_id)
        if job_id == "j-409":
            raise httpx.HTTPStatusError("conflict", request=httpx.Request("POST", "http://x"),
                                        response=httpx.Response(409, request=httpx.Request("POST", "http://x")))
        return {"ok": True, "job_id": "j-new-1"}

    JavScribeEngine.retry = fake_retry  # type: ignore[method-assign]
    try:
        client, _ = make_client()
        r = client.post("/api/jobs/车间A/j-done/retry")
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True, "job_id": "j-new-1"}
        assert calls == ["j-done"]
        # 车间 409（无跳过的文件）-> 409 中文提示
        r = client.post("/api/jobs/车间A/j-409/retry")
        assert r.status_code == 409 and "重新生成" in r.json()["detail"], r.text
        # 未知车间 -> 404
        assert client.post("/api/jobs/不存在/j-x/retry").status_code == 404
        print("  test_retry_proxy OK")
    finally:
        del JavScribeEngine.retry  # restore real method



if __name__ == "__main__":
    test_health_and_engines()
    test_jobs_aggregated_and_sorted()
    test_engine_crud()
    test_static_index()
    test_upload_pipeline_dispatches_opus()
    test_upload_error_no_audio()
    test_result_proxy_sanitizes_negative_srt()
    test_retry_proxy()
    print("  test_api OK")


# ---------- engine api_key + /config proxy ----------

def _status_err(code: int, msg: str) -> httpx.HTTPStatusError:
    req = httpx.Request("GET", "http://10.0.0.3:8300/config")
    resp = httpx.Response(code, json={"ok": False, "error": msg}, request=req)
    return httpx.HTTPStatusError(f"HTTP {code}", request=req, response=resp)


def test_engine_api_key_registration() -> None:
    with tempfile.TemporaryDirectory() as td:
        store = EngineStore(td)
        poller = Poller(store)
        client = TestClient(build_app(store, poller))
        r = client.post(
            "/api/engines",
            json={"name": "srv", "url": "http://10.0.0.3:8300", "api_key": "k9"},
        )
        assert r.status_code == 201 and r.json()["has_key"] is True
        assert store.get("srv")["api_key"] == "k9"
        # 列表回 has_key（模拟一次 poller tick 之后）
        poller.engines["srv"] = EngineInfo(
            "srv", "http://10.0.0.3:8300", online=True, has_key=True
        )
        listed = next(e for e in client.get("/api/engines").json() if e["name"] == "srv")
        assert listed["has_key"] is True
        assert "api_key" not in listed  # 列表不回显 key 明文
        assert client.put("/api/engines/srv", json={"api_key": "k10"}).status_code == 200
        assert store.get("srv")["api_key"] == "k10"
        assert client.put("/api/engines/nope", json={"api_key": "x"}).status_code == 404


def test_config_proxy_ok_and_key_passthrough() -> None:
    client, store = make_client()
    store.add("srv", "http://10.0.0.3:8300")
    store.set_api_key("srv", "k1")
    captured: dict = {}
    orig_get, orig_put = _jsm.JavScribeEngine.config, _jsm.JavScribeEngine.config_update

    async def fake_config(self):
        captured["key"] = self.api_key
        return {
            "ok": True, "profile": "server",
            "items": [{"path": "subtitle.lang_tag", "label": "字幕语言标签", "type": "string", "value": "zh"}],
        }

    async def fake_put(self, values):
        captured["values"] = values
        return {"ok": True, "updated": list(values)}

    _jsm.JavScribeEngine.config, _jsm.JavScribeEngine.config_update = fake_config, fake_put
    try:
        r = client.get("/api/engines/srv/config")
        assert r.status_code == 200
        assert r.json()["items"][0]["path"] == "subtitle.lang_tag"
        assert captured["key"] == "k1", "api_key 未从登记表透传给适配器"
        r = client.put("/api/engines/srv/config", json={"values": {"subtitle.lang_tag": "ja"}})
        assert r.status_code == 200 and r.json()["updated"] == ["subtitle.lang_tag"]
        assert captured["values"] == {"subtitle.lang_tag": "ja"}
        # 缺 values / 未知服务
        assert client.put("/api/engines/srv/config", json={}).status_code == 400
        assert client.put("/api/engines/srv/config", json={"values": {}}).status_code == 400
        assert client.get("/api/engines/nope/config").status_code == 404
    finally:
        _jsm.JavScribeEngine.config, _jsm.JavScribeEngine.config_update = orig_get, orig_put


def test_config_proxy_error_mapping() -> None:
    client, store = make_client()
    store.add("srv", "http://10.0.0.3:8300")
    store.set_api_key("srv", "k1")
    orig = _jsm.JavScribeEngine.config

    def _raise(err):
        async def fake(self):
            raise err
        return fake

    cases = [
        (_status_err(401, "API Key 不正确"), 400, "API Key"),
        (_status_err(403, "服务未设置 API Key（JAVSCRIBE_API_KEY）"), 400, "尚未设置"),
        (_status_err(404, "not found"), 400, "版本过旧"),
        (_status_err(400, "不支持的配置项: nope"), 400, "不支持的配置项"),
    ]
    try:
        for err, want_code, want_frag in cases:
            _jsm.JavScribeEngine.config = _raise(err)
            r = client.get("/api/engines/srv/config")
            assert r.status_code == want_code, (want_code, r.status_code, r.text)
            assert want_frag in r.json()["detail"], (want_frag, r.text)
        # 连接失败 -> 502 服务不可达
        async def fake_unreachable(self):
            raise httpx.ConnectError("boom")
        _jsm.JavScribeEngine.config = fake_unreachable
        r = client.get("/api/engines/srv/config")
        assert r.status_code == 502 and "不可达" in r.json()["detail"], r.text
    finally:
        _jsm.JavScribeEngine.config = orig

def test_scan_proxy_ok_and_key_passthrough() -> None:
    client, store = make_client()
    store.add("srv", "http://10.0.0.3:8300")
    store.set_api_key("srv", "k1")
    captured: dict = {}
    orig_scan, orig_submit = _jsm.JavScribeEngine.scan, _jsm.JavScribeEngine.scan_submit

    async def fake_scan(self, path):
        captured["key"] = self.api_key
        captured["path"] = path
        return {"ok": True, "path": path, "items": [
            {"path": "/m/a.mp4", "name": "a.mp4", "size": 10, "has_subtitle": False, "subtitle": None},
        ], "truncated": False}

    async def fake_submit(self, files):
        captured["files"] = files
        return {"ok": True, "job_id": "j1", "files": len(files)}

    _jsm.JavScribeEngine.scan, _jsm.JavScribeEngine.scan_submit = fake_scan, fake_submit
    try:
        r = client.get("/api/engines/srv/scan", params={"path": "/m"})
        assert r.status_code == 200, r.text
        assert r.json()["items"][0]["name"] == "a.mp4"
        assert captured["key"] == "k1" and captured["path"] == "/m"
        r = client.post("/api/engines/srv/scan/submit", json={"files": ["/m/a.mp4"]})
        assert r.status_code == 200 and r.json()["job_id"] == "j1", r.text
        assert captured["files"] == ["/m/a.mp4"]
        # 空 files / 未知服务
        assert client.post("/api/engines/srv/scan/submit", json={}).status_code == 400
        assert client.post("/api/engines/srv/scan/submit", json={"files": []}).status_code == 400
        assert client.get("/api/engines/nope/scan", params={"path": "/m"}).status_code == 404
    finally:
        _jsm.JavScribeEngine.scan, _jsm.JavScribeEngine.scan_submit = orig_scan, orig_submit


def test_scan_proxy_error_mapping() -> None:
    client, store = make_client()
    store.add("srv", "http://10.0.0.3:8300")
    store.set_api_key("srv", "k1")
    orig_scan = _jsm.JavScribeEngine.scan

    def _raise(err):
        async def fake(self, path):
            raise err
        return fake

    cases = [
        (_status_err(401, "API Key 不正确"), 400, "API Key"),
        (_status_err(403, "服务未设置 API Key（JAVSCRIBE_API_KEY）"), 400, "尚未设置"),
        (_status_err(404, "not found"), 400, "版本过旧"),
        (_status_err(400, "需要绝对路径"), 400, "需要绝对路径"),
    ]
    try:
        for err, want_code, want_frag in cases:
            _jsm.JavScribeEngine.scan = _raise(err)
            r = client.get("/api/engines/srv/scan", params={"path": "/m"})
            assert r.status_code == want_code, (want_code, r.status_code, r.text)
            assert want_frag in r.json()["detail"], (want_frag, r.text)
        # 连接失败 -> 502 服务不可达
        async def fake_unreachable(self, path):
            raise httpx.ConnectError("boom")
        _jsm.JavScribeEngine.scan = fake_unreachable
        r = client.get("/api/engines/srv/scan", params={"path": "/m"})
        assert r.status_code == 502 and "不可达" in r.json()["detail"], r.text
    finally:
        _jsm.JavScribeEngine.scan = orig_scan
