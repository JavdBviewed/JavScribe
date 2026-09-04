"""On-demand folder scanning for the /scan API (pure functions, testable).

Complements the Watcher (which auto-processes watch.dirs): this is the
user-facing "point at a folder, review what needs subtitles, queue the
selection" flow. Rules come from the live config so /config updates apply
to the next scan immediately:

  scan.video_exts         list of extensions without dot, lowercase
  scan.subtitle_patterns  list of suffixes with dot (".zh.srt", ".srt");
                          a video "has subtitles" when <stem>+<pattern>
                          exists in the same directory
  scan.recurse            follow subdirectories

Security posture: /scan is X-Api-Key protected like /config and can list
any directory on this machine (single-operator LAN deployment; see
web/docs/deployment.md).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional

MAX_SCAN_ITEMS = 5000
MAX_LIST_ITEMS = 200  # PUT /config: list members capped

_VIDEO_EXT_RE = re.compile(r"^[a-z0-9]{1,8}$")
# ".srt" / ".zh.srt" / ".en.vtt"：点 + 可选语言标签段 + 扩展名段
_SUB_PATTERN_RE = re.compile(r"^\.(?:[a-z0-9]{1,16}\.)?[a-z0-9]{1,8}$")


class ScanError(ValueError):
    """Scan/submit request rejected (bad path / bad file list)."""


# ---------------------------------------------------------------------------
# normalization (shared by /config validator and scan_dir)
# ---------------------------------------------------------------------------
def normalize_video_exts(value: Any) -> list[str]:
    """Accept a list of strings or a comma-separated string; -> [ext, ...]."""
    items: list[str] = []
    if isinstance(value, str):
        items = value.split(",")
    elif isinstance(value, list):
        items = [x for x in value if isinstance(x, str)]
    else:
        raise ScanError("video_exts 需要字符串数组或逗号分隔字符串")
    out: list[str] = []
    for raw in items:
        ext = str(raw).strip().lower().lstrip(".")
        if not ext:
            continue
        if not _VIDEO_EXT_RE.match(ext):
            raise ScanError(f"非法视频扩展名: {raw!r}")
        if ext not in out:
            out.append(ext)
    if not out:
        raise ScanError("video_exts 不能为空")
    if len(out) > MAX_LIST_ITEMS:
        raise ScanError(f"video_exts 最多 {MAX_LIST_ITEMS} 项")
    return out


def normalize_subtitle_patterns(value: Any) -> list[str]:
    """Accept a list or comma-separated string; -> ['.zh.srt', ...]."""
    items: list[str] = []
    if isinstance(value, str):
        items = value.split(",")
    elif isinstance(value, list):
        items = [x for x in value if isinstance(x, str)]
    else:
        raise ScanError("subtitle_patterns 需要字符串数组或逗号分隔字符串")
    out: list[str] = []
    for raw in items:
        pat = str(raw).strip().lower()
        if not pat:
            continue
        if not pat.startswith("."):
            pat = "." + pat
        if not _SUB_PATTERN_RE.match(pat):
            raise ScanError(f"非法字幕后缀: {raw!r}")
        if pat not in out:
            out.append(pat)
    if not out:
        raise ScanError("subtitle_patterns 不能为空")
    if len(out) > MAX_LIST_ITEMS:
        raise ScanError(f"subtitle_patterns 最多 {MAX_LIST_ITEMS} 项")
    return out


def _scan_cfg(cfg: dict) -> tuple[set[str], list[str], bool]:
    s = cfg.get("scan", {})
    try:
        exts = set(normalize_video_exts(s.get("video_exts") or []))
        pats = normalize_subtitle_patterns(s.get("subtitle_patterns") or [])
    except ScanError:
        # Malformed live cfg (shouldn't happen: /config validates); fall back
        # to defaults so /scan stays usable.
        exts = set(s.get("video_exts") or [])
        pats = [p for p in (s.get("subtitle_patterns") or []) if str(p).startswith(".")]
    recurse = bool(s.get("recurse", True))
    return exts, pats, recurse


# ---------------------------------------------------------------------------
# path validation
# ---------------------------------------------------------------------------
def validate_scan_path(raw: str) -> Path:
    """Expand/resolve the requested directory; must exist and be a directory."""
    if not raw or not raw.strip():
        raise ScanError("缺少路径（?path=/绝对/目录）")
    p = Path(raw.strip()).expanduser()
    if not p.is_absolute():
        raise ScanError("需要绝对路径")
    p = p.resolve()
    if not p.exists():
        raise ScanError(f"路径不存在: {p}")
    if not p.is_dir():
        raise ScanError(f"不是目录: {p}")
    return p


def validate_submit_files(raw: Any, cfg: dict) -> list[Path]:
    """Validate the submit list: existing files with a known video extension."""
    if not isinstance(raw, list) or not raw:
        raise ScanError("files 需要非空数组（绝对路径列表）")
    exts, _pats, _recurse = _scan_cfg(cfg)
    out: list[Path] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise ScanError(f"非法文件路径: {item!r}")
        p = Path(item.strip()).expanduser().resolve()
        if not p.is_absolute():
            raise ScanError(f"需要绝对路径: {item}")
        if not p.is_file():
            raise ScanError(f"文件不存在: {p.name}")
        if p.suffix.lower().lstrip(".") not in exts:
            raise ScanError(f"不是受支持的视频文件: {p.name}")
        if p not in out:
            out.append(p)
    if not out:
        raise ScanError("没有可提交的文件")
    return out


# ---------------------------------------------------------------------------
# scanning
# ---------------------------------------------------------------------------
def _subtitle_for(p: Path, patterns: list[str]) -> Optional[str]:
    for pat in patterns:
        sib = p.with_name(p.stem + pat)
        if sib.is_file():
            return sib.name
    return None


def scan_dir(root: Path, cfg: dict) -> dict[str, Any]:
    """Scan `root` per live scan rules. Returns {path, items, truncated}."""
    exts, pats, recurse = _scan_cfg(cfg)
    it = root.rglob("*") if recurse else root.glob("*")
    items: list[dict[str, Any]] = []
    truncated = False
    try:
        for f in it:
            try:
                if not f.is_file():
                    continue
                ext = f.suffix.lower().lstrip(".")
                if ext not in exts:
                    continue
                st = f.stat()
                if st.st_size <= 0:
                    continue
                sub = _subtitle_for(f, pats)
                items.append(
                    {
                        "path": str(f),
                        "name": f.name,
                        "size": st.st_size,
                        "has_subtitle": sub is not None,
                        "subtitle": sub,
                    }
                )
            except OSError:
                continue  # vanished mid-scan / permission quirk
            if len(items) >= MAX_SCAN_ITEMS:
                truncated = True
                break
    except OSError:
        pass
    items.sort(key=lambda x: x["name"].lower())
    return {"path": str(root), "items": items, "truncated": truncated}
