"""任务历史持久化（serve <data_dir>/jobs.json）：重建/重启后历史任务可恢复。

- 已完成（含全失败/跳过/取消）任务 → 恢复，/jobs 可见，任务表「已完成」不丢
- 未完成任务（pending/running）→ 不恢复（worker 已随进程消亡，重新提交即可）
- 损坏的 jobs.json → 忽略并继续启动
- GET /jobs?detail=1：一次拉齐 per-file 明细（桌面端单飞）；可叠 batch_id；无参行为不变
Run: python3 tests/test_jobs_history.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.engine import Engine  # noqa: E402
from jav_scribe.core.progress_api import ProgressHTTP  # noqa: E402
from jav_scribe.core.task import Job, Task, TaskStatus, new_job_id  # noqa: E402


def _http(url: str):
    req = urllib.request.Request(url, data=b"", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as ex:
        return ex.code, json.loads(ex.read().decode())

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



def _post(url: str) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=b"", method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as ex:
        return ex.code, json.loads(ex.read().decode())


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


def test_jobs_detail_param() -> None:
    """GET /jobs?detail=1：每项含 files 明细；可叠 batch_id 过滤；无参行为不变。"""
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        va, vb = td / "a.mkv", td / "b.mkv"
        va.write_bytes(b"1")
        vb.write_bytes(b"2")
        logs: list[str] = []
        eng = _make_engine(td, fake, logs)
        httpd = ProgressHTTP(eng, host="127.0.0.1", port=0, inbox_dir=td)
        httpd.start()
        base = f"http://127.0.0.1:{httpd.server.server_address[1]}"
        try:
            ja = eng.submit([va], run_in_thread=False)
            jb = eng.submit([vb], run_in_thread=False, batch_id="B1", batch_label="样本")
            assert ja.files[0].status == TaskStatus.DONE
            assert jb.files[0].status == TaskStatus.DONE
            # 无参：摘要口径不变（无 files 键）
            code, body = _http(base + "/jobs")
            assert code == 200 and [x["id"] for x in body] == [ja.id, jb.id], (code, body)
            for x in body:
                assert "files" not in x, x
            # detail=1：每项含 files（路径/状态齐全），摘要字段与无参逐键一致
            code, body = _http(base + "/jobs?detail=1")
            assert code == 200 and [x["id"] for x in body] == [ja.id, jb.id], (code, body)
            by_id = {x["id"]: x for x in body}
            for x in body:
                assert isinstance(x["files"], list) and len(x["files"]) == 1, x["id"]
            assert by_id[ja.id]["files"][0]["path"] == str(va)
            assert by_id[ja.id]["files"][0]["status"] == "done"
            assert by_id[jb.id]["files"][0]["path"] == str(vb)
            for jid, p in ((ja.id, by_id[ja.id]), (jb.id, by_id[jb.id])):
                plain = [x for x in _http(base + "/jobs")[1] if x["id"] == jid][0]
                for k, v in plain.items():
                    assert p[k] == v, (jid, k)  # detail 是摘要的严格超集
            # batch_id 过滤可叠加
            code, body = _http(base + "/jobs?batch_id=B1&detail=1")
            assert code == 200 and [x["id"] for x in body] == [jb.id], (code, body)
            assert isinstance(body[0]["files"], list) and body[0]["files"]
            code, body = _http(base + "/jobs?batch_id=NOPE&detail=1")
            assert code == 200 and body == [], (code, body)
        finally:
            httpd.stop()
            eng.stop()



def test_cleanup_finished() -> None:
    """POST /jobs/cleanup：仅删终态任务，非终态保留，jobs.json 同步收缩；
    累计统计（stats.json）同步归零——看板 chip 单一真源，清理后须回零（幽灵计数回归）。"""
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        fake = td / "fake_infer.py"
        fake.write_text(FAKE_OK, encoding="utf-8")
        va, vb = td / "a.mkv", td / "b.mkv"
        va.write_bytes(b"1")
        vb.write_bytes(b"2")
        logs: list[str] = []
        eng = _make_engine(td, fake, logs)
        # 一个终态（done）+ 一个非终态（pending，worker 未跑）
        jdone = eng.submit([va], run_in_thread=False)
        jhalf = Job(id=new_job_id(), files=[Task(path=Path("/tmp/hold.mkv"), status=TaskStatus.RUNNING)],
                    label="进行中")
        eng.jobs.append(jhalf)
        assert jdone.done is True and jhalf.done is False
        httpd = ProgressHTTP(eng, host="127.0.0.1", port=0, inbox_dir=td)
        httpd.start()
        base = f"http://127.0.0.1:{httpd.server.server_address[1]}"
        try:
            # 清理前：终态已计入累计统计
            assert eng.stats() == {"done": 1, "skipped": 0, "failed": 0}, eng.stats()
            code, body = _post(base + "/jobs/cleanup")
            assert code == 200 and body == {"ok": True, "removed": 1}, (code, body)
            code, body = _http(base + "/jobs")
            assert code == 200 and [x["id"] for x in body] == [jhalf.id], (code, body)
            # jobs.json 同步收缩：终态不再落盘，重启后不恢复
            saved = json.loads((td / "jobs.json").read_text(encoding="utf-8"))
            assert all(x["id"] != jdone.id for x in saved)
            # 累计统计同步归零（内存 + stats.json 落盘）：列表空后 chip 计数不再显示终身累计
            assert eng.stats() == {"done": 0, "skipped": 0, "failed": 0}, eng.stats()
            spath = td / "stats.json"
            sraw = json.loads(spath.read_text(encoding="utf-8"))
            assert sraw["done"] == 0 and sraw["skipped"] == 0 and sraw["failed"] == 0, sraw
            assert sraw["counted"] == [], sraw
            # 空清理幂等（表内无终态：不触发归零副作用）
            code, body = _post(base + "/jobs/cleanup")
            assert code == 200 and body == {"ok": True, "removed": 0}, (code, body)
            # 归零后新终态任务从 0 重计（不清理时仍正常累计）
            vc = td / "c.mkv"
            vc.write_bytes(b"3")
            jc = eng.submit([vc], run_in_thread=False)
            assert jc.files[0].status == TaskStatus.DONE
            assert eng.stats() == {"done": 1, "skipped": 0, "failed": 0}, eng.stats()
            # 二次清理再次归零（契约稳定，不依赖首次清理后的进程状态）
            code, body = _post(base + "/jobs/cleanup")
            assert code == 200 and body == {"ok": True, "removed": 1}, (code, body)
            assert eng.stats() == {"done": 0, "skipped": 0, "failed": 0}, eng.stats()
        finally:
            httpd.stop()
            eng.stop()

if __name__ == "__main__":
    test_history_survives_restart()
    test_unfinished_job_not_restored()
    test_all_failed_job_state_finished()
    test_corrupt_history_ignored()
    test_history_grows_after_restart()
    test_jobs_detail_param()
    test_cleanup_finished()
    print("ALL JOBS HISTORY TESTS PASSED")
