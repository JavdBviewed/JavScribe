"""Config API tests for the serve /config endpoints (no GPU/models needed).

Run:  python3 tests/test_progress_api_config.py
Covers: X-Api-Key auth (403 unset / 401 wrong / 200 ok), GET masking,
PUT whitelist + type validation, secret keep-on-empty, file persistence
(active profile section + top-level fallback), in-memory hot apply.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import tempfile
import urllib.error
import urllib.parse
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
                "skip_embedded": "target", "embedded_langs": ["zh"], "marker": True,
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
        self.paused = False

    def log(self, _msg: str) -> None:
        pass

    def job_by_id(self, _id: str):
        return None

    def stats(self):
        return {"done": 0, "skipped": 0, "failed": 0}

    def retry_job(self, _id: str):
        return None

    def result_srt_bytes(self, _job):
        return None

    def submit_remote_files(self, _files, source_name=None):
        self.last_source_name = source_name
        return _FakeJob()


class _FakeJob:
    id = "job-fake-1"


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
            assert body["stats"] == {"done": 0, "skipped": 0, "failed": 0}, body.get("stats")
            # 设置 key
            cfg["api"]["key"] = "k1"
            code, _ = _http("GET", base + "/config")
            assert code == 401, code
            code, _ = _http("GET", base + "/config", key="wrong")
            assert code == 401, code
            code, body = _http("GET", base + "/config", key="k1")
            assert code == 200 and body["ok"] and body["profile"] == "server", (code, body)
            items = {i["path"]: i for i in body["items"]}
            # 19 基础项 + 3 内嵌字幕/指纹项 + 3 扫描规则项 + 1 缓存保留项
            # + 5 新增可调项（formats/tag_formats/output_dir/jasna.output/polish.timeout_s）
            assert len(items) == 31, len(items)
            assert items["subtitle.lang_tag"]["value"] == "zh"
            assert items["infer.device"]["options"] == ["auto", "cpu", "cuda"]
            assert items["subtitle.skip_embedded"]["options"] == ["off", "target", "any"]
            assert items["subtitle.skip_embedded"]["value"] in ("off", "target", "any")
            assert items["subtitle.marker"]["value"] in (True, False)
            assert isinstance(items["subtitle.embedded_langs"]["value"], list)
            # 新增项默认值（来自 BASE_CFG）
            assert items["subtitle.formats"]["value"] == ["srt"]
            assert items["subtitle.tag_formats"]["value"] == ["srt", "vtt"]
            assert items["subtitle.output_dir"]["value"] in (None, "")
            assert items["jasna.output"]["value"] == "{stem}_restored{ext}"
            assert items["polish.timeout_s"]["type"] == "int"
            # 每项带帮助文案（客户端 ? 图标悬浮展示）
            for path in ("subtitle.lang_tag", "vad.threshold", "polish.api_key",
                         "subtitle.formats", "jasna.output", "storage.retention_days"):
                assert isinstance(items[path].get("hint"), str) and items[path]["hint"], path
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
                {"storage.retention_days": 0},          # 下限
                {"storage.retention_days": 3651},       # 上限
                {"storage.retention_days": "7"},        # 类型
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


def test_put_retention_days() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            code, body = _http("PUT", base + "/config", {"values": {"storage.retention_days": 30}}, key="k1")
            assert code == 200 and body["ok"], (code, body)
            assert cfg["storage"]["retention_days"] == 30, "热生效"
            items = {i["path"]: i for i in _http("GET", base + "/config", key="k1")[1]["items"]}
            assert items["storage.retention_days"]["value"] == 30
            saved = json.loads(cfg_path.read_text(encoding="utf-8"))
            assert saved["profiles"]["server"]["storage"]["retention_days"] == 30, "落盘"
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


def test_new_config_items_validation() -> None:
    """新增可调项：subtitle.formats / tag_formats / output_dir / jasna.output / polish.timeout_s。"""
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"

            def put(path, value):
                return _http("PUT", base + "/config", {"values": {path: value}}, key="k1")

            # subtitle.formats：逗号串/数组均可；必须含 srt
            code, body = put("subtitle.formats", "srt, vtt")
            assert code == 200 and body["updated"] == ["subtitle.formats"], (code, body)
            assert cfg["subtitle"]["formats"] == ["srt", "vtt"]
            code, _ = put("subtitle.formats", ["srt", "lrc"])
            assert code == 200
            assert cfg["subtitle"]["formats"] == ["srt", "lrc"]
            code, _ = put("subtitle.formats", ["srt"])  # 数组单元素合法
            assert cfg["subtitle"]["formats"] == ["srt"]
            for bad in ("vtt", "srt,ass", "", None, "mp4"):
                code, body = put("subtitle.formats", bad)
                assert code == 400 and not body["ok"], (bad, code, body)
            # 落盘到 active profile
            code, _ = put("subtitle.formats", "srt")
            saved = json.loads(cfg_path.read_text(encoding="utf-8"))
            assert saved["profiles"]["server"]["subtitle"]["formats"] == ["srt"]

            # subtitle.tag_formats：不强制 srt
            code, body = put("subtitle.tag_formats", "vtt")
            assert code == 200 and cfg["subtitle"]["tag_formats"] == ["vtt"]
            code, body = put("subtitle.tag_formats", "srt,ass")
            assert code == 400

            # subtitle.output_dir：普通字符串路径
            code, body = put("subtitle.output_dir", "/data/subs")
            assert code == 200 and cfg["subtitle"]["output_dir"] == "/data/subs"
            code, body = put("subtitle.output_dir", "  ")
            assert code == 200 and cfg["subtitle"]["output_dir"] == ""

            # jasna.output：模板必须含 {stem}/{ext}，不能含路径分隔符
            code, body = put("jasna.output", "{stem}_fixed{ext}")
            assert code == 200 and cfg["jasna"]["output"] == "{stem}_fixed{ext}"
            for bad in ("plain", "{stem}/x{ext}", "x" * 200, ""):
                code, body = put("jasna.output", bad)
                assert code == 400 and not body["ok"], (bad, code, body)

            # polish.timeout_s：5~3600
            code, body = put("polish.timeout_s", 900)
            assert code == 200 and cfg["polish"]["timeout_s"] == 900
            for bad in (0, 4, 3601, "abc", True):
                code, body = put("polish.timeout_s", bad)
                assert code == 400 and not body["ok"], (bad, code, body)
        finally:
            http.stop()


def test_put_vad_threshold_float() -> None:
    """vad.threshold 是 float 项：合法值热更+落盘，越界/错类型拒绝。"""
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            # 默认视图里带该浮点项，值为空（未设置 = 用上游默认 0.5）
            code, body = _http("GET", base + "/config", key="k1")
            items = {i["path"]: i for i in body["items"]}
            assert items["vad.threshold"]["type"] == "float"
            assert items["vad.threshold"]["value"] in (None, "")
            # 合法值：热更 + 落盘 + 回读
            code, b2 = _http("PUT", base + "/config", {"values": {"vad.threshold": 0.3}}, key="k1")
            assert code == 200 and b2["updated"] == ["vad.threshold"], (code, b2)
            assert cfg["vad"]["threshold"] == 0.3
            saved = json.loads(cfg_path.read_text(encoding="utf-8"))
            assert saved["profiles"]["server"]["vad"]["threshold"] == 0.3
            code, b3 = _http("GET", base + "/config", key="k1")
            items = {i["path"]: i for i in b3["items"]}
            assert items["vad.threshold"]["value"] == 0.3
            # 越界 / 错类型
            for bad in (0.0, 1.5, "abc", True, -1):
                code, b4 = _http("PUT", base + "/config", {"values": {"vad.threshold": bad}}, key="k1")
                assert code == 400 and not b4["ok"], (bad, code, b4)
        finally:
            http.stop()


def test_upload_source_name_percent_encoded() -> None:
    """契约回归：客户端对 X-Source-Name 头做 percent-encode(UTF-8)，服务端 unquote。
    此前三端客户端直接塞原始日文头 -> urllib/httpx latin-1 UnicodeEncodeError 全崩。
    """
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = _merged()
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            ja_name = "離婚しない男―サレ夫と悪嫁の騙し愛― 第1話.mkv"
            encoded = urllib.parse.quote(ja_name, safe="")
            assert "%" in encoded and "é" not in encoded and encoded.isascii()
            # PUT /upload：日文 percent-encode 头 -> 引擎收到原样日文名
            audio = b"opus-bytes-ja"
            sha1 = hashlib.sha1(audio).hexdigest()
            req = urllib.request.Request(
                f"{base}/upload?ext=opus&sha1={sha1}", data=audio, method="PUT")
            req.add_header("Content-Type", "application/octet-stream")
            req.add_header("X-Source-Name", encoded)
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = json.loads(resp.read().decode())
            assert resp.status == 201 and body["ok"], (resp.status, body)
            assert engine.last_source_name == ja_name, engine.last_source_name
            # POST /upload/submit（先问后传命中路径）：同一契约
            sub = urllib.request.Request(
                f"{base}/upload/submit?sha1={sha1}&ext=opus", method="POST")
            sub.add_header("X-Source-Name", encoded)
            with urllib.request.urlopen(sub, timeout=5) as resp2:
                body2 = json.loads(resp2.read().decode())
            assert resp2.status == 201 and body2["ok"], (resp2.status, body2)
            assert engine.last_source_name == ja_name, engine.last_source_name
            # 纯 ASCII 名（含空格）不受影响
            ascii_name = "AKDL-342 mkv2"
            req3 = urllib.request.Request(
                f"{base}/upload?ext=opus", data=b"other-audio", method="PUT")
            req3.add_header("X-Source-Name", urllib.parse.quote(ascii_name, safe=""))
            with urllib.request.urlopen(req3, timeout=5) as resp3:
                assert resp3.status == 201
            assert engine.last_source_name == ascii_name, engine.last_source_name
            # 头缺失时回落 query source（旧客户端兼容）
            req4 = urllib.request.Request(
                f"{base}/upload?ext=opus&source=fallback-name", data=b"more", method="PUT")
            with urllib.request.urlopen(req4, timeout=5) as resp4:
                assert resp4.status == 201
            assert engine.last_source_name == "fallback-name", engine.last_source_name
        finally:
            http.stop()


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"  {name} PASSED")
    print("ALL CONFIG API TESTS PASSED")
