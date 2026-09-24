"""Pause/resume tests: queue-level + job-level + retry-error + HTTP + persistence.

No models/GPU needed. Run: python3 tests/test_pause.py
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

# fail_flag 存在时 bad 无字幕输出（ERROR「无字幕输出」），good 正常（DONE）；
# 进程退出 0，模拟单文件失败不拖垮整批
FAKE_FLAKY = (
    "import sys, pathlib, time\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    'print("正在加载 Whisper 模型")\n'
    "time.sleep(0.3)\n"
    "fail = pathlib.Path(files[0]).parent.joinpath('fail_flag').exists()\n"
    "for i, f in enumerate(files, 1):\n"
    "    p = pathlib.Path(f)\n"
    '    print("正在翻译 (%d/%d)：%s" % (i, len(files), f))\n'
    "    if not (fail and p.name == 'bad.mkv'):\n"
    "        out = p.with_suffix('.srt')\n"
    "        out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\n你好\\n', encoding='utf-8')\n"
    '        print("正在写入：%s" % out)\n'
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


def test_pause_queue_stops_new_jobs() -> None:
    """队列暂停：运行中任务跑完、不再开新任务；继续后排队任务执行；状态持久化。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1, v2, v3 = (tmp / n for n in ("a.mkv", "b.mkv", "c.mkv"))
        for v in (v1, v2, v3):
            v.write_bytes(b"fake")
        data_dir = tmp / "data"
        data_dir.mkdir()
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None,
                        profile="test", data_dir=data_dir)
        try:
            j1 = engine.submit([v1], run_in_thread=True)   # 占用推理（0.6s）
            time.sleep(0.1)
            assert engine.pause_queue() is True
            assert engine.pause_queue() is False  # 幂等
            j2 = engine.submit([v2], run_in_thread=True)   # 暂停中：必须入队
            j3 = engine.submit([v3], run_in_thread=True)
            assert _wait(lambda: j1.finished is not None), "运行中任务应跑完"
            assert j1.files[0].status == TaskStatus.DONE
            time.sleep(0.8)  # 远大于推理耗时：确认没有开新任务
            assert not (v2.with_name("b.zh.srt")).exists()
            assert j2.files[0].status == TaskStatus.PENDING, j2.files[0].to_dict()
            assert j3.files[0].status == TaskStatus.PENDING
            assert engine.resume_queue() is True
            assert engine.resume_queue() is False
            assert _wait(lambda: j2.finished is not None and j3.finished is not None, timeout=30), \
                "继续后排队任务应依次执行"
            assert all(t.status == TaskStatus.DONE for t in j2.files + j3.files)
            assert (v2.with_name("b.zh.srt")).is_file() and (v3.with_name("c.zh.srt")).is_file()

            # 持久化：暂停状态落盘，新引擎（模拟重启）恢复
            assert engine.pause_queue() is True
            assert (data_dir / "pause.json").is_file()
            eng2 = Engine(engine.cfg, log=lambda s: None, profile="test", data_dir=data_dir)
            try:
                assert eng2.paused is True, "重启后应恢复暂停状态"
            finally:
                eng2.stop()
            engine.resume_queue()
        finally:
            engine.stop()
    print("  test_pause_queue_stops_new_jobs OK")


def test_pause_job_single() -> None:
    """单任务挂起：仅排队任务可挂起；运行中/已结束/不存在有明确返回。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1, v2, v3 = (tmp / n for n in ("a.mkv", "b.mkv", "c.mkv"))
        for v in (v1, v2, v3):
            v.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        try:
            j1 = engine.submit([v1], run_in_thread=True)   # 运行中
            time.sleep(0.1)
            j2 = engine.submit([v2], run_in_thread=True)   # 排队
            j3 = engine.submit([v3], run_in_thread=True)   # 排队
            assert engine.pause_job(j2.id) == "paused"
            assert engine.pause_job(j1.id) == "running"    # 运行中不可挂起
            assert engine.pause_job("no-such-job") is None
            assert engine.resume_job(j2.id) == "resumed"
            assert engine.resume_job(j2.id) == "not_paused"
            assert engine.resume_job("no-such-job") is None
            # j2 已恢复：j1 跑完后 j2 先跑再 j3
            assert _wait(lambda: j1.finished is not None)
            assert _wait(lambda: j2.finished is not None), "恢复的 j2 应执行"
            assert j2.files[0].status == TaskStatus.DONE
            assert _wait(lambda: j3.finished is not None)
            assert j3.files[0].status == TaskStatus.DONE
            assert engine.pause_job(j1.id) == "finished"   # 已结束
            assert engine.resume_job(j1.id) == "finished"
        finally:
            engine.stop()
    print("  test_pause_job_single OK")


def test_paused_job_does_not_block_queue() -> None:
    """队首挂起任务不阻塞后续：挂起者移尾，未挂起任务照常执行。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1, v2, v3 = (tmp / n for n in ("a.mkv", "b.mkv", "c.mkv"))
        for v in (v1, v2, v3):
            v.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        try:
            j1 = engine.submit([v1], run_in_thread=True)   # 运行中
            time.sleep(0.1)
            j2 = engine.submit([v2], run_in_thread=True)   # 队首
            j3 = engine.submit([v3], run_in_thread=True)
            assert engine.pause_job(j2.id) == "paused"
            assert _wait(lambda: j1.finished is not None)
            # j1 跑完后 j2 被挂起 → j3 先跑
            assert _wait(lambda: j3.finished is not None, timeout=15), "未挂起的 j3 应执行"
            assert j3.files[0].status == TaskStatus.DONE
            assert j2.files[0].status == TaskStatus.PENDING
            assert engine.resume_job(j2.id) == "resumed"
            assert _wait(lambda: j2.finished is not None)
            assert j2.files[0].status == TaskStatus.DONE
        finally:
            engine.stop()
    print("  test_paused_job_does_not_block_queue OK")


def test_retry_error_files() -> None:
    """重试覆盖 ERROR 文件：只重入失败文件，DONE 不重入；全 DONE 任务不可重试。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        good, bad = tmp / "good.mkv", tmp / "bad.mkv"
        good.write_bytes(b"fake")
        bad.write_bytes(b"fake")
        (tmp / "fail_flag").write_text("1")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_FLAKY)), log=lambda s: None, profile="test")
        try:
            job = engine.submit([good, bad], run_in_thread=False)  # 同步跑完
            assert job.files[0].status == TaskStatus.DONE, job.files[0].to_dict()
            assert job.files[1].status == TaskStatus.ERROR, job.files[1].to_dict()
            # 混合任务：重试只入 ERROR 文件
            new_job = engine.retry_job(job.id)
            assert new_job is not None, "ERROR 文件应可重试"
            assert [t.path.name for t in new_job.files] == ["bad.mkv"], new_job.files
            (tmp / "fail_flag").unlink()  # 重试时不再失败
            assert _wait(lambda: new_job.finished is not None), "重试任务应完成"
            assert new_job.files[0].status == TaskStatus.DONE, new_job.files[0].to_dict()
            assert (bad.with_name("bad.zh.srt")).is_file()
            # 全 DONE 任务不可重试
            v3 = tmp / "c.mkv"
            v3.write_bytes(b"fake")
            done_job = engine.submit([v3], run_in_thread=False)
            assert all(t.status == TaskStatus.DONE for t in done_job.files)
            assert engine.retry_job(done_job.id) is None
        finally:
            engine.stop()
    print("  test_retry_error_files OK")


def test_pause_http_status_codes() -> None:
    """HTTP：/jobs/pause|resume、/jobs/<id>/pause|resume、/health.paused。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        v1, v2, v3 = (tmp / n for n in ("a.mkv", "b.mkv", "c.mkv"))
        for v in (v1, v2, v3):
            v.write_bytes(b"fake")
        engine = Engine(_base_cfg(_write_fake(tmp, FAKE_SLOW)), log=lambda s: None, profile="test")
        httpd = ProgressHTTP(engine, host="127.0.0.1", port=0, inbox_dir=tmp)
        httpd.start()
        base = f"http://127.0.0.1:{httpd.server.server_address[1]}"
        try:
            # /health 带 paused 字段
            code, body = _http("GET", f"{base}/health")
            assert code == 200 and body.get("paused") is False, (code, body)
            # 队列级暂停/继续
            code, body = _http("POST", f"{base}/jobs/pause")
            assert code == 200 and body.get("paused") is True and body.get("changed") is True, (code, body)
            code, body = _http("POST", f"{base}/jobs/pause")
            assert code == 200 and body.get("changed") is False, (code, body)
            code, body = _http("GET", f"{base}/health")
            assert body.get("paused") is True
            # 暂停中提交 → 排队不开跑
            j = engine.submit([v1], run_in_thread=True)
            time.sleep(0.3)
            code, body = _http("GET", f"{base}/jobs")
            assert code == 200
            row = next(x for x in body if x["id"] == j.id)
            assert row.get("paused") is False and row["state"] == "running" and not row.get("current"), row
            assert j.files[0].status == TaskStatus.PENDING
            code, body = _http("POST", f"{base}/jobs/resume")
            assert code == 200 and body.get("paused") is False, (code, body)
            assert _wait(lambda: j.finished is not None)
            # 单任务级：j1 运行中 409 / j2 排队 200 / 二次 409 / 404
            j1 = engine.submit([v2], run_in_thread=True)
            time.sleep(0.1)
            j2 = engine.submit([v3], run_in_thread=True)
            code, body = _http("POST", f"{base}/jobs/{j1.id}/pause")
            assert code == 409 and body.get("ok") is False, (code, body)
            code, body = _http("POST", f"{base}/jobs/{j2.id}/pause")
            assert code == 200 and body.get("status") == "paused", (code, body)
            code, body = _http("GET", f"{base}/jobs/{j2.id}")
            assert code == 200 and body.get("paused") is True, body
            code, body = _http("POST", f"{base}/jobs/{j2.id}/pause")
            assert code == 200 and body.get("status") == "paused", (code, body)  # 幂等
            code, body = _http("POST", f"{base}/jobs/{j2.id}/resume")
            assert code == 200 and body.get("status") == "resumed", (code, body)
            code, body = _http("POST", f"{base}/jobs/{j2.id}/resume")
            assert code == 409, (code, body)  # not_paused
            code, body = _http("POST", f"{base}/jobs/no-such-job/pause")
            assert code == 404, (code, body)
            code, body = _http("POST", f"{base}/jobs/no-such-job/resume")
            assert code == 404, (code, body)
            assert _wait(lambda: j1.finished is not None and j2.finished is not None)
        finally:
            httpd.stop()
            engine.stop()
    print("  test_pause_http_status_codes OK")


def main() -> None:
    test_pause_queue_stops_new_jobs()
    test_pause_job_single()
    test_paused_job_does_not_block_queue()
    test_retry_error_files()
    test_pause_http_status_codes()
    print("test_pause: all OK")


if __name__ == "__main__":
    main()
