from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def get_jasna_settings_path() -> Path:
    appdata = os.environ.get("APPDATA", "")
    if appdata:
        return Path(appdata) / "jasna" / "settings.json"
    xdg = os.environ.get("XDG_CONFIG_HOME", "")
    if xdg:
        return Path(xdg) / "jasna" / "settings.json"
    return Path.home() / ".config" / "jasna" / "settings.json"


def read_jasna_presets() -> dict[str, dict[str, Any]]:
    """Read JASNA's settings.json and return user_presets dict.

    Returns {"Default": {...defaults...}} plus any user-defined presets.
    Returns empty dict if the settings file doesn't exist.
    """
    config_path = get_jasna_settings_path()
    if not config_path.exists():
        return {}
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}

    user_presets = data.get("user_presets", {})

    default_settings = {
        "batch_size": 4,
        "max_clip_size": 90,
        "temporal_overlap": 8,
        "enable_crossfade": True,
        "fp16_mode": True,
        "denoise_strength": "none",
        "denoise_step": "after_primary",
        "secondary_restoration": "none",
        "tvai_ffmpeg_path": r"C:\Program Files\Topaz Labs LLC\Topaz Video\ffmpeg.exe",
        "tvai_model": "iris-2",
        "tvai_scale": 4,
        "tvai_workers": 2,
        "tvai_args": "preblur=0:noise=0:details=0:halo=0:blur=0:compression=0:estimate=8:blend=0.2:device=-2:vram=1:instances=1",
        "rtx_scale": 4,
        "rtx_quality": "high",
        "rtx_denoise": "medium",
        "rtx_deblur": "none",
        "detection_model": "rfdetr-v5",
        "detection_score_threshold": 0.25,
        "compile_basicvsrpp": True,
        "codec": "hevc",
        "encoder_cq": 22,
        "encoder_custom_args": "",
        "lut_path": "",
        "output_same_as_input": True,
        "output_folder": "",
        "output_pattern": "{original}_restored.mp4",
        "file_conflict": "auto_rename",
        "working_directory": "",
    }

    result = {"Default": default_settings}
    for name, preset_data in user_presets.items():
        merged = {**default_settings, **preset_data}
        result[name] = merged

    return result


def read_jasna_last_selected() -> str:
    """Read the last selected preset name from JASNA settings."""
    config_path = get_jasna_settings_path()
    if not config_path.exists():
        return "Default"
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
        return data.get("last_selected", "Default")
    except (json.JSONDecodeError, OSError):
        return "Default"
