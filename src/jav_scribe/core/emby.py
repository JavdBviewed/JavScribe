"""Optional Emby integration: trigger a metadata/subtitle refresh for a video
after we drop a new external subtitle next to it. Uses only the public
Emby REST API with an API key (X-Emby-Token).
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


@dataclass
class EmbyConfig:
    url: str
    api_key: str
    timeout_s: int = 30

    @property
    def usable(self) -> bool:
        return bool(self.url and self.api_key)


def _req(cfg: EmbyConfig, method: str, path: str, body: bytes | None = None) -> dict:
    req = urllib.request.Request(
        cfg.url.rstrip("/") + path,
        data=body,
        headers={"X-Emby-Token": cfg.api_key},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=cfg.timeout_s) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def refresh_for_video(cfg: EmbyConfig, video: Path, log: Optional[Callable[[str], None]] = None) -> bool:
    """Find the library item whose path ends with this file and refresh it."""
    logf = log or (lambda _s: None)
    if not cfg.usable:
        return False
    try:
        data = _req(
            cfg,
            "GET",
            "/Items?Recursive=true&Limit=200&SearchTerm="
            + urllib.parse.quote(video.stem),
        )
    except Exception as e:
        logf(f"[emby] 查询失败: {e}")
        return False
    items = data.get("Items") or []
    name = video.name
    target = None
    for it in items:
        p = (it.get("Path") or "").replace("\\", "/")
        if p and p.endswith("/" + name):
            target = it
            break
    if target is None:
        logf(f"[emby] 未在媒体库中找到 {name}")
        return False
    try:
        _req(cfg, "POST", f"/Items/{target['Id']}/Refresh")
        logf(f"[emby] 已请求刷新 {name}")
        return True
    except Exception as e:
        logf(f"[emby] 刷新失败: {e}")
        return False
