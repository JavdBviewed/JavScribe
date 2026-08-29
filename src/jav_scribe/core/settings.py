from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..constants import SETTINGS_FILE


def _settings_dir() -> Path:
    base = Path.home() / ".jav_scribe"
    base.mkdir(parents=True, exist_ok=True)
    return base


def settings_path() -> Path:
    return _settings_dir() / SETTINGS_FILE


def load() -> dict[str, Any]:
    p = settings_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def save(data: dict[str, Any]) -> None:
    p = settings_path()
    p.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
