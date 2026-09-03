"""Smoke tests: fake ChickenRice stdout -> Engine -> finalize.

No models/GPU needed. Run:  python3 tests/test_pipeline_smoke.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from textwrap import dedent
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.engine import Engine  # noqa: E402
from jav_scribe.core.task import TaskStatus  # noqa: E402


def _base_cfg(fake: Path) -> dict:
    return {
        "infer": {
            "command": f"{sys.executable} {fake}",
            "model": "models",
            "device": "cpu",
            "log_level": "DEBUG",
        },
        "subtitle": {
            "formats": ["srt"],
            "lang_tag": "zh",
            "naming": "rename",
            "output_dir": None,
            "skip_if_exists": True,
            "overwrite": False,
            "tag_formats": ["srt"],
        },
        "polish": {"enabled": False},
        "emby": {"enabled": False},
        "jasna": {"enabled": False},
    }


# Fake engine #1: honest logging (writes exactly what it announces)
FAKE_OK = (
    "import sys, pathlib\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    'print("找到 %d 个文件待处理" % len(files))\n'
    'print("正在加载 Whisper 模型")\n'
    'print("模型运行精度：float16，设备：cuda")\n'
    'print("增强 VAD 已激活")\n'
    "for i, f in enumerate(files, 1):\n"
    '    print("正在翻译 (%d/%d)：%s" % (i, len(files), f))\n'
    '    print("时长：1小时2分钟 → 30分钟")\n'
    '    print("[0:30 --> 1:00] こんにちは")\n'
    '    print("[1:30 --> 2:00] 再见")\n'
    "    out = pathlib.Path(f).with_suffix('.srt')\n"
    '    out.write_text("1\\n00:00:30,000 --> 00:01:00,000\\n你好\\n\\n2\\n00:01:30,000 --> 00:02:00,000\\n再见\\n", encoding="utf-8")\n'
    '    print("正在写入：%s" % out)\n'
    'print("全部完成")\n'
)

# Fake engine #2: logs a path that differs from what it writes
# (drops the container extension in the real file name)
FAKE_LIE = (
    "import sys, pathlib\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    "for f in files:\n"
    "    p = pathlib.Path(f)\n"
    '    print("正在翻译 (1/1)：%s" % f)\n'
    '    print("时长：1小时2分钟 → 30分钟")\n'
    '    print("[0:30 --> 1:00] テスト")\n'
    "    (p.parent / (p.stem + '.srt')).write_text('x\\n00:00:30,000 --> 00:01:00,000\\n你好\\n', encoding='utf-8')\n"
    '    print("正在写入：%s.srt" % p)  # logs full name + .srt, wrote <stem>.srt\n'
)

# Fake engine #3: English stdout (ChickenRice v1.9 inside Docker / EN locale)
FAKE_EN = (
    "import sys, pathlib\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    'print("Loading Whisper model...")\n'
    'print("Found %d files to process" % len(files))\n'
    "for i, f in enumerate(files, 1):\n"
    '    print("Processing (translate) (%d/%d): %s" % (i, len(files), f))\n'
    '    print("Duration: 30.00s")\n'
    '    print("[0:30 --> 1:00] konnichiwa")\n'
    "    out = pathlib.Path(f).with_suffix('.srt')\n"
    "    out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\nnihao\\n', encoding='utf-8')\n"
    '    print("Writing: %s" % out)\n'
)


def _write_fake(tmp: Path, code: str) -> Path:
    fake = tmp / "fake_infer.py"
    fake.write_text(code, encoding="utf-8")
    return fake


def test_run_and_finalize() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_OK)), log=lambda s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        assert job.files[0].duration_s == 3720.0, job.files[0].duration_s
        zh = video.with_name("demo.zh.srt")
        assert zh.is_file(), f"missing {zh}"
        text = zh.read_text(encoding="utf-8")
        assert "你好" in text and "-->" in text
        assert not video.with_suffix(".srt").exists()
        print("  test_run_and_finalize OK")


def test_skip_if_exists() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        video.with_name("demo.zh.srt").write_text("已有字幕\n", encoding="utf-8")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_OK)), log=lambda s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.SKIPPED, job.files[0].to_dict()
        print("  test_skip_if_exists OK")


def test_overwrite() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        video.with_name("demo.zh.srt").write_text("旧字幕\n", encoding="utf-8")
        cfg = _base_cfg(_write_fake(tmp, FAKE_OK))
        cfg["subtitle"]["skip_if_exists"] = False
        cfg["subtitle"]["overwrite"] = True
        engine = Engine(cfg, log=lambda s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        assert "你好" in video.with_name("demo.zh.srt").read_text(encoding="utf-8")
        print("  test_overwrite OK")


def test_retry_skipped_regenerates() -> None:
    """「仍要重新生成」：跳过的文件删旧字幕、重新入队并真正产出。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        zh = video.with_name("demo.zh.srt")
        zh.write_text("旧字幕\n", encoding="utf-8")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_OK)), log=lambda s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.SKIPPED, job.files[0].to_dict()
        # 跳过消息带完整路径
        assert str(zh) in job.files[0].message, job.files[0].message
        # 无跳过文件时 retry 返回 None
        done_job = engine.submit([tmp / "none"], run_in_thread=False)  # 文件不存在 → 失败，非跳过
        assert engine.retry_job(done_job.id) is None
        # retry：删旧字幕 + 新任务完成
        new_job = engine.retry_job(job.id)
        assert new_job is not None and new_job.id != job.id
        assert not zh.exists(), "旧字幕应已删除"
        deadline = time.time() + 30
        while time.time() < deadline and new_job.files[0].status not in (
            TaskStatus.DONE, TaskStatus.ERROR, TaskStatus.CANCELED
        ):
            time.sleep(0.05)
        assert new_job.files[0].status == TaskStatus.DONE, new_job.files[0].to_dict()
        assert "你好" in zh.read_text(encoding="utf-8")
        # 原任务仍保持 skipped（历史不改写）
        assert job.files[0].status == TaskStatus.SKIPPED
        print("  test_retry_skipped_regenerates OK")


def test_mismatched_log_path() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_LIE)), log=lambda s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        zh = video.with_name("demo.zh.srt")
        assert zh.is_file(), f"missing {zh}"
        print("  test_mismatched_log_path OK")


def test_run_and_finalize_english_log() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_EN)), log=lambda s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        assert job.files[0].duration_s == 30.0, job.files[0].duration_s
        zh = video.with_name("demo.zh.srt")
        assert zh.is_file(), f"missing {zh}"
        assert not video.with_suffix(".srt").exists()
        print("  test_run_and_finalize_english_log OK")


# ---------------------------------------------------------------------------
# SRT 防御性清洗（负时间戳/乱序兜底）
# ---------------------------------------------------------------------------

from jav_scribe.core.finalize import sanitize_srt_file, sanitize_srt_text  # noqa: E402

# 取证样本：PJAM-045 首部 2 条负 start（faster-whisper translate 首段无起始时间戳）
EVIDENCE_HEAD = (
    "1\n"
    "-1:45:55,320 --> 00:00:23,880\n"
    "毕竟科长你啊 只要喝醉了就肯定会搭讪的吧？\n"
    "\n"
    "2\n"
    "-1:51:58,760 --> 00:01:58,300\n"
    "嘛 也是呢 确实是店长的本领\n"
    "\n"
    "3\n"
    "00:00:09,300 --> 00:00:15,660\n"
    "之前啊 我去大阪喝了一点 虽然不是很想喝\n"
    "\n"
)


def _parse_back(text: str) -> list[tuple[int, int]]:
    out = []
    for blk in text.strip().split("\n\n"):
        lines = blk.split("\n")
        ts = [l for l in lines if "-->" in l][0]
        def ms(hms):
            h, m, s = hms.split(":")
            s, x = s.split(",")
            return (int(h) * 3600 + int(m) * 60 + int(s)) * 1000 + int(x)
        a, b = ts.split(" --> ")
        out.append((ms(a), ms(b)))
    return out


def test_sanitize_evidence_pattern() -> None:
    """取证模式：前 2 条负 start → 全量非负、按 start 升序、文本不变、重编号。"""
    logs: list[str] = []
    new_text, fixed = sanitize_srt_text(EVIDENCE_HEAD, log=logs.append)
    assert fixed == 2, logs
    cues = _parse_back(new_text)
    assert all(s >= 0 for s, _ in cues), cues
    assert cues == sorted(cues), cues
    # 两条负值 clamp 到 0，end 不变
    assert (0, 23880) in cues and (0, 118300) in cues and (9300, 15660) in cues
    assert "毕竟科长你啊" in new_text and "店长的本领" in new_text
    assert "之前啊" in new_text
    assert "1\n00:00:00,000 --> 00:00:23,880" in new_text
    print("  test_sanitize_evidence_pattern OK")


def test_sanitize_valid_passthrough() -> None:
    valid = "1\n00:00:01,000 --> 00:00:02,000\n甲\n\n2\n00:00:03,000 --> 00:00:04,000\n乙\n\n"
    new_text, fixed = sanitize_srt_text(valid)
    assert fixed == 0 and new_text == valid
    print("  test_sanitize_valid_passthrough OK")


def test_sanitize_unparseable_untouched() -> None:
    for garbage in ("", "\n\n", "这不是 srt", "1\n乱来 --> 乱来\n文本\n\n", "1\n00:00:01,000 --> 00:00:02,000\n文本\r\n"):
        new_text, fixed = sanitize_srt_text(garbage)
        assert new_text == garbage and fixed == 0, repr(garbage)
    print("  test_sanitize_unparseable_untouched OK")


def test_sanitize_end_negative_and_inverted() -> None:
    text = (
        "1\n-00:00:10,000 --> -00:00:05,000\n甲\n\n"   # 整条全负
        "2\n00:00:20,000 --> 00:00:10,000\n乙\n\n"      # end < start
        "3\n00:00:30,000 --> 00:00:40,000\n丙\n\n"
    )
    new_text, fixed = sanitize_srt_text(text)
    assert fixed == 2, new_text
    cues = _parse_back(new_text)
    assert cues == [(0, 0), (20000, 20000), (30000, 40000)], cues
    assert "甲\n\n" in new_text and "乙\n\n" in new_text and "丙\n\n" in new_text
    print("  test_sanitize_end_negative_and_inverted OK")


def test_sanitize_file_roundtrip() -> None:
    with tempfile.TemporaryDirectory() as td:
        f = Path(td) / "a.srt"
        f.write_text(EVIDENCE_HEAD, encoding="utf-8")
        assert sanitize_srt_file(f) == 2
        assert sanitize_srt_file(f) == 0  # 二次幂等
    print("  test_sanitize_file_roundtrip OK")


# Fake engine #3: 写出负时间戳 srt（模拟 faster-whisper translate 首段异常）
FAKE_NEG = (
    "import sys, pathlib\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    "for i, f in enumerate(files, 1):\n"
    '    print("正在翻译 (%d/%d)：%s" % (i, len(files), f))\n'
    "    p = pathlib.Path(f)\n"
    '    out = p.with_suffix(".srt")\n'
    '    out.write_text("1\\n-1:45:55,320 --> 00:00:23,880\\n甲\\n\\n2\\n00:00:09,300 --> 00:00:15,660\\n乙\\n\\n", encoding="utf-8")\n'
    '    print("正在写入：%s" % out)\n'
)


def test_run_finalize_sanitizes_negative() -> None:
    """端到端：引擎写出负时间戳 → finalize 落位的 zh.srt 必须合法。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        video.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_NEG)), log=lambda s: None, profile="test")
        job = engine.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        zh = video.with_name("demo.zh.srt")
        cues = _parse_back(zh.read_text(encoding="utf-8"))
        assert all(s >= 0 for s, _ in cues), cues
        assert cues == sorted(cues)
        print("  test_run_finalize_sanitizes_negative OK")


def test_watch_stability() -> None:
    """A file that is still growing (BT/PT in progress) is not handed over
    until its size is stable across two scans."""
    from jav_scribe.core.watch import Watcher

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        video = tmp / "demo.mkv"
        handed: list[Path] = []
        w = Watcher([tmp], interval_s=0.05, process_existing=False,
                    log=lambda s: None, on_new_files=handed.extend)
        video.write_bytes(b"a")
        w.scan_once()                      # first sight
        assert not handed
        video.write_bytes(b"ab")           # still downloading
        w.scan_once()
        assert not handed
        w.scan_once()                      # stable across two scans
        assert [p.name for p in handed] == ["demo.mkv"], handed
        print("  test_watch_stability OK")


if __name__ == "__main__":
    test_run_and_finalize()
    test_skip_if_exists()
    test_overwrite()
    test_mismatched_log_path()
    test_run_and_finalize_english_log()
    test_retry_skipped_regenerates()
    test_sanitize_evidence_pattern()
    test_sanitize_valid_passthrough()
    test_sanitize_unparseable_untouched()
    test_sanitize_end_negative_and_inverted()
    test_sanitize_file_roundtrip()
    test_run_finalize_sanitizes_negative()
    test_watch_stability()
    print("ALL SMOKE TESTS PASSED")
