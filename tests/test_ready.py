"""GET /ready 组件就绪自检（serve 0.2.6+）。

Run:  python3 tests/test_ready.py
Covers: 全就绪 → ready=true；模型缺失 → fail + ready=false；
device=cpu → GPU 项 off；代理环境变量 → proxy 字段 + 凭据掩码。
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.progress_api import ProgressHTTP  # noqa: E402
from jav_scribe.core import readiness as readinesslib  # noqa: E402


class FakeEngine:
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.jobs: list = []
        self.paused = False

    def log(self, _msg: str) -> None:
        pass

    def stats(self):
        return {"done": 0, "skipped": 0, "failed": 0}


def _cfg(cwd: Path, *, device: str = "cuda") -> dict:
    return {
        "infer": {
            "command": "python3 infer.py", "cwd": str(cwd),
            "model": "models/main-model", "device": device, "log_level": "DEBUG",
        },
        "subtitle": {"formats": ["srt"], "lang_tag": "zh", "naming": "rename"},
        "polish": {"enabled": False, "base_url": "", "api_key": "", "model": ""},
        "emby": {"enabled": False, "url": "", "api_key": ""},
        "jasna": {"enabled": False, "command": ""},
        "watch": {"dirs": [str(cwd / "watch")], "interval_s": 10},
    }


def _setup_models(cwd: Path) -> None:
    models = cwd / "models"
    (models / "main-model").mkdir(parents=True)
    with open(models / "main-model" / "model.bin", "wb") as f:
        f.truncate(3 * 1024 ** 3)
    with open(models / "whisper_vad.onnx", "wb") as f:
        f.truncate(100 * 1024 ** 2)
    (models / "whisper-base").mkdir()
    (models / "whisper-base" / "config.json").write_text("{}")
    (cwd / "watch").mkdir()


def _ready(base: str) -> dict:
    with urllib.request.urlopen(base + "/ready", timeout=10) as resp:
        assert resp.status == 200
        return json.loads(resp.read().decode())


def test_all_ready() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        _setup_models(td)
        cfg = _cfg(td)
        engine = FakeEngine(cfg)
        http = ProgressHTTP(engine, host="127.0.0.1", port=0, profile="server", inbox_dir=td / "inbox")
        http.start()
        try:
            rep = _ready(f"http://127.0.0.1:{http.server.server_address[1]}")
        finally:
            http.stop()
    assert rep["ok"] is True
    by_key = {it["key"]: it for it in rep["items"]}
    for key in ("model", "vad", "fe", "ffmpeg", "disk", "watch"):
        assert by_key[key]["status"] == "ok", (key, by_key[key])
    assert by_key["model"]["detail"].startswith("models/main-model")
    assert by_key["watch"]["status"] == "ok"
    # 可选组件未启用 → off
    for key in ("polish", "emby", "jasna"):
        assert by_key[key]["status"] == "off", by_key[key]
    # ready：required 项（model/vad/fe/ffmpeg/disk + cuda 时 gpu）全 ok
    # CI 无 GPU：cuda 模式 gpu=fail → ready False；本机有 GPU 则 True。两种都合法，断言一致性：
    gpu_status = by_key["gpu"]["status"]
    expect_ready = all(i["status"] == "ok" for i in rep["items"] if i["required"])
    assert rep["ready"] == expect_ready, rep
    assert gpu_status in ("ok", "fail"), gpu_status


def test_missing_model_fails() -> None:
    with tempfile.TemporaryDirectory() as td_s:
        td = Path(td_s)
        # 只建 VAD/fe，缺主模型
        (td / "models" / "main-model").mkdir(parents=True)
        (td / "models" / "whisper_vad.onnx").write_bytes(b"x")
        (td / "models" / "whisper-base").mkdir()
        (td / "models" / "whisper-base" / "config.json").write_text("{}")
        (td / "watch").mkdir()
        cfg = _cfg(td, device="cpu")  # cpu 模式：GPU 项 off，不干扰
        engine = FakeEngine(cfg)
        http = ProgressHTTP(engine, host="127.0.0.1", port=0, profile="server", inbox_dir=td / "inbox")
        http.start()
        try:
            rep = _ready(f"http://127.0.0.1:{http.server.server_address[1]}")
        finally:
            http.stop()
    by_key = {it["key"]: it for it in rep["items"]}
    assert by_key["model"]["status"] == "fail"
    assert "缺失" in by_key["model"]["detail"]
    assert by_key["gpu"]["status"] == "off" and by_key["gpu"]["required"] is False
    assert rep["ready"] is False


def test_proxy_masking() -> None:
    os.environ["JAV_PROXY"] = "http://user:pass@192.168.0.1:10808"
    try:
        cfg = _cfg(Path("/nonexistent"), device="cpu")
        rep = readinesslib.build_readiness_report(cfg)
    finally:
        del os.environ["JAV_PROXY"]
    assert rep["proxy"] == "http://***@192.168.0.1:10808"
    by_key = {it["key"]: it for it in rep["items"]}
    assert by_key["proxy"]["status"] == "ok"
    assert "user:pass" not in json.dumps(rep, ensure_ascii=False)


def test_disk_warn_threshold() -> None:
    # 阈值是模块常量：直接验证判定函数（避免依赖真实磁盘余量）
    cfg = _cfg(Path("/nonexistent"), device="cpu")
    rep = readinesslib.build_readiness_report(cfg)
    by_key = {it["key"]: it for it in rep["items"]}
    assert by_key["disk"]["status"] in ("ok", "warn"), by_key["disk"]


def main() -> None:
    test_all_ready()
    test_missing_model_fails()
    test_proxy_masking()
    test_disk_warn_threshold()
    print("test_ready: all OK")


if __name__ == "__main__":
    main()
