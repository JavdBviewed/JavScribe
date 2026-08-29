from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ModePreset:
    key: str
    label: str
    device: str
    enable_batching: bool = False
    max_batch_size: Optional[int] = None
    description: str = ""


PRESETS = [
    ModePreset(
        key="cpu",
        label="CPU",
        device="cpu",
        description="无显卡或不想用 GPU 时使用",
    ),
    ModePreset(
        key="gpu",
        label="GPU 标准",
        device="cuda",
        description="≥6GB 显存推荐",
    ),
    ModePreset(
        key="gpu_low",
        label="GPU 低显存",
        device="cuda",
        description="4GB 显存",
    ),
    ModePreset(
        key="gpu_batch",
        label="GPU 高显存批处理",
        device="cuda",
        enable_batching=True,
        max_batch_size=8,
        description="≥8GB 显存，自动检测最佳批大小以加速",
    ),
    ModePreset(
        key="custom",
        label="自定义",
        device="auto",
        description="完全使用下方设置 / 高级参数",
    ),
]

PRESET_MAP = {p.key: p for p in PRESETS}
