"""JavScribe 新版本检查（GitHub Releases 版本对比 + 更新引导）。

设计备注：
- 这是工作台级功能（整站一个版本源），不是某个字幕服务 serve 的设置项，
  因此**不进 serve 的 /config 白名单**，全部走环境变量（运维级配置）：
  - JAV_UPDATE_CHECK=off        完全关闭（/api/update 返回 enabled=false）
  - JAV_UPDATE_GITHUB_BASE      GitHub API base（默认 https://api.github.com，
                                e2e 指向本地 mock-github）
  - JAV_UPDATE_MIRROR           Release 页面前缀（如 https://gh-proxy.example.com/，
                                拼到 html_url 前，适配内网/国内网络）
  - JAV_UPDATE_INTERVAL_S       后台检查间隔秒数（默认 86400；GitHub unauth 限流 60/h）
- tag 规范：`v*` 对应 serve/web 镜像（app），`client-v*` 对应 JavScribe Client 桌面端。
- 拉取失败保留上一次快照 + 记 last_error；/api/update 永不因网络抛错。
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from typing import Callable, Optional

import httpx

log = logging.getLogger("jav-scribe-web")

REPO = "JavdBviewed/JavScribe"
_APP_TAG = re.compile(r"^v\d")
_CLIENT_TAG = re.compile(r"^client-v\d")


def parse_version(tag: str) -> tuple[int, ...]:
    """'v0.2.1' / 'client-v0.2.1' / '0.2.1' → (0, 2, 1)；解析不了返回空元组。

    v 前缀可选：tag 规范带 v，但工作台 __version__ 与服务上报是纯数字。
    """
    m = re.match(r"^(?:client-)?v?(\d+(?:\.\d+)*)", tag or "")
    if not m:
        return ()
    return tuple(int(x) for x in m.group(1).split("."))


def version_gt(a: str, b: str) -> bool:
    """版本号数值比较（缺位补 0）：'v0.2' > 'v0.1.9'。任一解析失败 → False。"""
    ta, tb = parse_version(a), parse_version(b)
    if not ta or not tb:
        return False
    n = max(len(ta), len(tb))
    ta += (0,) * (n - len(ta))
    tb += (0,) * (n - len(tb))
    return ta > tb


class UpdateChecker:
    """后台循环拉取 GitHub 最新 Release；/api/update 读内存快照（永不抛错）。"""

    def __init__(self, current: str, log_fn: Optional[Callable[[str], None]] = None) -> None:
        self._current = current
        self._enabled = os.environ.get("JAV_UPDATE_CHECK", "on").strip().lower() != "off"
        self._base = os.environ.get("JAV_UPDATE_GITHUB_BASE", "https://api.github.com").rstrip("/")
        self._mirror = os.environ.get("JAV_UPDATE_MIRROR", "").strip()
        self._interval = float(os.environ.get("JAV_UPDATE_INTERVAL_S", "86400"))
        self._latest_app: Optional[dict] = None
        self._latest_client: Optional[dict] = None
        self._last_checked: Optional[float] = None
        self._last_error: Optional[str] = None
        self._log = log_fn or (lambda _s: None)

    # -- 拉取 ----------------------------------------------------------------

    async def fetch(self) -> None:
        url = f"{self._base}/repos/{REPO}/releases?per_page=30"
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(url, headers={"Accept": "application/vnd.github+json"})
                r.raise_for_status()
                releases = r.json()
            app = cli = None
            # releases 按创建时间倒序 → 每类 tag 首个命中即最新
            for rel in releases if isinstance(releases, list) else []:
                tag = rel.get("tag_name") or ""
                html_url = rel.get("html_url") or ""
                entry = {
                    "version": tag,
                    "name": rel.get("name") or tag,
                    "body": rel.get("body") or "",
                    "url": (self._mirror + html_url) if (self._mirror and html_url) else html_url,
                    "published_at": rel.get("published_at"),
                }
                if _APP_TAG.match(tag) and app is None:
                    app = entry
                elif _CLIENT_TAG.match(tag) and cli is None:
                    cli = entry
            self._latest_app, self._latest_client = app, cli
            self._last_error = None
            self._last_checked = time.time()
        except Exception as ex:  # noqa: BLE001 — 网络失败保留旧值，不打扰请求路径
            self._last_error = str(ex)[:200]
            self._log(f"[update] 新版本检查失败: {ex}")

    async def run(self) -> None:
        if not self._enabled:
            return
        while True:
            await self.fetch()
            await asyncio.sleep(self._interval)

    # -- 快照 ----------------------------------------------------------------

    def snapshot(self, engine_versions: list[str]) -> dict:
        """/api/update 响应体。has_update：工作台自身落后，或任一已登记服务落后于最新镜像。"""
        latest_app = self._latest_app
        has_update = False
        if latest_app is not None and version_gt(latest_app["version"], self._current):
            has_update = True
        elif latest_app is not None:
            for v in engine_versions:
                if v and version_gt(latest_app["version"], v):
                    has_update = True
                    break
        return {
            "enabled": self._enabled,
            "current": self._current,
            "latest_app": latest_app,
            "latest_client": self._latest_client,
            "has_update": has_update,
            "commands": {
                "docker": "docker compose pull && docker compose up -d",
                "source": "git fetch && git pull && docker compose up -d --build",
            },
            "last_error": self._last_error,
            "last_checked": self._last_checked,
        }
