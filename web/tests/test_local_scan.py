"""本地扫描（「扫描目录」= 工作台部署所在机器）：规则单元 + API + 字幕回写。

架构约定（2026-09-22 定稿）：服务端只负责模型对接与音轨处理，不做文件交互；
扫描与字幕落盘全部发生在工作台部署机。测试不依赖真实 serve：
monkeypatch JavScribeEngine 的 config / upload_audio / result。
"""
from __future__ import annotations

import asyncio
import copy
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from jav_scribe_web import localscan  # noqa: E402
from jav_scribe_web.api import build_app  # noqa: E402
from jav_scribe_web.engines.javscribe import JavScribeEngine  # noqa: E402
from test_api import _make_store_and_poller, _wait_upload  # noqa: E402

# 结尾空行 = sanitizer 规范形态（保证写回后字节可精确比对）
SRT_OK = (
    "1\n"
    "00:00:00,000 --> 00:00:02,000\n"
    "你好\n"
    "\n"
).encode("utf-8")


# ---------------------------------------------------------------------------
# 规则归一化 / 配置合并
# ---------------------------------------------------------------------------
def test_normalize_rejects_bad_rules() -> None:
    assert localscan.normalize_video_exts("mp4, MKV ,.webm") == ["mp4", "mkv", "webm"]
    assert localscan.normalize_video_exts(["mp4", "mp4", "mkv"]) == ["mp4", "mkv"]
    assert localscan.normalize_subtitle_patterns(["zh.srt", ".srt", "srt"]) == [
        ".zh.srt", ".srt",
    ]
    for bad in ([], ["mp4;bad ext"], ""):
        try:
            localscan.normalize_video_exts(bad)
            raise AssertionError(f"video_exts 应拒绝 {bad!r}")
        except localscan.ScanError:
            pass
    for bad in ([""], [".weird..srt"]):
        try:
            localscan.normalize_subtitle_patterns(bad)
            raise AssertionError(f"subtitle_patterns 应拒绝 {bad!r}")
        except localscan.ScanError:
            pass


def test_cfg_from_items_merges_defaults() -> None:
    # 缺键必须回落到默认规则（不能空集 -> 扫描全空）
    base = localscan.cfg_from_items([])
    assert base == copy.deepcopy(localscan.DEFAULT_SCAN_CFG)
    sc = localscan._scan_cfg(base)
    assert len(sc["exts"]) >= 10 and ".srt" in sc["pats"] and sc["recurse"] is True
    assert sc["min_size_mb"] == 200 and sc["naming_c"] == "no_sub"

    cfg = localscan.cfg_from_items([
        {"path": "scan.video_exts", "value": ["mkv"]},
        {"path": "subtitle.skip_embedded", "value": "off"},
        {"path": "scan.recurse", "value": None},  # None 视为未提供，保持默认
        {"path": "other.noise", "value": 1},
        {"path": "nodot"},
    ])
    assert cfg["scan"]["video_exts"] == ["mkv"]
    assert cfg["scan"]["subtitle_patterns"] == copy.deepcopy(
        localscan.DEFAULT_SCAN_CFG["scan"]["subtitle_patterns"]
    )
    assert cfg["scan"]["recurse"] is True
    assert cfg["subtitle"]["skip_embedded"] == "off"
    assert "other" not in cfg
    # _scan_cfg 吃合配置后规则可用
    sc2 = localscan._scan_cfg(cfg)
    assert sc2["exts"] == {"mkv"} and sc2["recurse"] is True


def test_resolve_scan_root_direct_and_mapped() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "host").mkdir()
        (d / "host" / "media").mkdir()
        saved = os.environ.get("JAVSCRIBE_HOST_ROOT")
        os.environ.pop("JAVSCRIBE_HOST_ROOT", None)
        try:
            root, mapped = localscan.resolve_scan_root(str(d / "host"))
            assert root == d / "host" and mapped is False
            for bad, frag in [
                ("relative/path", "需要绝对路径"),
                ("/definitely/not/here/xyz", "路径不存在"),
            ]:
                try:
                    localscan.resolve_scan_root(bad)
                    raise AssertionError(f"应拒绝 {bad!r}")
                except localscan.ScanError as ex:
                    assert frag in str(ex), (frag, str(ex))
            # 未配置映射前缀：错误信息要能提示
            try:
                localscan.resolve_scan_root("/definitely/not/here/xyz")
                raise AssertionError("应拒绝不存在路径")
            except localscan.ScanError as ex:
                assert "未配置 JAVSCRIBE_HOST_ROOT" in str(ex), str(ex)
        finally:
            if saved is None:
                os.environ.pop("JAVSCRIBE_HOST_ROOT", None)
            else:
                os.environ["JAVSCRIBE_HOST_ROOT"] = saved

        # 配置宿主机映射前缀：字面路径不存在 -> 落到前缀下
        os.environ["JAVSCRIBE_HOST_ROOT"] = str(d)
        try:
            root, mapped = localscan.resolve_scan_root("/host/media")
            assert root == d / "host" / "media" and mapped is True
            try:
                localscan.resolve_scan_root("/host/missing")
                raise AssertionError("映射路径也不存在时应拒绝")
            except localscan.ScanError as ex:
                assert "宿主机映射" in str(ex), str(ex)
        finally:
            if saved is None:
                os.environ.pop("JAVSCRIBE_HOST_ROOT", None)
            else:
                os.environ["JAVSCRIBE_HOST_ROOT"] = saved


def test_scan_dir_external_subtitle_recurse_exts() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "sub").mkdir()
        (d / "a.mp4").write_bytes(b"x")
        (d / "a.zh.srt").write_text(SRT_OK.decode())
        (d / "b.mkv").write_bytes(b"x")
        (d / "sub" / "d.mp4").write_bytes(b"x")
        (d / "e.mp4").write_bytes(b"")  # 空文件排除
        (d / "notes.txt").write_text("no")

        cfg = copy.deepcopy(localscan.DEFAULT_SCAN_CFG)
        cfg["subtitle"]["skip_embedded"] = "off"  # 免 ffprobe，行为确定
        res = localscan.scan_dir(d, cfg)
        names = [it["name"] for it in res["items"]]
        assert names == ["a.mp4", "b.mkv", "d.mp4"], names  # 排序 + recurse + 过滤
        by = {it["name"]: it for it in res["items"]}
        assert by["a.mp4"]["subtitle"] == "a.zh.srt"
        assert by["a.mp4"]["subtitle_status"] == "external"
        assert by["a.mp4"]["has_subtitle"] is True
        assert by["b.mkv"]["subtitle_status"] == "none"
        assert by["b.mkv"]["has_subtitle"] is False
        assert res["path"] == str(d) and res["truncated"] is False

        cfg_nr = copy.deepcopy(cfg)
        cfg_nr["scan"]["recurse"] = False
        assert [it["name"] for it in localscan.scan_dir(d, cfg_nr)["items"]] == [
            "a.mp4", "b.mkv",
        ]

        cfg_mkv = copy.deepcopy(cfg)
        cfg_mkv["scan"]["video_exts"] = ["mkv"]
        assert [it["name"] for it in localscan.scan_dir(d, cfg_mkv)["items"]] == [
            "b.mkv",
        ]


def test_standalone_c_heuristic() -> None:
    hit = ["SSIS-123-C.mp4", "SSIS-123 C.mp4", "SSIS-123_C.mp4",
           "SSIS-123 (c).mkv", "C-SSIS-123.mp4", "ssis-123-c.webm", "SSIS-123.C.mp4"]
    miss = ["SSIS-123C.mp4", "SSIS-123CD2.mp4", "CD1-SSIS-123.mp4", "SSIS-123 1CD.mp4",
            "SSIS-123C2.mp4", "SSIS-123 Uncut.mp4", "SSIS-123 CUT.mp4",
            "300MIUM-1266.mp4", ""]
    for n in hit:
        assert localscan.standalone_c_in(n), n
    for n in miss:
        assert not localscan.standalone_c_in(n), n


def test_scan_min_size_and_naming_c() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "SSIS-123-C.mp4").write_bytes(b"x" * 1000)
        (d / "big.mp4").write_bytes(b"x" * 3 * 1024 * 1024)
        (d / "tiny.mp4").write_bytes(b"x" * 1000)
        cfg = copy.deepcopy(localscan.DEFAULT_SCAN_CFG)
        cfg["subtitle"]["skip_embedded"] = "off"

        # 默认 200MB：全部过小；独立 C 默认 no_sub ⇒ 仅信息标，不触发确认
        by = {i["name"]: i for i in localscan.scan_dir(d, cfg)["items"]}
        assert len(by) == 3 and all(i["too_small"] for i in by.values())
        c = by["SSIS-123-C.mp4"]
        assert c["name_no_sub"] is True and c["name_sub"] is False
        assert c["has_subtitle"] is False and c["subtitle_status"] == "none"

        # 阈值 1MB：只有 1KB 的过小
        cfg["scan"]["min_size_mb"] = 1
        by = {i["name"]: i for i in localscan.scan_dir(d, cfg)["items"]}
        assert by["big.mp4"]["too_small"] is False
        assert by["tiny.mp4"]["too_small"] is True
        # 0 = 不忽略
        cfg["scan"]["min_size_mb"] = 0
        by = {i["name"]: i for i in localscan.scan_dir(d, cfg)["items"]}
        assert not any(i["too_small"] for i in by.values())

        # no_sub：仅信息标，不改变 has_subtitle / 状态
        cfg["scan"]["min_size_mb"] = 1
        cfg["scan"]["naming_c"] = "no_sub"
        by = {i["name"]: i for i in localscan.scan_dir(d, cfg)["items"]}
        c = by["SSIS-123-C.mp4"]
        assert c["name_no_sub"] is True and c["name_sub"] is False
        assert c["has_subtitle"] is False and c["subtitle_status"] == "none"

        # off：不识别
        cfg["scan"]["naming_c"] = "off"
        by = {i["name"]: i for i in localscan.scan_dir(d, cfg)["items"]}
        c = by["SSIS-123-C.mp4"]
        assert c["name_sub"] is False and c["name_no_sub"] is False

        # 优先级：外部 srt > named
        cfg["scan"]["naming_c"] = "has_sub"
        (d / "SSIS-123-C.zh.srt").write_text(SRT_OK.decode())
        by = {i["name"]: i for i in localscan.scan_dir(d, cfg)["items"]}
        c = by["SSIS-123-C.mp4"]
        assert c["subtitle_status"] == "external" and c["subtitle"] == "SSIS-123-C.zh.srt"
        # 过小文件显式提交不拦截
        got = localscan.validate_submit_files([str(d / "tiny.mp4")], cfg)
        assert got == [d / "tiny.mp4"]


def test_scan_probe_failure_explicit() -> None:
    """ffprobe 探测失败 -> 该项 probe_failed=True / probe_errors 含文件名；
    失败不缓存（恢复后重扫重新探测），探测整体关闭时不探测不报错。"""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "A.mp4").write_bytes(b"x" * 100)
        (d / "B.mp4").write_bytes(b"x" * 100)
        cfg = copy.deepcopy(localscan.DEFAULT_SCAN_CFG)
        localscan.clear_probe_cache()
        real = localscan._run_ffprobe

        def boom(p: Path) -> list:
            if p.name == "A.mp4":
                raise localscan.ProbeError("ffprobe 超时（>15s）")
            return []  # B：探测成功但无内嵌轨

        def ok(p: Path) -> list:
            return []

        try:
            localscan._run_ffprobe = boom  # type: ignore[assignment]
            res = localscan.scan_dir(d, cfg)
            # 恢复探测后重扫：A 的失败未写缓存 ⇒ 重新探测成功
            localscan._run_ffprobe = ok  # type: ignore[assignment]
            res2 = localscan.scan_dir(d, cfg)
        finally:
            localscan._run_ffprobe = real  # type: ignore[assignment]

        by = {i["name"]: i for i in res["items"]}
        by2 = {i["name"]: i for i in res2["items"]}
        assert res["probe_errors"] == ["A.mp4"], res["probe_errors"]
        a = by["A.mp4"]
        assert a["probe_failed"] is True
        assert a["subtitle_status"] == "none" and a["has_subtitle"] is False
        assert by["B.mp4"]["probe_failed"] is False
        assert by["B.mp4"]["subtitle_status"] == "none"
        assert res2["probe_errors"] == [], res2["probe_errors"]
        assert by2["A.mp4"]["probe_failed"] is False
        assert by2["A.mp4"]["subtitle_status"] == "none"

        # 探测整体关闭（skip_embedded=off）：不探测、无错误、无失败标记
        cfg_off = copy.deepcopy(cfg)
        cfg_off["subtitle"]["skip_embedded"] = "off"
        res3 = localscan.scan_dir(d, cfg_off)
        assert res3["probe_errors"] == []
        assert all(i["probe_failed"] is False for i in res3["items"])

    # 文件消失（stat 失败）同样 -> None，不抛异常
    assert localscan.probe_embedded_subs("/no/such/vid.mp4") is None


def test_validate_submit_files() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        (d / "a.mp4").write_bytes(b"x")
        (d / "b.mkv").write_bytes(b"x")
        (d / "c.txt").write_text("no")
        cfg = localscan.cfg_from_items([])
        saved = os.environ.get("JAVSCRIBE_HOST_ROOT")
        os.environ.pop("JAVSCRIBE_HOST_ROOT", None)
        try:
            got = localscan.validate_submit_files(
                [str(d / "a.mp4"), str(d / "a.mp4"), str(d / "b.mkv")], cfg
            )
            assert got == [d / "a.mp4", d / "b.mkv"]  # 去重保序
            for bad, frag in [
                ([str(d / "c.txt")], "不是受支持的视频文件"),
                ([str(d / "ghost.mp4")], "文件不存在"),
                (["a.mp4"], "需要绝对路径"),
                ([""], "非法文件路径"),
            ]:
                try:
                    localscan.validate_submit_files(bad, cfg)
                    raise AssertionError(f"应拒绝 {bad!r}")
                except localscan.ScanError as ex:
                    assert frag in str(ex), (frag, str(ex))
            for bad in ([], {}, None):
                try:
                    localscan.validate_submit_files(bad, cfg)
                    raise AssertionError(f"应拒绝 {bad!r}")
                except localscan.ScanError as ex:
                    assert "files" in str(ex), str(ex)
        finally:
            if saved is None:
                os.environ.pop("JAVSCRIBE_HOST_ROOT", None)
            else:
                os.environ["JAVSCRIBE_HOST_ROOT"] = saved

        # 宿主机映射：容器内路径不存在，映射后存在 -> 通过
        os.environ["JAVSCRIBE_HOST_ROOT"] = str(d)
        try:
            got = localscan.validate_submit_files(["/a.mp4"], cfg)
            assert got == [d / "a.mp4"]
        finally:
            if saved is None:
                os.environ.pop("JAVSCRIBE_HOST_ROOT", None)
            else:
                os.environ["JAVSCRIBE_HOST_ROOT"] = saved


# ---------------------------------------------------------------------------
# API：GET /api/scan/local 与 POST /api/scan/local/submit
# ---------------------------------------------------------------------------
def _make_tree(td: str) -> Path:
    d = Path(td) / "media"
    d.mkdir()
    (d / "a.mp4").write_bytes(b"x")
    (d / "b.mkv").write_bytes(b"x")
    (d / "c.txt").write_text("no")
    return d


def test_local_scan_api_rules_and_errors() -> None:
    orig_config = JavScribeEngine.config

    async def fake_unreachable(self):
        raise httpx.ConnectError("boom")

    async def fake_engine_cfg(self):
        return {
            "items": [
                {"path": "scan.video_exts", "value": ["mkv"]},
                {"path": "subtitle.skip_embedded", "value": "off"},
            ],
        }

    try:
        with tempfile.TemporaryDirectory() as td:
            store, _poller = _make_store_and_poller(td)
            media = _make_tree(td)
            JavScribeEngine.config = fake_unreachable  # 引擎不可达 -> 内置默认
            client = TestClient(build_app(store, _poller))
            with client:
                r = client.get(
                    "/api/scan/local",
                    params={"engine": "车间A", "path": str(media)},
                )
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["rules"] == "defaults" and body["mapped"] is False
                assert [it["name"] for it in body["items"]] == ["a.mp4", "b.mkv"]

                # 引擎自定义规则生效
                JavScribeEngine.config = fake_engine_cfg
                r = client.get(
                    "/api/scan/local",
                    params={"engine": "车间A", "path": str(media)},
                )
                body = r.json()
                assert body["rules"] == "engine"
                assert [it["name"] for it in body["items"]] == ["b.mkv"]

                # 错误映射
                assert client.get(
                    "/api/scan/local", params={"engine": "nope", "path": str(media)}
                ).status_code == 404
                r = client.get(
                    "/api/scan/local",
                    params={"engine": "车间A", "path": "relative/x"},
                )
                assert r.status_code == 400 and "需要绝对路径" in r.json()["detail"]
                r = client.get(
                    "/api/scan/local",
                    params={"engine": "车间A", "path": "/no/such/dir"},
                )
                assert r.status_code == 400 and "路径不存在" in r.json()["detail"]

                r = client.post(
                    "/api/scan/local/submit",
                    json={"engine": "车间A", "files": [str(media / "c.txt")]},
                )
                assert r.status_code == 400 and "不是受支持的视频文件" in r.json()["detail"]
                r = client.post(
                    "/api/scan/local/submit",
                    json={"engine": "车间A", "files": []},
                )
                assert r.status_code == 400
                r = client.post("/api/scan/local/submit", json={"engine": "nope"})
                assert r.status_code == 404
    finally:
        JavScribeEngine.config = orig_config


def _make_video(td: str, name: str = "testvid.mp4") -> Path:
    p = Path(td) / name
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
         "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
         "-shortest", str(p)],
        check=True,
    )
    return p


def test_local_scan_api_size_and_naming_overrides() -> None:
    orig_config = JavScribeEngine.config

    async def fake_unreachable(self):
        raise httpx.ConnectError("boom")

    try:
        with tempfile.TemporaryDirectory() as td:
            store, _poller = _make_store_and_poller(td)
            media = Path(td) / "media2"
            media.mkdir()
            (media / "SSIS-123-C.mp4").write_bytes(b"x" * 1000)
            (media / "SSIS-123C.mp4").write_bytes(b"x" * 1000)
            (media / "big.mp4").write_bytes(b"x" * 3 * 1024 * 1024)
            JavScribeEngine.config = fake_unreachable  # 内置默认规则
            client = TestClient(build_app(store, _poller))
            with client:
                # 默认 200MB：全部过小；独立 C 默认 no_sub => 信息标，粘番号 C => none
                r = client.get(
                    "/api/scan/local", params={"engine": "车间A", "path": str(media)})
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["min_size_mb"] == 200 and body["naming_c"] == "no_sub"
                by = {it["name"]: it for it in body["items"]}
                assert all(it["too_small"] for it in by.values())
                assert by["SSIS-123-C.mp4"]["name_no_sub"] is True
                assert by["SSIS-123-C.mp4"]["name_sub"] is False
                assert by["SSIS-123-C.mp4"]["subtitle_status"] == "none"
                assert by["SSIS-123C.mp4"]["name_sub"] is False
                assert by["SSIS-123C.mp4"]["subtitle_status"] == "none"

                # 覆盖：min_size_mb=1 + naming_c=no_sub
                r = client.get(
                    "/api/scan/local",
                    params={"engine": "车间A", "path": str(media),
                            "min_size_mb": 1, "naming_c": "no_sub"},
                )
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["min_size_mb"] == 1 and body["naming_c"] == "no_sub"
                by = {it["name"]: it for it in body["items"]}
                assert by["big.mp4"]["too_small"] is False
                assert by["SSIS-123-C.mp4"]["too_small"] is True
                assert by["SSIS-123-C.mp4"]["name_no_sub"] is True
                assert by["SSIS-123-C.mp4"]["has_subtitle"] is False

                # 非法值 -> 400
                assert client.get(
                    "/api/scan/local",
                    params={"engine": "车间A", "path": str(media), "min_size_mb": -1},
                ).status_code == 400
                assert client.get(
                    "/api/scan/local",
                    params={"engine": "车间A", "path": str(media), "naming_c": "weird"},
                ).status_code == 400
    finally:
        JavScribeEngine.config = orig_config


def _done_job(job_id: str, status: str = "done") -> dict:
    return {
        "id": job_id, "created": 1000.0, "finished": 1060.0,
        "source_kind": "local", "label": "testvid.mp4",
        "total": 1, "done": 1 if status == "done" else 0,
        "skipped": 0, "failed": 1 if status == "error" else 0,
        "state": "finished",
        "files": [{"path": "x", "name": "testvid.opus", "status": status,
                   "phase": status, "progress": 1.0, "message": ""}],
    }


def test_local_submit_pipeline_and_writeback() -> None:
    """本机提交：提 opus（不复制视频）-> 假服务收 opus -> 完成后 srt 落回影片旁。"""
    captured: dict = {}
    orig_upload, orig_result = JavScribeEngine.upload_audio, JavScribeEngine.result

    async def fake_upload_audio(self, audio: bytes, source_name: str) -> dict:
        captured.setdefault("audio", []).append((source_name, audio))
        return {"job_id": "job-ls-1", "cached": False}

    async def fake_result(self, job_id: str) -> tuple[bytes, str]:
        assert job_id == "job-ls-1"
        return SRT_OK, "testvid.zh.srt"

    JavScribeEngine.upload_audio = fake_upload_audio  # type: ignore[method-assign]
    try:
        with tempfile.TemporaryDirectory() as td:
            vid = _make_video(td)
            store, poller = _make_store_and_poller(td)
            client = TestClient(build_app(store, poller))
            with client:
                r = client.post(
                    "/api/scan/local/submit",
                    json={"engine": "车间A", "files": [str(vid)],
                          "sub_status": {str(vid): "named"}},
                )
                assert r.status_code == 200, r.text
                body = r.json()
                assert body["ok"] and body["files"] == 1
                uid = body["upload_ids"][0]

                d = _wait_upload(client, uid)
                assert d["phase"] == "done", d
                assert d["job_id"] == "job-ls-1"
                assert d["local_path"] == str(vid)
                assert d["sub_status"] == "named"
                assert d["writeback"] is None  # 任务表还没看到该 job
                name, audio = captured["audio"][0]
                assert name == "testvid.mp4" and audio[:4] == b"OggS"
                assert vid.is_file()  # 原片未被移动/删除

                # 字幕回写：轮询快照出现 finished job -> tick 写回本机
                poller.jobs["车间A"] = [_done_job("job-ls-1")]
                JavScribeEngine.result = fake_result  # type: ignore[method-assign]
                asyncio.run(poller._on_jobs())
                target = vid.with_name("testvid.zh.srt")
                assert target.is_file() and target.read_bytes() == SRT_OK
                d = client.get(f"/api/uploads/{uid}").json()
                assert d["writeback"] == "ok", d
                # 任务表行带回写状态
                row = next(
                    x for x in client.get("/api/jobs").json()
                    if x["job_id"] == "job-ls-1"
                )
                assert row["writeback"] == "ok"
                assert row["sub_status"] == "named"

                # 二次提交同一视频：字幕已存在 -> skipped_exists（不覆盖）
                r = client.post(
                    "/api/scan/local/submit",
                    json={"engine": "车间A", "files": [str(vid)]},
                )
                uid2 = r.json()["upload_ids"][0]
                _wait_upload(client, uid2)
                target.write_bytes("用户手工改过的字幕".encode("utf-8"))
                asyncio.run(poller._on_jobs())
                assert target.read_bytes() == "用户手工改过的字幕".encode("utf-8")
                d = client.get(f"/api/uploads/{uid2}").json()
                assert d["writeback"] == "skipped_exists", d

                # 生成失败 -> failed 标记
                r = client.post(
                    "/api/scan/local/submit",
                    json={"engine": "车间A", "files": [str(vid)]},
                )
                uid3 = r.json()["upload_ids"][0]
                _wait_upload(client, uid3)
                poller.jobs["车间A"] = [_done_job("job-ls-1", status="error")]
                asyncio.run(poller._on_jobs())
                d = client.get(f"/api/uploads/{uid3}").json()
                assert d["writeback"] and d["writeback"].startswith("failed"), d
    finally:
        JavScribeEngine.upload_audio = orig_upload  # type: ignore[method-assign]
        JavScribeEngine.result = orig_result  # type: ignore[method-assign]


if __name__ == "__main__":
    for _n, _f in sorted(
        (n, f) for n, f in list(globals().items())
        if n.startswith("test_") and callable(f)
    ):
        print(f"  {_n} ... ", flush=True)
        _f()
        print("  ok")
    print("ALL LOCAL SCAN TESTS PASSED")
