"""Config loading: defaults < config file < CLI overrides, with named profiles.

Config file lookup order:
  1. --config PATH
  2. $JAVSCRIBE_CONFIG
  3. ~/.jav_scribe/config.json

Profiles: the file may contain {"profiles": {"local": {...}, "server": {...}}}.
The active profile is chosen by --profile / $JAVSCRIBE_PROFILE (default: "default",
or the file's "profile" key). A profile without its own key inherits "default".
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

from ..constants import (
    CONFIG_DIR_NAME,
    CONFIG_FILE,
    DEFAULT_LANG_TAG,
    DEFAULT_PROGRESS_HOST,
    DEFAULT_PROGRESS_PORT,
)

DEFAULTS: dict[str, Any] = {
    "infer": {
        # Command that produces subtitles (ChickenRice infer.exe on Windows,
        # `python -m ...` / uv run on Linux). May include args; file paths are
        # appended by the engine.
        "command": "",
        "cwd": None,
        "model": "models",
        "device": "auto",
        "preset": "gpu",
        "log_level": "DEBUG",
        "batch": False,
        "max_batch_size": 8,
        "extra_args": [],
    },
    "subtitle": {
        "formats": ["srt"],
        "lang_tag": DEFAULT_LANG_TAG,
        # rename: <source-stem>.<lang>.<ext> next to the source (or output_dir)
        # keep: leave whatever the engine wrote as-is
        "naming": "rename",
        "output_dir": None,
        "skip_if_exists": True,
        "overwrite": False,
        "tag_formats": ["srt", "vtt"],
    },
    "polish": {
        "enabled": False,
        "base_url": "",
        "api_key": "",
        "model": "",
        "batch_lines": 60,
        "timeout_s": 600,
    },
    "emby": {
        "enabled": False,
        "url": "",
        "api_key": "",
    },
    "watch": {
        "dirs": [],
        "interval_s": 10,
        "process_existing": True,
    },
    "jasna": {
        "enabled": False,
        "command": "",
        "preset": "Default",
        "extra_args": [],
    },
    "progress": {
        "host": DEFAULT_PROGRESS_HOST,
        "port": DEFAULT_PROGRESS_PORT,
    },
    # 进度/配置管理 API 的鉴权 key。推荐 env JAVSCRIBE_API_KEY（见下方 fallback），
    # 也支持直接写在配置文件（profiles.<active>.api.key）。
    "api": {"key": ""},
}


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def config_file_path(explicit: str | None) -> Path | None:
    """Resolve the config file path actually in use (None when no file)."""
    candidates = []
    if explicit:
        candidates.append(Path(explicit))
    env = os.environ.get("JAVSCRIBE_CONFIG")
    if env:
        candidates.append(Path(env).expanduser())
    candidates.append(Path.home() / CONFIG_DIR_NAME / CONFIG_FILE)
    for c in candidates:
        if c.is_file():
            return c
    return None


def load_config(
    path: str | None = None,
    profile: str | None = None,
    overrides: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str]:
    """Return (merged_profile_config, profile_name)."""
    file_data: dict[str, Any] = {}
    p = config_file_path(path)
    if p:
        try:
            file_data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            raise SystemExit(f"配置文件解析失败 {p}: {e}") from e

    profiles = file_data.get("profiles") or {}
    profile_name = (
        profile
        or os.environ.get("JAVSCRIBE_PROFILE")
        or file_data.get("profile")
        or ("default" if profiles else None)
    )

    if profile_name and profile_name in profiles:
        base_profile = dict(profiles.get("default") or {})
        merged_profile = _deep_merge(base_profile, profiles[profile_name])
    else:
        merged_profile = {}
        if profile_name and profile_name != "default" and profile_name not in profiles:
            print(f"[config] 警告：profile '{profile_name}' 不存在，按 default 处理")
        profile_name = profile_name or "default"

    cfg = _deep_merge(DEFAULTS, {k: v for k, v in file_data.items() if k not in ("profiles", "profile")})
    cfg = _deep_merge(cfg, merged_profile)

    for k, v in (overrides or {}).items():
        if v is None:
            continue
        if isinstance(v, dict) and isinstance(cfg.get(k), dict):
            cfg[k] = _deep_merge(cfg[k], v)
        else:
            cfg[k] = v

    # Env fallbacks for secrets
    if not cfg.get("polish", {}).get("api_key") and os.environ.get("JAVSCRIBE_LLM_API_KEY"):
        cfg["polish"]["api_key"] = os.environ["JAVSCRIBE_LLM_API_KEY"]
    if not cfg.get("emby", {}).get("api_key") and os.environ.get("JAVSCRIBE_EMBY_API_KEY"):
        cfg["emby"]["api_key"] = os.environ["JAVSCRIBE_EMBY_API_KEY"]
    if not cfg.get("api", {}).get("key") and os.environ.get("JAVSCRIBE_API_KEY"):
        cfg["api"]["key"] = os.environ["JAVSCRIBE_API_KEY"]

    return cfg, profile_name
