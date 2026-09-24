"""Periodic refresh of the in-memory snapshot of all subtitle services."""
from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, Optional

from .config import EngineStore
from .engines.base import EngineAdapter, EngineInfo
from .engines.javscribe import JavScribeEngine


class Poller:
    """Refreshes {engine: EngineInfo} and {engine: [job details]} in place.

    The workbench keeps no task state of its own: on a service restart
    its job list is simply gone, and the snapshot follows. Failed engines
    keep their last known jobs with online=False.
    """

    def __init__(
        self,
        store: EngineStore,
        interval_s: float = 5.0,
        factory: Optional[Callable[[dict], EngineAdapter]] = None,
        log: Optional[Callable[[str], None]] = None,
        on_jobs: Optional[Callable[[], Awaitable[None]]] = None,
    ) -> None:
        self._store = store
        self._interval = interval_s
        self._factory = factory or (lambda e: JavScribeEngine(e["name"], e["url"]))
        self._log = log or (lambda _s: None)
        self._on_jobs = on_jobs
        self._stop = asyncio.Event()
        self.engines: dict[str, EngineInfo] = {}
        self.jobs: dict[str, list[dict]] = {}

    def stop(self) -> None:
        self._stop.set()

    def set_on_jobs(self, cb: Optional[Callable[[], Awaitable[None]]]) -> None:
        """Register a post-snapshot side-effect hook (e.g. local write-back)."""
        self._on_jobs = cb

    async def run(self) -> None:
        while not self._stop.is_set():
            await self.tick()
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self._interval)
            except asyncio.TimeoutError:
                pass

    async def tick(self) -> None:
        # 临时诊断（flaky 复现用，定位后移除）：逐 tick 计时，
        # 快照滞留超 15s 即由 tick 变慢引起。
        import time as _t
        _t0 = _t.monotonic()
        await asyncio.gather(*(self._refresh_one(e) for e in self._store.engines))
        _t1 = _t.monotonic()
        for name in list(self.engines):
            if self._store.get(name) is None:
                del self.engines[name]
                self.jobs.pop(name, None)
        _t2 = _t.monotonic()
        if self._on_jobs is not None:
            # 快照就绪后的本地侧副作用（如本地扫描字幕回写）；失败不阻塞轮询
            try:
                await self._on_jobs()
            except Exception as ex:  # noqa: BLE001
                self._log(f"[poll] on_jobs 回调失败: {ex}")
        _t3 = _t.monotonic()
        if _t3 - _t0 > 1.5:
            self._log(
                f"[poll] 慢 tick total={(_t3 - _t0) * 1000:.0f}ms "
                f"refresh={(_t1 - _t0) * 1000:.0f}ms on_jobs={(_t3 - _t2) * 1000:.0f}ms"
            )

    async def _refresh_one(self, entry: dict) -> None:
        name, url = entry["name"], entry["url"]
        adapter = self._factory(entry)
        import time as _t
        _t0 = _t.monotonic()
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
                has_key=bool(entry.get("api_key")),
                stats=h.get("stats") if isinstance(h.get("stats"), dict) else None,
            )
            self.jobs[name] = details
            # 临时诊断（flaky 复现用，定位后移除）
            if _t.monotonic() - _t0 > 1.5:
                self._log(f"[poll] {name} 慢 refresh {(_t.monotonic() - _t0) * 1000:.0f}ms jobs={len(details)}")
        except Exception as ex:
            prev = self.engines.get(name)
            info = EngineInfo(name=name, url=url, online=False, error=str(ex)[:200],
                              has_key=bool(entry.get("api_key")))
            if prev is not None:
                info.device = prev.device
                info.version = prev.version
            self.engines[name] = info
            self._log(f"[poll] {name} 离线: {ex}")
