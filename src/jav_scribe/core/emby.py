"""Optional Emby integration: trigger a metadata/subtitle refresh for a video
after we drop a new external subtitle next to it. Uses only the public
Emby REST API with an API key (X-Emby-Token).

匹配策略（09-22 修复）：
1. 多候选 SearchTerm（stem、完整文件名）——Emby SearchTerm 只匹配 Name 类
   字段，不匹配 Path/文件名。Movie 的 Name 以番号开头（= stem），可命中；
2. 仍未命中则分页全量扫（IncludeItemTypes=Video,Movie,Episode，
   Limit=500/页，上限 20 页）按 Path.endswith('/'+name) 匹配——TV episode
   的 Name 是剧集标题（如 "Pilot"），SearchTerm 必 0 命中，只能靠全量扫
   的 Path 匹配兜底。
注意：Items API 默认响应不含 Path 字段（实测 09-22），查询必须带
Fields=Path，否则即便 search 命中也无法按路径匹配（旧版两层 bug 之一）。
命中策略会记入日志（search=<候选> / fullscan 第 N 页）。
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

_FULL_PAGE_SIZE = 500
_MAX_FULL_PAGES = 20  # 上限 10000 项，超出记日志并放弃（库更大时应先修索引）
_ITEM_TYPES = "Video,Movie,Episode"


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


def _match_by_path(items: list[dict], name: str) -> Optional[dict]:
    """首个 Path 以 '/<文件名>' 结尾的 item（容器内路径，统一 / 分隔）。"""
    for it in items:
        p = (it.get("Path") or "").replace("\\", "/")
        if p and p.endswith("/" + name):
            return it
    return None


def _search_candidates(video: Path) -> list[str]:
    cands: list[str] = []
    for c in (video.stem, video.name):
        c = (c or "").strip()
        if c and c not in cands:
            cands.append(c)
    return cands


def _find_by_search(cfg: EmbyConfig, video: Path) -> Optional[tuple[dict, str]]:
    """策略 1：多候选 SearchTerm。返回 (item, 命中的候选) 或 None。"""
    for cand in _search_candidates(video):
        data = _req(
            cfg,
            "GET",
            "/Items?Recursive=true&Limit=200&IncludeItemTypes="
            + _ITEM_TYPES
            + "&Fields=Path"
            + "&SearchTerm=" + urllib.parse.quote(cand),
        )
        target = _match_by_path(data.get("Items") or [], video.name)
        if target is not None:
            return target, f"search={cand}"
    return None


def _find_by_fullscan(cfg: EmbyConfig, video: Path, log: Callable[[str], None]) -> Optional[tuple[dict, str]]:
    """策略 2：分页全量扫，按 Path 匹配。返回 (item, 页描述) 或 None。"""
    for page in range(_MAX_FULL_PAGES):
        start = page * _FULL_PAGE_SIZE
        data = _req(
            cfg,
            "GET",
            f"/Items?Recursive=true&IncludeItemTypes={_ITEM_TYPES}"
            f"&Fields=Path&Limit={_FULL_PAGE_SIZE}&StartIndex={start}",
        )
        items = data.get("Items") or []
        target = _match_by_path(items, video.name)
        if target is not None:
            return target, f"fullscan 第 {page + 1} 页"
        if len(items) < _FULL_PAGE_SIZE:
            return None  # 已扫完全部
    log(f"[emby] 全量扫达到 {_MAX_FULL_PAGES * _FULL_PAGE_SIZE} 项上限，未继续（库更大时应先修索引）")
    return None


def refresh_for_video(cfg: EmbyConfig, video: Path, log: Optional[Callable[[str], None]] = None) -> bool:
    """Find the library item for this file (search → fullscan 兜底) and refresh it."""
    logf = log or (lambda _s: None)
    if not cfg.usable:
        return False
    name = video.name

    hit: Optional[tuple[dict, str]] = None
    searched: list[str] = []
    try:
        hit = _find_by_search(cfg, video)
        searched = _search_candidates(video)
    except Exception as e:
        logf(f"[emby] search 查询失败: {e}")
        hit = None
    if hit is None:
        try:
            hit = _find_by_fullscan(cfg, video, logf)
        except Exception as e:
            logf(f"[emby] 全量扫失败: {e}")
            hit = None
    if hit is None:
        logf(f"[emby] 未在媒体库中找到 {name}（search 候选 {searched or '无'} + 全量扫）")
        return False
    target, how = hit
    try:
        _req(cfg, "POST", f"/Items/{target['Id']}/Refresh")
        logf(f"[emby] 已请求刷新 {name}（命中策略={how}）")
        return True
    except Exception as e:
        logf(f"[emby] 刷新失败: {e}")
        return False
