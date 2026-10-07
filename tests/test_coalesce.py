"""Coalesce（模型预热 / 前瞻合并）测试：一个推理进程覆盖多个 Job。

验收（PRD a~e 对应）：
  T1 a) 3 个 Job、coalesce_max_jobs=3 → 只 1 次模型加载，3 Job 全 DONE，
        字幕落位 <stem>.zh.srt，合并日志 + 「随批加载」phase_detail + metrics
  T2 b) coalesce_max_jobs=1（关闭态）→ 每 Job 一个进程（现状行为），applied=0
  T3 c) 合并批次中取消 1 个 Job → 进程不死跑完全部，被取消 Job 置 CANCELED
  T4 d) 暂停队列后新上传不被合并进在跑进程（不越暂停线）
  T5 e) 配置项：校验（正整数 1~50）+ 引擎钳位 + /config 热调落盘
  T6   metrics：新 4 项渲染 + 旧 FakeEngine（无 coalesce_stats）回归为 0

无 GPU / 真实模型：stub 推理脚本打印 LogParser 可解析的行（同 test_live_progress 套路）。

Run:  uv run pytest tests/test_coalesce.py -q
      python3 tests/test_coalesce.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.engine import Engine  # noqa: E402
from jav_scribe.core.task import TaskStatus  # noqa: E402

PASSED = 0


def ok(name: str) -> None:
    global PASSED
    PASSED += 1
    print(f"  ok - {name}")


def _wait(cond: Callable[[], bool], timeout: float = 30.0, step: float = 0.02) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(step)
    return cond()


def _fake_fast(window_s: float) -> str:
    """假推理进程：一次模型加载 → 窗口 sleep（制造观察/取消窗口）→ 逐文件快速产出。"""
    return (
        "import sys, pathlib, time\n"
        "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
        'print("Loading Whisper model", flush=True)\n'
        f"time.sleep({window_s!r})\n"
        "for i, f in enumerate(files, 1):\n"
        '    print("Processing (translate) (%d/%d): %s" % (i, len(files), f), flush=True)\n'
        "    out = pathlib.Path(f).with_suffix('.srt')\n"
        "    out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\nhello\\n', encoding='utf-8')\n"
        '    print("Writing: %s" % out, flush=True)\n'
        "    time.sleep(0.25)\n"
        'print("done-all", flush=True)\n'
    )


def _fake_slow_second() -> str:
    """文件1 快速完成，文件2 开始前 sleep 1.5s（取消命中该窗口；进程应不死）。"""
    return (
        "import sys, pathlib, time\n"
        "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
        'print("Loading Whisper model", flush=True)\n'
        "for i, f in enumerate(files, 1):\n"
        '    print("Processing (translate) (%d/%d): %s" % (i, len(files), f), flush=True)\n'
        "    if i == 1:\n"
        "        for k in range(20):\n"
        '            print("[0:%d.00 --> 0:%d.00] seg%d" % (30 + k, 31 + k, k), flush=True)\n'
        "            time.sleep(0.02)\n"
        "    else:\n"
        "        time.sleep(1.5)\n"
        "    out = pathlib.Path(f).with_suffix('.srt')\n"
        "    out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\nhello\\n', encoding='utf-8')\n"
        '    print("Writing: %s" % out, flush=True)\n'
        'print("done-all", flush=True)\n'
    )


def _write_fake(tmp: Path, code: str, name: str = "fake_coalesce.py") -> Path:
    fake = tmp / name
    fake.write_text(code, encoding="utf-8")
    return fake


def _cfg(td: Path, fake: Path, coalesce: int | None = None) -> dict:
    infer = {
        "command": f"{sys.executable} {fake}",
        "model": "models", "device": "cuda", "log_level": "DEBUG",
    }
    if coalesce is not None:
        infer["coalesce_max_jobs"] = coalesce
    return {
        "infer": infer,
        "subtitle": {
            "formats": ["srt"], "lang_tag": "zh", "naming": "rename",
            "output_dir": None, "skip_if_exists": True, "overwrite": False,
            "tag_formats": ["srt"],
        },
        "polish": {"enabled": False},
        "emby": {"enabled": False},
        "jasna": {"enabled": False},
    }


def _model_loads(lines: list[str]) -> int:
    return sum(1 for l in lines if "Loading Whisper model" in l)


# ---------------------------------------------------------------------------
# T1 验收 a：3 Job 合并进一个进程
# ---------------------------------------------------------------------------
def test_a_coalesce_single_load() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        fake = _write_fake(td, _fake_fast(1.0))
        f1, f2, f3 = td / "v1.opus", td / "v2.opus", td / "v3.opus"
        for i, f in enumerate((f1, f2, f3)):
            f.write_bytes(b"fake-%d" % i)
        lines: list[str] = []
        eng = Engine(_cfg(td, fake, coalesce=3), log=lines.append, data_dir=td / "data")
        try:
            # 确定性排队：暂停 → 3 个 Job 全入队（顺序可预期）→ 恢复，j1 成为主任务
            eng.pause_queue()
            j1 = eng.submit([f1], source_kind="remote", label="A.mp4")
            j2 = eng.submit([f2], source_kind="remote", label="B.mp4")
            j3 = eng.submit([f3], source_kind="remote", label="C.mp4")
            assert [j.id for j in eng._pending_jobs] == [j1.id, j2.id, j3.id]
            eng.resume_queue()
            # 轮询到全部终态；期间捕获 j2/j3 文件的「随批加载」（R3 展示路径，
            # 终态后 phase_detail 会被覆盖，必须在运行窗口内观察到）
            seen_batch_detail = False
            deadline = time.time() + 30
            while time.time() < deadline:
                for j in (j2, j3):
                    for t in j.files:
                        if t.phase_detail == "随批加载":
                            seen_batch_detail = True
                if j1.done and j2.done and j3.done:
                    break
                time.sleep(0.02)
            assert j1.done and j2.done and j3.done, (
                [t.status for j in (j1, j2, j3) for t in j.files])
            assert seen_batch_detail, "运行窗口内未观察到「随批加载」展示"
            for j in (j1, j2, j3):
                for t in j.files:
                    assert t.status == TaskStatus.DONE, (j.id, t.status, t.message)
            for f in (f1, f2, f3):
                assert f.with_name(f.stem + ".zh.srt").is_file(), f
            assert _model_loads(lines) == 1, "应只加载一次模型"
            cl = [l for l in lines if "coalesce 合并" in l]
            assert cl, "缺少 coalesce 合并日志"
            assert j2.id in cl[0] and j3.id in cl[0], cl[0]
            assert eng.coalesce_stats() == {
                "coalesce_applied": 1,
                "model_loads": 1,
                "last_batch_files": 3,
                "last_batch_jobs": 3,
            }, eng.coalesce_stats()
            ok("a) 3 Job 一次模型加载全 DONE，字幕落位，日志+metrics 自证")
        finally:
            eng.stop()


# ---------------------------------------------------------------------------
# T2 验收 b：关闭态（coalesce=1）行为与现状一致
# ---------------------------------------------------------------------------
def test_b_disabled_unchanged() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        fake = _write_fake(td, _fake_fast(1.2))
        f1, f2 = td / "w1.opus", td / "w2.opus"
        f1.write_bytes(b"a"); f2.write_bytes(b"b")
        lines: list[str] = []
        eng = Engine(_cfg(td, fake, coalesce=1), log=lines.append, data_dir=td / "data")
        try:
            j1 = eng.submit([f1], source_kind="remote", label="A.mp4")
            time.sleep(0.5)  # j1 进程在跑（1.2s 窗口），j2 必排队
            j2 = eng.submit([f2], source_kind="remote", label="B.mp4")
            assert _wait(lambda: j1.done and j2.done, timeout=30), (
                [t.status for j in (j1, j2) for t in j.files])
            for j in (j1, j2):
                assert all(t.status == TaskStatus.DONE for t in j.files)
            assert _model_loads(lines) == 2, "关闭态应每 Job 一个进程"
            assert not any("coalesce 合并" in l for l in lines)
            assert eng.coalesce_stats() == {
                "coalesce_applied": 0,
                "model_loads": 2,
                "last_batch_files": 1,
                "last_batch_jobs": 1,
            }, eng.coalesce_stats()
            ok("b) coalesce=1 关闭态：2 进程、0 合并、行为与现状一致")
        finally:
            eng.stop()


# ---------------------------------------------------------------------------
# T3 验收 c：合并批次中取消 1 个 Job，进程不死
# ---------------------------------------------------------------------------
def test_c_cancel_merged_job() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        fake = _write_fake(td, _fake_slow_second())
        f1, f2 = td / "x1.opus", td / "x2.opus"
        f1.write_bytes(b"a"); f2.write_bytes(b"b")
        lines: list[str] = []
        eng = Engine(_cfg(td, fake, coalesce=3), log=lines.append, data_dir=td / "data")
        try:
            eng.pause_queue()
            j1 = eng.submit([f1], source_kind="remote", label="A.mp4")
            j2 = eng.submit([f2], source_kind="remote", label="B.mp4")
            eng.resume_queue()
            # 等 j1 文件已写出（file_written 已记录）→ 此时进程在文件2 的 sleep 窗口
            assert _wait(lambda: bool(j1.files[0].output_files), timeout=15), (
                j1.files[0].status, j1.files[0].message)
            res = eng.cancel_job(j2.id)
            assert res == "canceling", f"合并中的 Job 应按运行中处理: {res}"
            assert _wait(lambda: j1.done and j2.done, timeout=20), (
                [t.status for j in (j1, j2) for t in j.files])
            # 进程跑完了全部文件（没被单 Job 取消杀死）
            assert any("done-all" in l for l in lines), "推理进程应存活跑完"
            assert j1.files[0].status == TaskStatus.DONE
            assert f1.with_name("x1.zh.srt").is_file()
            t2 = j2.files[0]
            assert t2.status == TaskStatus.CANCELED, (t2.status, t2.message)
            assert t2.message == "已取消", t2.message
            assert t2.output_files == []
            assert not f2.with_name("x2.zh.srt").exists(), "被取消 Job 不应 finalize"
            assert j2.finished is not None
            assert any(f"coalesce 并入 {j1.id}" in l for l in lines), "缺并入收尾日志"
            assert eng.coalesce_stats() == {
                "coalesce_applied": 1,
                "model_loads": 1,
                "last_batch_files": 2,
                "last_batch_jobs": 2,
            }, eng.coalesce_stats()
            ok("c) 合并批中取消 1 Job：进程不死、其余 DONE、被取消 CANCELED")
        finally:
            eng.stop()


# ---------------------------------------------------------------------------
# T4 验收 d：暂停队列后新上传不被合并进在跑进程
# ---------------------------------------------------------------------------
def test_d_paused_queue_no_merge() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        fake = _write_fake(td, _fake_fast(1.5))
        f1, f2 = td / "y1.opus", td / "y2.opus"
        f1.write_bytes(b"a"); f2.write_bytes(b"b")
        lines: list[str] = []
        eng = Engine(_cfg(td, fake, coalesce=3), log=lines.append, data_dir=td / "data")
        try:
            j1 = eng.submit([f1], source_kind="remote", label="A.mp4")
            time.sleep(0.5)  # j1 进程在跑（1.5s 窗口）
            eng.pause_queue()
            j2 = eng.submit([f2], source_kind="remote", label="B.mp4")
            time.sleep(0.5)
            # 暂停线：j2 只排队，不进在跑进程
            assert j2.id in [x.id for x in eng._pending_jobs], "j2 应仍在队列"
            assert j2.files[0].status == TaskStatus.PENDING
            assert j2.files[0].phase_detail != "随批加载", "暂停后不得合并"
            assert _model_loads(lines) <= 1, "暂停窗口内不应出现第二个进程"
            eng.resume_queue()
            assert _wait(lambda: j1.done and j2.done, timeout=30), (
                [t.status for j in (j1, j2) for t in j.files])
            for j in (j1, j2):
                assert all(t.status == TaskStatus.DONE for t in j.files)
            assert _model_loads(lines) == 2, "恢复后 j2 应自起一个进程"
            assert not any("coalesce 合并" in l for l in lines)
            assert eng.coalesce_stats()["coalesce_applied"] == 0
            ok("d) 暂停队列期间新上传不合并，恢复后独立成进程")
        finally:
            eng.stop()


# ---------------------------------------------------------------------------
# T5 验收 e：配置项校验 + 引擎钳位 + /config 热调
# ---------------------------------------------------------------------------
def test_e_config_item() -> None:
    from jav_scribe.core.progress_api import (
        ConfigError, build_config_view, validate_config_updates)

    out = validate_config_updates({"infer.coalesce_max_jobs": 7})
    assert ("infer", "coalesce_max_jobs", 7) in out, out
    for bad in (0, 51, "5", True, None):
        try:
            validate_config_updates({"infer.coalesce_max_jobs": bad})
        except ConfigError:
            pass
        else:
            raise AssertionError(f"{bad!r} 应被拒绝")
    view = {i["path"]: i for i in build_config_view({"infer": {"coalesce_max_jobs": 5}})}
    item = view["infer.coalesce_max_jobs"]
    assert item["type"] == "int" and item["value"] == 5 and item["hint"], item

    # 引擎钳位：缺省 5 / 0→1 / 99→50 / "8"→8 / "x"→5
    for v, want in ((None, 5), (0, 1), (99, 50), ("8", 8), ("x", 5)):
        cfg = {"infer": {}, "subtitle": {"lang_tag": "zh"}}
        if v is not None:
            cfg["infer"]["coalesce_max_jobs"] = v
        with tempfile.TemporaryDirectory() as td:
            eng = Engine(cfg, data_dir=Path(td))
            assert eng.coalesce_max_jobs == want, (v, eng.coalesce_max_jobs)
            eng.stop()
    ok("e) 配置项：校验 1~50 / 钳位 / build_config_view 含 hint")


class _CfgEngine:
    """/config 路径仅用 cfg/log 的 duck-typed engine。"""

    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.jobs: list = []
        self.paused = False

    def log(self, _msg: str) -> None:
        pass


def _http(method: str, url: str, body: dict | None = None, key: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if key is not None:
        req.add_header("X-Api-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as ex:
        raw = ex.read().decode()
        try:
            return ex.code, json.loads(raw)
        except json.JSONDecodeError:
            return ex.code, {"raw": raw}


def test_e2_config_http() -> None:
    from jav_scribe.core.progress_api import ProgressHTTP

    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        cfg = {
            "api": {"key": "k1"},
            "infer": {"command": "", "model": "m", "device": "cpu"},
            "subtitle": {"lang_tag": "zh"},
        }
        cfg_path = td / "config.json"
        cfg_path.write_text(json.dumps(
            {"profile": "server", "profiles": {"server": {"infer": {"model": "m"}}},
             "progress": {"host": "0.0.0.0", "port": 8300}}), encoding="utf-8")
        engine = _CfgEngine(cfg)
        http = ProgressHTTP(engine, host="127.0.0.1", port=0, profile="server",
                            inbox_dir=td / "inbox", config_path=cfg_path)
        http.start()
        base = f"http://127.0.0.1:{http.server.server_address[1]}"
        try:
            code, body = _http("PUT", base + "/config",
                               {"values": {"infer.coalesce_max_jobs": 3}}, key="k1")
            assert code == 200 and body.get("updated") == ["infer.coalesce_max_jobs"], (code, body)
            assert cfg["infer"]["coalesce_max_jobs"] == 3, "热调未生效"
            saved = json.loads(cfg_path.read_text(encoding="utf-8"))
            assert saved["profiles"]["server"]["infer"]["coalesce_max_jobs"] == 3, "未落盘"
            code, body = _http("PUT", base + "/config",
                               {"values": {"infer.coalesce_max_jobs": 51}}, key="k1")
            assert code == 400 and not body["ok"], (code, body)
        finally:
            http.stop()
    ok("e) /config HTTP：PUT 3 热调+落盘 / PUT 51 拒绝")


# ---------------------------------------------------------------------------
# T6 metrics：新 4 项渲染 + 旧 engine 回归 0
# ---------------------------------------------------------------------------
def _parse(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        key, _, val = line.rpartition(" ")
        out[key] = val
    return out


def test_f_metrics_render() -> None:
    from jav_scribe.core import metrics as M

    class _EngWithStats:
        jobs: list = []
        cfg: dict = {"infer": {}}
        model_loaded = False

        def active_workers(self) -> int:
            return 0

        def coalesce_stats(self) -> dict:
            return {"coalesce_applied": 3, "model_loads": 5,
                    "last_batch_files": 7, "last_batch_jobs": 4}

    out = _parse(M.MetricsRegistry().render(_EngWithStats()))
    assert out["javscribe_model_loads_total"] == "5"
    assert out["javscribe_coalesce_applied_total"] == "3"
    assert out["javscribe_infer_last_batch_files"] == "7"
    assert out["javscribe_infer_last_batch_jobs"] == "4"

    class _EngLegacy:  # 无 coalesce_stats 的旧形态 engine（回归保护）
        jobs: list = []
        cfg: dict = {"infer": {}}
        model_loaded = False

        def active_workers(self) -> int:
            return 0

    out2 = _parse(M.MetricsRegistry().render(_EngLegacy()))
    assert out2["javscribe_model_loads_total"] == "0"
    assert out2["javscribe_coalesce_applied_total"] == "0"
    assert out2["javscribe_infer_last_batch_files"] == "0"
    assert out2["javscribe_infer_last_batch_jobs"] == "0"
    ok("f) metrics：新 4 项值正确，无 coalesce_stats 的 engine 渲染 0")


if __name__ == "__main__":
    test_a_coalesce_single_load()
    test_b_disabled_unchanged()
    test_c_cancel_merged_job()
    test_d_paused_queue_no_merge()
    test_e_config_item()
    test_e2_config_http()
    test_f_metrics_render()
    print(f"ALL {PASSED} COALESCE TESTS PASSED")
