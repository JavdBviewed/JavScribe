"""Control room HTTP API + static frontend."""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .audio import extract_audio
from .config import EngineStore
from .engines.javscribe import JavScribeEngine
from .poller import Poller

STATIC_DIR = Path(__file__).parent / "static"
UPLOAD_MAX_GB = float(os.environ.get("JAV_UPLOAD_MAX_GB", "10"))


def _job_rows(engine: str, job: dict) -> list[dict]:
    """Flatten one job into dashboard rows (one per file when detailed)."""
    base = {
        "engine": engine,
        "job_id": job.get("id"),
        "label": job.get("label") or "",
        "state": job.get("state"),
        "created": job.get("created"),
        "finished": job.get("finished"),
        "source_kind": job.get("source_kind"),
    }
    files = job.get("files")
    if not files:
        total = job.get("total") or 0
        done = job.get("done") or 0
        finished = job.get("state") == "finished"
        return [
            {
                **base,
                "file": job.get("label") or str(job.get("id")),
                "status": "done" if finished else "running",
                "progress": (done / total) if total else (1.0 if finished else 0.0),
                "position": "",
                "duration_s": None,
                "position_s": None,
                "message": f"{done}/{total}",
                "output_files": [],
            }
        ]
    rows = []
    for t in files:
        rows.append(
            {
                **base,
                "file": t.get("name") or "",
                "status": t.get("status"),
                "phase": t.get("phase"),
                "progress": t.get("progress") or 0.0,
                "position": t.get("position") or "",
                "duration_s": t.get("duration_s"),
                "position_s": t.get("position_s"),
                "message": t.get("message") or "",
                "finished": t.get("finished"),
                "output_files": t.get("output_files") or [],
            }
        )
    return rows


def build_app(store: EngineStore, poller: Poller, lifespan=None) -> FastAPI:
    app = FastAPI(title="JavScribe-Web", version=__version__, lifespan=lifespan)

    @app.get("/api/health")
    async def api_health() -> dict:
        infos = list(poller.engines.values())
        return {
            "ok": True,
            "app": "JavScribe-Web",
            "version": __version__,
            "engines": len(infos),
            "online": sum(1 for i in infos if i.online),
        }

    @app.get("/api/engines")
    async def api_list_engines() -> list[dict]:
        return [i.to_dict() for i in sorted(poller.engines.values(), key=lambda e: e.name)]

    @app.post("/api/engines", status_code=201)
    async def api_add_engine(body: dict) -> dict:
        entry = store.add(str(body.get("name", "")), str(body.get("url", "")))
        if entry is None:
            raise HTTPException(400, "name/url 无效，或该名称已指向其它地址")
        return entry

    @app.delete("/api/engines/{name}")
    async def api_remove_engine(name: str) -> dict:
        if not store.remove(name):
            raise HTTPException(404, "engine not found")
        return {"ok": True}

    @app.get("/api/jobs")
    async def api_list_jobs() -> list[dict]:
        rows: list[dict] = []
        for name, details in poller.jobs.items():
            for job in details:
                rows.extend(_job_rows(name, job))
        rows.sort(
            key=lambda r: (
                0 if r["status"] == "running" else 1,
                -(r.get("created") or 0),
            )
        )
        return rows

    # -- 派工单：浏览器上传 → 抽音轨 → 转发车间 ---------------------------------
    _upload_locks: dict[str, asyncio.Lock] = {}

    def _lock_for(engine_name: str) -> asyncio.Lock:
        return _upload_locks.setdefault(engine_name, asyncio.Lock())

    @app.post("/api/upload", status_code=202)
    async def api_upload(file: UploadFile = File(...), engine: str = Form(...)) -> dict:
        entry = store.get(engine)
        if entry is None:
            raise HTTPException(404, "engine not found")
        max_bytes = int(UPLOAD_MAX_GB * 1024**3)
        fd, name = tempfile.mkstemp(suffix=Path(file.filename or "").suffix or ".bin", prefix="javweb_up_")
        tmp = Path(name)
        import os as _os

        _os.close(fd)
        received = 0
        try:
            with open(tmp, "wb") as fh:
                while chunk := await file.read(4 * 1024 * 1024):
                    received += len(chunk)
                    if received > max_bytes:
                        raise HTTPException(413, f"file too large (max {UPLOAD_MAX_GB:g}GB)")
                    fh.write(chunk)
            try:
                audio_tmp, audio_size = await extract_audio(tmp)
            except Exception as ex:
                raise HTTPException(400, f"音轨提取失败: {ex}")
        finally:
            tmp.unlink(missing_ok=True)
        eng = JavScribeEngine(engine, entry["url"])
        try:
            async with _lock_for(engine):
                job_id = await eng.upload_audio(audio_tmp.read_bytes(), file.filename or "remote")
        except Exception as ex:
            raise HTTPException(502, f"车间拒绝任务: {ex}")
        finally:
            audio_tmp.unlink(missing_ok=True)
            await eng.close()
        return {
            "ok": True,
            "engine": engine,
            "job_id": job_id,
            "audio_mb": round(audio_size / 1048576, 1),
        }

    # -- srt 下载（代理车间 /result）-------------------------------------------
    @app.get("/api/jobs/{engine}/{job_id}/result")
    async def api_result(engine: str, job_id: str) -> Response:
        entry = store.get(engine)
        if entry is None:
            raise HTTPException(404, "engine not found")
        eng = JavScribeEngine(engine, entry["url"])
        try:
            data, suggested = await eng.result(job_id)
        except httpx.HTTPStatusError as ex:
            if ex.response.status_code == 404:
                raise HTTPException(404, "no result yet (任务未完成或无输出)")
            raise HTTPException(502, f"workshop error: HTTP {ex.response.status_code}")
        except httpx.HTTPError as ex:
            raise HTTPException(502, f"workshop unreachable: {ex}")
        finally:
            await eng.close()
        label = next(
            (j.get("label", "") for j in poller.jobs.get(engine, []) if j.get("id") == job_id),
            "",
        )
        stem = Path(label).stem if label else Path(suggested).stem
        filename = f"{stem}.zh.srt"
        return Response(
            content=data,
            media_type="application/x-subrip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app
