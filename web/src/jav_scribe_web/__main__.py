"""Entry point: jav-scribe-web (or python -m jav_scribe_web)."""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import uvicorn

from . import __version__
from .api import build_app
from .config import EngineStore
from .poller import Poller

log = logging.getLogger("jav-scribe-web")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [web] %(message)s", datefmt="%H:%M:%S"
    )
    port = int(os.environ.get("JAV_WEB_PORT", "8400"))
    interval_s = float(os.environ.get("JAV_POLL_INTERVAL_S", "5"))
    data_dir = os.environ.get("JAV_DATA_DIR", "/data")

    store = EngineStore(data_dir)
    poller = Poller(store, interval_s=interval_s, log=lambda s: log.info(s))

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.get_running_loop().create_task(poller.run())
        log.info(
            "JavScribe-Web v%s 启动 | 服务 %d 个 | http://0.0.0.0:%d",
            __version__,
            len(store.engines),
            port,
        )
        try:
            yield
        finally:
            poller.stop()
            await task

    app = build_app(store, poller, lifespan=lifespan)
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
