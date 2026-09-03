"""Engine registry: the only state the control room persists.

Engines are named subtitle-service endpoints (JavScribe `serve` URLs). The preset
table can be supplied via the JAV_ENGINES environment variable
(`name=url,name=url`); engines added/removed through the API are persisted
to <data_dir>/engines.json. Env presets are merged idempotently on every
start (same name + same URL = no-op; same name + different URL = kept).
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Optional

_URL_RE = re.compile(r"^https?://[^\s]+$")


def is_url(url: str) -> bool:
    return bool(_URL_RE.match(url.strip()))


def parse_engines_env(value: str) -> list[tuple[str, str]]:
    """Parse `name=url,name=url`. Malformed parts are ignored, not fatal."""
    out: list[tuple[str, str]] = []
    for part in value.split(","):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, url = part.split("=", 1)
        name, url = name.strip(), url.strip().rstrip("/")
        if name and is_url(url):
            out.append((name, url))
    return out


class EngineStore:
    """In-memory registry with JSON persistence and env preset merge."""

    def __init__(self, data_dir: str | os.PathLike = "/data") -> None:
        self._path = Path(data_dir) / "engines.json"
        self._lock = threading.Lock()
        self._engines: dict[str, dict] = {}
        self._load_file()
        for name, url in parse_engines_env(os.environ.get("JAV_ENGINES", "")):
            self._upsert(name, url)  # api_key=None: 保留已登记的 key

    # -- persistence ------------------------------------------------------
    def _load_file(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            for entry in data.get("engines", []):
                name, url = entry["name"], entry["url"]
                if name and is_url(url):
                    # 旧文件可能没有 api_key 字段（向后兼容）
                    self._upsert(name, url, entry.get("api_key", ""))
        except (json.JSONDecodeError, KeyError, TypeError):
            # Corrupt registry: start fresh rather than crash the service.
            pass

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_name(self._path.name + ".tmp")
        tmp.write_text(
            json.dumps({"engines": list(self._engines.values())}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        tmp.replace(self._path)

    # -- mutation ----------------------------------------------------------
    def _upsert(self, name: str, url: str, api_key: Optional[str] = None) -> None:
        """Register/refresh an engine. api_key=None keeps the stored key
        (env preset merge must not wipe a key set via the API)."""
        entry = {"name": name, "url": url.rstrip("/")}
        if api_key is None:
            entry["api_key"] = self._engines.get(name, {}).get("api_key", "")
        else:
            entry["api_key"] = api_key.strip()
        self._engines[name] = entry

    def add(self, name: str, url: str, api_key: Optional[str] = None) -> Optional[dict]:
        """Add or update an engine. Returns the entry, or None if rejected."""
        name = (name or "").strip()
        url = (url or "").strip()
        if not name or not is_url(url):
            return None
        with self._lock:
            existing = self._engines.get(name)
            if existing is not None and existing["url"] != url.rstrip("/"):
                return None  # same name pointing elsewhere is a different engine
            self._upsert(name, url, api_key)
            self._save()
            return self._engines[name]

    def set_api_key(self, name: str, api_key: str) -> Optional[dict]:
        """Update only the stored API key for an existing engine."""
        with self._lock:
            entry = self._engines.get(name)
            if entry is None:
                return None
            entry["api_key"] = (api_key or "").strip()
            self._save()
            return entry

    def remove(self, name: str) -> bool:
        with self._lock:
            if self._engines.pop(name, None) is None:
                return False
            self._save()
            return True

    # -- read --------------------------------------------------------------
    @property
    def engines(self) -> list[dict]:
        with self._lock:
            return list(self._engines.values())

    def get(self, name: str) -> Optional[dict]:
        with self._lock:
            return self._engines.get(name)
