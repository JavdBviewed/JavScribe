"""Adapter for a JavScribe `serve` endpoint.

Protocol (JavScribe repo, progress_api.py):
  GET  /health                     -> {ok, app, version, profile, device, jobs}
  GET  /jobs                       -> [Job summary]
  GET  /jobs/<id>                  -> Job detail (includes files[])
  PUT  /upload?source=NAME         -> 201 {ok, job_id, file}   (body = audio bytes)
  GET  /cache/check?sha1=&size=&ext= -> {ok, cached, size?}     (新版服务；旧版 404)
  POST /upload/submit?sha1=&ext=   -> 201 {ok, job_id, file, cached}（命中免传字节；未命中 409）
  POST /jobs/<id>/retry          -> 201 {ok, job_id}  (re-queue SKIPPED files, force regenerate)
  GET  /jobs/<id>/result           -> SRT bytes
  GET  /config                     -> {ok, profile, items[]}      (X-Api-Key)
  PUT  /config {"values": {...}}   -> {ok, updated[]}             (X-Api-Key)
"""
from __future__ import annotations

import hashlib
from urllib.parse import unquote

import httpx

from .base import EngineAdapter

_TIMEOUT = httpx.Timeout(15.0, connect=5.0)


class EngineUploadError(RuntimeError):
    """Workshop rejected the uploaded audio."""


class JavScribeEngine(EngineAdapter):
    def __init__(
        self,
        name: str,
        url: str,
        api_key: str = "",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.name = name
        self.url = url.rstrip("/")
        self.api_key = (api_key or "").strip()
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

    async def upload_audio(self, audio: bytes, source_name: str) -> dict:
        """转发 opus：先问后传（服务端内容寻址缓存）。

        命中 → POST /upload/submit 免传字节建任务；
        未命中 / 旧版服务（/cache/check 404）/ submit 竞态失败 → 常规 PUT /upload。
        返回 {job_id, cached}。
        """
        sha1 = hashlib.sha1(audio).hexdigest()
        client = self._get_client()
        try:
            ck = await client.get(
                f"{self.url}/cache/check",
                params={"sha1": sha1, "size": len(audio), "ext": "opus"},
            )
            if ck.status_code == 200 and ck.json().get("cached") is True:
                sub = await client.post(
                    f"{self.url}/upload/submit",
                    params={"sha1": sha1, "ext": "opus"},
                    headers={"X-Source-Name": source_name},
                )
                if sub.status_code == 201:
                    d = sub.json()
                    return {"job_id": str(d.get("job_id") or ""), "cached": True}
                # 命中后 submit 失败（缓存文件恰被 retention 清理等）→ 落回常规上传
        except httpx.HTTPError:
            pass  # 预检网络异常不阻断，落回常规上传由 PUT 报真实错误
        r = await client.put(
            f"{self.url}/upload",
            params={"ext": "opus", "sha1": sha1},
            content=audio,
            headers={"X-Source-Name": source_name, "Content-Type": "application/octet-stream"},
        )
        if r.status_code != 201:
            raise EngineUploadError(f"service rejected upload: HTTP {r.status_code}")
        return {"job_id": str(r.json()["job_id"]), "cached": False}

    async def result(self, job_id: str) -> tuple[bytes, str]:
        r = await self._get_client().get(f"{self.url}/jobs/{job_id}/result")
        r.raise_for_status()
        name = _attachment_name(r.headers.get("content-disposition")) or f"{job_id}.srt"
        return r.content, name

    async def retry(self, job_id: str) -> dict:
        """「仍要重新生成」：服务删除已存在字幕并重新入队跳过的文件。

        返回 {ok, job_id}；服务 404/409 时原样抛出 HTTPStatusError。
        """
        r = await self._get_client().post(f"{self.url}/jobs/{job_id}/retry")
        r.raise_for_status()
        return r.json()

    def _auth_headers(self) -> dict[str, str]:
        return {"X-Api-Key": self.api_key} if self.api_key else {}

    async def config(self) -> dict:
        """GET /config（服务侧白名单设置项，敏感项打码）。

        服务未设 key → 403；key 不符 → 401；旧镜像无此端点 → 404。
        """
        r = await self._get_client().get(f"{self.url}/config", headers=self._auth_headers())
        r.raise_for_status()
        return r.json()

    async def config_update(self, values: dict) -> dict:
        """PUT /config：白名单校验由服务侧执行；返回 {ok, updated[]}。"""
        r = await self._get_client().put(
            f"{self.url}/config",
            json={"values": values},
            headers=self._auth_headers(),
        )
        r.raise_for_status()
        return r.json()

    async def scan(self, path: str) -> dict:
        """GET /scan?path=：按服务侧扫描规则列出目录内视频文件（含字幕标记）。"""
        r = await self._get_client().get(
            f"{self.url}/scan", params={"path": path}, headers=self._auth_headers()
        )
        r.raise_for_status()
        return r.json()

    async def scan_submit(self, files: list[str]) -> dict:
        """POST /scan/submit：把勾选的本地视频路径批量入队。返回 {ok, job_id, files}。"""
        r = await self._get_client().post(
            f"{self.url}/scan/submit",
            json={"files": files},
            headers=self._auth_headers(),
        )
        r.raise_for_status()
        return r.json()


def _attachment_name(content_disposition: str | None) -> str | None:
    if not content_disposition:
        return None
    for part in content_disposition.split(";"):
        part = part.strip()
        if part.lower().startswith("filename="):
            value = unquote(part.split("=", 1)[1].strip().strip('"'))
            return value or None
    return None
