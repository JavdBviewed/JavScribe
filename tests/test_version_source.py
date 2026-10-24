"""版本单一真源测试（serve 0.2.14）。

Run:  python3 tests/test_version_source.py
Covers:
- constants.APP_VERSION == jav_scribe.__version__（单一真源，constants 不再硬编码）
- constants.APP_VERSION == pyproject.toml 声明版本（tomllib 读）
- /health 回归：端点报告 version == pyproject 版本（修复 127/158 实跑 0.2.13 却报 0.2.12）
- /ready 同真源：readiness 报告 version 与 /health 一致
"""
from __future__ import annotations

import json
import sys
import tempfile
import tomllib
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe import __version__  # noqa: E402
from jav_scribe.constants import APP_VERSION  # noqa: E402


def _pyproject_version() -> str:
    p = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with p.open("rb") as f:
        return tomllib.load(f)["project"]["version"]


def test_constants_matches_init():
    assert APP_VERSION == __version__, (
        f"constants.APP_VERSION={APP_VERSION!r} != __init__.__version__={__version__!r}"
    )


def test_constants_matches_pyproject():
    v = _pyproject_version()
    assert APP_VERSION == v, f"constants.APP_VERSION={APP_VERSION!r} != pyproject {v!r}"


class _FE:
    """ProgressHTTP /health 所需的最小 engine 面。"""

    def __init__(self) -> None:
        self.cfg = {"infer": {"device": "cpu"}}
        self.jobs = []
        self.paused = False
        self.batch_paused_ids = []

    def log(self, *_a) -> None:
        pass

    def stats(self):
        return {"done": 0, "skipped": 0, "failed": 0, "canceled": 0}


def test_health_reports_pyproject_version():
    from jav_scribe.core.progress_api import ProgressHTTP

    with tempfile.TemporaryDirectory() as td:
        http = ProgressHTTP(_FE(), host="127.0.0.1", port=0, profile="server",
                            inbox_dir=Path(td) / "inbox", config_path=None)
        http.start()
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            with urllib.request.urlopen(base + "/health", timeout=5) as resp:
                assert resp.status == 200
                d = json.loads(resp.read().decode())
            assert d["ok"] is True
            assert d["version"] == _pyproject_version(), (
                f"/health 报 {d['version']!r}，pyproject 声明 {_pyproject_version()!r}"
            )
        finally:
            http.stop()


def test_ready_reports_same_version():
    from jav_scribe.core import readiness

    rep = readiness.build_readiness_report({})
    assert rep["version"] == _pyproject_version()
    assert rep["version"] == APP_VERSION

if __name__ == "__main__":
    test_constants_matches_init()
    print("test_constants_matches_init PASSED")
    test_constants_matches_pyproject()
    print("test_constants_matches_pyproject PASSED")
    test_health_reports_pyproject_version()
    print("test_health_reports_pyproject_version PASSED")
    test_ready_reports_same_version()
    print("test_ready_reports_same_version PASSED")
    print("ALL VERSION SOURCE TESTS PASSED")
