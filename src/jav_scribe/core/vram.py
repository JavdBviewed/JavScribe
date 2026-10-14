"""GPU 空闲显存查询（并发前预检，serve 0.2.12）。

已有 ≥1 个推理进程在跑时，起新进程前先查 GPU 空闲显存：
large-v2 int8 单实例驻留约 5G + 激活波动，默认阈值 12G 为单实例安全边际
（见 Engine.vram_per_instance_gb 注释）。nvidia-smi 采样口径与
metrics.LiveSampler 相同。无 nvidia-smi / 查询失败 / 无 GPU 环境一律返回
None，调用方降级（不阻断派发）——CPU 部署与容器 GPU 映射异常不得被卡死。
"""
from __future__ import annotations

import shutil
import subprocess

_SMI_TIMEOUT_S = 3.0


def gpu_free_vram_gb(timeout: float = _SMI_TIMEOUT_S) -> float | None:
    """GPU 0 空闲显存（GB）。nvidia-smi 缺失 / 查询失败 / 解析失败返回 None。"""
    nvidia = shutil.which("nvidia-smi")
    if not nvidia:
        return None
    try:
        out = subprocess.run(
            [nvidia, "--query-gpu=memory.free", "--format=csv,noheader,nounits", "--id=0"],
            capture_output=True, text=True, timeout=timeout,
        )
        if out.returncode != 0:
            return None
        lines = out.stdout.strip().splitlines()
        if not lines or not lines[0].strip():
            return None
        return float(lines[0].strip()) / 1024.0
    except (subprocess.SubprocessError, OSError, ValueError, IndexError):
        return None
