"""JavScribeEngine against the documented serve contract (httpx.MockTransport)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe_web.engines.javscribe import EngineUploadError, JavScribeEngine  # noqa: E402

BASE = "http://workshop:8300"

HEALTH = {"ok": True, "app": "JavScribe", "version": "0.1.0", "profile": "server", "device": "cuda", "jobs": []}
JOB_SUMMARY = {
    "id": "20260830-abc123", "created": 1756560000.0, "finished": None,
    "source_kind": "remote", "label": "PJAM-045.mp4", "total": 1,
    "done": 0, "skipped": 0, "failed": 0, "state": "running",
}
JOB_DETAIL = {**JOB_SUMMARY, "files": [
    {"path": "/inbox/PJAM-045.opus", "name": "PJAM-045.opus", "status": "running",
     "phase": "subtitling", "progress": 0.36, "message": "",
     "duration_s": 6180.0, "position_s": 2224.8, "position": "37:04",
     "output_files": [], "started": 1756560010.0, "finished": None},
]}
SRT = "1\n00:00:00,000 --> 00:00:02,000\n测试\n"


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _handler(upload_status: int = 201):
    def handle(request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if p == "/health":
            return httpx.Response(200, json=HEALTH)
        if p == "/jobs":
            return httpx.Response(200, json=[JOB_SUMMARY])
        if p == f"/jobs/{JOB_SUMMARY['id']}":
            return httpx.Response(200, json=JOB_DETAIL)
        if p == f"/jobs/{JOB_SUMMARY['id']}/result":
            return httpx.Response(200, content=SRT.encode(), headers={"content-type": "text/plain"})
        if p == "/upload":
            if request.headers.get("X-Source-Name") != "PJAM-045.mp4":
                return httpx.Response(500)
            return httpx.Response(upload_status, json={"ok": upload_status == 201, "job_id": "j1", "file": "x.opus"})
        return httpx.Response(404, json={"ok": False, "error": "not found"})
    return handle


def test_health_jobs_detail() -> None:
    async def run():
        e = JavScribeEngine("w", BASE + "/")  # trailing slash normalized
        assert e.url == BASE
        e._client = _client(_handler())
        try:
            h = await e.health()
            assert h == {"ok": True, "device": "cuda", "version": "0.1.0"}
            jobs = await e.jobs()
            assert jobs == [JOB_SUMMARY]
            d = await e.job_detail(JOB_SUMMARY["id"])
            assert d["files"][0]["progress"] == 0.36
            data, name = await e.result(JOB_SUMMARY["id"])
            assert data.decode() == SRT
            # no content-disposition from the workshop -> fallback <job_id>.srt
            assert name == "20260830-abc123.srt"
        finally:
            await e.close()
    asyncio.run(run())


def test_upload_ok_and_rejected() -> None:
    async def run():
        e = JavScribeEngine("w", BASE)
        e._client = _client(_handler(201))
        try:
            assert await e.upload_audio(b"audio", "PJAM-045.mp4") == "j1"
        finally:
            await e.close()
        e2 = JavScribeEngine("w", BASE)
        e2._client = _client(_handler(400))
        try:
            try:
                await e2.upload_audio(b"audio", "PJAM-045.mp4")
                raise AssertionError("expected EngineUploadError")
            except EngineUploadError as ex:
                assert "400" in str(ex)
        finally:
            await e2.close()
    asyncio.run(run())


def test_jobs_tolerates_non_list() -> None:
    async def run():
        e = JavScribeEngine("w", BASE)
        e._client = _client(lambda r: httpx.Response(200, json={"oops": True}))
        try:
            assert await e.jobs() == []
        finally:
            await e.close()
    asyncio.run(run())


def test_config_get_put_sends_api_key() -> None:
    seen: dict[str, dict] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if p == "/config" and request.method == "GET":
            seen["get_key"] = {"k": request.headers.get("X-Api-Key")}
            return httpx.Response(200, json={"ok": True, "profile": "server", "items": [
                {"path": "subtitle.lang_tag", "label": "字幕语言标签", "type": "string", "value": "zh"},
            ]})
        if p == "/config" and request.method == "PUT":
            body = json.loads(request.content.decode())
            seen["put"] = {"key": request.headers.get("X-Api-Key"), "body": body}
            return httpx.Response(200, json={"ok": True, "updated": ["subtitle.lang_tag"]})
        return httpx.Response(404, json={"ok": False, "error": "not found"})

    async def run():
        e = JavScribeEngine("w", BASE, api_key="k1")
        e._client = _client(handler)
        try:
            d = await e.config()
            assert d["ok"] and d["items"][0]["path"] == "subtitle.lang_tag"
            assert seen["get_key"]["k"] == "k1"
            r = await e.config_update({"subtitle.lang_tag": "ja"})
            assert r == {"ok": True, "updated": ["subtitle.lang_tag"]}
            assert seen["put"]["key"] == "k1"
            assert seen["put"]["body"] == {"values": {"subtitle.lang_tag": "ja"}}
        finally:
            await e.close()
        # no key -> no auth header
        e2 = JavScribeEngine("w", BASE)
        e2._client = _client(handler)
        try:
            await e2.config()
            assert seen["get_key"]["k"] is None
        finally:
            await e2.close()

    asyncio.run(run())


def test_config_error_propagates() -> None:
    import httpx as _httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"ok": False, "error": "API Key 不正确"})

    async def run():
        e = JavScribeEngine("w", BASE, api_key="wrong")
        e._client = _client(handler)
        try:
            try:
                await e.config()
                raise AssertionError("expected HTTPStatusError")
            except _httpx.HTTPStatusError as ex:
                assert ex.response.status_code == 401
        finally:
            await e.close()

    asyncio.run(run())


def test_scan_get_post_sends_api_key() -> None:
    seen: dict[str, dict] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        p = request.url.path
        if p == "/scan" and request.method == "GET":
            seen["get"] = {
                "key": request.headers.get("X-Api-Key"),
                "path": request.url.params.get("path"),
            }
            return httpx.Response(200, json={"ok": True, "path": "/media/x", "items": [
                {"path": "/media/x/a.mp4", "name": "a.mp4", "size": 10,
                 "has_subtitle": True, "subtitle": "a.zh.srt"},
            ], "truncated": False})
        if p == "/scan/submit" and request.method == "POST":
            body = json.loads(request.content.decode())
            seen["post"] = {"key": request.headers.get("X-Api-Key"), "body": body}
            return httpx.Response(201, json={"ok": True, "job_id": "j1", "files": 2})
        return httpx.Response(404, json={"ok": False, "error": "not found"})

    async def run():
        e = JavScribeEngine("w", BASE, api_key="k1")
        e._client = _client(handler)
        try:
            d = await e.scan("/media/x")
            assert d["ok"] and d["items"][0]["name"] == "a.mp4"
            assert seen["get"]["key"] == "k1" and seen["get"]["path"] == "/media/x"
            r = await e.scan_submit(["/media/x/a.mp4", "/media/x/sub/d.mp4"])
            assert r["job_id"] == "j1" and r["files"] == 2
            assert seen["post"]["key"] == "k1"
            assert seen["post"]["body"] == {"files": ["/media/x/a.mp4", "/media/x/sub/d.mp4"]}
        finally:
            await e.close()

    asyncio.run(run())


if __name__ == "__main__":
    test_health_jobs_detail()
    test_upload_ok_and_rejected()
    test_jobs_tolerates_non_list()
    test_config_get_put_sends_api_key()
    test_config_error_propagates()
    test_scan_get_post_sends_api_key()
    print("  test_adapter OK")
