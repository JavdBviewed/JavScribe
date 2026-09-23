"""任务历史持久化（serve <data_dir>/jobs.json）：重建/重启后历史任务可恢复。

- 已完成（含全失败/跳过/取消）任务 → 恢复，/jobs 可见，任务表「已完成」不丢
- 未完成任务（pending/running）→ 不恢复（worker 已随进程消亡，重新提交即可）
- 损坏的 jobs.json → 忽略并继续启动
Run: python3 tests/test_jobs_history.py
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


def test_history_survives_restart() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        video = td / "demo.mkv"
        video.write_bytes(b"fake")

        logs_a: list[str] = []
        eng_a = _make_engine(td, fake, logs_a)
        job = eng_a.submit([video], run_in_thread=False)
        assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
        hist = td / "jobs.json"
        assert hist.exists(), "完成的任务应落盘 jobs.json"
        saved = json.loads(hist.read_text(encoding="utf-8"))
        assert len(saved) == 1 and saved[0]["id"] == job.id
        assert saved[0]["state"] == "finished"

        logs_b: list[str] = []
        eng_b = _make_engine(td, fake, logs_b)
        assert len(eng_b.jobs) == 1, f"重启后应恢复 1 个历史任务，实际 {len(eng_b.jobs)}"
        rj = eng_b.jobs[0]
        assert rj.id == job.id and rj.label == "" and rj.source_kind == "local"
        assert rj.files[0].status == TaskStatus.DONE
        assert rj.files[0].path == video
        assert rj.to_dict()["state"] == "finished"
        assert any("已恢复历史任务" in l for l in logs_b)
        # 客户端任务表「已完成」口径：status 非 running/pending
        assert rj.files[0].status in {TaskStatus.DONE, TaskStatus.SKIPPED, TaskStatus.ERROR, TaskStatus.CANCELED}


def test_unfinished_job_not_restored() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        logs: list[str] = []
        eng = _make_engine(td, fake, logs)
        # 模拟一个跑了一半的 job（重启时 worker 已死）
        half = Job(id=new_job_id(), files=[Task(path=Path("/tmp/a.mkv"), status=TaskStatus.RUNNING),
                                            Task(path=Path("/tmp/b.mkv"))], label="中断任务")
        eng.jobs.append(half)
        eng._save_jobs()

        logs_b: list[str] = []
        eng_b = _make_engine(td, fake, logs_b)
        assert eng_b.jobs == [], "未完成任务不应恢复（避免误导用户）"


def test_all_failed_job_state_finished() -> None:
    """全失败 job 的 state 必须是 finished（原 Job.done 漏 error，会永远卡 running）。"""
    job = Job(id=new_job_id(), files=[Task(path=Path("/tmp/x.mkv"), status=TaskStatus.ERROR,
                                            message="boom"),
                                      Task(path=Path("/tmp/y.mkv"), status=TaskStatus.ERROR)])
    assert job.done is True
    assert job.to_dict()["state"] == "finished"
    assert job.to_dict()["failed"] == 2


def test_corrupt_history_ignored() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        (td / "jobs.json").write_text("{not json!!", encoding="utf-8")
        logs: list[str] = []
        eng = _make_engine(td, fake, logs)  # 不应抛异常
        assert eng.jobs == []
        assert any("任务历史读取失败" in l for l in logs)


def test_history_grows_after_restart() -> None:
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        logs: list[str] = []
        eng = _make_engine(td, fake, logs)
        v1 = td / "a.mkv"; v1.write_bytes(b"1")
        eng.submit([v1], run_in_thread=False)
        # 重启后再跑一个 → 历史 2 条（不丢旧的）
        v2 = td / "b.mkv"; v2.write_bytes(b"2")
        logs2: list[str] = []
        eng2 = _make_engine(td, fake, logs2)
        eng2.submit([v2], run_in_thread=False)
        assert len(eng2.jobs) == 2
        saved = json.loads((td / "jobs.json").read_text(encoding="utf-8"))
        assert len(saved) == 2
        # 第三次重启：两条都在
        eng3 = _make_engine(td, fake, logs2)
        assert len(eng3.jobs) == 2


if __name__ == "__main__":
    test_history_survives_restart()
    test_unfinished_job_not_restored()
    test_all_failed_job_state_finished()
    test_corrupt_history_ignored()
    test_history_grows_after_restart()
    print("ALL JOBS HISTORY TESTS PASSED")
