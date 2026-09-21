"""09-21 内嵌字幕探测 + JavScribe 指纹单测（无需 GPU/模型）。

Run:  python3 tests/test_subprobe.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import jav_scribe.core.subprobe as subprobe  # noqa: E402
from jav_scribe.core.engine import Engine  # noqa: E402
from jav_scribe.core.finalize import (  # noqa: E402
    append_javscribe_marker,
    javscribe_marker_info,
    render_javscribe_marker,
)
from jav_scribe.core.scan import scan_dir  # noqa: E402
from jav_scribe.core.subprobe import (  # noqa: E402
    norm_language,
    should_skip_embedded,
)
from jav_scribe.core.task import TaskStatus  # noqa: E402
from jav_scribe.core.watch import Watcher  # noqa: E402

SAMPLE_SRT = "1\n00:00:01,000 --> 00:00:02,000\n你好\n\n2\n00:00:05,000 --> 00:00:06,000\n再见\n"


# ---------------------------------------------------------------------------
# 语言归一 / 跳过策略（纯函数）
# ---------------------------------------------------------------------------

def test_norm_language() -> None:
    assert norm_language("chi") == "zh"
    assert norm_language("ZHO") == "zh"
    assert norm_language("jpn") == "ja"
    assert norm_language("JAP") == "ja"
    assert norm_language(None) == "und"
    assert norm_language("") == "und"
    assert norm_language("  ") == "und"
    assert norm_language("Eng") == "eng"
    print("  test_norm_language OK")


def test_should_skip_embedded_matrix() -> None:
    zh = {"skip_embedded": "target", "lang_tag": "zh"}
    # target 模式：ja/und 不挡 zh
    assert should_skip_embedded(zh, ["jpn", None]) == (False, "")
    # chi -> zh 命中
    ok, reason = should_skip_embedded(zh, ["chi"])
    assert ok and "zh" in reason, (ok, reason)
    # embedded_langs 覆盖 lang_tag（多目标库）
    multi = {"skip_embedded": "target", "lang_tag": "zh", "embedded_langs": ["ja"]}
    assert should_skip_embedded(multi, ["jap"])[0] is True
    assert should_skip_embedded(multi, ["chi"])[0] is False
    # embedded_langs 空列表 -> 回落 lang_tag
    empty = {"skip_embedded": "target", "lang_tag": "zh", "embedded_langs": []}
    assert should_skip_embedded(empty, ["chi"])[0] is True
    # any 模式：und 也跳
    any_cfg = {"skip_embedded": "any"}
    ok, reason = should_skip_embedded(any_cfg, [None])
    assert ok and "1 条" in reason
    # off / 未知值 / 空轨
    assert should_skip_embedded({"skip_embedded": "off"}, ["chi"]) == (False, "")
    assert should_skip_embedded({"skip_embedded": "bogus"}, ["chi"]) == (False, "")
    assert should_skip_embedded(zh, []) == (False, "")
    # 缺省 = target
    assert should_skip_embedded({"lang_tag": "zh"}, ["chi"])[0] is True
    print("  test_should_skip_embedded_matrix OK")


# ---------------------------------------------------------------------------
# 探测（monkeypatch _run_ffprobe，含缓存/失败语义）
# ---------------------------------------------------------------------------

def test_probe_cache_and_failure() -> None:
    calls: list[Path] = []

    def fake(path: Path):
        calls.append(path)
        return [{"codec": "subrip", "language": "chi"}]

    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / "a.mkv"
        f.write_bytes(b"x")
        orig = subprobe._run_ffprobe
        subprobe._run_ffprobe = fake
        try:
            r1 = subprobe.probe_embedded_subs(f)
            r2 = subprobe.probe_embedded_subs(f)
        finally:
            subprobe._run_ffprobe = orig
        assert r1 == r2 == [{"codec": "subrip", "language": "chi"}]
        assert len(calls) == 1, "同 (path,size,mtime) 应命中缓存"
        # 文件消失 -> []
        f.unlink()
        assert subprobe.probe_embedded_subs(f) == []


def test_probe_failure_returns_empty() -> None:
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / "bad.mkv"
        f.write_bytes(b"not-a-container")
        orig = subprobe._run_ffprobe
        subprobe._run_ffprobe = lambda p: []  # ffprobe 失败语义
        try:
            assert subprobe.probe_embedded_subs(f) == []
        finally:
            subprobe._run_ffprobe = orig


def test_probe_argv_contract_stream_tags_section() -> None:
    """回归：ffmpeg 7.x 实测 `-show_entries stream=codec_name,tags.language`
    合并写法不输出 tags（language 恒缺失 -> target 模式永不命中）。
    探测必须用独立 stream_tags 段。fake ffprobe 复刻该行为并记录 argv：
    退回合并写法时本测试必失败。"""
    import os as _os
    import stat as _stat

    fake = (
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "argv = sys.argv[1:]\n"
        "rec = os.environ.get('FAKE_FFPROBE_ARGV')\n"
        "if rec:\n"
        "    open(rec, 'a').write(chr(31).join(argv) + chr(10))\n"
        "combined = any(a.startswith('stream=') and 'tags.' in a for a in argv)\n"
        "has_tags_sec = any(a.startswith('stream_tags=') for a in argv)\n"
        "stream = {'codec_name': 'subrip'}\n"
        "if has_tags_sec and not combined:\n"
        "    stream['tags'] = {'language': 'chi'}\n"
        "print(json.dumps({'streams': [stream]}))\n"
    )
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake_bin = tmp / "ffprobe"
        fake_bin.write_text(fake, encoding="utf-8")
        fake_bin.chmod(fake_bin.stat().st_mode | _stat.S_IXUSR | _stat.S_IXGRP | _stat.S_IXOTH)
        rec = tmp / "argv.log"
        video = tmp / "v.mkv"
        video.write_bytes(b"x")
        saved_env = _os.environ.get("FAKE_FFPROBE_ARGV")
        saved = (subprobe._ffprobe_path, subprobe._ffprobe_resolved)
        _os.environ["FAKE_FFPROBE_ARGV"] = str(rec)
        subprobe.reset_ffprobe_cache()
        subprobe._ffprobe_path = str(fake_bin)
        subprobe._ffprobe_resolved = True
        subprobe.clear_probe_cache()
        try:
            subs = subprobe.probe_embedded_subs(video)
        finally:
            subprobe._ffprobe_path, subprobe._ffprobe_resolved = saved
            subprobe.reset_ffprobe_cache()
            subprobe.clear_probe_cache()
            if saved_env is None:
                _os.environ.pop("FAKE_FFPROBE_ARGV", None)
            else:
                _os.environ["FAKE_FFPROBE_ARGV"] = saved_env
        argv = rec.read_text(encoding="utf-8").strip().split("\x1f")
        i = argv.index("-show_entries")
        assert "tags." not in argv[i], f"禁止合并写法: {argv}"
        assert "stream_tags=language" in argv, f"缺 stream_tags 段: {argv}"
        assert subs == [{"codec": "subrip", "language": "chi"}], subs
    print("  test_probe_argv_contract_stream_tags_section OK")


def test_should_skip_embedded_from_probe() -> None:
    """组合语义：und 内嵌轨 + target/zh -> 不跳（emby 库实测场景）。"""
    subs = [{"codec": "subrip", "language": None}, {"codec": "ass", "language": None}]
    cfg = {"skip_embedded": "target", "lang_tag": "zh"}
    assert should_skip_embedded(cfg, [s["language"] for s in subs]) == (False, "")
    assert should_skip_embedded({"skip_embedded": "any"}, [s["language"] for s in subs])[0]
    print("  test_should_skip_embedded_from_probe OK")


# ---------------------------------------------------------------------------
# JavScribe 指纹（渲染/检测/幂等/序号）
# ---------------------------------------------------------------------------

_META = {
    "version": "0.1.5", "engine": "test", "job_id": "20260922-abc123",
    "ts": "2026-09-22T00:03:32+08:00", "audio_sha1": "a" * 40, "src_size": 760332281,
}


def test_marker_render_and_detect() -> None:
    line = render_javscribe_marker(_META)
    assert line.startswith("<!-- jav-scribe v0.1.5")
    assert line.endswith("-->")
    info = javscribe_marker_info("1\n00:00:01,000 --> 00:00:02,000\nx\n" + line + "\n")
    assert info is not None
    assert info["version"] == "0.1.5"
    assert info["fields"]["job"] == "20260922-abc123"
    assert info["fields"]["audio_sha1"] == "a" * 40
    assert info["fields"]["src_size"] == "760332281"
    assert info["fields"]["engine"] == "test"
    # 非 JavScribe 文件 -> None
    assert javscribe_marker_info("1\n00:00:01,000 --> 00:00:02,000\n你好\n") is None
    print("  test_marker_render_and_detect OK")


def test_marker_append_idempotent_and_index() -> None:
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / "a.zh.srt"
        f.write_text(SAMPLE_SRT, encoding="utf-8")
        assert append_javscribe_marker(f, _META) is True
        text = f.read_text(encoding="utf-8")
        assert text.count("<!-- jav-scribe") == 1
        # 正式 cue 保持在前，指纹 cue 序号 = 最大序号 + 1
        lines = [l for l in text.splitlines() if l.strip()]
        assert lines[-3:] == ["3", "00:00:00,000 --> 00:00:00,000", lines[-1]]
        assert lines[-1].startswith("<!-- jav-scribe")
        before = text
        # 幂等：再写一次不动文件
        assert append_javscribe_marker(f, _META) is False
        assert f.read_text(encoding="utf-8") == before
        # 已有指纹（不同元数据）也不覆盖
        meta2 = dict(_META, job_id="20260922-ffff")
        assert append_javscribe_marker(f, meta2) is False
        assert f.read_text(encoding="utf-8") == before
    print("  test_marker_append_idempotent_and_index OK")


# ---------------------------------------------------------------------------
# scan 三态
# ---------------------------------------------------------------------------

def _scan_cfg(sub_cfg: dict) -> dict:
    return {
        "scan": {"video_exts": ["mkv", "mp4"], "subtitle_patterns": [".zh.srt"], "recurse": False},
        "subtitle": sub_cfg,
    }


def test_scan_three_states() -> None:
    def fake(path: Path):
        name = path.name
        if name == "zh.mkv":
            return [{"codec": "subrip", "language": "chi"}]
        if name == "ja.mkv":
            return [{"codec": "hdmv_pgs_subtitle", "language": "jpn"}]
        if name == "und.mkv":
            return [{"codec": "subrip", "language": None}]
        return []

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for n in ("zh.mkv", "ja.mkv", "und.mkv", "clean.mp4", "extvid.mkv"):
            (tmp / n).write_bytes(b"x")
        (tmp / "extvid.zh.srt").write_text("x", encoding="utf-8")
        orig = subprobe._run_ffprobe
        subprobe._run_ffprobe = fake
        try:
            out = scan_dir(tmp, _scan_cfg({"skip_embedded": "target", "lang_tag": "zh"}))
        finally:
            subprobe._run_ffprobe = orig
        items = {i["name"]: i for i in out["items"]}
        assert items["extvid.mkv"]["subtitle_status"] == "external"
        assert items["extvid.mkv"]["has_subtitle"] is True
        assert items["zh.mkv"]["subtitle_status"] == "embedded"
        assert items["zh.mkv"]["embedded_langs"] == ["zh"]
        assert items["zh.mkv"]["has_subtitle"] is True, "target 命中应计入 has_subtitle"
        assert items["ja.mkv"]["subtitle_status"] == "embedded"
        assert items["ja.mkv"]["embedded_langs"] == ["ja"]
        assert items["ja.mkv"]["has_subtitle"] is False, "ja 内嵌不挡 zh"
        assert items["und.mkv"]["subtitle_status"] == "embedded"
        assert items["und.mkv"]["embedded_langs"] == ["und"]
        assert items["und.mkv"]["has_subtitle"] is False
        assert items["clean.mp4"]["subtitle_status"] == "none"
        assert items["clean.mp4"]["has_subtitle"] is False

        # any 模式：ja/und 也计入 has_subtitle
        subprobe._run_ffprobe = fake
        try:
            out = scan_dir(tmp, _scan_cfg({"skip_embedded": "any"}))
        finally:
            subprobe._run_ffprobe = orig
        items = {i["name"]: i for i in out["items"]}
        for n in ("zh.mkv", "ja.mkv", "und.mkv"):
            assert items[n]["has_subtitle"] is True
        # off 模式：不探测，内嵌不体现
        calls: list = []
        subprobe._run_ffprobe = lambda p: calls.append(p) or []
        try:
            out = scan_dir(tmp, _scan_cfg({"skip_embedded": "off"}))
        finally:
            subprobe._run_ffprobe = orig
        items = {i["name"]: i for i in out["items"]}
        assert items["zh.mkv"]["subtitle_status"] == "none"
        assert items["zh.mkv"]["has_subtitle"] is False
        assert not calls, "off 模式不应探测"
    print("  test_scan_three_states OK")


# ---------------------------------------------------------------------------
# watch 候选过滤
# ---------------------------------------------------------------------------

def test_watch_filters_embedded_target() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        keep = d / "clean.mkv"
        drop = d / "zh.mkv"
        keep.write_bytes(b"x")
        drop.write_bytes(b"x")
        calls: list[Path] = []

        def fake(path: Path):
            calls.append(path)
            return [{"codec": "subrip", "language": "chi"}] if path.name == "zh.mkv" else []

        orig = subprobe._run_ffprobe
        subprobe._run_ffprobe = fake
        try:
            got: list[Path] = []
            w = Watcher([d], interval_s=9999, process_existing=False,
                        log=lambda _s: None, on_new_files=got.extend,
                        sub_cfg={"skip_embedded": "target", "lang_tag": "zh"})
            assert w.scan_once() == []
            assert w.scan_once() == [keep], "内嵌 zh 的候选应被过滤"
            assert got == [keep]
        finally:
            subprobe._run_ffprobe = orig
        # off 模式不过滤
        with tempfile.TemporaryDirectory() as td2:
            d2 = Path(td2)
            f2 = d2 / "zh.mkv"
            f2.write_bytes(b"x")
            subprobe._run_ffprobe = fake
            got2: list[Path] = []
            w2 = Watcher([d2], interval_s=9999, process_existing=False,
                         log=lambda _s: None, on_new_files=got2.extend,
                         sub_cfg={"skip_embedded": "off"})
            try:
                w2.scan_once()
                assert w2.scan_once() == [f2]
            finally:
                subprobe._run_ffprobe = orig
    print("  test_watch_filters_embedded_target OK")


# ---------------------------------------------------------------------------
# engine：内嵌跳过 / retry 放行 / 指纹写入
# ---------------------------------------------------------------------------

def _engine_cfg(tmp: Path, code: str, sub_extra: dict | None = None) -> dict:
    fake = tmp / "fake_infer.py"
    fake.write_text(code, encoding="utf-8")
    cfg = {
        "infer": {"command": f"{sys.executable} {fake}", "model": "models",
                  "device": "cpu", "log_level": "DEBUG"},
        "subtitle": {
            "formats": ["srt"], "lang_tag": "zh", "naming": "rename",
            "output_dir": None, "skip_if_exists": True, "overwrite": False,
            "tag_formats": ["srt"], "skip_embedded": "target",
            "embedded_langs": ["zh"], "marker": True,
        },
        "polish": {"enabled": False},
        "emby": {"enabled": False},
        "jasna": {"enabled": False},
    }
    if sub_extra:
        cfg["subtitle"].update(sub_extra)
    return cfg


_FAKE_OK = (
    "import sys, pathlib\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    'print("找到 %d 个文件待处理" % len(files))\n'
    "for i, f in enumerate(files, 1):\n"
    '    print("正在翻译 (%d/%d)：%s" % (i, len(files), f))\n'
    "    out = pathlib.Path(f).with_suffix('.srt')\n"
    '    out.write_text("1\\n00:00:30,000 --> 00:01:00,000\\n你好\\n", encoding="utf-8")\n'
    '    print("正在写入：%s" % out)\n'
    'print("全部完成")\n'
)


def test_engine_skips_embedded_target() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        cfg = _engine_cfg(tmp, _FAKE_OK)
        engine = Engine(cfg, log=lambda _s: None, profile="test")
        orig = subprobe._run_ffprobe
        subprobe._run_ffprobe = lambda p: [{"codec": "subrip", "language": "chi"}]
        try:
            job = engine.submit([video], run_in_thread=False)
        finally:
            subprobe._run_ffprobe = orig
        t = job.files[0]
        assert t.status == TaskStatus.SKIPPED, t.to_dict()
        assert "内嵌" in t.message, t.message
        assert t.progress == 1.0
        # 未产出任何字幕
        assert not list(tmp.glob("*.srt"))
    print("  test_engine_skips_embedded_target OK")


def test_engine_mixed_batch_skip_checks_not_bypassed() -> None:
    """回归：批量推理会把全部 PENDING 文件拉进首批，若跳过检查滞后于批次，
    排在可处理文件之后的「内嵌目标语言 / 已存在字幕」文件会被顺带生成。
    预检必须在任何推理前完成。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        clean = tmp / "clean.mkv"
        clean.write_bytes(b"fake")
        embedded = tmp / "embedded-zh.mkv"
        embedded.write_bytes(b"fake")
        ext = tmp / "ext.mkv"
        ext.write_bytes(b"fake")
        ext.with_name("ext.zh.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\n已有\n", encoding="utf-8")
        cfg = _engine_cfg(tmp, _FAKE_OK)
        engine = Engine(cfg, log=lambda _s: None, profile="test")

        def fake_probe(path):
            if path.name == "embedded-zh.mkv":
                return [{"codec": "subrip", "language": "chi"}]
            return []

        orig = subprobe._run_ffprobe
        subprobe._run_ffprobe = fake_probe
        try:
            job = engine.submit([clean, embedded, ext], run_in_thread=False)
        finally:
            subprobe._run_ffprobe = orig
        by_name = {t.path.name: t for t in job.files}
        assert by_name["clean.mkv"].status == TaskStatus.DONE, by_name["clean.mkv"].to_dict()
        t = by_name["embedded-zh.mkv"]
        assert t.status == TaskStatus.SKIPPED, t.to_dict()
        assert "内嵌" in t.message, t.message
        t = by_name["ext.mkv"]
        assert t.status == TaskStatus.SKIPPED, t.to_dict()
        assert "已存在" in t.message, t.message
        # 内嵌/已存在文件不得产出任何字幕
        assert not (tmp / "embedded-zh.srt").exists()
        assert not (tmp / "ext.srt").exists()
        assert (tmp / "clean.zh.srt").is_file()
    print("  test_engine_mixed_batch_skip_checks_not_bypassed OK")


def test_engine_processes_ja_embedded() -> None:
    """内嵌 ja 不挡 zh 生成（JAV 库主场景）。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        engine = Engine(_engine_cfg(tmp, _FAKE_OK), log=lambda _s: None, profile="test")
        orig = subprobe._run_ffprobe
        subprobe._run_ffprobe = lambda p: [{"codec": "hdmv_pgs_subtitle", "language": "jpn"}]
        try:
            job = engine.submit([video], run_in_thread=False)
        finally:
            subprobe._run_ffprobe = orig
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        assert video.with_name("demo.zh.srt").is_file()
    print("  test_engine_processes_ja_embedded OK")


def test_engine_retry_embedded_forces_regenerate() -> None:
    """「仍要重新生成」对内嵌跳过的任务：放行内嵌判定、真正产出。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        engine = Engine(_engine_cfg(tmp, _FAKE_OK), log=lambda _s: None, profile="test")
        orig = subprobe._run_ffprobe
        subprobe._run_ffprobe = lambda p: [{"codec": "subrip", "language": "chi"}]
        try:
            job = engine.submit([video], run_in_thread=False)
            assert job.files[0].status == TaskStatus.SKIPPED
            new_job = engine.retry_job(job.id)
            assert new_job is not None
            deadline = time.time() + 30
            while time.time() < deadline and new_job.files[0].status not in (
                TaskStatus.DONE, TaskStatus.ERROR, TaskStatus.CANCELED
            ):
                time.sleep(0.05)
            assert new_job.files[0].status == TaskStatus.DONE, new_job.files[0].to_dict()
            # force 一次性：删掉刚生成的 srt，再正常提交会重新被内嵌判定跳过
            zh = video.with_name("demo.zh.srt")
            zh.unlink()
            job3 = engine.submit([video], run_in_thread=False)
            assert job3.files[0].status == TaskStatus.SKIPPED, job3.files[0].to_dict()
            assert "内嵌" in job3.files[0].message, job3.files[0].message
        finally:
            subprobe._run_ffprobe = orig
    print("  test_engine_retry_embedded_forces_regenerate OK")


def test_engine_marker_written_and_marker_off() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fakefake")  # 8 字节，指纹里可核对
        engine = Engine(_engine_cfg(tmp, _FAKE_OK), log=lambda _s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE
        zh = video.with_name("demo.zh.srt")
        info = javscribe_marker_info(zh.read_text(encoding="utf-8"))
        assert info is not None, "默认 marker=true 应写指纹"
        assert info["version"] == "0.1.5"
        assert info["fields"]["engine"] == "test"
        assert info["fields"]["job"] == job.id
        assert info["fields"]["audio_sha1"] == "-"  # 本地无音轨产物
        assert info["fields"]["src_size"] == "8"
        # 正文 cue 仍在
        assert "你好" in zh.read_text(encoding="utf-8")
    # marker=false 不写
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo2.mkv"
        video.write_bytes(b"fakefake")
        engine = Engine(_engine_cfg(tmp, _FAKE_OK, {"marker": False}),
                        log=lambda _s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE
        text = video.with_name("demo2.zh.srt").read_text(encoding="utf-8")
        assert javscribe_marker_info(text) is None, "marker=false 不应写指纹"
    print("  test_engine_marker_written_and_marker_off OK")


def test_inbox_upload_audio_sha1_in_marker() -> None:
    """远程 inbox 上传（<sha1>.opus）：指纹 audio_sha1 = 文件名 stem。"""
    import hashlib

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        sha = hashlib.sha1(b"opus-bytes").hexdigest()
        audio = tmp / f"{sha}.opus"
        audio.write_bytes(b"opus-bytes")
        engine = Engine(_engine_cfg(tmp, _FAKE_OK), log=lambda _s: None, profile="test")
        job = engine.submit([audio], source_kind="remote", label="testsrc", run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        zh = audio.with_name(f"{sha}.zh.srt")
        assert zh.is_file()
        info = javscribe_marker_info(zh.read_text(encoding="utf-8"))
        assert info["fields"]["audio_sha1"] == sha, info
    print("  test_inbox_upload_audio_sha1_in_marker OK")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("ALL OK")
