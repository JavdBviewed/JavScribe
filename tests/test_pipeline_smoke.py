"""Smoke tests: fake ChickenRice stdout -> Engine -> finalize.

No models/GPU needed. Run:  python3 tests/test_pipeline_smoke.py
"""
from __future__ import annotations

import sys
import tempfile
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
    test_watch_stability()
    print("ALL SMOKE TESTS PASSED")
