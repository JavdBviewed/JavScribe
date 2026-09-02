"""Adapter for a JavScribe `serve` endpoint.

Protocol (JavScribe repo, progress_api.py):
  GET  /health                     -> {ok, app, version, profile, device, jobs}
  GET  /jobs                       -> [Job summary]
  GET  /jobs/<id>                  -> Job detail (includes files[])
  PUT  /upload?source=NAME         -> 201 {ok, job_id, file}   (body = audio bytes)
  GET  /jobs/<id>/result           -> SRT bytes
"""
from __future__ import annotations

from urllib.parse import unquote

import httpx

from .base import EngineAdapter

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class EngineUploadError(RuntimeError):
    """Workshop rejected the uploaded audio."""


class JavScribeEngine(EngineAdapter):
    def __init__(self, name: str, url: str, client: httpx.AsyncClient | None = None) -> None:
        self.name = name
        self.url = url.rstrip("/")
        self._client = client

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=_TIMEOUT)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def health(self) -> dict:
        r = await self._get_client().get(f"{self.url}/health")
        r.raise_for_status()
        d = r.json()
        return {
            "ok": bool(d.get("ok")),
            "device": str(d.get("device") or ""),
            "version": str(d.get("version") or ""),
        }

    async def jobs(self) -> list[dict]:
        r = await self._get_client().get(f"{self.url}/jobs")
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []

    async def job_detail(self, job_id: str) -> dict:
        r = await self._get_client().get(f"{self.url}/jobs/{job_id}")
        r.raise_for_status()
        return r.json()

    async def upload_audio(self, audio: bytes, source_name: str) -> str:
        r = await self._get_client().put(
            f"{self.url}/upload",
            content=audio,
            headers={"X-Source-Name": source_name, "Content-Type": "application/octet-stream"},
        )
        if r.status_code != 201:
            raise EngineUploadError(f"workshop rejected upload: HTTP {r.status_code}")
        return str(r.json()["job_id"])

    async def result(self, job_id: str) -> tuple[bytes, str]:
        r = await self._get_client().get(f"{self.url}/jobs/{job_id}/result")
        r.raise_for_status()
        name = _attachment_name(r.headers.get("content-disposition")) or f"{job_id}.srt"
        return r.content, name


def _attachment_name(content_disposition: str | None) -> str | None:
    if not content_disposition:
        return None
    for part in content_disposition.split(";"):
        part = part.strip()
        if part.lower().startswith("filename="):
            value = unquote(part.split("=", 1)[1].strip().strip('"'))
            return value or None
    return None
