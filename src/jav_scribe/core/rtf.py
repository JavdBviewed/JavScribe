"""Transcription speed (RTF) history for live progress / ETA estimation.

ChickenRice (faster-whisper) only prints per-segment lines when a batched
transcribe() run FINISHES, so no per-segment progress is available mid-run.
To still show smooth, honest progress we estimate the transcribe wall time
from measured history on this machine:

  RTF = seconds of audio processed per second of wall time  (e.g. 25.0 = 25x)

Each finished task records (device, model, media_s, speech_s, wall_s) into a
small JSON file next to the config (survives container restarts when the
data dir is bind-mounted).  New jobs estimate transcribe wall time as
(speech_s or media_s) / median recent RTF for the same device+model.

Defaults when no history exists (conservative, i.e. ETA errs on the slow side):
  cuda: 15x, cpu: 0.8x, other: 5x
"""
from __future__ import annotations

import json
import statistics
import threading
import time
from pathlib import Path
from typing import Any, Optional

MAX_ENTRIES = 200
DEFAULT_RTF: dict[str, float] = {"cuda": 15.0, "cpu": 0.8, "auto": 5.0}
FALLBACK_RTF = 5.0


def _rtf_of(media_s: float | None, speech_s: float | None, wall_s: float) -> float | None:
    audio = speech_s or media_s
    if not audio or audio <= 0 or wall_s <= 0:
        return None
    return audio / wall_s


class RtfHistory:
    """On-disk ring of measured (device, model, media_s, speech_s, wall_s)."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()
        self._entries: list[dict[str, Any]] = []
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                self._entries = [e for e in data if isinstance(e, dict)][:MAX_ENTRIES]
        except (OSError, json.JSONDecodeError):
            self._entries = []

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self._entries, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self.path)
        except OSError:
            pass  # history is an optimization; never break the pipeline

    def record(self, device: str, model: str, media_s: float | None,
               speech_s: float | None, wall_s: float) -> None:
        rtf = _rtf_of(media_s, speech_s, wall_s)
        if rtf is None or rtf <= 0 or rtf > 10000:
            return
        with self._lock:
            self._entries.append({
                "ts": round(time.time()),
                "device": device or "auto",
                "model": model or "",
                "media_s": round(media_s or 0, 1),
                "speech_s": round(speech_s or 0, 1),
                "wall_s": round(wall_s, 1),
                "rtf": round(rtf, 2),
            })
            if len(self._entries) > MAX_ENTRIES:
                self._entries = self._entries[-MAX_ENTRIES:]
            self._save()

    def estimate(self, device: str, model: str,
                 media_s: float | None, speech_s: float | None) -> tuple[float, Optional[str]]:
        """Return (estimated wall seconds, basis description or None)."""
        audio = speech_s or media_s or 0.0
        with self._lock:
            entries = list(self._entries)
        def pick(pred, n):
            recent = [e for e in entries if pred(e)][-n:]
            rtfs = [_rtf_of(e.get("media_s") or None, e.get("speech_s") or None, e.get("wall_s") or 0)
                    for e in recent]
            rtfs = [r for r in rtfs if r]
            return statistics.median(rtfs) if rtfs else None

        dev = (device or "auto").lower()
        specific = pick(lambda e: (e.get("device") or "") == dev and (not model or e.get("model") == model), 10)
        if specific:
            return max(1.0, audio / specific), f"本机同配置 {10} 次均值 {specific:g}x"
        dev_only = pick(lambda e: (e.get("device") or "") == dev, 20)
        if dev_only:
            return max(1.0, audio / dev_only), f"本机 {dev} 均值 {dev_only:g}x"
        rtf = DEFAULT_RTF.get(dev, FALLBACK_RTF)
        return max(1.0, audio / rtf), f"默认 {rtf:g}x"
