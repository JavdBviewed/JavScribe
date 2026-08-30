"""Control room API with a canned poller snapshot (no network)."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient  # noqa: E402

from jav_scribe_web.api import build_app  # noqa: E402
from jav_scribe_web.config import EngineStore  # noqa: E402
from jav_scribe_web.engines.base import EngineInfo  # noqa: E402
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


def make_client():
    with tempfile.TemporaryDirectory() as td:
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
    assert r.status_code == 200 and "中控室" in r.text


if __name__ == "__main__":
    test_health_and_engines()
    test_jobs_aggregated_and_sorted()
    test_engine_crud()
    test_static_index()
    print("  test_api OK")
