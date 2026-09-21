"""emby.refresh_for_video 匹配策略单测（fake _req，不发真请求）。

Run: python3 tests/test_emby.py
覆盖：
- Movie 经 SearchTerm(stem) 命中 → 刷新，日志 search=候选
- TV episode（SearchTerm 0 命中）→ 分页全量扫第 2 页命中
- 全量扫跨页（首页满 500 条不命中 → 次页命中）
- 全库扫完仍未命中 → False + "未在媒体库中找到"
- 超过 20 页上限 → 放弃（False，无异常）
- Refresh POST 失败 → False + "刷新失败"
- search 请求异常 → 兜底全量扫仍可命中
"""
from __future__ import annotations

import re
import sys
import urllib.parse
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core import emby  # noqa: E402


class FakeEmby:
    """按 (method, path) 脚本化响应。记录全部请求。"""

    def __init__(self, pages: list[list[dict]] | None = None,
                 search: dict[str, list[dict]] | None = None,
                 refresh_exc: Exception | None = None,
                 search_exc: Exception | None = None) -> None:
        self.pages = pages or []  # 全量扫分页序列
        self.search = search or {}  # SearchTerm -> items
        self.refresh_exc = refresh_exc
        self.search_exc = search_exc
        self.requests: list[tuple[str, str]] = []
        self.refreshed: list[str] = []

    def _items(self, cfg, method, path):
        self.requests.append((method, path))
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
        if method == "POST":
            if self.refresh_exc:
                raise self.refresh_exc
            m = re.match(r"/Items/(\w+)/Refresh$", path)
            self.refreshed.append(m.group(1) if m else "")
            return {}
        if "SearchTerm" in qs:
            if self.search_exc:
                raise self.search_exc
            term = qs["SearchTerm"][0]
            return {"Items": self.search.get(term, [])}
        # 全量扫：按 StartIndex 切片
        start = int(qs.get("StartIndex", ["0"])[0])
        idx = start // emby._FULL_PAGE_SIZE
        if idx < len(self.pages):
            return {"Items": self.pages[idx]}
        return {"Items": []}


def _cfg() -> emby.EmbyConfig:
    return emby.EmbyConfig(url="http://emby:8096/Emby", api_key="k")


def _item(iid: str, path: str, name: str = "") -> dict:
    return {"Id": iid, "Name": name, "Path": path}


MOVIE = Path("/media/Movies/XVT-030.mp4")
EP = Path("/media/TV/Breaking Bad/Season 1/Breaking.Bad.S01E01.mp4")


def test_movie_hit_via_search_stem(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeEmby(search={"XVT-030": [_item("A1", "/media/Movies/XVT-030.mp4", "XVT-030 标题")]})
    monkeypatch.setattr(emby, "_req", fake._items)
    logs: list[str] = []
    assert emby.refresh_for_video(_cfg(), MOVIE, log=logs.append) is True
    assert fake.refreshed == ["A1"]
    assert any("命中策略=search=XVT-030" in l for l in logs)


def test_episode_falls_back_to_fullscan(monkeypatch: pytest.MonkeyPatch) -> None:
    full = [_item("E1", "/media/TV/Breaking Bad/Season 1/Breaking.Bad.S01E01.mp4", "Pilot")]
    fake = FakeEmby(pages=[full], search={})  # SearchTerm 全 0 命中
    monkeypatch.setattr(emby, "_req", fake._items)
    logs: list[str] = []
    assert emby.refresh_for_video(_cfg(), EP, log=logs.append) is True
    assert fake.refreshed == ["E1"]
    assert any("命中策略=fullscan 第 1 页" in l for l in logs)
    # search 候选确实发过（stem 与完整文件名）
    search_terms = [r[1] for r in fake.requests if "SearchTerm" in r[1]]
    assert any("SearchTerm=Breaking.Bad.S01E01" in u for u in search_terms)
    # Path 字段必须显式请求（Items API 默认响应不含 Path）
    assert all("Fields=Path" in u for u in search_terms)
    scan_reqs = [r[1] for r in fake.requests if "StartIndex" in r[1]]
    assert scan_reqs and all("Fields=Path" in u for u in scan_reqs)


def test_fullscan_pagination_cross_page(monkeypatch: pytest.MonkeyPatch) -> None:
    page1 = [_item(f"P{i}", f"/media/x{i}.mkv") for i in range(emby._FULL_PAGE_SIZE)]
    target = _item("T9", "/media/TV/JUR/Season 1/JUR-667.mp4", "第 3 集")
    fake = FakeEmby(pages=[page1, [target]], search={})
    monkeypatch.setattr(emby, "_req", fake._items)
    assert emby.refresh_for_video(_cfg(), Path("/media/TV/JUR/Season 1/JUR-667.mp4")) is True
    assert fake.refreshed == ["T9"]


def test_not_found_exhausts_library(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeEmby(pages=[[_item("O1", "/media/Movies/other.mp4")]], search={})
    monkeypatch.setattr(emby, "_req", fake._items)
    logs: list[str] = []
    assert emby.refresh_for_video(_cfg(), Path("/media/Movies/ghost.mp4"), log=logs.append) is False
    assert fake.refreshed == []
    assert any("未在媒体库中找到" in l for l in logs)


def test_fullscan_page_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    # 每页都满 → 永远扫不完；必须在上限内放弃且不抛异常
    full_page = [_item(f"C{i}", f"/media/c{i}.mkv") for i in range(emby._FULL_PAGE_SIZE)]
    fake = FakeEmby(pages=[full_page] * (emby._MAX_FULL_PAGES + 2), search={})
    monkeypatch.setattr(emby, "_req", fake._items)
    logs: list[str] = []
    assert emby.refresh_for_video(_cfg(), Path("/media/ghost.mp4"), log=logs.append) is False
    scan_reqs = [r for r in fake.requests if "StartIndex" in r[1]]
    assert len(scan_reqs) == emby._MAX_FULL_PAGES
    assert any("上限" in l for l in logs)


def test_refresh_post_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeEmby(search={"XVT-030": [_item("A1", "/media/Movies/XVT-030.mp4")]},
                    refresh_exc=OSError("boom"))
    monkeypatch.setattr(emby, "_req", fake._items)
    logs: list[str] = []
    assert emby.refresh_for_video(_cfg(), MOVIE, log=logs.append) is False
    assert any("刷新失败" in l for l in logs)


def test_search_error_falls_back_to_fullscan(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeEmby(pages=[[_item("E2", "/media/Movies/XVT-030.mp4", "XVT-030")]],
                    search_exc=OSError("search down"))
    monkeypatch.setattr(emby, "_req", fake._items)
    logs: list[str] = []
    assert emby.refresh_for_video(_cfg(), MOVIE, log=logs.append) is True
    assert any("search 查询失败" in l for l in logs)
    assert fake.refreshed == ["E2"]
