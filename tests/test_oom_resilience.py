"""OOM 韧性（serve 0.2.12：A 可读提示 / B 显存预检 / C 一次自动重试 / D 补丁）。

对应 /tmp/jscribe-real/report.md 第四节根因调查与 E1–E4 隔离实验：
- A：OOM 失败落 Task.oom + 可读文案（含「显存不足」「重试」要素），未命中签名保持原兜底（附退出码）
- B：已有在跑进程时查 nvidia-smi 空闲显存，低于 infer.vram_per_instance_gb（默认 12）
  新任务留 pending；无 nvidia-smi 降级不阻断
- C：OOM 失败自动重排 PENDING 一次（auto_retries 上限 1，防循环；取消/停止/挂起不重试）
- D：docker/chickenrice-patches/log-concurrent-safe.patch 修 latest.log 并发互截

Run: python3 tests/test_oom_resilience.py  （或随 pytest 收集）
"""
from __future__ import annotations

import os
import re
import stat
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.engine import (  # noqa: E402
    OOM_MESSAGE,
    Engine,
    looks_like_oom,
)
from jav_scribe.core.progress_api import (  # noqa: E402
    ConfigError,
    build_config_view,
    validate_config_updates,
)
from jav_scribe.core.task import Job, Task, TaskPhase, TaskStatus  # noqa: E402
from jav_scribe.core.vram import gpu_free_vram_gb  # noqa: E402

REPO = Path(__file__).resolve().parents[1]

# 慢启动假引擎（与 test_concurrency.py 同口径）：加载模型 sleep 1.2s，给并发观测留窗口
FAKE_SLOW = (
    "import sys, pathlib, time\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    'print("正在加载 Whisper 模型")\n'
    "time.sleep(1.2)\n"
    "for f in files:\n"
    "    p = pathlib.Path(f)\n"
    '    print("正在翻译 (1/1)：%s" % f)\n'
    '    print("Duration: 30.00s")\n'
    "    out = p.with_suffix('.srt')\n"
    "    out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\n你好\\n', encoding='utf-8')\n"
    '    print("Writing: %s" % out)\n'
    'print("全部完成")\n'
)

# 假引擎 1：首跑 OOM（stderr 签名 + 退出 1，不写字幕），留下 marker；二跑成功
FAKE_OOM_THEN_OK = (
    "import sys, pathlib\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    "p0 = pathlib.Path(files[0])\n"
    "marker = p0.with_name(p0.name + '.retry')\n"
    "if marker.exists():\n"
    "    for f in files:\n"
    "        p = pathlib.Path(f)\n"
    '        print("正在翻译 (1/1)：%s" % f, flush=True)\n'
    '        print("Duration: 30.00s", flush=True)\n'
    "        out = p.with_suffix('.srt')\n"
    "        out.write_text('1\\n00:00:30,000 --> 00:01:00,000\\n你好\\n', encoding='utf-8')\n"
    '        print("Writing: %s" % out, flush=True)\n'
    '    print("全部完成", flush=True)\n'
    "    sys.exit(0)\n"
    "marker.write_text('1')\n"
    'print("正在翻译 (1/1)：%s" % files[0], flush=True)\n'
    'print("RuntimeError: CUDA failed with error out of memory", file=sys.stderr, flush=True)\n'
    "sys.exit(1)\n"
)

# 假引擎 2：总是 OOM（每次调用计数，验证重试上限 1 → 恰好两次进程调用）
FAKE_ALWAYS_OOM = (
    "import os, sys, pathlib\n"
    "files = [a for a in sys.argv[1:] if not a.startswith('-')]\n"
    "counter = os.environ.get('OOM_COUNTER_FILE')\n"
    "if counter:\n"
    "    c = pathlib.Path(counter)\n"
    "    n = int(c.read_text()) if c.exists() else 0\n"
    "    n += 1\n"
    "    c.write_text(str(n))\n"
    'print("正在翻译 (1/1)：%s" % files[0], flush=True)\n'
    'print("RuntimeError: CUDA failed with error out of memory", file=sys.stderr, flush=True)\n'
    "sys.exit(1)\n"
)


def _write_fake(tmp: Path, code: str, name: str = "fake_infer.py") -> Path:
    fake = tmp / name
    fake.write_text(code, encoding="utf-8")
    return fake


def _base_cfg(fake: Path, concurrency: int | None = None) -> dict:
    cfg = {
        "infer": {
            "command": f"{sys.executable} {fake}",
            "model": "models",
            "device": "cpu",
            "log_level": "DEBUG",
            "coalesce_max_jobs": 1,
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
    if concurrency is not None:
        cfg["infer"]["concurrency"] = concurrency
    return cfg


def _mk_video(tmp: Path, name: str) -> Path:
    v = tmp / name
    v.write_bytes(b"fake")
    return v


def _running_count(engine: Engine) -> int:
    return sum(
        1 for j in engine.jobs for t in j.files if t.status == TaskStatus.RUNNING
    )


def _wait_done(jobs, timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if all(j.done for j in jobs):
            return
        time.sleep(0.05)
    raise AssertionError(
        f"超时：任务未完成 {[(j.id, [t.status for t in j.files]) for j in jobs]}"
    )


def _observed_max_running(engine: Engine, stop_when, timeout: float = 60.0) -> int:
    peak = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        peak = max(peak, _running_count(engine))
        if stop_when():
            return peak
        time.sleep(0.03)
    raise AssertionError("观测超时")


# ---------------------------------------------------------------------------
# A：OOM 签名识别 + 可读文案
# ---------------------------------------------------------------------------

def test_oom_pattern_recognition() -> None:
    """looks_like_oom：命中真实签名（大小写不敏感），不误伤常规日志行。"""
    assert looks_like_oom("RuntimeError: CUDA failed with error out of memory")
    assert looks_like_oom("  File ... torch/cuda/memory.py | CUDA out of memory. Tried to allocate ...")
    assert looks_like_oom("RUNTIMEERROR: CUDA")
    assert not looks_like_oom("Duration: 30.00s")
    assert not looks_like_oom("正在翻译 (1/1)：/data/a.mkv")
    print("  test_oom_pattern_recognition OK")


def test_oom_engine_readable_message() -> None:
    """引擎级：OOM 失败 → task ERROR + oom=True + A 文案；未命中签名 → 原兜底附退出码。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_OOM_THEN_OK)
        v1 = _mk_video(tmp, "oom.mkv")
        (tmp / "oom.mkv.retry").unlink(missing_ok=True)  # 清场（本用例期望首跑 OOM 后重试成功）
        logs: list[str] = []
        engine = Engine(_base_cfg(fake), log=logs.append)
        try:
            j1 = engine.submit([v1])
            _wait_done([j1])
            t = j1.files[0]
            # 首跑 OOM → 自动重试（C）→ 二跑成功；终态 DONE 且留痕
            assert t.status == TaskStatus.DONE, t.to_dict()
            assert j1.auto_retries == 1, j1.to_dict()
            assert any("自动重试" in line for line in logs), logs
        finally:
            engine.stop()
    # 直接构造 OOM 失败终态：单独引擎跑一次即耗尽（always-OOM）
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_ALWAYS_OOM, name="fake_always_oom.py")
        counter = tmp / "count.txt"
        os.environ["OOM_COUNTER_FILE"] = str(counter)
        try:
            v1 = _mk_video(tmp, "boom.mkv")
            engine = Engine(_base_cfg(fake), log=lambda s: None)
            try:
                j1 = engine.submit([v1])
                _wait_done([j1])
            finally:
                engine.stop()
        finally:
            os.environ.pop("OOM_COUNTER_FILE", None)
        t = j1.files[0]
        assert t.status == TaskStatus.ERROR, t.to_dict()
        assert t.oom is True, t.to_dict()
        assert t.message == OOM_MESSAGE, t.message
        assert "显存不足" in t.message and "重试" in t.message
        assert j1.auto_retries == 1, j1.to_dict()
        # C 上限 1：恰好两次进程调用（首跑 + 重试），不循环
        assert int(counter.read_text()) == 2, counter.read_text()
    print("  test_oom_engine_readable_message OK")


def test_non_oom_failure_keeps_exit_code() -> None:
    """未命中 OOM 签名的非零退出：保持原兜底并附退出码（排障信息不丢）。"""
    code = (
        'import sys\n'
        'print("boom: 内部错误（非 OOM）", file=sys.stderr, flush=True)\n'
        "sys.exit(3)\n"
    )
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, code)
        v1 = _mk_video(tmp, "x.mkv")
        engine = Engine(_base_cfg(fake), log=lambda s: None)
        try:
            j1 = engine.submit([v1])
            _wait_done([j1])
        finally:
            engine.stop()
        t = j1.files[0]
        assert t.status == TaskStatus.ERROR, t.to_dict()
        assert t.oom is False, t.to_dict()
        assert "引擎退出非零（退出码 3）" in t.message, t.message
    print("  test_non_oom_failure_keeps_exit_code OK")


# ---------------------------------------------------------------------------
# B：并发前显存预检
# ---------------------------------------------------------------------------

def test_vram_gate_serializes_when_tight(monkeypatch) -> None:
    """空闲 8G < 12G 阈值：第 2 并发留 pending 等位，峰值 RUNNING=1（158 等效串行）。"""
    monkeypatch.setattr("jav_scribe.core.engine.gpu_free_vram_gb", lambda timeout=3.0: 8.0)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv")
        logs: list[str] = []
        engine = Engine(_base_cfg(fake, concurrency=2), log=logs.append)
        try:
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            peak = _observed_max_running(engine, lambda: j1.done and j2.done)
            assert peak == 1, f"显存不足时第 2 并发应排队，观察到峰值 {peak}"
            assert any("显存预检" in line for line in logs), logs
            assert j2.files[0].status == TaskStatus.DONE
        finally:
            engine.stop()
    print("  test_vram_gate_serializes_when_tight OK")


def test_vram_gate_passes_when_roomy(monkeypatch) -> None:
    """空闲 15G ≥ 12G 阈值：双并发照常（127 场景不受影响）。"""
    monkeypatch.setattr("jav_scribe.core.engine.gpu_free_vram_gb", lambda timeout=3.0: 15.0)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv")
        engine = Engine(_base_cfg(fake, concurrency=2), log=lambda s: None)
        try:
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            peak = _observed_max_running(engine, lambda: j1.done and j2.done)
            assert peak == 2, f"显存充足应双并发，观察到峰值 {peak}"
        finally:
            engine.stop()
    print("  test_vram_gate_passes_when_roomy OK")


def test_vram_gate_degrades_without_smi(monkeypatch) -> None:
    """nvidia-smi 不可用（None）：降级不阻断，双并发照常（CPU 部署不被卡死）。"""
    monkeypatch.setattr("jav_scribe.core.engine.gpu_free_vram_gb", lambda timeout=3.0: None)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        v1, v2 = _mk_video(tmp, "a.mkv"), _mk_video(tmp, "b.mkv")
        logs: list[str] = []
        engine = Engine(_base_cfg(fake, concurrency=2), log=logs.append)
        try:
            j1 = engine.submit([v1])
            j2 = engine.submit([v2])
            peak = _observed_max_running(engine, lambda: j1.done and j2.done)
            assert peak == 2, f"降级路径不得阻断并发，观察到峰值 {peak}"
            assert any("显存预检降级" in line for line in logs), logs
        finally:
            engine.stop()
    print("  test_vram_gate_degrades_without_smi OK")


def test_vram_config_key() -> None:
    """infer.vram_per_instance_gb：PUT /config 白名单 + 上限 512 + 不出现在设置页。"""
    ok = validate_config_updates({"infer.vram_per_instance_gb": 8})
    assert ok == [("infer", "vram_per_instance_gb", 8)], ok
    for bad in (0, -1, 513, "8", True):
        try:
            validate_config_updates({"infer.vram_per_instance_gb": bad})
        except ConfigError:
            pass
        else:
            raise AssertionError(f"{bad!r} 应被拒绝")
    view = build_config_view({"infer": {"vram_per_instance_gb": 8}})
    paths = [i["path"] for i in view]
    assert "infer.vram_per_instance_gb" not in paths, paths
    assert "infer.concurrency" in paths
    print("  test_vram_config_key OK")


# ---------------------------------------------------------------------------
# C：OOM 一次自动重试（重排门槛）
# ---------------------------------------------------------------------------

def _hand_job(tmp: Path, **kw) -> Job:
    t = Task(path=tmp / "h.mkv", status=TaskStatus.ERROR, oom=True, message=OOM_MESSAGE)
    return Job(id="hand-1", files=[t], **kw)


def test_oom_retry_gates() -> None:
    """_maybe_oom_retry 门槛：正常重排；耗尽/取消/挂起/batch 暂停不重排。"""
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        fake = _write_fake(tmp, FAKE_SLOW)
        engine = Engine(_base_cfg(fake), log=lambda s: None)
        try:
            # 正常：ERROR+oom → 重排，文件回 PENDING，计数 1
            j = _hand_job(tmp)
            assert engine._maybe_oom_retry(j, []) is True
            assert j.auto_retries == 1
            assert j in engine._pending_jobs
            t = j.files[0]
            assert (t.status, t.oom, t.phase) == (
                TaskStatus.PENDING, False, TaskPhase.QUEUED,
            ), t.to_dict()
            assert "自动重试" in t.message
            # 重试耗尽：auto_retries=1 → 不重排
            j2 = _hand_job(tmp)
            j2.auto_retries = 1
            assert engine._maybe_oom_retry(j2, []) is False
            assert j2.files[0].status == TaskStatus.ERROR
            # 取消优先：不重排
            j3 = _hand_job(tmp)
            j3.cancel_requested = True
            assert engine._maybe_oom_retry(j3, []) is False
            # 挂起优先：不重排
            j4 = _hand_job(tmp)
            j4.paused = True
            assert engine._maybe_oom_retry(j4, []) is False
            # batch 暂停优先：不重排
            j5 = _hand_job(tmp, batch_id="batch-X")
            engine._batch_paused.add("batch-X")
            assert engine._maybe_oom_retry(j5, []) is False
            engine._batch_paused.discard("batch-X")
            # 非 OOM 失败：不重排
            j6 = _hand_job(tmp)
            j6.files[0].oom = False
            assert engine._maybe_oom_retry(j6, []) is False
        finally:
            engine.stop()
    print("  test_oom_retry_gates OK")


# ---------------------------------------------------------------------------
# vram 采样器
# ---------------------------------------------------------------------------

def test_gpu_free_vram_parses(monkeypatch, tmp_path: Path) -> None:
    """gpu_free_vram_gb：nvidia-smi 输出 MiB → GB；退出非零 → None（降级）。"""
    ok_smi = tmp_path / "smi-ok"
    ok_smi.mkdir()
    (ok_smi / "nvidia-smi").write_text('#!/bin/sh\necho 15360\n')
    ok_smi.joinpath("nvidia-smi").chmod(
        ok_smi.joinpath("nvidia-smi").stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
    )
    monkeypatch.setenv("PATH", f"{ok_smi}{os.pathsep}{os.environ['PATH']}")
    assert gpu_free_vram_gb() == 15.0

    bad_smi = tmp_path / "smi-bad"
    bad_smi.mkdir()
    (bad_smi / "nvidia-smi").write_text('#!/bin/sh\nexit 1\n')
    bad_smi.joinpath("nvidia-smi").chmod(
        bad_smi.joinpath("nvidia-smi").stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH
    )
    monkeypatch.setenv("PATH", f"{bad_smi}{os.pathsep}{os.environ['PATH']}")
    assert gpu_free_vram_gb() is None
    print("  test_gpu_free_vram_parses OK")


# ---------------------------------------------------------------------------
# D：chickenrice 日志并发安全补丁
# ---------------------------------------------------------------------------

def test_patch_d() -> None:
    """log-concurrent-safe.patch：存在、改 mode='a' + 每进程 latest-<pid>.log；
    CHICKENRICE_V19_DIR 提供时对钉版源 git apply --check（Docker 构建强制同验）。"""
    patch = REPO / "docker" / "chickenrice-patches" / "log-concurrent-safe.patch"
    assert patch.exists(), "缺 docker/chickenrice-patches/log-concurrent-safe.patch"
    body = patch.read_text(encoding="utf-8")
    assert 'mode="a"' in body, "shared latest.log 须改为追加模式"
    assert "os.getpid()" in body, "须新增每进程 latest-<pid>.log"
    assert "a/src/faster_whisper_transwithai_chickenrice/infer.py" in body
    v19 = os.environ.get("CHICKENRICE_V19_DIR")
    if not v19:
        print("  test_patch_d OK (CHICKENRICE_V19_DIR 未设，apply 校验留给 Docker 构建)")
        return
    import subprocess
    for p in sorted((REPO / "docker" / "chickenrice-patches").glob("*.patch")):
        r = subprocess.run(
            ["git", "apply", "--check", "-p1", str(p)], cwd=v19,
            capture_output=True, text=True,
        )
        assert r.returncode == 0, f"{p.name} 对 {v19} 校验失败: {r.stderr}"
    print("  test_patch_d OK")


def main() -> None:
    class _MP:  # 直跑模式的最小 monkeypatch 替身
        def __init__(self):
            self._undo = []

        def setattr(self, target, value):
            mod, _, attr = target.rpartition(".")
            import importlib
            m = importlib.import_module(mod)
            self._undo.append((m, attr, getattr(m, attr, None)))
            setattr(m, attr, value)

        def setenv(self, k, v):
            self._undo.append(("env", k, os.environ.get(k)))
            os.environ[k] = v

        def undo(self):
            for item in reversed(self._undo):
                if item[0] == "env":
                    _, k, old = item
                    if old is None:
                        os.environ.pop(k, None)
                    else:
                        os.environ[k] = old
                else:
                    m, attr, old = item
                    if old is None:
                        delattr(m, attr)
                    else:
                        setattr(m, attr, old)

    import pytest
    mp = pytest.MonkeyPatch()
    try:
        test_oom_pattern_recognition()
        test_oom_engine_readable_message()
        test_non_oom_failure_keeps_exit_code()
        test_vram_gate_serializes_when_tight(mp)
        test_vram_gate_passes_when_roomy(mp)
        test_vram_gate_degrades_without_smi(mp)
        test_vram_config_key()
        test_oom_retry_gates()
        import tempfile as _tf
        with _tf.TemporaryDirectory() as _td:
            test_gpu_free_vram_parses(mp, Path(_td))
        test_patch_d()
    finally:
        mp.undo()
    print("test_oom_resilience: all OK")


if __name__ == "__main__":
    main()
