"""Control room HTTP API + static frontend."""
from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .audio import extract_audio_progress, probe_duration
from .config import EngineStore
from .engines.javscribe import JavScribeEngine
from .poller import Poller
from .srt_sanitizer import sanitize_srt_bytes

STATIC_DIR = Path(__file__).parent / "static"
_log = logging.getLogger("jav-scribe-web")
UPLOAD_MAX_GB = float(os.environ.get("JAV_UPLOAD_MAX_GB", "10"))
UPLOAD_TTL_S = 24 * 3600  # finished upload entries kept this long, then pruned


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


# -- 派工单流水线（上传 → 本地抽音轨 → 转发车间）----------------------------------

@dataclass
class UploadTask:
    """One 派工单 pipeline run; phases: extracting -> dispatching -> done/error."""

    id: str
    engine: str
    name: str
    size_mb: float
    phase: str = "extracting"
    progress: float = 0.0
    created: float = field(default_factory=time.time)
    finished: float | None = None
    audio_mb: float | None = None
    job_id: str | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "engine": self.engine,
            "name": self.name,
            "size_mb": self.size_mb,
            "phase": self.phase,
            "progress": round(self.progress, 4),
            "created": self.created,
            "finished": self.finished,
            "audio_mb": self.audio_mb,
            "job_id": self.job_id,
            "error": self.error,
        }


def build_app(store: EngineStore, poller: Poller, lifespan=None) -> FastAPI:
    app = FastAPI(title="JavScribe-Web", version=__version__, lifespan=lifespan)

    _uploads: dict[str, UploadTask] = {}
    _upload_locks: dict[str, asyncio.Lock] = {}

    def _lock_for(engine_name: str) -> asyncio.Lock:
        return _upload_locks.setdefault(engine_name, asyncio.Lock())

    def _prune_uploads() -> None:
        cutoff = time.time() - UPLOAD_TTL_S
        stale = [k for k, t in _uploads.items() if (t.finished or 0) and t.finished < cutoff]
        for k in stale:
            _uploads.pop(k, None)

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

    # -- 派工单：浏览器上传 → 本地抽音轨 → 转发车间（2 段式，进度可查）-----------

    async def _run_upload(task: UploadTask, video_tmp: Path) -> None:
        entry = store.get(task.engine)
        assert entry is not None
        audio_tmp = video_tmp.with_suffix(".opus")
        try:
            try:
                size = await extract_audio_progress(
                    video_tmp,
                    audio_tmp,
                    on_progress=lambda frac: setattr(task, "progress", frac),
                )
                task.audio_mb = round(size / 1048576, 1)
            except Exception as ex:
                task.phase = "error"
                task.error = f"音轨提取失败: {ex}"
                return
            task.phase = "dispatching"
            eng = JavScribeEngine(task.engine, entry["url"])
            try:
                async with _lock_for(task.engine):
                    task.job_id = await eng.upload_audio(
                        audio_tmp.read_bytes(), task.name or "remote"
                    )
            except Exception as ex:
                task.phase = "error"
                task.error = f"车间拒绝任务: {ex}"
                return
            finally:
                await eng.close()
            task.phase = "done"
            task.progress = 1.0
        finally:
            task.finished = time.time()
            video_tmp.unlink(missing_ok=True)
            audio_tmp.unlink(missing_ok=True)

    @app.post("/api/upload", status_code=202)
    async def api_upload(file: UploadFile = File(...), engine: str = Form(...)) -> dict:
        entry = store.get(engine)
        if entry is None:
            raise HTTPException(404, "engine not found")
        _prune_uploads()
        max_bytes = int(UPLOAD_MAX_GB * 1024**3)
        fd, name = tempfile.mkstemp(
            suffix=Path(file.filename or "").suffix or ".bin", prefix="javweb_up_"
        )
        tmp = Path(name)
        os.close(fd)
        received = 0
        try:
            with open(tmp, "wb") as fh:
                while chunk := await file.read(4 * 1024 * 1024):
                    received += len(chunk)
                    if received > max_bytes:
                        raise HTTPException(413, f"file too large (max {UPLOAD_MAX_GB:g}GB)")
                    fh.write(chunk)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        task = UploadTask(
            id=uuid.uuid4().hex[:8],
            engine=engine,
            name=file.filename or "remote",
            size_mb=round(received / 1048576, 1),
        )
        _uploads[task.id] = task
        asyncio.create_task(_run_upload(task, tmp))
        return {
            "ok": True,
            "upload_id": task.id,
            "engine": engine,
            "name": task.name,
            "size_mb": task.size_mb,
            "duration_s": round(probe_duration(tmp), 1),
        }

    @app.get("/api/uploads/{upload_id}")
    async def api_upload_status(upload_id: str) -> dict:
        task = _uploads.get(upload_id)
        if task is None:
            raise HTTPException(404, "upload not found (已过期或 id 无效)")
        return task.to_dict()

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
        # 防御兜底：车间引擎偶发产出负时间戳 srt（见 srt_sanitizer 注释），
        # 下载代理处统一清洗，保证用户拿到的文件合法。
        data, _fixed = sanitize_srt_bytes(data, log=_log.warning)
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
