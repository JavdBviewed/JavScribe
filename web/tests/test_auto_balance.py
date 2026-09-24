"""多服务自动负载均衡（engine=auto，v0.2.11+）：派发时刻按在途任务最少者选服务。"""
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient  # noqa: E402

from jav_scribe_web.api import build_app  # noqa: E402
from jav_scribe_web.config import EngineStore  # noqa: E402
from jav_scribe_web.engines.base import EngineInfo  # noqa: E402
from jav_scribe_web.engines.javscribe import JavScribeEngine  # noqa: E402
from jav_scribe_web.poller import Poller  # noqa: E402


def _make(td: str, loads: dict[str, int], online: dict[str, bool] | None = None):
    store = EngineStore(td)
    for name in loads:
        store.add(name, f"http://10.0.0.{list(loads).index(name) + 1}:8300")
    poller = Poller(store)
    poller.engines = {
        name: EngineInfo(
            name, f"http://10.0.0.{i + 1}:8300",
            online=bool((online or {}).get(name, True)),
            device="cuda", version="0.2.3", jobs_running=load,
        )
        for i, (name, load) in enumerate(loads.items())
    }
    poller.jobs = {n: [] for n in loads}
    return store, poller


def _fake(captured: list):
    async def fake_upload_audio(self, audio_bytes: bytes, name: str) -> dict:
        captured.append({"engine": self.name, "name": name})
        return {"job_id": f"job-{self.name}-{len(captured)}", "cached": False}
    return fake_upload_audio


def _auto_upload(client: TestClient, n: int = 1) -> list[dict]:
    """发 n 个 auto 音频上传，等全部派发完成，返回 captured。"""
    out = []
    for i in range(n):
        with client:
            r = client.post(
                "/api/upload-audio",
                files={"audio": (f"a{i}.opus", b"OggS" + b"\x00" * 32, "audio/ogg")},
                data={"engine": "auto", "name": f"a{i}.opus", "duration_s": "1"},
            )
        assert r.status_code == 202, r.text
        uid = r.json()["upload_id"]
        deadline = time.time() + 20
        while time.time() < deadline:
            d = client.get(f"/api/uploads/{uid}").json()
            if d["phase"] in ("done", "error"):
                assert d["phase"] == "done", d
                out.append(d)
                break
            time.sleep(0.05)
        else:
            raise AssertionError(f"upload {uid} stuck: {d}")
    return out


def test_auto_picks_least_loaded() -> None:
    """3 台在线：负载 5/1/7 → 选负载 1 的。"""
    captured: list = []
    JavScribeEngine.upload_audio = _fake(captured)  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            store, poller = _make(td, {"车间A": 5, "车间B": 1, "车间C": 7})
            client = TestClient(build_app(store, poller))
            tasks = _auto_upload(client)
            assert [t["engine"] for t in tasks] == ["车间B"]
            assert captured[0]["engine"] == "车间B"
    finally:
        del JavScribeEngine.upload_audio  # type: ignore[attr-defined]


def test_auto_round_robin_on_tie() -> None:
    """同负载 → 按名称轮转，两台交替。"""
    captured: list = []
    JavScribeEngine.upload_audio = _fake(captured)  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            store, poller = _make(td, {"车间A": 2, "车间B": 2})
            client = TestClient(build_app(store, poller))
            tasks = _auto_upload(client, n=2)
            assert [t["engine"] for t in tasks] == ["车间A", "车间B"]
    finally:
        del JavScribeEngine.upload_audio  # type: ignore[attr-defined]


def test_auto_excludes_offline_and_disabled() -> None:
    captured: list = []
    JavScribeEngine.upload_audio = _fake(captured)  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            store, poller = _make(td, {"车间A": 9, "车间B": 0})
            client = TestClient(build_app(store, poller))
            # 最闲的 B 被取消参与均衡 → 只能去 A
            r = client.put("/api/engines/车间B", json={"enabled": False})
            assert r.status_code == 200 and r.json()["enabled"] is False
            tasks = _auto_upload(client)
            assert [t["engine"] for t in tasks] == ["车间A"]
            # 持久化：engines.json 带 enabled 字段
            raw = json.loads((Path(td) / "engines.json").read_text(encoding="utf-8"))
            by = {e["name"]: e for e in raw["engines"]}
            assert by["车间B"]["enabled"] is False and by["车间A"].get("enabled", True) is True
            # 再关掉 A（或离线）→ 无候选 503
            client.put("/api/engines/车间A", json={"enabled": False})
            r = client.post(
                "/api/upload-audio",
                files={"audio": ("z.opus", b"OggS", "audio/ogg")},
                data={"engine": "auto", "name": "z.opus"},
            )
            assert r.status_code == 503
    finally:
        del JavScribeEngine.upload_audio  # type: ignore[attr-defined]


def test_auto_all_offline_is_503() -> None:
    with tempfile.TemporaryDirectory() as td:
        store, poller = _make(td, {"车间A": 0}, online={"车间A": False})
        client = TestClient(build_app(store, poller))
        r = client.post(
            "/api/upload-audio",
            files={"audio": ("z.opus", b"OggS", "audio/ogg")},
            data={"engine": "auto", "name": "z.opus"},
        )
        assert r.status_code == 503


def test_auto_no_engines_is_404() -> None:
    with tempfile.TemporaryDirectory() as td:
        store = EngineStore(td)
        poller = Poller(store)
        client = TestClient(build_app(store, poller))
        r = client.post(
            "/api/upload-audio",
            files={"audio": ("z.opus", b"OggS", "audio/ogg")},
            data={"engine": "auto", "name": "z.opus"},
        )
        assert r.status_code == 404


def test_scan_submit_auto_keeps_auto_until_dispatch() -> None:
    """本地扫描提交 engine=auto：任务行保留 auto，派发时刻才解析（此处直接断言
    任务创建成功且 engine=auto——解析逻辑由 upload-audio 用例覆盖）。"""
    captured: list = []
    JavScribeEngine.upload_audio = _fake(captured)  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            store, poller = _make(td, {"车间A": 3, "车间B": 1})
            client = TestClient(build_app(store, poller))
            media = Path(td) / "media"
            media.mkdir()
            vid = media / "AKDL-001.mp4"
            vid.write_bytes(b"\x00" * 64)
            r = client.post(
                "/api/scan/local/submit",
                json={"engine": "auto", "files": [str(vid)]},
            )
            assert r.status_code == 200, r.text
            assert r.json()["files"] == 1
            uids = r.json()["upload_ids"]
            d = client.get(f"/api/uploads/{uids[0]}").json()
            assert d["engine"] == "auto"
    finally:
        del JavScribeEngine.upload_audio  # type: ignore[attr-defined]


def test_engines_list_carries_enabled() -> None:
    with tempfile.TemporaryDirectory() as td:
        store, poller = _make(td, {"车间A": 0})
        client = TestClient(build_app(store, poller))
        e = client.get("/api/engines").json()[0]
        assert e["enabled"] is True
        client.put("/api/engines/车间A", json={"enabled": False})
        e = client.get("/api/engines").json()[0]
        assert e["enabled"] is False
