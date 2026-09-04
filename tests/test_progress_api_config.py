"""Config API tests for the serve /config endpoints (no GPU/models needed).

Run:  python3 tests/test_progress_api_config.py
Covers: X-Api-Key auth (403 unset / 401 wrong / 200 ok), GET masking,
PUT whitelist + type validation, secret keep-on-empty, file persistence
(active profile section + top-level fallback), in-memory hot apply.
"""
from __future__ import annotations

import copy
import json
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.progress_api import ProgressHTTP  # noqa: E402

BASE_CFG = {
    "profile": "server",
    "profiles": {
        "server": {
            "infer": {
                "command": "", "cwd": None, "model": "models/x", "device": "cuda",
                "preset": "gpu_batch", "log_level": "DEBUG", "batch": True,
                "max_batch_size": 8, "extra_args": [],
            },
            "subtitle": {
                "formats": ["srt"], "lang_tag": "zh", "naming": "rename",
                "output_dir": None, "skip_if_exists": True, "overwrite": False,
                "tag_formats": ["srt", "vtt"],
            },
            "polish": {"enabled": False, "base_url": "", "api_key": "", "model": "", "batch_lines": 60},
            "emby": {"enabled": False, "url": "", "api_key": ""},
            "watch": {"dirs": ["/media/jav"], "interval_s": 10, "process_existing": False},
            "jasna": {"enabled": False, "command": "", "output": "{stem}_restored{ext}", "preset": "Default"},
        }
    },
    "progress": {"host": "0.0.0.0", "port": 8300},
}


class FakeEngine:
    """Duck-typed Engine: only cfg/log are exercised by the /config paths."""

    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.jobs: list = []

    def log(self, _msg: str) -> None:
        pass

    def job_by_id(self, _id: str):
        return None

    def retry_job(self, _id: str):
        return None

    def result_srt_bytes(self, _job):
        return None

    def submit_remote_files(self, _files, source_name=None):
        raise NotImplementedError


def _http(method: str, url: str, body: dict | None = None, key: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key is not None:
        req.add_header("X-Api-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as ex:
        raw = ex.read().decode()
        try:
            return ex.code, json.loads(raw)
        except json.JSONDecodeError:
            return ex.code, {"raw": raw}


def _merged() -> dict:
    """Engine's in-memory cfg: the server profile values (loader-equivalent)."""
    return copy.deepcopy({"api": {"key": ""}, **BASE_CFG["profiles"]["server"]})


def _start(td: Path, cfg: dict, file_cfg: dict | None, profile: str = "server"):
    cfg_path = td / "config.json"
    if file_cfg is not None:
        cfg_path.write_text(json.dumps(file_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    engine = FakeEngine(cfg)
    http = ProgressHTTP(
        engine,
        host="127.0.0.1",
        port=0,
        profile=profile,
        inbox_dir=td / "inbox",
        config_path=cfg_path if file_cfg is not None else None,
    )
    http.start()
    return http, engine, cfg_path


def test_auth_and_masking() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()  # no api key yet
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            # 未设置 key -> 403
            code, body = _http("GET", base + "/config")
            assert code == 403 and not body["ok"], (code, body)
            code, _ = _http("PUT", base + "/config", {"values": {"subtitle.lang_tag": "ja"}})
            assert code == 403, code
            # 其余端点维持无鉴权
            code, body = _http("GET", base + "/health")
            assert code == 200 and body["ok"], (code, body)
            # 设置 key
            cfg["api"]["key"] = "k1"
            code, _ = _http("GET", base + "/config")
            assert code == 401, code
            code, _ = _http("GET", base + "/config", key="wrong")
            assert code == 401, code
            code, body = _http("GET", base + "/config", key="k1")
            assert code == 200 and body["ok"] and body["profile"] == "server", (code, body)
            items = {i["path"]: i for i in body["items"]}
            assert len(items) == 21, len(items)  # 18 基础项 + 3 扫描规则项
            assert items["subtitle.lang_tag"]["value"] == "zh"
            assert items["infer.device"]["options"] == ["auto", "cpu", "cuda"]
            # 敏感项打码：未设置 -> ""
            assert items["emby.api_key"]["secret"] and items["emby.api_key"]["value"] == ""
            cfg["emby"]["api_key"] = "sek"
            code, body = _http("GET", base + "/config", key="k1")
            raw = json.dumps(body)
            items = {i["path"]: i for i in body["items"]}
            assert items["emby.api_key"]["value"] == "***"
            assert "sek" not in raw, "secret leaked in GET /config"
        finally:
            http.stop()


def test_put_valid_persists_and_hot_applies() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            cfg["api"]["key"] = "k1"
            code, body = _http(
                "PUT", base + "/config",
                {"values": {
                    "subtitle.lang_tag": "ja",
                    "subtitle.skip_if_exists": False,
                    "infer.device": "cpu",
                    "infer.max_batch_size": 4,
                    "infer.batch": False,
                    "emby.enabled": True,
                    "emby.api_key": "sek",
                }},
                key="k1",
            )
            assert code == 200 and body["ok"], (code, body)
            assert sorted(body["updated"]) == sorted([
                "subtitle.lang_tag", "subtitle.skip_if_exists", "infer.device",
                "infer.max_batch_size", "infer.batch", "emby.enabled", "emby.api_key",
            ])
            # 内存热更
            assert cfg["subtitle"]["lang_tag"] == "ja"
            assert cfg["infer"]["device"] == "cpu"
            assert cfg["infer"]["max_batch_size"] == 4
            assert cfg["emby"]["api_key"] == "sek"
            # 落盘到活动 profile 段
            saved = json.loads(cfg_path.read_text(encoding="utf-8"))
            prof = saved["profiles"]["server"]
            assert prof["subtitle"]["lang_tag"] == "ja"
            assert prof["infer"]["device"] == "cpu"
            assert prof["emby"]["api_key"] == "sek"
            assert saved["profile"] == "server"
            # GET 回读
            code, body = _http("GET", base + "/config", key="k1")
            items = {i["path"]: i for i in body["items"]}
            assert items["subtitle.lang_tag"]["value"] == "ja"
            assert items["emby.api_key"]["value"] == "***"
        finally:
            http.stop()


def test_put_secret_empty_keeps() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        cfg["emby"]["api_key"] = "keepme"
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            code, body = _http("PUT", base + "/config", {"values": {"emby.api_key": ""}}, key="k1")
            assert code == 200 and body["updated"] == [], (code, body)
            assert cfg["emby"]["api_key"] == "keepme"
            saved = json.loads(cfg_path.read_text(encoding="utf-8"))
            assert saved["profiles"]["server"]["emby"]["api_key"] == ""
        finally:
            http.stop()


def test_put_invalid_rejected() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            bad = [
                {"nope.path": "x"},                    # 未知项
                {"subtitle.lang_tag": 123},            # 类型不符
                {"subtitle.lang_tag": "1!"},           # lang_tag 格式
                {"infer.device": "gpu"},               # enum 越界
                {"infer.max_batch_size": 0},           # int 越界
                {"infer.max_batch_size": True},        # bool 冒充 int
                {"infer.max_batch_size": 500},         # 上限
                {"polish.batch_lines": 10000},         # 上限
                {"subtitle.skip_if_exists": "yes"},    # bool 类型
                {"watch.dirs": ["/tmp"]},              # 未暴露项
            ]
            for values in bad:
                code, body = _http("PUT", base + "/config", {"values": values}, key="k1")
                assert code == 400 and not body["ok"], (values, code, body)
            # 非法请求不应落盘
            saved = json.loads(cfg_path.read_text(encoding="utf-8"))
            assert saved["profiles"]["server"]["subtitle"]["lang_tag"] == "zh"
            # body 不是对象
            req = urllib.request.Request(base + "/config", data=b"[]", method="PUT")
            req.add_header("X-Api-Key", "k1")
            req.add_header("Content-Type", "application/json")
            try:
                urllib.request.urlopen(req, timeout=5)
                raise AssertionError("expected 400")
            except urllib.error.HTTPError as ex:
                assert ex.code == 400, ex.code
            # 缺 values 字段
            code, _ = _http("PUT", base + "/config", {}, key="k1")
            assert code == 400, code
        finally:
            http.stop()


def test_persist_top_level_when_no_profile_section() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        file_cfg = {"profile": "default", "subtitle": {"lang_tag": "zh"}, "progress": {"port": 8300}}
        http, engine, cfg_path = _start(td, cfg, file_cfg, profile="default")
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            code, body = _http("PUT", base + "/config", {"values": {"subtitle.lang_tag": "ja"}}, key="k1")
            assert code == 200, (code, body)
            saved = json.loads(cfg_path.read_text(encoding="utf-8"))
            assert "profiles" not in saved
            assert saved["subtitle"]["lang_tag"] == "ja"
        finally:
            http.stop()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  {name} PASSED")
    print("ALL CONFIG API TESTS PASSED")
