"""Scan API tests for the serve /scan endpoints (no GPU/models needed).

Run:  python3 tests/test_scan_api.py
Covers: X-Api-Key auth (403 unset / 401 wrong), scan listing + subtitle
detection, path validation errors, hot rule updates via /config (list type),
submit queueing + validation, file persistence of scan rules.
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
            "scan": {
                "video_exts": ["mp4", "mkv", "ts"],
                "subtitle_patterns": [".zh.srt", ".srt"],
                "recurse": True,
            },
        }
    },
    "progress": {"host": "0.0.0.0", "port": 8300},
}


class FakeJob:
    def __init__(self, id: str, files: list, source_kind: str, label: str) -> None:
        self.id = id
        self.files = files
        self.source_kind = source_kind
        self.label = label


class FakeEngine:
    """Duck-typed Engine: cfg/log/submit are exercised by /scan paths."""

    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.jobs: list[FakeJob] = []

    def log(self, _msg: str) -> None:
        pass

    def job_by_id(self, _id: str):
        return None

    def retry_job(self, _id: str):
        return None

    def result_srt_bytes(self, _job):
        return None

    def submit(self, files, source_kind="local", label="", run_in_thread=True):
        job = FakeJob(f"job{len(self.jobs) + 1}", list(files), source_kind, label)
        self.jobs.append(job)
        return job


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


def _media(td: Path, name: str = "media") -> Path:
    """A fake media dir: 2 videos w/o subs, 1 with .zh.srt, 1 with .srt,
    1 empty video, 1 non-video file, 1 nested video."""
    m = td / name
    (m / "sub").mkdir(parents=True)
    (m / "a.mp4").write_bytes(b"x" * 10)
    (m / "b.mkv").write_bytes(b"x" * 10)
    (m / "b.zh.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nhi\n", encoding="utf-8")
    (m / "c.ts").write_bytes(b"x" * 10)
    (m / "c.srt").write_text("1\n", encoding="utf-8")
    (m / "empty.mp4").write_bytes(b"")
    (m / "notes.txt").write_text("not a video", encoding="utf-8")
    (m / "sub" / "d.mp4").write_bytes(b"x" * 10)
    return m


def test_scan_auth_and_listing() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        media = _media(td)
        cfg = _merged()
        http, _engine, _ = _start(td, cfg, None)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            # 未设置 key -> 403
            code, body = _http("GET", base + "/scan?path=" + media.as_uri())
            assert code == 403, (code, body)
            code, _ = _http("POST", base + "/scan/submit", {"files": []})
            assert code == 403, code
            # 设置 key 后：错 key 401
            cfg["api"]["key"] = "k1"
            code, _ = _http("GET", base + f"/scan?path={media}")
            assert code == 401, code
            code, _ = _http("GET", base + f"/scan?path={media}", key="wrong")
            assert code == 401, code
            # 对 key：清单（a/d 无字幕，b 有 .zh.srt，c 有 .srt；empty/notes 不在）
            code, body = _http("GET", base + f"/scan?path={media}", key="k1")
            assert code == 200 and body["ok"], (code, body)
            by_name = {i["name"]: i for i in body["items"]}
            assert set(by_name) == {"a.mp4", "b.mkv", "c.ts", "d.mp4"}, by_name.keys()
            assert by_name["a.mp4"]["has_subtitle"] is False
            assert by_name["b.mkv"]["has_subtitle"] is True and by_name["b.mkv"]["subtitle"] == "b.zh.srt"
            assert by_name["c.ts"]["has_subtitle"] is True and by_name["c.ts"]["subtitle"] == "c.srt"
            assert by_name["d.mp4"]["has_subtitle"] is False  # 递归命中子目录
            assert body["truncated"] is False
            print("  test_scan_auth_and_listing PASSED")
        finally:
            http.stop()


def test_scan_path_errors() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        media = _media(td)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        http, _engine, _ = _start(td, cfg, None)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            for q, expect in [
                ("?path=" + (str(media) + "/nope"), 400),       # 不存在
                ("?path=" + str(media / "a.mp4"), 400),          # 不是目录
                ("?path=media", 400),                            # 相对路径
                ("?path=", 400),                                 # 空
            ]:
                code, body = _http("GET", base + "/scan" + q, key="k1")
                assert code == 400 and not body["ok"], (q, code, body)
            print("  test_scan_path_errors PASSED")
        finally:
            http.stop()


def test_scan_rules_hot_update() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        media = _media(td)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        file_cfg = copy.deepcopy(BASE_CFG)
        http, engine, cfg_path = _start(td, cfg, file_cfg)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            # video_exts 收紧到 mp4（逗号字符串形式提交）
            code, body = _http("PUT", base + "/config",
                               {"values": {"scan.video_exts": "MP4, mkv"}}, key="k1")
            assert code == 200 and body["updated"] == ["scan.video_exts"], (code, body)
            assert engine.cfg["scan"]["video_exts"] == ["mp4", "mkv"]  # 归一化+热生效
            code, body = _http("GET", base + f"/scan?path={media}", key="k1")
            assert {i["name"] for i in body["items"]} == {"a.mp4", "b.mkv", "d.mp4"}  # d.mp4 在子目录，recurse 默认开
            # subtitle_patterns 只认 .srt → b.mkv（只有 .zh.srt）不再算有字幕
            code, _ = _http("PUT", base + "/config",
                            {"values": {"scan.subtitle_patterns": ".srt"}}, key="k1")
            assert code == 200, code
            code, body = _http("GET", base + f"/scan?path={media}", key="k1")
            by_name = {i["name"]: i for i in body["items"]}
            assert by_name["b.mkv"]["has_subtitle"] is False
            # 非法列表拒绝
            code, body = _http("PUT", base + "/config",
                               {"values": {"scan.video_exts": "a b"}}, key="k1")
            assert code == 400 and not body["ok"], (code, body)
            code, body = _http("PUT", base + "/config",
                               {"values": {"scan.subtitle_patterns": ""}}, key="k1")
            assert code == 400, (code, body)
            # 持久化进活动 profile 段
            on_disk = json.loads(cfg_path.read_text(encoding="utf-8"))
            assert on_disk["profiles"]["server"]["scan"]["video_exts"] == ["mp4", "mkv"]
            assert on_disk["profiles"]["server"]["scan"]["subtitle_patterns"] == [".srt"]
            # recurse=false：子目录不再进入
            code, _ = _http("PUT", base + "/config",
                            {"values": {"scan.recurse": False, "scan.video_exts": "mp4,mkv,ts"}}, key="k1")
            assert code == 200, code
            code, body = _http("GET", base + f"/scan?path={media}", key="k1")
            assert {i["name"] for i in body["items"]} == {"a.mp4", "b.mkv", "c.ts"}
            print("  test_scan_rules_hot_update PASSED")
        finally:
            http.stop()


def test_scan_submit() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        media = _media(td)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        http, engine, _ = _start(td, cfg, None)
        try:
            base = f"http://127.0.0.1:{http.server.server_address[1]}"
            # 正常入队（含子目录文件）
            code, body = _http("POST", base + "/scan/submit",
                               {"files": [str(media / "a.mp4"), str(media / "sub" / "d.mp4")]},
                               key="k1")
            assert code == 201 and body["ok"] and body["files"] == 2, (code, body)
            assert len(engine.jobs) == 1
            job = engine.jobs[0]
            assert job.source_kind == "local" and job.label == "文件夹扫描 · 2 项"
            assert {str(p) for p in job.files} == {str(media / "a.mp4"), str(media / "sub" / "d.mp4")}
            # 校验失败分支
            for payload in [
                {"files": []},                                   # 空
                {"files": [str(media / "ghost.mp4")]},            # 不存在
                {"files": [str(media / "notes.txt")]},            # 非视频
                {"files": ["media/a.mp4"]},                       # 相对
                {"files": 42},                                    # 非数组
            ]:
                code, body = _http("POST", base + "/scan/submit", payload, key="k1")
                assert code == 400 and not body["ok"], (payload, code, body)
            assert len(engine.jobs) == 1  # 失败的未入队
            print("  test_scan_submit PASSED")
        finally:
            http.stop()



def test_scan_host_root_mapping() -> None:
    """Containerized layout: host fs mounted RO under a prefix (JAVSCRIBE_HOST_ROOT).

    Simulates /:/hostfs:ro with td/hostfs standing in for the host root, so
    "host path" /media lives at td/hostfs/media and is NOT visible literally.
    """
    import os as _os

    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        host_root = td / "hostfs"
        host_root.mkdir()
        # host-side media dir (user path /hst/videos) invisible in "container"
        media = _media(host_root / "hst", name="videos")
        local = td / "local"       # a dir that IS visible in the "container"
        local.mkdir()
        (local / "x.mp4").write_bytes(b"x" * 10)
        cfg = _merged()
        cfg["api"]["key"] = "k1"
        old_env = _os.environ.get("JAVSCRIBE_HOST_ROOT")
        _os.environ["JAVSCRIBE_HOST_ROOT"] = str(host_root)
        try:
            http, engine, _ = _start(td, cfg, None)
            try:
                base = f"http://127.0.0.1:{http.server.server_address[1]}"
                # 字面路径不存在 → 走宿主机映射
                code, body = _http("GET", base + "/scan?path=/hst/videos", key="k1")
                assert code == 200 and body["ok"] and body["mapped"] is True, (code, body)
                assert body["path"] == str(media.resolve()), body["path"]
                assert {i["name"] for i in body["items"]} == {"a.mp4", "b.mkv", "c.ts", "d.mp4"}
                by = {i["name"]: i for i in body["items"]}
                assert by["b.mkv"]["has_subtitle"] is True and by["a.mp4"]["has_subtitle"] is False
                # submit 同样跟随映射（入队的是映射后的真实路径）
                code, body = _http("POST", base + "/scan/submit",
                                   {"files": ["/hst/videos/a.mp4"]}, key="k1")
                assert code == 201 and body["files"] == 1, (code, body)
                assert engine.jobs[0].files[0] == (media / "a.mp4").resolve()
                # 两处都不存在 → 400 且提示宿主机映射
                code, body = _http("GET", base + "/scan?path=/no/such/dir", key="k1")
                assert code == 400 and "宿主机映射" in body["error"], (code, body)
                # 字面可见的路径仍优先（不映射）
                code, body = _http("GET", base + f"/scan?path={local}", key="k1")
                assert code == 200 and body["mapped"] is False, (code, body)
                assert {i["name"] for i in body["items"]} == {"x.mp4"}
                print("  test_scan_host_root_mapping PASSED")
            finally:
                http.stop()
        finally:
            if old_env is None:
                _os.environ.pop("JAVSCRIBE_HOST_ROOT", None)
            else:
                _os.environ["JAVSCRIBE_HOST_ROOT"] = old_env


def main() -> None:
    print("test_scan_api.py")
    test_scan_auth_and_listing()
    test_scan_path_errors()
    test_scan_rules_hot_update()
    test_scan_submit()
    test_scan_host_root_mapping()
    print("ALL SCAN API TESTS PASSED")


if __name__ == "__main__":
    main()
