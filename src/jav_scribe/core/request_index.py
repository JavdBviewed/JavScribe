"""Durable admission tokens for HTTP task submission.

Reservations are persisted before job creation so a crash can never turn an
uncertain submission into an implicit second job with the same token.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable

TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,96}$")
RETAIN_SECONDS = 7 * 86400
MAX_RECORDS = 50000


class RequestIndex:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.RLock()
        self.records: dict[str, dict[str, Any]] = {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                self.records = {k: v for k, v in raw.items()
                                if TOKEN_RE.fullmatch(k) and isinstance(v, dict)
                                and isinstance(v.get("fingerprint"), str)}
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp")
        try:
            tmp.write_text(json.dumps(self.records, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.path)
        finally:
            tmp.unlink(missing_ok=True)

    def lookup(self, token: str, job_exists: Callable[[str], bool]) -> dict[str, Any] | None:
        with self.lock:
            row = self.records.get(token)
            if row is None:
                return None
            job_id = row.get("job_id")
            return {"ok": True, "status": "accepted" if job_id and job_exists(job_id)
                    else "lost" if job_id else "uncertain", "job_id": job_id or None}

    def submit(self, token: str | None, fingerprint: str, create: Callable[[], dict[str, Any]],
               job_exists: Callable[[str], bool]) -> tuple[int, dict[str, Any]]:
        if not token:
            return 201, create()
        with self.lock:
            row = self.records.get(token)
            if row:
                if row["fingerprint"] != fingerprint:
                    return 409, {"ok": False, "error": "request-conflict"}
                job_id = row.get("job_id")
                if not job_id or not job_exists(job_id):
                    return 409, {"ok": False, "error": "request-uncertain-or-lost", "job_id": job_id}
                return 201, dict(row["response"])
            now = time.time()
            self.records = {k: v for k, v in self.records.items()
                            if now - float(v.get("created", 0)) < RETAIN_SECONDS}
            if len(self.records) >= MAX_RECORDS:
                return 503, {"ok": False, "error": "request-index-full"}
            self.records[token] = {"fingerprint": fingerprint, "created": now}
            try:
                self._save()  # reservation must survive a crash before creating the job
                response = create()
                self.records[token].update(job_id=response["job_id"], response=response)
                self._save()
            except Exception:
                # The reservation survives even if job creation/recording failed.
                raise
            return 201, response
