"""Engine adapter boundary.

v1 ships a single implementation (JavScribeEngine, talks to a JavScribe
`serve` process). The interface is deliberately small so other backends
(e.g. a generic model API) can be added as new adapters later without
touching the poller, API or frontend.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class EngineInfo:
    """Latest known state of one subtitle-service endpoint."""

    name: str
    url: str
    online: bool = False
    device: str = ""
    version: str = ""
    jobs_running: int = 0
    error: str = ""
    has_key: bool = False
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "url": self.url,
            "online": self.online,
            "device": self.device,
            "version": self.version,
            "jobs_running": self.jobs_running,
            "error": self.error,
            "has_key": self.has_key,
            "updated_at": self.updated_at,
        }


class EngineAdapter(ABC):
    name: str
    url: str

    @abstractmethod
    async def health(self) -> dict:
        """Return {"ok": bool, "device": str, "version": str}."""

    @abstractmethod
    async def jobs(self) -> list[dict]:
        """Job summaries in service format (JavScribe Job.to_dict)."""

    @abstractmethod
    async def job_detail(self, job_id: str) -> dict:
        """One job with per-file details (Job.to_dict(detail=True))."""

    @abstractmethod
    async def upload_audio(self, audio: bytes, source_name: str) -> dict:
        """Send an extracted audio track (先问后传); return {job_id, cached}."""

    @abstractmethod
    async def result(self, job_id: str) -> tuple[bytes, str]:
        """Fetch the finished primary SRT; return (bytes, suggested name)."""
