"""Embedded subtitle track probing (ffprobe) + skip policy.

只读容器头（ffprobe -select_streams s），单文件 100–500ms，适合对
scan/watch 的稳定候选跑；结果按 (path, size, mtime) 缓存。

策略（subtitle.skip_embedded）：
  off    - 永不因内嵌轨跳过
  target - 仅当某条内嵌轨语言命中目标语言（subtitle.embedded_langs，
           缺省 [lang_tag]）才跳过；未标注（und）轨永不命中
           ——JAV 库普遍内嵌 ja PGS，any 会把整个库挡死
  any    - 存在任意内嵌字幕轨即跳过

ffprobe 缺失/失败（损坏容器等）一律按「无内嵌字幕」处理，不挡流程。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Callable, Optional

# 只认这些字幕 codec；排除 timed_text / dvd_subtitle 等边角轨
SUBTITLE_CODECS = frozenset({
    "subrip", "srt", "ass", "ssa", "mov_text", "webvtt",
    "hdmv_pgs_subtitle", "dvb_subtitle", "dvb_teletext", "xsub", "txt",
})

_PROBE_TIMEOUT_S = 15
_CACHE_MAX = 512

_cache: dict[tuple[str, int, float], list[dict[str, Optional[str]]]] = {}
_cache_lock = threading.Lock()

_ffprobe_resolved = False
_ffprobe_path: Optional[str] = None


def _resolve_ffprobe() -> Optional[str]:
    """PATH -> JAVSCRIBE_FFMPEG_DIR/ffprobe -> JAVSCRIBE_FFMPEG 同目录。"""
    global _ffprobe_resolved, _ffprobe_path
    if _ffprobe_resolved:
        return _ffprobe_path
    name = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    cand = shutil.which(name)
    if not cand:
        env_dir = os.environ.get("JAVSCRIBE_FFMPEG_DIR", "").strip()
        if env_dir:
            p = Path(env_dir) / name
            cand = str(p) if p.is_file() else None
    if not cand:
        env_bin = os.environ.get("JAVSCRIBE_FFMPEG", "").strip()
        if env_bin:
            p = Path(env_bin).with_name(name)
            cand = str(p) if p.is_file() else None
    _ffprobe_path = cand
    _ffprobe_resolved = True
    return cand


def reset_ffprobe_cache() -> None:
    """测试用：强制下次重新解析 ffprobe 路径。"""
    global _ffprobe_resolved, _ffprobe_path
    _ffprobe_resolved = False
    _ffprobe_path = None


def clear_probe_cache() -> None:
    """测试用：清空 (path,size,mtime) 结果缓存。"""
    with _cache_lock:
        _cache.clear()


def norm_language(lang: Optional[str]) -> str:
    """ffprobe 语言标签归一：chi/zho→zh；jpn/jap→ja；空→und；其余小写透传。"""
    if not lang:
        return "und"
    l = str(lang).strip().lower()
    if not l:
        return "und"
    if l in ("chi", "zho"):
        return "zh"
    if l in ("jpn", "jap"):
        return "ja"
    return l


def _run_ffprobe(path: Path) -> list[dict[str, Optional[str]]]:
    """跑一次 ffprobe，返回 [{codec, language}]；任何失败 -> []。"""
    ff = _resolve_ffprobe()
    if not ff:
        return []
    try:
        proc = subprocess.run(
            [ff, "-v", "error", "-select_streams", "s",
             "-show_entries", "stream=codec_name,tags.language",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=_PROBE_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if proc.returncode != 0:
        return []
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return []
    out: list[dict[str, Optional[str]]] = []
    for s in data.get("streams") or []:
        codec = s.get("codec_name")
        if codec not in SUBTITLE_CODECS:
            continue
        tags = s.get("tags") or {}
        out.append({"codec": codec, "language": tags.get("language")})
    return out


def probe_embedded_subs(
    path: Path | str,
    log: Optional[Callable[[str], None]] = None,
) -> list[dict[str, Optional[str]]]:
    """探测视频内嵌字幕轨；(path, size, mtime) 缓存；失败 -> []。"""
    p = Path(path)
    try:
        st = p.stat()
    except OSError:
        return []
    key = (str(p), st.st_size, st.st_mtime)
    with _cache_lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    res = _run_ffprobe(p)
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()
        _cache[key] = res
    return res


_LANG_ITEM_RE = re.compile(r"^[a-z0-9]{2,16}$")
_MAX_LANGS = 8


class EmbedLangsError(ValueError):
    """subtitle.embedded_langs 取值非法。"""


def normalize_embedded_langs(value) -> list[str]:
    """/config 校验：接受 list[str] 或逗号分隔字符串，归一去重，1~8 项。"""
    if isinstance(value, str):
        raw: list = [x for x in value.replace("，", ",").split(",")]
    elif isinstance(value, list):
        raw = value
    else:
        raise EmbedLangsError("subtitle.embedded_langs 需要数组或逗号分隔字符串")
    out: list[str] = []
    for x in raw:
        if not isinstance(x, str):
            raise EmbedLangsError("subtitle.embedded_langs 每项需要字符串")
        t = norm_language(x)
        if t == "und" or not _LANG_ITEM_RE.match(t):
            raise EmbedLangsError(f"非法语言标签: {x!r}（2-16 位字母数字）")
        if t not in out:
            out.append(t)
    if not out:
        raise EmbedLangsError("subtitle.embedded_langs 不能为空")
    if len(out) > _MAX_LANGS:
        raise EmbedLangsError(f"subtitle.embedded_langs 最多 {_MAX_LANGS} 项")
    return out


def embedded_targets(sub_cfg: dict) -> list[str]:
    """target 模式的有效目标语言：embedded_langs（非空）否则 [lang_tag]。"""
    langs = sub_cfg.get("embedded_langs")
    if isinstance(langs, list):
        items = [norm_language(x) for x in langs if str(x).strip()]
        if items:
            return items
    return [norm_language(sub_cfg.get("lang_tag") or "zh")]


def should_skip_embedded(sub_cfg: dict, langs: list[str]) -> tuple[bool, str]:
    """纯决策：内嵌轨语言列表 `langs`（ffprobe 原始值）是否触发跳过。

    返回 (skip, reason)；reason 仅在 skip=True 时非空，供 task.message 展示。
    """
    mode = str(sub_cfg.get("skip_embedded", "target") or "target").lower()
    if mode == "off" or not langs:
        return False, ""
    if mode == "any":
        return True, f"视频已内嵌 {len(langs)} 条字幕轨（不区分语言）"
    if mode != "target":
        return False, ""  # 未知值按 off 处理，不挡流程
    targets = embedded_targets(sub_cfg)
    hit = sorted({norm_language(l) for l in langs if norm_language(l) in targets})
    if hit:
        return True, f"视频已内嵌 {'/'.join(hit)} 字幕轨"
    return False, ""
