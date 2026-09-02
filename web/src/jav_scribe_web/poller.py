"""Periodic refresh of the in-memory snapshot of all workshops."""
from __future__ import annotations

import asyncio
from typing import Callable, Optional

from .config import EngineStore
from .engines.base import EngineAdapter, EngineInfo
from .engines.javscribe import JavScribeEngine


class Poller:
    """Refreshes {engine: EngineInfo} and {engine: [job details]} in place.

    The control room keeps no task state of its own: on a workshop restart
    its job list is simply gone, and the snapshot follows. Failed engines
    keep their last known jobs with online=False.
    """

    def __init__(
        self,
        store: EngineStore,
        interval_s: float = 5.0,
        factory: Optional[Callable[[dict], EngineAdapter]] = None,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self._store = store
        self._interval = interval_s
        self._factory = factory or (lambda e: JavScribeEngine(e["name"], e["url"]))
        self._log = log or (lambda _s: None)
        self._stop = asyncio.Event()
        self.engines: dict[str, EngineInfo] = {}
        self.jobs: dict[str, list[dict]] = {}

    def stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        while not self._stop.is_set():
            await self.tick()
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._interval)
            except asyncio.TimeoutError:
                pass

    async def tick(self) -> None:
        await asyncio.gather(*(self._refresh_one(e) for e in self._store.engines))
        for name in list(self.engines):
            if self._store.get(name) is None:
                del self.engines[name]
                self.jobs.pop(name, None)

    async def _refresh_one(self, entry: dict) -> None:
        name, url = entry["name"], entry["url"]
        adapter = self._factory(entry)
        try:
            h = await adapter.health()
            if not h.get("ok"):
                raise RuntimeError(f"health not ok: {h}")
            details = []
            for summary in await adapter.jobs():
                try:
                    details.append(await adapter.job_detail(summary["id"]))
                except Exception as ex:  # one bad job must not take down the engine
                    self._log(f"[poll] {name} 任务 {summary.get('id')} 明细获取失败: {ex}")
                    details.append(summary)
            running = sum(1 for j in details if j.get("state") == "running")
            self.engines[name] = EngineInfo(
                name=name,
                url=url,
                online=True,
                device=h.get("device", ""),
                version=h.get("version", ""),
                jobs_running=running,
            )
            self.jobs[name] = details
        except Exception as ex:
            prev = self.engines.get(name)
            info = EngineInfo(name=name, url=url, online=False, error=str(ex)[:200])
            if prev is not None:
                info.device = prev.device
                info.version = prev.version
            self.engines[name] = info
            self._log(f"[poll] {name} 离线: {ex}")
