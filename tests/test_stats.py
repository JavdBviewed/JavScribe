"""累计终态统计（serve <data_dir>/stats.json）：看板统计单一真源。

背景：内存任务表只留最近 200 条，大批量任务下客户端按行计数必然少算。
serve 在任务收尾时累计终态（done/skipped/failed，failed=error+canceled）
并持久化 stats.json，作为 /health.stats 的单一真源。

- 计数口径：DONE→done / SKIPPED→skipped / ERROR+CANCELED→failed，非终态不计
- 幂等：counted 集合按 job.id:序号 去重，重复收尾/重启后再次收尾不重复计
- 持久化：stats.json 落盘；新进程恢复后继续累加
- 旧版升级：stats.json 缺失但 jobs.json 已恢复 → 从恢复任务计基线
- stats() 返回拷贝，外部改不动内部状态

Run: python3 tests/test_stats.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.engine import Engine  # noqa: E402
from jav_scribe.core.task import Job, Task, TaskStatus, new_job_id  # noqa: E402

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


def _cfg(fake: Path) -> dict:
    return {
        "infer": {"command": f"{sys.executable} {fake}", "model": "models",
                  "device": "cpu", "log_level": "DEBUG"},
        "subtitle": {"formats": ["srt"], "lang_tag": "zh", "naming": "rename",
                     "output_dir": None, "skip_if_exists": True, "overwrite": False,
                     "tag_formats": ["srt"]},
        "polish": {"enabled": False},
        "emby": {"enabled": False},
        "jasna": {"enabled": False},
    }


def _make_engine(td: Path, fake: Path, logs: list[str]) -> Engine:
    return Engine(_cfg(fake), log=logs.append, profile="test", data_dir=td)


def _mk_job(statuses: list[TaskStatus]) -> Job:
    return Job(
        id=new_job_id(),
        files=[Task(path=Path(f"/tmp/f{i}"), status=s) for i, s in enumerate(statuses)],
    )


def test_count_mixed_terminals_and_idempotent() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        eng = _make_engine(td, fake, [])

        job = _mk_job([TaskStatus.DONE, TaskStatus.SKIPPED, TaskStatus.ERROR,
                       TaskStatus.CANCELED, TaskStatus.RUNNING, TaskStatus.PENDING])
        job.finished = 0.0
        eng._count_terminals([job])
        assert eng.stats() == {"done": 1, "skipped": 1, "failed": 2}, eng.stats()

        # 幂等：同一任务重复收尾（重试/取消交接/重启）不重复计
        eng._count_terminals([job])
        eng._count_terminals([job])
        assert eng.stats() == {"done": 1, "skipped": 1, "failed": 2}, eng.stats()

        # 不同 id 的同状态任务照常累加
        job2 = _mk_job([TaskStatus.DONE])
        job2.finished = 0.0
        eng._count_terminals([job2])
        assert eng.stats() == {"done": 2, "skipped": 1, "failed": 2}, eng.stats()


def test_stats_persisted_and_restored() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")

        eng_a = _make_engine(td, fake, [])
        job = _mk_job([TaskStatus.DONE, TaskStatus.ERROR])
        job.finished = 0.0
        eng_a._count_terminals([job])
        spath = td / "stats.json"
        assert spath.exists(), "收尾后应落盘 stats.json"
        saved = json.loads(spath.read_text(encoding="utf-8"))
        assert saved["done"] == 1 and saved["failed"] == 1
        assert f"{job.id}:0" in saved["counted"] and f"{job.id}:1" in saved["counted"]

        # 重启：从 stats.json 恢复基线；已计文件再次收尾不重复
        eng_b = _make_engine(td, fake, [])
        assert eng_b.stats() == {"done": 1, "skipped": 0, "failed": 1}, eng_b.stats()
        job_again = Job(id=job.id, files=[Task(path=Path("/tmp/x"), status=TaskStatus.DONE)])
        job_again.finished = 0.0
        eng_b._count_terminals([job_again])
        assert eng_b.stats() == {"done": 1, "skipped": 0, "failed": 1}, eng_b.stats()

        # 新任务在基线上累加
        eng_b._count_terminals([_mk_job([TaskStatus.SKIPPED])])
        assert eng_b.stats() == {"done": 1, "skipped": 1, "failed": 1}, eng_b.stats()


def test_upgrade_baseline_from_jobs_json() -> None:
    """旧版升级：stats.json 缺失，jobs.json 有全终态历史 → 从恢复任务计基线。"""
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        video = td / "demo.mkv"
        video.write_bytes(b"fake")

        eng_a = _make_engine(td, fake, [])
        job = eng_a.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        assert (td / "jobs.json").exists()

        # 模拟旧版数据目录：删掉 stats.json（旧版本从未写过）
        (td / "stats.json").unlink()
        eng_b = _make_engine(td, fake, [])
        assert len(eng_b.jobs) == 1, "重启应恢复历史任务"
        assert eng_b.stats() == {"done": 1, "skipped": 0, "failed": 0}, eng_b.stats()


def test_stats_returns_copy() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        eng = _make_engine(td, fake, [])
        got = eng.stats()
        got["done"] = 999
        assert eng.stats() == {"done": 0, "skipped": 0, "failed": 0}, eng.stats()


if __name__ == "__main__":
    test_count_mixed_terminals_and_idempotent()
    test_stats_persisted_and_restored()
    test_upgrade_baseline_from_jobs_json()
    test_stats_returns_copy()
    print("test_stats: all ok")
