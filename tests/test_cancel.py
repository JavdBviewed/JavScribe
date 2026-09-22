"""Cancel tests: queued / running / idempotent / HTTP.

No models/GPU needed. Run:  python3 tests/test_cancel.py
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

from jav_scribe.core.engine import Engine  # noqa: E402
from jav_scribe.core.progress_api import ProgressHTTP  # noqa: E402
from jav_scribe.core.task import TaskStatus  # noqa: E402


def _http_post(url: str) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=b"", method="POST")
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


# 占位慢任务：前 0.6s 不处理任何文件（让第二个任务进队列）
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

# 批内慢任务：第一个文件快速完成，之后 sleep 3s 再处理第二个
# （取消会命中 sleep 窗口，子进程被 kill）
FAKE_SLOW_BATCH = (
    "import sys, pathlib, time\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    'print("正在加载 Whisper 模型")\n'
    "time.sleep(0.4)\n"
    "for i, f in enumerate(files, 1):\n"
    '    print("正在翻译 (%d/%d)：%s" % (i, len(files), f))\n'
    "    out = pathlib.Path(f).with_suffix('.srt')\n"
    "    out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\n你好\\n', encoding='utf-8')\n"
    '    print("正在写入：%s" % out)\n'
    "    if i < len(files):\n"
    "        time.sleep(3)\n"
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


def test_cancel_queued_job() -> None:
    """排队任务取消：立即终态、不占推理资源、不产出。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1 = tmp / "a.mkv"
        v1.write_bytes(b"fake")
        v2, v3 = tmp / "b.mkv", tmp / "c.mkv"
        v2.write_bytes(b"fake")
        v3.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        job1 = engine.submit([v1], run_in_thread=True)      # 占用推理（0.6s）
        job2 = engine.submit([v2, v3], run_in_thread=True)  # 进队列
        assert engine.job_by_id(job2.id) is job2
        time.sleep(0.1)  # 等 job1 线程真正跑起来
        assert job2.id in [j.id for j in engine._pending_jobs], "job2 应在队列中"
        res = engine.cancel_job(job2.id)
        assert res == "canceled", res
        assert job2.finished is not None
        assert all(t.status == TaskStatus.CANCELED for t in job2.files)
        assert not v2.with_name("b.zh.srt").exists() and not v3.with_name("c.zh.srt").exists()
        # 幂等：已结束再取消 → finished
        assert engine.cancel_job(job2.id) == "finished"
        # job1 不受影响，正常完成
        assert _wait(lambda: job1.finished is not None), "job1 应正常完成"
        assert job1.files[0].status == TaskStatus.DONE, job1.files[0].to_dict()
        assert v1.with_name("a.zh.srt").is_file()
        print("  test_cancel_queued_job OK")


def test_cancel_running_job_keeps_done_output() -> None:
    """运行中取消：子进程被杀；已产出字幕保留为 DONE，未开始文件 CANCELED，无 ERROR。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1, v2 = tmp / "a.mkv", tmp / "b.mkv"
        v1.write_bytes(b"fake")
        v2.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW_BATCH)), log=lambda s: None, profile="test")
        job = engine.submit([v1, v2], run_in_thread=True)
        # 等第一个文件已写出（parser 已记录 output_files），此时子进程在 3s sleep 中
        assert _wait(lambda: job.files[0].output_files), "file1 应已产出"
        t0 = time.time()
        res = engine.cancel_job(job.id)
        assert res == "canceling", res
        assert _wait(lambda: job.finished is not None, timeout=20), "取消后应收尾"
        elapsed = time.time() - t0
        assert elapsed < 3.0, f"子进程应被 kill 而非跑完 sleep（{elapsed:.1f}s）"
        t1, t2 = job.files
        assert t1.status == TaskStatus.DONE, t1.to_dict()
        assert t2.status == TaskStatus.CANCELED, t2.to_dict()
        assert all(t.status != TaskStatus.ERROR for t in job.files)
        # 已产出字幕保留并 finalize（.zh.srt 在盘）
        assert v1.with_name("a.zh.srt").is_file()
        assert not v2.with_name("b.zh.srt").exists()
        d = job.to_dict()
        assert d["done"] == 1 and d["canceled"] == 1 and d["failed"] == 0, d
        assert d["state"] == "finished" and d["cancel_requested"] is True
        # 幂等二次取消
        assert engine.cancel_job(job.id) == "finished"
        print("  test_cancel_running_job_keeps_done_output OK")


def test_cancel_unknown_and_running_then_finished() -> None:
    """不存在 → None；已结束 → finished。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1 = tmp / "a.mkv"
        v1.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        assert engine.cancel_job("no-such-job") is None
        job = engine.submit([v1], run_in_thread=False)  # 同步跑完
        assert job.finished is not None
        assert engine.cancel_job(job.id) == "finished"
        print("  test_cancel_unknown_and_running_then_finished OK")


def test_cancel_http_status_codes() -> None:
    """POST /jobs/<id>/cancel：200 排队取消 / 404 不存在 / 409 已结束。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1, v2, v3 = tmp / "a.mkv", tmp / "b.mkv", tmp / "c.mkv"
        for v in (v1, v2, v3):
            v.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        httpd = ProgressHTTP(engine, host="127.0.0.1", port=0, inbox_dir=tmp)
        httpd.start()
        base = f"http://127.0.0.1:{httpd.server.server_address[1]}"
        try:
            # 404
            code, body = _http_post(f"{base}/jobs/no-such-job/cancel")
            assert code == 404 and body.get("ok") is False, (code, body)
            # 排队取消 → 200 canceled
            j1 = engine.submit([v1], run_in_thread=True)
            time.sleep(0.1)
            j2 = engine.submit([v2], run_in_thread=True)
            code, body = _http_post(f"{base}/jobs/{j2.id}/cancel")
            assert code == 200 and body.get("ok") is True and body.get("status") == "canceled", (code, body)
            # 409：已结束
            assert _wait(lambda: j2.finished is not None)
            code, body = _http_post(f"{base}/jobs/{j2.id}/cancel")
            assert code == 409 and body.get("ok") is False, (code, body)
            # j1 正常完成（取消不影响别的任务）
            assert _wait(lambda: j1.finished is not None)
            assert j1.files[0].status == TaskStatus.DONE
        finally:
            httpd.stop()
        print("  test_cancel_http_status_codes OK")


def main() -> None:
    test_cancel_queued_job()
    test_cancel_running_job_keeps_done_output()
    test_cancel_unknown_and_running_then_finished()
    test_cancel_http_status_codes()
    print("test_cancel: all OK")


if __name__ == "__main__":
    main()
