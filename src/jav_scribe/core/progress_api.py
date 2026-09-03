"""Progress / remote-job HTTP API (stdlib only).

Endpoints (all JSON unless noted):
  GET  /health                 -> {ok, version, profile, device, jobs}
  GET  /jobs                   -> list of job summaries
  GET  /jobs/<id>              -> job detail (per-file status/progress/position)
  GET  /jobs/<id>/result       -> raw bytes of the primary finished SRT
  POST /jobs/<id>/retry       -> re-queue SKIPPED files (force regenerate)
  PUT  /upload?source=<name>   -> body = audio bytes; creates a remote job
                                   (X-Source-Name header or ?source=, ?ext=)
  GET  /jobs/<id>/result.srt   -> alias of /result

Used for: watching progress from a browser/`curl` on the server box, and the
remote flow (the client extracts audio with ffmpeg and PUTs it here; only
audio crosses the network, ~30-80MB per 2.5h movie).
"""
from __future__ import annotations

import json
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from ..constants import APP_NAME, APP_VERSION

if TYPE_CHECKING:
    from .engine import Engine

MAX_UPLOAD_MB = 400


class _Handler(BaseHTTPRequestHandler):
    engine: "Engine"  # set by ProgressHTTP
    profile: str = ""
    inbox_dir: Path

    def log_message(self, fmt: str, *args) -> None:  # quieter default logging
        self.engine.log(f"[http] {self.address_string()} {fmt % args}")

    # -- helpers ---------------------------------------------------------
    def _send(self, code: int, payload, ctype: str = "application/json") -> None:
        if isinstance(payload, (dict, list)):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        elif isinstance(payload, str):
            data = payload.encode("utf-8")
        else:
            data = bytes(payload)
        self.send_response(code)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # -- GET -------------------------------------------------------------
    def do_GET(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        if not parts or parts[0] == "health":
            e = self.engine
            self._send(
                200,
                {
                    "ok": True,
                    "app": APP_NAME,
                    "version": APP_VERSION,
                    "profile": self.profile,
                    "device": e.cfg.get("infer", {}).get("device", "auto"),
                    "jobs": [j.to_dict() for j in e.jobs],
                },
            )
            return
        if parts[0] == "jobs":
            if len(parts) == 1:
                self._send(200, [j.to_dict() for j in self.engine.jobs])
                return
            job = self.engine.job_by_id(parts[1])
            if job is None:
                self._send(404, {"ok": False, "error": "job not found"})
                return
            if len(parts) >= 3 and parts[2] in ("result", "result.srt"):
                data = self.engine.result_srt_bytes(job)
                if data is None:
                    self._send(404, {"ok": False, "error": "no result srt yet"})
                else:
                    self._send(200, data, "text/plain")
                return
            self._send(200, job.to_dict(detail=True))
            return
        self._send(404, {"ok": False, "error": "not found"})

    # -- POST /jobs/<id>/retry -------------------------------------------------
    def do_POST(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "retry":
            if self.engine.job_by_id(parts[1]) is None:
                self._send(404, {"ok": False, "error": "job not found（任务不存在或已过期）"})
                return
            job = self.engine.retry_job(parts[1])
            if job is None:
                self._send(409, {"ok": False, "error": "no retryable file（无跳过的文件，或任务已过期）"})
            else:
                self._send(201, {"ok": True, "job_id": job.id})
            return
        self._send(404, {"ok": False, "error": "not found"})

    # -- PUT /upload ------------------------------------------------------
    def do_PUT(self) -> None:
        if not self.path.startswith("/upload"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD_MB * 1024 * 1024:
            self._send(400, {"ok": False, "error": f"bad body size (max {MAX_UPLOAD_MB}MB)"})
            return
        body = self.rfile.read(length)
        source_name = (
            self.headers.get("X-Source-Name")
            or (q.get("source") or ["remote"])[0]
        )
        ext = (q.get("ext") or ["opus"])[0].lstrip(".")
        self.inbox_dir.mkdir(parents=True, exist_ok=True)
        safe = "".join(c for c in source_name if c.isalnum() or c in "._-") or "remote"
        audio_path = self.inbox_dir / f"{safe}.{ext}"
        audio_path.write_bytes(body)
        job = self.engine.submit_remote_files([audio_path], source_name=source_name)
        self._send(201, {"ok": True, "job_id": job.id, "file": audio_path.name})


class ProgressHTTP:
    def __init__(
        self,
        engine: "Engine",
        host: str = "0.0.0.0",
        port: int = 8300,
        profile: str = "",
        inbox_dir: Optional[Path] = None,
    ) -> None:
        self.engine = engine
        self.profile = profile
        self.inbox_dir = inbox_dir or (Path.home() / ".jav_scribe" / "inbox")
        h = _Handler
        h.engine = engine
        h.profile = profile
        h.inbox_dir = self.inbox_dir
        self.server = ThreadingHTTPServer((host, port), h)
        self.thread: threading.Thread | None = None
        self.host, self.port = host, port

    def start(self) -> None:
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()
        self.engine.log(f"[progress] HTTP 服务已启动 http://{self.host}:{self.port} (health/jobs/upload)")

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
