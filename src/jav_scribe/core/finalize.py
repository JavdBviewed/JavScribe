"""Post-processing: turn engine output into media-server-friendly subtitles.

Media servers (Emby/Jellyfin/Plex) auto-associate external subtitles that sit
next to the video with the same base name; a language tag in the name
(`title.zh.srt`) makes the language explicit. This module renames/copies
engine output into that shape.

  source:  /media/TV/Show.S01E01.1080p.mkv
  engine:  writes /media/TV/Show.S01E01.1080p.srt   (ChickenRice default)
  final:   /media/TV/Show.S01E01.1080p.zh.srt       <- what we produce
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

LogFn = Callable[[str], None]


@dataclass
class FinalizeResult:
    source: Path
    final_paths: list[Path] = field(default_factory=list)
    skipped: list[Path] = field(default_factory=list)
    message: str = ""


def target_path_for(source: Path, written: Path, lang_tag: str) -> Path:
    """Compute the final location/name for one written subtitle file."""
    ext = written.suffix.lower().lstrip(".")
    if ext == "srt":
        # If the engine already wrote a lang-tagged name (rare), keep it.
        parts = source.stem.split(".")
        if lang_tag != "none" and parts and parts[-1] == lang_tag:
            name = f"{source.stem}.srt"  # xxx.zh -> xxx.zh.srt
        else:
            name = f"{source.stem}.{lang_tag}.srt" if lang_tag != "none" else f"{source.stem}.srt"
        return written.parent / name
    # vtt/lrc/txt: mirror the same naming scheme
    name = f"{source.stem}.{lang_tag}.{ext}" if lang_tag != "none" else f"{source.stem}.{ext}"
    return written.parent / name


def finalize_one(
    source: Path,
    written: list[Path],
    sub_cfg: dict,
    log: Optional[LogFn] = None,
) -> FinalizeResult:
    """Move/copy engine output into <stem>.<lang>.<ext> form.

    sub_cfg keys used: naming (rename|keep), lang_tag, output_dir,
    skip_if_exists, overwrite, tag_formats.
    """
    logf = log or (lambda _s: None)
    res = FinalizeResult(source=source)
    if sub_cfg.get("naming", "rename") == "keep":
        res.final_paths = [p for p in written if p.exists()]
        res.message = "保持引擎原始输出"
        return res

    lang = sub_cfg.get("lang_tag", "zh")
    out_dir = sub_cfg.get("output_dir")
    base_dir = Path(out_dir).expanduser() if out_dir else source.parent
    base_dir.mkdir(parents=True, exist_ok=True)

    tagged_exts = {e.lower() for e in sub_cfg.get("tag_formats", ["srt", "vtt"])}

    # Engines differ in how they name/announce output (some log the full
    # filename, some write <stem>.<ext> after dropping the container
    # extension). Prefer recorded paths; fall back to conventional names
    # next to the source so a cosmetic log mismatch doesn't lose the file.
    resolved = [w for w in written if w.is_file()]
    if not resolved:
        for ext in (["srt"] + [e for e in sub_cfg.get("formats", ["srt"]) if e != "srt"]):
            cand = base_dir / f"{source.stem}.{ext}"
            if cand.is_file():
                resolved = [cand]
                logf(f"[finalize] 日志路径与实际不符，按惯例名采用: {cand.name}")
                break
    if not resolved:
        res.message = "未找到引擎输出"
        return res

    for w in resolved:
        if lang != "none" and w.suffix.lower().lstrip(".") in tagged_exts:
            target = target_path_for(source, w, lang)
            # If the engine wrote an untagged file in a custom dir, still tag it.
        else:
            target = base_dir / w.name

        if target == w:
            res.final_paths.append(w)
            continue
        if target.exists():
            if sub_cfg.get("skip_if_exists") and not sub_cfg.get("overwrite"):
                res.skipped.append(target)
                logf(f"[finalize] 已存在，跳过: {target.name}")
                continue
            # overwrite: replace atomically
            tmp = target.with_suffix(target.suffix + ".tmp")
            shutil.move(str(w), str(tmp))
            os.replace(tmp, target)
        else:
            same_dir = w.parent == base_dir
            if same_dir:
                os.replace(w, target)
            else:
                shutil.move(str(w), str(target))
        res.final_paths.append(target)
        logf(f"[finalize] {w.name} -> {target.name}")

    if not res.final_paths and not res.skipped:
        res.message = "未找到引擎输出"
    return res


def existing_lang_sub(source: Path, lang: str, ext: str = "srt") -> Path | None:
    """Return the existing <stem>.<lang>.<ext> next to source, if any."""
    if lang in (None, "", "none"):
        return source.with_suffix(f".{ext}")
    p = source.with_name(f"{source.stem}.{lang}.{ext}")
    return p if p.is_file() else None
