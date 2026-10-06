"""本地目录扫描（客户端形态：扫描的是「工作台部署所在机器」的磁盘）。

架构约定（2026-09-22 定稿）：
  - 服务端（serve）只负责模型/模型渠道对接 + 处理客户端上传的音轨，
    不做任何文件交互；
  - 客户端（web 工作台）负责用户侧全部文件夹交互：
      * 「选择文件夹」= 浏览器所在机器（File System Access API 物理约束）
      * 「扫描目录」  = 工作台部署所在机器（本模块，服务端只收音轨）
  - 完成后字幕由工作台自动写回本机影片旁（见 api.py 本地回写）。

纯函数移植自 src/jav_scribe/core/{scan,subprobe}.py（桌面形态 serve 侧
同逻辑），保持规则与行为一致：

  scan.video_exts         视频扩展名（无点、小写）
  scan.subtitle_patterns  已有字幕判定后缀（带点，".zh.srt"）
  scan.recurse            是否进入子目录
  subtitle.skip_embedded  不参与普通目录扫描；普通扫描不读取视频内容，
                          内嵌字幕检查必须由用户后续主动发起。
  subtitle.embedded_langs 仅供主动内嵌字幕检查展示（norm_language 归一）
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable, Optional

MAX_SCAN_ITEMS = 5000
MAX_LIST_ITEMS = 200  # 列表配置项上限（与服务端一致）

_VIDEO_EXT_RE = re.compile(r"^[a-z0-9]{1,8}$")
# ".srt" / ".zh.srt" / ".en.vtt"：点 + 可选语言标签段 + 扩展名段
_SUB_PATTERN_RE = re.compile(r"^\.(?:[a-z0-9]{1,16}\.)?[a-z0-9]{1,8}$")
# 独立 C：前后都不是字母数字（行首/行尾、- 空格 _ . [ ] 等分隔均算独立）。
# 由此天然排除：粘番号（SSIS-123C）、CD 集数（SSIS-123CD2 / CD1 / 1CD）、词内 C（Uncut/CUT）。
_STANDALONE_C_RE = re.compile(r"(?<![A-Za-z0-9])c(?![A-Za-z0-9])", re.IGNORECASE)
NAMING_C_MODES = ("has_sub", "no_sub", "off")

# 引擎配置不可达时的兜底规则（与 serve 默认配置一致，loader.py）
DEFAULT_SCAN_CFG: dict[str, Any] = {
    "scan": {
        "video_exts": ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv",
                       "ts", "m2ts", "mpg", "mpeg"],
        "subtitle_patterns": [".zh.srt", ".srt"],
        "recurse": True,
        # 客户端侧文件属性规则（不进 serve /config 白名单）：
        # min_size_mb  低于该值(MB)的文件「忽略」= 列表显示但不默认选中，显式勾选仍可提交
        # naming_c     文件名独立 C 的语义：has_sub=视为已压字幕 / no_sub=视为无字幕版 / off=不识别
        #               默认 no_sub：JAV 命名里独立 C（-C-/C 不粘番号、不粘 CD 集数）= 无字幕版
        "min_size_mb": 200,
        "naming_c": "no_sub",
    },
    "subtitle": {
        "skip_embedded": "target",
        "embedded_langs": ["zh"],
        "lang_tag": "zh",
    },
}


class ScanError(ValueError):
    """扫描/提交请求被拒绝（路径非法 / 文件列表非法）。"""


_log = logging.getLogger("jav_scribe_web.localscan")



class ProbeError(Exception):
    """ffprobe 不可用或执行失败（区别于「探测成功但无字幕轨」；失败不缓存）。"""


def standalone_c_in(name: str) -> bool:
    """文件名是否含「独立 C」（见 _STANDALONE_C_RE 注释；大小写不敏感）。

    命中：SSIS-123-C / SSIS-123 C / SSIS-123_C / SSIS-123 (c) / C-SSIS-123
    不命中：SSIS-123C（粘番号）/ SSIS-123CD2、CD1、1CD（CD 集数）/ Uncut、CUT（词内）
    """
    return bool(_STANDALONE_C_RE.search(name or ""))


# ---------------------------------------------------------------------------
# 内嵌字幕轨探测（ffprobe，只读容器头）。探测失败抛 ProbeError：
# 「探测失败」与「探测成功但无轨」必须可区分，且失败不写缓存（瞬态故障重扫可恢复）。
# ---------------------------------------------------------------------------
SUBTITLE_CODECS = frozenset({
    "subrip", "srt", "ass", "ssa", "mov_text", "webvtt",
    "hdmv_pgs_subtitle", "dvb_subtitle", "dvb_teletext", "xsub", "txt",
})
_PROBE_TIMEOUT_S = 15
_CACHE_MAX = 512

_cache: dict[tuple[str, int, float], list[dict[str, Optional[str]]]] = {}
_cache_lock = threading.Lock()

_ffprobe_path: Optional[str] = None
_ffprobe_lock = threading.Lock()


def _resolve_ffprobe() -> Optional[str]:
    """解析 ffprobe 路径（线程安全）。

    只缓存成功解析：并发首调时某线程的 which() 若瞬态返回 None（PATH
    尚未就绪等），不能把失败写进缓存让同进程后续所有探测都「不可用」——
    旧实现存在该竞态（首线程缓存 None，mp4 正常而 mkv 报不可用）。
    """
    global _ffprobe_path
    with _ffprobe_lock:
        if _ffprobe_path is not None:
            return _ffprobe_path
        p = shutil.which("ffprobe")
        if p:
            _ffprobe_path = p
    return _ffprobe_path


def clear_probe_cache() -> None:
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
    """跑一次 ffprobe，返回 [{codec, language}]（可能为空列表）；失败 -> 抛 ProbeError。"""
    ff = _resolve_ffprobe()
    if not ff:
        raise ProbeError("ffprobe 不可用")
    try:
        proc = subprocess.run(
            [ff, "-v", "error", "-select_streams", "s",
             # 流标签必须走独立 stream_tags 段（ffmpeg 7.x 合并写法不输出 tags）
             "-show_entries", "stream=codec_name",
             "-show_entries", "stream_tags=language",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=_PROBE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired as e:
        raise ProbeError(f"ffprobe 超时（>{_PROBE_TIMEOUT_S}s）") from e
    except OSError as e:
        raise ProbeError(f"ffprobe 执行失败: {type(e).__name__}") from e
    if proc.returncode != 0:
        raise ProbeError(f"ffprobe 退出码 {proc.returncode}")
    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as e:
        raise ProbeError("ffprobe 输出不是合法 JSON") from e
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
) -> Optional[list[dict[str, Optional[str]]]]:
    """探测视频内嵌字幕轨；(path, size, mtime) 缓存。

    文件消失或探测失败（ProbeError）-> None：失败不写缓存，瞬态故障
    （I/O 风暴 / 超时）不会被永久当成「无内嵌字幕」，重新扫描会再探测。
    """
    p = Path(path)
    try:
        st = p.stat()
    except OSError:
        return None
    key = (str(p), st.st_size, st.st_mtime)
    with _cache_lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    try:
        res = _run_ffprobe(p)
    except ProbeError as e:
        _log.warning("内嵌字幕探测失败 %s: %s", p, e)
        return None
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()
        _cache[key] = res
    return res



# ---------------------------------------------------------------------------
# 规则归一化
# ---------------------------------------------------------------------------
def normalize_video_exts(value: Any) -> list[str]:
    """接受字符串数组或逗号分隔字符串；-> [ext, ...]。"""
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
    """接受字符串数组或逗号分隔字符串；-> ['.zh.srt', ...]。"""
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


def _scan_cfg(cfg: dict) -> dict[str, Any]:
    """归一化扫描规则；返回 {exts, pats, recurse, min_size_mb, naming_c}。"""
    s = cfg.get("scan", {}) or {}
    try:
        exts = set(normalize_video_exts(s.get("video_exts") or []))
        pats = normalize_subtitle_patterns(s.get("subtitle_patterns") or [])
    except ScanError:
        # 配置损坏时退回默认，保证扫描可用（与服务端同策略）
        exts = set(s.get("video_exts") or [])
        pats = [p for p in (s.get("subtitle_patterns") or []) if str(p).startswith(".")]
    recurse = bool(s.get("recurse", True))
    raw_min = s.get("min_size_mb", DEFAULT_SCAN_CFG["scan"]["min_size_mb"])
    try:
        min_size_mb = float(raw_min)
        if not (min_size_mb >= 0) or min_size_mb == float("inf"):
            raise ValueError
    except (TypeError, ValueError):
        min_size_mb = float(DEFAULT_SCAN_CFG["scan"]["min_size_mb"])
    naming_c = str(s.get("naming_c", DEFAULT_SCAN_CFG["scan"]["naming_c"]) or "").lower()
    if naming_c not in NAMING_C_MODES:
        naming_c = "has_sub"
    return {
        "exts": exts,
        "pats": pats,
        "recurse": recurse,
        "min_size_mb": min_size_mb,
        "naming_c": naming_c,
    }


def cfg_from_items(items: list[dict]) -> dict[str, Any]:
    """把引擎 /config 的 items[{path,value}] 展平为扫描配置。

    以 DEFAULT_SCAN_CFG 深拷贝为底，再覆盖 items 中出现的非 None 值：
    引擎配置缺键时不会退回空规则（空 video_exts 会导致扫描全空）。
    """
    out: dict[str, Any] = copy.deepcopy(DEFAULT_SCAN_CFG)
    for it in items or []:
        if not isinstance(it, dict):
            continue
        path = str(it.get("path") or "")
        if "." not in path:
            continue
        sec, key = path.split(".", 1)
        if sec not in ("scan", "subtitle"):
            continue
        value = it.get("value")
        if value is None:
            continue
        out.setdefault(sec, {})[key] = value
    return out


# ---------------------------------------------------------------------------
# 宿主机映射（容器化部署：/ 只读挂载到 /hostfs 之类的前缀）
# ---------------------------------------------------------------------------
def host_root_prefix() -> Optional[str]:
    """容器侧只读宿主挂载前缀（JAVSCRIBE_HOST_ROOT），无则 None。"""
    raw = os.environ.get("JAVSCRIBE_HOST_ROOT", "").strip()
    if not raw:
        return None
    p = Path(raw).expanduser()
    if not p.is_absolute() or not p.is_dir():
        return None
    return str(p)


def _host_mapped(clean: str) -> Optional[Path]:
    prefix = host_root_prefix()
    if not prefix or not clean.startswith("/"):
        return None
    p = Path(prefix) / clean.lstrip("/")
    if p.exists():
        return p
    return None


def validate_scan_path(raw: str) -> Path:
    p = Path((raw or "").strip()).expanduser()
    if not p.is_absolute():
        raise ScanError("需要绝对路径")
    if not p.is_dir():
        raise ScanError(f"路径不存在或不是目录: {p}")
    return p


def resolve_scan_root(raw: str) -> tuple[Path, bool]:
    """校验扫描目录；字面路径不存在时回退宿主机映射前缀。

    返回 (resolved_dir, mapped)。mapped=True 表示使用了 JAVSCRIBE_HOST_ROOT
    映射（只读；该路径下「字幕回写」会失败，需为对应目录加读写挂载）。
    """
    try:
        return validate_scan_path(raw), False
    except ScanError:
        if not raw or not raw.strip():
            raise
        clean = raw.strip()
        if not clean.startswith("/"):
            raise ScanError("需要绝对路径")
        mapped = _host_mapped(clean)
        if mapped is None or not mapped.is_dir():
            prefix = host_root_prefix()
            hint = (f"（宿主机映射 {prefix} 下也不存在）" if prefix else
                    "（未配置 JAVSCRIBE_HOST_ROOT 宿主机映射）")
            raise ScanError(f"路径不存在: {clean}{hint}")
        return mapped, True


def validate_submit_files(raw: Any, cfg: dict) -> list[Path]:
    """校验提交列表：存在的、扩展名受支持的视频文件（去重保序）。"""
    if not isinstance(raw, list) or not raw:
        raise ScanError("files 需要非空数组（绝对路径列表）")
    _c = _scan_cfg(cfg)
    exts = _c["exts"]
    # 注意：too_small / naming_c 只是「默认勾选与提示」信号，不拦提交——
    # 用户显式勾选小文件/已有字幕文件即放行（提交前的确认由前端负责）。
    out: list[Path] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            raise ScanError(f"非法文件路径: {item!r}")
        raw_p = Path(item.strip()).expanduser()
        if not raw_p.is_absolute():  # 先判再 resolve（resolve 会把相对路径变绝对，检查会失真）
            raise ScanError(f"需要绝对路径: {item}")
        p = raw_p.resolve()
        if not p.is_file():
            mapped = _host_mapped(item.strip())
            if mapped is None or not mapped.is_file():
                raise ScanError(f"文件不存在: {p.name}")
            p = mapped
        if p.suffix.lower().lstrip(".") not in exts:
            raise ScanError(f"不是受支持的视频文件: {p.name}")
        if p not in out:
            out.append(p)
    if not out:
        raise ScanError("没有可提交的文件")
    return out


# ---------------------------------------------------------------------------
# 扫描
# ---------------------------------------------------------------------------
def _subtitle_for(p: Path, patterns: list[str]) -> Optional[str]:
    for pat in patterns:
        sib = p.with_name(p.stem + pat)
        if sib.is_file():
            return sib.name
    return None


class ScanCanceled(Exception):
    """后台扫描被用户取消。"""


def _scan_item(f: Path, size: int, sc: dict[str, Any]) -> dict[str, Any]:
    """根据一个视频的元数据组装扫描行；绝不读取视频内容。"""
    sub = _subtitle_for(f, sc["pats"])
    naming_c = sc["naming_c"]
    name_c = naming_c != "off" and standalone_c_in(f.name)
    named = naming_c == "has_sub" and name_c
    no_sub_named = naming_c == "no_sub" and name_c
    return {
        "path": str(f),
        "name": f.name,
        "size": size,
        "has_subtitle": sub is not None or named,
        "subtitle": sub,
        "subtitle_status": "external" if sub else "named" if named else "none",
        "embedded_checked": False,
        "embedded_langs": [],
        "too_small": sc["min_size_mb"] > 0 and size < sc["min_size_mb"] * 1048576,
        "name_sub": named,
        "name_no_sub": no_sub_named,
        "probe_failed": False,
    }


def scan_dir_controlled(
    root: Path,
    cfg: dict,
    *,
    should_pause: Callable[[], bool] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """可暂停/取消的 metadata-only 扫描。

    使用 ``os.scandir`` 分层枚举，而不是 ``Path.rglob`` 一次性展开，
    这样每个目录项之间都有控制点；网盘挂载只会产生列目录、stat 和同名字幕
    的元数据请求，不会调用 ffprobe/ffmpeg，也不会打开视频内容。
    """
    sc = _scan_cfg(cfg)
    stack = [root]
    items: list[dict[str, Any]] = []
    scanned = 0
    truncated = False
    recurse = sc["recurse"]

    def checkpoint() -> None:
        if should_cancel and should_cancel():
            raise ScanCanceled
        while should_pause and should_pause():
            if should_cancel and should_cancel():
                raise ScanCanceled
            import time
            time.sleep(0.1)

    while stack:
        checkpoint()
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        entries.sort(key=lambda e: e.name.casefold())
        for entry in entries:
            checkpoint()
            scanned += 1
            if on_progress:
                on_progress(scanned, len(items))
            try:
                if entry.is_dir(follow_symlinks=False):
                    if recurse:
                        stack.append(Path(entry.path))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    continue
                ext = Path(entry.name).suffix.lower().lstrip(".")
                if ext not in sc["exts"]:
                    continue
                st = entry.stat(follow_symlinks=False)
                if st.st_size <= 0:
                    continue
                if len(items) >= MAX_SCAN_ITEMS:
                    truncated = True
                    return {
                        "path": str(root), "items": sorted(items, key=lambda x: x["name"].lower()),
                        "truncated": True, "embedded_checked": False, "probe_errors": [],
                    }
                items.append(_scan_item(Path(entry.path), st.st_size, sc))
                if on_progress:
                    on_progress(scanned, len(items))
            except OSError:
                continue
    items.sort(key=lambda x: x["name"].lower())
    return {
        "path": str(root), "items": items, "truncated": truncated,
        "embedded_checked": False, "probe_errors": [],
    }


def scan_dir(root: Path, cfg: dict) -> dict[str, Any]:
    """只按文件系统元数据列出视频，不读取视频内容。"""
    return scan_dir_controlled(root, cfg)
