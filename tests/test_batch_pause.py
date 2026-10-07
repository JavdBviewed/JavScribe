"""Batch（主任务）级优雅暂停/继续/取消 tests（S2：分批 + batch 级控制）。

口径（PRD 钉死）：
- 优雅暂停 = Job 级：在跑子任务跑完、未开始不开跑（_drain_pending / 开跑门冻结）
- 与队列暂停独立可叠加
- 暂停态持久化，serve 重启不丢（验收 e）
- 取消 = batch 内未开始子任务取消（在跑的不动、不置 cancel_requested）

No models/GPU needed. Run: python3 tests/test_batch_pause.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.engine import Engine, job_from_dict  # noqa: E402
from jav_scribe.core.progress_api import ProgressHTTP  # noqa: E402
from jav_scribe.core.task import Job, Task, TaskStatus  # noqa: E402


def _http(method: str, url: str) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=b"", method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as ex:
        return ex.code, json.loads(ex.read().decode())


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


# 占位慢任务：前 0.6s 不处理任何文件（让后续任务进队列）
FAKE_SLOW = (
    "import sys, pathlib, time\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    'print("正在加载 Whisper 模型")\n'
    "time.sleep(0.6)\n"
    "for i, f in enumerate(files, 1):\n"
    '    print("正在翻译 (%d/%d)：%s" % (i, len(files), f))\n'
    "    out = pathlib.Path(f).with_suffix('.srt')\n"
    "    out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\n你好\\n', encoding='utf-8')\n"
    '    print("正在写入：%s" % out)\n'
    'print("全部完成")\n'
)


def _write_fake(tmp: Path, code: str) -> Path:
    fake = tmp / "fake_infer.py"
    fake.write_text(code, encoding="utf-8")
    return fake


def _wait(cond, timeout=30.0, step=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(step)
    return cond()


def _mk_videos(tmp: Path, names) -> list[Path]:
    vs = []
    for n in names:
        v = tmp / n
        v.write_bytes(b"fake")
        vs.append(v)
    return vs


def test_batch_fields_compat() -> None:
    """Job 新字段 to_dict/job_from_dict 往返；旧字典（无字段）容忍缺失→None。"""
    v = Path("/tmp/x.mkv")
    j = Job(id="j1", files=[Task(path=v)], batch_id="b-abc", batch_label="样本目录")
    d = j.to_dict()
    assert d.get("batch_id") == "b-abc" and d.get("batch_label") == "样本目录", d
    back = job_from_dict(j.to_dict(detail=True))
    assert back is not None and back.batch_id == "b-abc" and back.batch_label == "样本目录"
    # 旧客户端/旧 jobs.json 条目：无 batch 字段 → None（天然兼容，不炸）
    old = job_from_dict({"id": "j2", "files": [{"path": str(v), "status": "pending"}]})
    assert old is not None and old.batch_id is None and old.batch_label is None
    # 无 batch 任务 to_dict 也带字段（None）——字段恒在，UI 渲染简单
    assert j.to_dict()["batch_id"] == "b-abc"
    j2 = Job(id="j3", files=[Task(path=v)])
    assert j2.to_dict()["batch_id"] is None
    print("  test_batch_fields_compat OK")


def test_batch_pause_freezes_queued_only() -> None:
    """batch 暂停：在跑子任务跑完、同 batch 排队不开跑、非 batch/他 batch 不受影响；继续后恢复。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        va, vb, vc, vd = _mk_videos(tmp, ("a.mkv", "b.mkv", "c.mkv", "d.mkv"))
        data_dir = tmp / "data"
        data_dir.mkdir()
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None,
                        profile="test", data_dir=data_dir)
        try:
            jA = engine.submit([va], run_in_thread=True)                       # 在跑
            time.sleep(0.1)
            jB = engine.submit([vb], run_in_thread=True, batch_id="B1", batch_label="样本")
            jC = engine.submit([vc], run_in_thread=True, batch_id="B1")
            jD = engine.submit([vd], run_in_thread=True)                        # 无 batch
            assert engine.batch_pause("B1") is True
            assert engine.batch_pause("B1") is False  # 幂等
            assert "B1" in engine.batch_paused_ids
            assert _wait(lambda: jA.finished is not None), "在跑子任务应跑完"
            assert jA.files[0].status == TaskStatus.DONE
            time.sleep(0.8)  # 远大于推理耗时：同 batch 排队必须仍冻结
            assert (vb.with_name("b.zh.srt")).exists() is False
            assert (vc.with_name("c.zh.srt")).exists() is False
            assert jB.files[0].status == TaskStatus.PENDING, jB.files[0].to_dict()
            assert jC.files[0].status == TaskStatus.PENDING
            # 非 batch 任务不受 batch 暂停影响
            assert _wait(lambda: jD.finished is not None, timeout=15), "无 batch 任务应照常执行"
            assert jD.files[0].status == TaskStatus.DONE
            # 落盘
            raw = json.loads((data_dir / "batch-pause.json").read_text(encoding="utf-8"))
            assert raw.get("paused") == ["B1"], raw
            # 继续：排队子任务恢复执行
            assert engine.batch_resume("B1") is True
            assert engine.batch_resume("B1") is False
            assert "B1" not in engine.batch_paused_ids
            assert _wait(lambda: jB.finished is not None and jC.finished is not None), \
                "继续后冻结子任务应执行"
            assert jB.files[0].status == TaskStatus.DONE
            assert jC.files[0].status == TaskStatus.DONE
            assert (vb.with_name("b.zh.srt")).is_file() and (vc.with_name("c.zh.srt")).is_file()
        finally:
            engine.stop()
    print("  test_batch_pause_freezes_queued_only OK")


def test_batch_pause_race_no_runaway() -> None:
    """竞态回归：batch_pause 与开跑提交（committed）同锁互斥。

    在跑任务（0.6s 窗口）期间对同 batch 新任务「提交后立即暂停」，
    断言该任务绝不跑起来（暂停成功=任务必须保持 PENDING）。
    """
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        va, vb = _mk_videos(tmp, ("a.mkv", "b.mkv"))
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        try:
            jA = engine.submit([va], run_in_thread=True)
            time.sleep(0.1)
            jB = engine.submit([vb], run_in_thread=True, batch_id="B1")
            changed = engine.batch_pause("B1")
            assert changed is True
            assert _wait(lambda: jA.finished is not None)
            time.sleep(0.8)
            assert jB.files[0].status == TaskStatus.PENDING, \
                "暂停成功但任务照跑才是 bug"
            assert (vb.with_name("b.zh.srt")).exists() is False
            assert engine.batch_resume("B1") is True
            assert _wait(lambda: jB.finished is not None)
            assert jB.files[0].status == TaskStatus.DONE
        finally:
            engine.stop()
    print("  test_batch_pause_race_no_runaway OK")


def test_batch_pause_persist_restart() -> None:
    """验收 e：暂停态持久化，serve 重启不丢；重启后同 batch 新提交仍冻结。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        va, vb, vc = _mk_videos(tmp, ("a.mkv", "b.mkv", "c.mkv"))
        data_dir = tmp / "data"
        data_dir.mkdir()
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None,
                        profile="test", data_dir=data_dir)
        jA = engine.submit([va], run_in_thread=True, batch_id="B1")
        time.sleep(0.1)
        engine.submit([vb], run_in_thread=True, batch_id="B1")  # 在途排队（重启即消亡）
        assert engine.batch_pause("B1") is True
        assert (data_dir / "batch-pause.json").is_file()
        engine.stop()  # 模拟重启：在途 Job 随进程消亡
        eng2 = Engine(engine.cfg, log=lambda s: None, profile="test", data_dir=data_dir)
        try:
            assert eng2.batch_paused_ids == ["B1"], "重启后应恢复 batch 暂停态"
            jD = eng2.submit([vb], run_in_thread=True, batch_id="B1")  # 重新提交同 batch
            time.sleep(0.1)
            jE = eng2.submit([vc], run_in_thread=True)  # 无 batch 不受影响
            assert _wait(lambda: jE.finished is not None, timeout=15)
            assert jE.files[0].status == TaskStatus.DONE
            time.sleep(0.8)
            assert jD.files[0].status == TaskStatus.PENDING, "重启后同 batch 新提交必须仍冻结"
            assert (vb.with_name("b.zh.srt")).exists() is False
            assert eng2.batch_resume("B1") is True
            assert _wait(lambda: jD.finished is not None)
            assert jD.files[0].status == TaskStatus.DONE
        finally:
            eng2.stop()
    print("  test_batch_pause_persist_restart OK")


def test_batch_pause_stacks_with_queue_pause() -> None:
    """与队列暂停独立叠加：各自继续互不解锁；双解锁后才执行。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        va, vb = _mk_videos(tmp, ("a.mkv", "b.mkv"))
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        try:
            jA = engine.submit([va], run_in_thread=True)
            time.sleep(0.1)
            jB = engine.submit([vb], run_in_thread=True, batch_id="B1")
            assert engine.pause_queue() is True
            assert engine.batch_pause("B1") is True
            assert _wait(lambda: jA.finished is not None)
            # 队列继续 ≠ 解锁 batch
            assert engine.resume_queue() is True
            time.sleep(0.8)
            assert jB.files[0].status == TaskStatus.PENDING, "队列继续不能解锁 batch 冻结"
            assert (vb.with_name("b.zh.srt")).exists() is False
            # 队列重新暂停 + batch 继续 ≠ 解锁队列（batch_resume 触发补派但队列闸不放行）
            assert engine.pause_queue() is True
            assert engine.batch_resume("B1") is True
            time.sleep(0.3)
            assert jB.files[0].status == TaskStatus.PENDING, "batch 继续不能解锁队列暂停"
            # 双解锁后才执行
            assert engine.resume_queue() is True
            assert _wait(lambda: jB.finished is not None)
            assert jB.files[0].status == TaskStatus.DONE
            assert (vb.with_name("b.zh.srt")).is_file()
            assert engine.paused is False and "B1" not in engine.batch_paused_ids
        finally:
            engine.stop()
    print("  test_batch_pause_stacks_with_queue_pause OK")


def test_batch_cancel_semantics() -> None:
    """取消：batch 内未开始子任务取消（PENDING→CANCELED）；在跑的不动、不置 cancel_requested；
    他 batch 不受影响；取消清暂停标记。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        va, vb, vc, vd = _mk_videos(tmp, ("a.mkv", "b.mkv", "c.mkv", "d.mkv"))
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        try:
            jA = engine.submit([va], run_in_thread=True, batch_id="B1")   # 在跑
            time.sleep(0.1)
            jB = engine.submit([vb], run_in_thread=True, batch_id="B1")   # 排队
            jC = engine.submit([vc], run_in_thread=True, batch_id="B2")   # 他 batch
            jD = engine.submit([vd], run_in_thread=True, batch_id="B1")   # 排队
            assert engine.batch_pause("B1") is True
            res = engine.batch_cancel("B1")
            assert res is not None and res.get("canceled_jobs") == 2 and res.get("canceled_files") == 2, res
            # 排队子任务：PENDING 文件全部 CANCELED，消息「主任务已取消」
            for j in (jB, jD):
                assert j.files[0].status == TaskStatus.CANCELED, j.files[0].to_dict()
                assert j.files[0].message == "主任务已取消"
                assert j.done and j.finished is not None
            # 在跑子任务：不动、不协作中止
            assert jA.cancel_requested is False, "在跑子任务不得置 cancel_requested"
            assert jA.files[0].status == TaskStatus.RUNNING
            assert _wait(lambda: jA.finished is not None), "在跑子任务应跑完"
            assert jA.files[0].status == TaskStatus.DONE
            # 他 batch 不受影响
            assert _wait(lambda: jC.finished is not None, timeout=15)
            assert jC.files[0].status == TaskStatus.DONE
            # 取消清暂停标记
            assert "B1" not in engine.batch_paused_ids
            # 重复取消：无可取消对象（幂等）
            res2 = engine.batch_cancel("B1")
            assert res2.get("canceled_jobs") == 0 and res2.get("canceled_files") == 0, res2
        finally:
            engine.stop()
    print("  test_batch_cancel_semantics OK")


def test_single_file_unbatched_untouched() -> None:
    """无 batch 任务（单文件上传）完全不受 batch 操作影响。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        va, vb = _mk_videos(tmp, ("a.mkv", "b.mkv"))
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        try:
            assert engine.batch_pause("GHOST") is True  # 标记存在但无对应任务
            jA = engine.submit([va], run_in_thread=True)  # 无 batch
            time.sleep(0.1)
            jB = engine.submit([vb], run_in_thread=True)  # 无 batch
            assert _wait(lambda: jA.finished is not None and jB.finished is not None), \
                "无 batch 任务不应被任何 batch 标记冻结"
            assert jA.files[0].status == TaskStatus.DONE
            assert jB.files[0].status == TaskStatus.DONE
            assert engine.batch_cancel("GHOST") == {"canceled_jobs": 0, "canceled_files": 0}
        finally:
            engine.stop()
    print("  test_single_file_unbatched_untouched OK")


def test_batch_http_endpoints() -> None:
    """HTTP：/jobs/batch/<id>/pause|resume|cancel、/health.batch_paused、/jobs?batch_id=。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        va, vb = _mk_videos(tmp, ("a.mkv", "b.mkv"))
        data_dir = tmp / "data"
        data_dir.mkdir()
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None,
                        profile="test", data_dir=data_dir)
        httpd = ProgressHTTP(engine, host="127.0.0.1", port=0, inbox_dir=tmp)
        httpd.start()
        base = f"http://127.0.0.1:{httpd.server.server_address[1]}"
        try:
            code, body = _http("GET", f"{base}/health")
            assert code == 200 and body.get("batch_paused") == [], (code, body)
            # 暂停一个本 serve 未持有任务的 batch：200 + changed，标记照记（后续派发/重启仍生效）
            code, body = _http("POST", f"{base}/jobs/batch/BX/pause")
            assert code == 200 and body.get("changed") is True, (code, body)
            code, body = _http("POST", f"{base}/jobs/batch/BX/pause")
            assert code == 200 and body.get("changed") is False, (code, body)  # 幂等
            code, body = _http("GET", f"{base}/health")
            assert body.get("batch_paused") == ["BX"], body
            # 带 batch 提交 + /jobs?batch_id= 过滤
            jA = engine.submit([va], run_in_thread=True, batch_id="B1", batch_label="样本")
            jB = engine.submit([vb], run_in_thread=True)
            time.sleep(0.1)
            code, body = _http("GET", f"{base}/jobs?batch_id=B1")
            assert code == 200 and [x["id"] for x in body] == [jA.id], (code, body)
            code, body = _http("GET", f"{base}/jobs?batch_id=NOPE")
            assert code == 200 and body == [], (code, body)
            code, body = _http("GET", f"{base}/jobs")
            assert code == 200 and len(body) == 2, (code, body)
            # resume 未暂停的 → changed=False
            code, body = _http("POST", f"{base}/jobs/batch/B1/resume")
            assert code == 200 and body.get("changed") is False, (code, body)
            # cancel：排队/在跑语义（jA 可能 running，B1 无排队 → 只影响 PENDING 文件）
            code, body = _http("POST", f"{base}/jobs/batch/B1/cancel")
            assert code == 200 and isinstance(body.get("canceled_jobs"), int), (code, body)
            assert _wait(lambda: jA.finished is not None and jB.finished is not None)
        finally:
            httpd.stop()
            engine.stop()
    print("  test_batch_http_endpoints OK")


def main() -> None:
    test_batch_fields_compat()
    test_batch_pause_freezes_queued_only()
    test_batch_pause_race_no_runaway()
    test_batch_pause_persist_restart()
    test_batch_pause_stacks_with_queue_pause()
    test_batch_cancel_semantics()
    test_single_file_unbatched_untouched()
    test_batch_http_endpoints()
    print("test_batch_pause: all OK")


if __name__ == "__main__":
    main()
