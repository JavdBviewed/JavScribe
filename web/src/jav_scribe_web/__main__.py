"""Entry point: jav-scribe-web (or python -m jav_scribe_web).

默认起 HTTP 8400；若 JAV_WEB_TLS_PORT 未设为 0（默认 8443），同时起一份
HTTPS（自签证书，首次自动生成于 <data_dir>/certs/）。写回源目录
（File System Access API）要求页面处于安全上下文，即需经 https 访问。
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn

from . import __version__
from .api import build_app
from .config import EngineStore
from .poller import Poller
from .update_check import UpdateChecker

log = logging.getLogger("jav-scribe-web")


def _ensure_selfsigned_cert(data_dir: str) -> tuple[str, str] | None:
    """Generate (or reuse) a 10-year self-signed cert. Returns (cert, key) paths."""
    cert_dir = Path(data_dir) / "certs"
    cert_dir.mkdir(parents=True, exist_ok=True)
    cert, key = cert_dir / "cert.pem", cert_dir / "key.pem"
    if cert.exists() and key.exists():
        return str(cert), str(key)
    if shutil.which("openssl") is None:
        log.warning("openssl not found — HTTPS disabled")
        return None
    sans = os.environ.get("JAV_WEB_CERT_SANS", "IP:127.0.0.1").strip()
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", str(key), "-out", str(cert), "-days", "3650",
        "-subj", "/CN=JavScribe Web", "-addext", f"subjectAltName={sans}",
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=60)
        log.info("self-signed cert generated: %s (SAN: %s)", cert, sans)
        return str(cert), str(key)
    except Exception as ex:  # noqa: BLE001 — 证书生成失败不应拖垮 HTTP 服务
        log.warning("self-signed cert generation failed: %s — HTTPS disabled", ex)
        return None


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s [web] %(message)s", datefmt="%H:%M:%S"
    )
    port = int(os.environ.get("JAV_WEB_PORT", "8400"))
    tls_port = int(os.environ.get("JAV_WEB_TLS_PORT", "8443"))
    interval_s = float(os.environ.get("JAV_POLL_INTERVAL_S", "5"))
    data_dir = os.environ.get("JAV_DATA_DIR", "/data")

    store = EngineStore(data_dir)
    poller = Poller(store, interval_s=interval_s, log=lambda s: log.info(s))
    updater = UpdateChecker(__version__, log_fn=lambda s: log.info(s))

    _started = False

    @asynccontextmanager
    async def lifespan(app):
        # 同一 app 可能被 http/https 两个 uvicorn Server 各执行一次 lifespan，
        # 用幂等标志保证 poller 只启动一份。
        nonlocal _started
        if _started:
            yield
            return
        _started = True
        task = asyncio.get_running_loop().create_task(poller.run())
        update_task = asyncio.get_running_loop().create_task(updater.run())
        log.info(
            "JavScribe-Web v%s 启动 | 服务 %d 个 | 更新检查 %s | http://0.0.0.0:%d%s",
            __version__,
            len(store.engines),
            "开" if updater.snapshot([])["enabled"] else "关",
            port,
            f" + https://0.0.0.0:{tls_port}" if tls_port > 0 else "",
        )
        try:
            yield
        finally:
            poller.stop()
            update_task.cancel()
            await asyncio.gather(task, update_task, return_exceptions=True)

    app = build_app(store, poller, updater=updater, lifespan=lifespan)
    servers = [uvicorn.Server(uvicorn.Config(
        app, host="0.0.0.0", port=port, log_level="warning"))]
    if tls_port > 0:
        c = _ensure_selfsigned_cert(data_dir)
        if c:
            servers.append(uvicorn.Server(uvicorn.Config(
                app, host="0.0.0.0", port=tls_port,
                ssl_certfile=c[0], ssl_keyfile=c[1], log_level="warning")))

    async def serve_all() -> None:
        await asyncio.gather(*(s.serve() for s in servers))

    try:
        asyncio.run(serve_all())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
