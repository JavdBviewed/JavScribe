"""Warm pool（ChickenRice --server 常驻模型池）测试（serve 0.2.16）。

conftest.py 给全套件钉死 JAVSCRIBE_NO_WARM=1（fake 引擎无 --server 协议）；
本文件显式删除该变量，用实现 [SERVER] 协议的 fake ChickenRice 常驻服验证：

  W1 批复用：2 Job 只 spawn 1 次（model_loads=1），全 DONE，批后回池空闲
  W2 空闲释放：keepalive=1s → 批后进程 idle_exit 自退，reaper 对账 model_loaded 回落
  W3 崩溃回收：第 2 批 fake 崩溃（exit 3）→ 文件 ERROR；第 3 批重新 spawn 成功 DONE
  W4 取消：批中取消 → 常驻进程被杀（即时），已产出保留、未开始 CANCELED，池清空
  W5 回退：引擎不支持 --server（ready 前退出）→ 本批自动回退经典一次性进程，DONE
  W6 配置：model_keepalive_s 校验（0=禁用 / 负数拒 / 上限 86400）+ 引擎钳位
  W7 池单测（fake runner，不起进程）：容量闸 / 忙闲对账 / 死亡清扫

Run:  uv run --with pytest -- pytest tests/test_warm_pool.py -q
      python3 tests/test_warm_pool.py
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
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


# ---------------------------------------------------------------------------
# fake ChickenRice --server 常驻服（[SERVER] 协议 + LogParser 可解析行）
# ---------------------------------------------------------------------------
def _fake_server(crash_at: int = 0) -> str:
    return (
        "import sys, json, os, pathlib, queue, threading, time\n"
        "keepalive = 600\n"
        "crash_at = 0\n"
        "for a in sys.argv:\n"
        "    if a.startswith('--keepalive_s='):\n"
        "        keepalive = int(a.split('=', 1)[1])\n"
        "    if a.startswith('--crash_at='):\n"
        "        crash_at = int(a.split('=', 1)[1])\n"
        "print('Loading Whisper model', flush=True)\n"
        "print('[SERVER] ready pid=%d' % os.getpid(), flush=True)\n"
        "q = queue.Queue()\n"
        "def rd():\n"
        "    try:\n"
        "        for line in sys.stdin:\n"
        "            q.put(line)\n"
        "    except Exception:\n"
        "        pass\n"
        "    q.put(None)\n"
        "threading.Thread(target=rd, daemon=True).start()\n"
        "nbatch = 0\n"
        "while True:\n"
        "    try:\n"
        "        line = q.get(timeout=keepalive if keepalive > 0 else None)\n"
        "    except queue.Empty:\n"
        "        print('[SERVER] idle_exit', flush=True)\n"
        "        sys.exit(0)\n"
        "    if line is None:\n"
        "        sys.exit(0)\n"
        "    line = line.strip()\n"
        "    if not line:\n"
        "        continue\n"
        "    fs = json.loads(line).get('files') or []\n"
        "    nbatch += 1\n"
        "    if crash_at and nbatch == crash_at:\n"
        "        sys.exit(3)\n"
        "    for i, f in enumerate(fs, 1):\n"
        "        print('Processing (translate) (%d/%d): %s' % (i, len(fs), f), flush=True)\n"
        "        out = pathlib.Path(f).with_suffix('.srt')\n"
        "        out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\nhello\\n', encoding='utf-8')\n"
        "        print('Writing: %s' % out, flush=True)\n"
        "        time.sleep(0.05)\n"
        "    print('[SERVER] batch_done files=%d' % len(fs), flush=True)\n"
    )


def _fake_server_slow(per_file_s: float) -> str:
    """每文件处理窗口拉长（取消命中窗口用）。"""
    return (
        "import sys, json, os, pathlib, queue, threading, time\n"
        "keepalive = 600\n"
        "for a in sys.argv:\n"
        "    if a.startswith('--keepalive_s='):\n"
        "        keepalive = int(a.split('=', 1)[1])\n"
        "print('Loading Whisper model', flush=True)\n"
        "print('[SERVER] ready pid=%d' % os.getpid(), flush=True)\n"
        "q = queue.Queue()\n"
        "def rd():\n"
        "    try:\n"
        "        for line in sys.stdin:\n"
        "            q.put(line)\n"
        "    except Exception:\n"
        "        pass\n"
        "    q.put(None)\n"
        "threading.Thread(target=rd, daemon=True).start()\n"
        "while True:\n"
        "    try:\n"
        "        line = q.get(timeout=keepalive if keepalive > 0 else None)\n"
        "    except queue.Empty:\n"
        "        print('[SERVER] idle_exit', flush=True)\n"
        "        sys.exit(0)\n"
        "    if line is None:\n"
        "        sys.exit(0)\n"
        "    line = line.strip()\n"
        "    if not line:\n"
        "        continue\n"
        "    fs = json.loads(line).get('files') or []\n"
        "    for i, f in enumerate(fs, 1):\n"
        "        print('Processing (translate) (%d/%d): %s' % (i, len(fs), f), flush=True)\n"
        "        time.sleep(__PER_FILE__)\n"
        "        out = pathlib.Path(f).with_suffix('.srt')\n"
        "        out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\nhello\\n', encoding='utf-8')\n"
        "        print('Writing: %s' % out, flush=True)\n"
        "    print('[SERVER] batch_done files=%d' % len(fs), flush=True)\n"
    ).replace("__PER_FILE__", repr(per_file_s))


def _fake_server_unsupported() -> str:
    """见到 --server 立即 exit 2（老 ChickenRice 无常驻模式）；否则经典一次性行为。"""
    return (
        "import sys, pathlib, time\n"
        "if '--server' in sys.argv:\n"
        "    sys.exit(2)\n"
        "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
        "print('Loading Whisper model', flush=True)\n"
        "for i, f in enumerate(files, 1):\n"
        "    print('Processing (translate) (%d/%d): %s' % (i, len(files), f), flush=True)\n"
        "    out = pathlib.Path(f).with_suffix('.srt')\n"
        "    out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\nhello\\n', encoding='utf-8')\n"
        "    print('Writing: %s' % out, flush=True)\n"
        "    time.sleep(0.05)\n"
        "print('done-all', flush=True)\n"
    )


def _write_fake(tmp: Path, code: str, name: str = "fake_warm.py") -> Path:
    fake = tmp / name
    fake.write_text(code, encoding="utf-8")
    return fake


def _cfg(td: Path, fake: Path, keepalive: int = 600, extra_args: list[str] | None = None) -> dict:
    infer: dict = {
        "command": f"{sys.executable} {fake}",
        "model": "models", "device": "cuda", "log_level": "DEBUG",
        "model_keepalive_s": keepalive,
    }
    if extra_args:
        infer["extra_args"] = extra_args
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


def _make_files(td: Path, n: int) -> list[Path]:
    out = []
    for i in range(n):
        f = td / f"v{i}.opus"
        f.write_bytes(b"fake-%d" % i)
        out.append(f)
    return out


def _spawns(lines: list[str]) -> int:
    return sum(1 for l in lines if "[warm] 启动常驻模型进程" in l)


# ---------------------------------------------------------------------------
# W1 批复用：2 Job 只加载一次模型
# ---------------------------------------------------------------------------
def test_w1_batch_reuse() -> None:
    if not sys.platform.startswith("linux"):
        print("  skip - W1 仅 Linux（warm 平台）")
        return
    old = os.environ.pop("JAVSCRIBE_NO_WARM", None)
    try:
        with tempfile.TemporaryDirectory() as td_s:
            td = Path(td_s)
            fake = _write_fake(td, _fake_server())
            f1, f2 = _make_files(td, 2)
            lines: list[str] = []
            eng = Engine(_cfg(td, fake), log=lines.append, data_dir=td / "data")
            try:
                assert eng.warm_pool_enabled, "warm 应启用（Linux + keepalive>0）"
                eng.pause_queue()
                j1 = eng.submit([f1], source_kind="remote", label="A.mp4")
                j2 = eng.submit([f2], source_kind="remote", label="B.mp4")
                eng.resume_queue()
                assert _wait(lambda: j1.done and j2.done, 60), [
                    t.status for j in (j1, j2) for t in j.files]
                for j in (j1, j2):
                    for t in j.files:
                        assert t.status == TaskStatus.DONE, (j.id, t.status, t.message)
                for f in (f1, f2):
                    assert f.with_name(f.stem + ".zh.srt").is_file(), f
                # 一次 spawn 覆盖两批（批 2 复用常驻进程，零加载等待）
                assert _spawns(lines) == 1, _spawns(lines)
                assert sum(1 for l in lines if "[warm] 常驻模型进程就绪" in l) == 1
                assert sum(1 for l in lines if "Loading Whisper model" in l) == 1, \
                    "批 2 不应再出现模型加载行"
                assert eng.coalesce_stats()["model_loads"] == 1, eng.coalesce_stats()
                # 批后进程回池空闲（不占 worker，但驻留模型计数 +1）
                assert _wait(lambda: eng._pool.idle_count == 1, 10), eng._pool.idle_count
                assert eng.model_loaded
                ok("W1 2 Job 一次模型加载，批 2 复用常驻进程，批后回池空闲")
            finally:
                eng.stop()
            # stop 后常驻进程必须被终止（不泄漏）
            assert _wait(lambda: eng._pool.size == 0 and not eng.model_loaded, 10)
    finally:
        if old is not None:
            os.environ["JAVSCRIBE_NO_WARM"] = old
    ok("W1 stop 后常驻进程终止，模型计数归零")


# ---------------------------------------------------------------------------
# W2 空闲释放：keepalive 自退 + reaper 对账
# ---------------------------------------------------------------------------
def test_w2_idle_release() -> None:
    if not sys.platform.startswith("linux"):
        print("  skip - W2 仅 Linux（warm 平台）")
        return
    old = os.environ.pop("JAVSCRIBE_NO_WARM", None)
    try:
        with tempfile.TemporaryDirectory() as td_s:
            td = Path(td_s)
            fake = _write_fake(td, _fake_server())
            f1 = _make_files(td, 1)[0]
            lines: list[str] = []
            eng = Engine(_cfg(td, fake, keepalive=1), log=lines.append, data_dir=td / "data")
            try:
                j1 = eng.submit([f1], source_kind="remote", label="A.mp4")
                assert _wait(lambda: j1.done, 60), [t.status for t in j1.files]
                assert j1.files[0].status == TaskStatus.DONE
                # keepalive=1s：批后 ~1s idle_exit 自退；reaper（5s 间隔）对账
                assert _wait(lambda: not eng.model_loaded, 15), \
                    "keepalive 自退后 model_loaded 未回落"
                assert eng._pool.size == 0, eng._pool.size
            finally:
                eng.stop()
    finally:
        if old is not None:
            os.environ["JAVSCRIBE_NO_WARM"] = old
    ok("W2 keepalive 自退（idle_exit）+ reaper 对账 model_loaded 回落")


# ---------------------------------------------------------------------------
# W3 崩溃回收：批 2 崩溃 → ERROR；批 3 重新 spawn → DONE
# ---------------------------------------------------------------------------
def test_w3_crash_recovery() -> None:
    if not sys.platform.startswith("linux"):
        print("  skip - W3 仅 Linux（warm 平台）")
        return
    old = os.environ.pop("JAVSCRIBE_NO_WARM", None)
    try:
        with tempfile.TemporaryDirectory() as td_s:
            td = Path(td_s)
            fake = _write_fake(td, _fake_server(crash_at=2))
            f1, f2, f3 = _make_files(td, 3)
            lines: list[str] = []
            eng = Engine(_cfg(td, fake, extra_args=["--crash_at=2"]),
                         log=lines.append, data_dir=td / "data")
            try:
                # 串行提交：每 Job 独立成批（并发提交会被 coalesce 合并进
                # 同一批，「批 2 崩溃」前提不成立）
                j1 = eng.submit([f1], source_kind="remote", label="A.mp4")
                assert _wait(lambda: j1.done, 60), [t.status for t in j1.files]
                j2 = eng.submit([f2], source_kind="remote", label="B.mp4")
                assert _wait(lambda: j2.done, 60), [t.status for t in j2.files]
                j3 = eng.submit([f3], source_kind="remote", label="C.mp4")
                assert _wait(lambda: j3.done, 90), [t.status for t in j3.files]
                assert j1.files[0].status == TaskStatus.DONE, j1.files[0].message
                assert j2.files[0].status == TaskStatus.ERROR, j2.files[0].status
                assert "退出码 3" in (j2.files[0].message or ""), j2.files[0].message
                assert j3.files[0].status == TaskStatus.DONE, j3.files[0].message
                assert _spawns(lines) == 2, _spawns(lines)  # 崩溃后重建一次
                assert eng.coalesce_stats()["model_loads"] == 2
            finally:
                eng.stop()
    finally:
        if old is not None:
            os.environ["JAVSCRIBE_NO_WARM"] = old
    ok("W3 批 2 崩溃 → ERROR(退出码 3)；批 3 重新 spawn → DONE")


# ---------------------------------------------------------------------------
# W4 批中取消：常驻进程被杀（即时），已产出保留 / 未开始 CANCELED
# ---------------------------------------------------------------------------
def test_w4_cancel_kills_resident() -> None:
    if not sys.platform.startswith("linux"):
        print("  skip - W4 仅 Linux（warm 平台）")
        return
    old = os.environ.pop("JAVSCRIBE_NO_WARM", None)
    try:
        with tempfile.TemporaryDirectory() as td_s:
            td = Path(td_s)
            fake = _write_fake(td, _fake_server_slow(1.5))
            f1, f2, f3 = _make_files(td, 3)
            lines: list[str] = []
            eng = Engine(_cfg(td, fake), log=lines.append, data_dir=td / "data")
            try:
                j1 = eng.submit([f1, f2, f3], source_kind="remote", label="A.mp4")
                # 等首文件进入 RUNNING（批已投出）再取消
                assert _wait(
                    lambda: any(t.status == TaskStatus.RUNNING for t in j1.files), 30
                ), [t.status for t in j1.files]
                eng.cancel_job(j1.id)
                assert _wait(lambda: j1.done, 30), [t.status for t in j1.files]
                assert any(t.status == TaskStatus.CANCELED for t in j1.files), [
                    t.status for t in j1.files]
                # 常驻进程被即时杀（池清空、模型计数归零）
                assert _wait(lambda: eng._pool.size == 0 and not eng.model_loaded, 15)
                assert any("收到取消，终止常驻进程" in l for l in lines)
            finally:
                eng.stop()
    finally:
        if old is not None:
            os.environ["JAVSCRIBE_NO_WARM"] = old
    ok("W4 批中取消：常驻进程被杀，未开始文件 CANCELED，池清空")


# ---------------------------------------------------------------------------
# W5 回退：引擎不支持 --server（ready 前退出）→ 经典一次性进程兜底
# ---------------------------------------------------------------------------
def test_w5_fallback_classic() -> None:
    if not sys.platform.startswith("linux"):
        print("  skip - W5 仅 Linux（warm 平台）")
        return
    old = os.environ.pop("JAVSCRIBE_NO_WARM", None)
    try:
        with tempfile.TemporaryDirectory() as td_s:
            td = Path(td_s)
            fake = _write_fake(td, _fake_server_unsupported())
            f1 = _make_files(td, 1)[0]
            lines: list[str] = []
            eng = Engine(_cfg(td, fake), log=lines.append, data_dir=td / "data")
            try:
                j1 = eng.submit([f1], source_kind="remote", label="A.mp4")
                assert _wait(lambda: j1.done, 60), [t.status for t in j1.files]
                assert j1.files[0].status == TaskStatus.DONE, j1.files[0].message
                assert any("就绪前退出（code 2）" in l for l in lines), \
                    "缺少 spawn 失败日志"
                assert f1.with_name(f1.stem + ".zh.srt").is_file()
                # 回退经典路径：模型加载走一次性进程（_model_loads 口径）
                assert eng._model_loads == 1 and eng._pool.loads == 0
            finally:
                eng.stop()
    finally:
        if old is not None:
            os.environ["JAVSCRIBE_NO_WARM"] = old
    ok("W5 --server 不支持时自动回退经典一次性进程，任务仍 DONE")


# ---------------------------------------------------------------------------
# W6 配置：校验 / 钳位 / 禁用态
# ---------------------------------------------------------------------------
def test_w6_config_validation() -> None:
    from jav_scribe.core.progress_api import ConfigError, validate_config_updates

    for v in (0, 600, 86400):
        validate_config_updates({"infer.model_keepalive_s": v})
    for v in (-1, 86401, "600", True):
        try:
            validate_config_updates({"infer.model_keepalive_s": v})
        except ConfigError:
            pass
        else:
            raise AssertionError(f"非法值 {v!r} 未被拒绝")

    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        fake = _write_fake(td, _fake_server())
        eng0 = Engine(_cfg(td, fake, keepalive=0), log=lambda s: None, data_dir=td / "data")
        assert not eng0.warm_pool_enabled, "keepalive=0 必须禁用 warm（回退现行为）"
        assert eng0.model_keepalive_s == 0
        eng0.stop()
        eng_b = Engine(_cfg(td, fake, keepalive=-50), log=lambda s: None, data_dir=td / "data")
        assert eng_b.model_keepalive_s == 0, "负值钳到 0（禁用）"
        eng_b.stop()
    ok("W6 配置校验：0=禁用 / 负数钳 0 / 上限 86400 / 非法类型拒")


# ---------------------------------------------------------------------------
# W7 池单测（fake runner，不起真实进程）：容量 / 对账 / 清扫
# ---------------------------------------------------------------------------
class _FakeRunner:
    def __init__(self, alive: bool = True) -> None:
        self.alive = alive
        self.on_line = None
        self.stopped = False

    @property
    def proc_alive(self) -> bool:
        return self.alive

    def stop(self) -> None:
        self.stopped = True
        self.alive = False


class _FakeEngine:
    def __init__(self, concurrency: int = 2, vram_open: bool = True) -> None:
        import threading
        self.cfg = {"infer": {}}
        self.log = lambda s: None
        self.concurrency = concurrency
        self._model_procs = 0
        self._model_lock = threading.Lock()
        self._stop_evt = threading.Event()
        self._runners_lock = threading.Lock()
        self._active_runners: set = set()
        self._vram_open = vram_open

    @property
    def model_loaded(self) -> bool:
        return self._model_procs > 0

    def _model_up(self) -> None:
        self._model_procs += 1

    def _model_down(self) -> None:
        if self._model_procs > 0:
            self._model_procs -= 1

    def _vram_gate_open(self) -> bool:
        return self._vram_open

    def _build_infer_command(self, files, server: bool = False):
        raise AssertionError("fake engine 不应 spawn")


def test_w7_pool_unit() -> None:
    from jav_scribe.core.model_pool import ModelPool

    eng = _FakeEngine(concurrency=1)
    pool = ModelPool(eng)
    try:
        # 容量闸：一个在批进程占满容量（concurrency=1）→ acquire 回退经典
        r1 = _FakeRunner()
        eng._model_procs += 1
        pool._busy.add(r1)
        assert pool.acquire(lambda l: None) is None, "容量满且无空闲 → 回退经典"
        # 空闲复用：release 回池后 acquire 复用同一进程（不 spawn 新进程）
        pool.release(r1)
        r2 = pool.acquire(lambda l: None)
        assert r2 is r1, "空闲进程应被复用而非新建"
        assert r1 in pool._busy
        # 在批进程由属主 discard 回收（含模型计数对账）
        pool.discard(r1, "归还")
        assert eng._model_procs == 0
        # 死亡空闲对账：idle 中死进程（idle_exit 自退）→ reap 清理 bookkeeping
        r2x = _FakeRunner(alive=False)
        eng._model_procs += 1
        pool._idle.append(r2x)
        with pool._lock:
            pool._reap_locked()
        assert pool._idle == [] and eng._model_procs == 0, "死亡进程模型计数未对账"
        # 显存闸关（已有驻留实例）→ 不 spawn，回退经典
        eng._model_procs += 1
        eng._vram_open = False
        assert pool.acquire(lambda l: None) is None, "显存闸关应回退经典"
    finally:
        eng._stop_evt.set()
        pool.shutdown()
    ok("W7 池单测：容量闸 / 空闲复用 / 死亡对账 / 显存闸回退")


if __name__ == "__main__":
    os.environ.pop("JAVSCRIBE_NO_WARM", None)
    test_w1_batch_reuse()
    test_w2_idle_release()
    test_w3_crash_recovery()
    test_w4_cancel_kills_resident()
    test_w5_fallback_classic()
    test_w6_config_validation()
    test_w7_pool_unit()
    print(f"ALL {PASSED} WARM POOL TESTS PASSED")
