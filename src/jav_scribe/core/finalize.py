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
import re
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

    # 防御兜底：引擎偶发产出负时间戳/乱序 cue（见 sanitize_srt_text 注释），
    # 落位前统一清洗，保证最终 srt 合法。
    for w in resolved:
        if w.suffix.lower() == ".srt":
            sanitize_srt_file(w, log=logf)

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
                # 目标已存在时引擎的原始输出没有落位价值，删掉避免残留孤儿文件
                w.unlink(missing_ok=True)
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


# ---------------------------------------------------------------------------
# SRT 防御性清洗
#
# 上游引擎（faster-whisper 批量推断 + translate 任务）偶发产出负的 cue 起点：
# 模型输出未以时间戳 token 开头时，首个子段的 start 会被算成
# `偏移 + (文本token_id - 时间戳token_begin) * 0.02`，得到大负数。
# 非法 SRT 让 Emby/Jellyfin/Plex 行为不可预期，所以在落位前做兜底修正：
#   - start < 0            -> clamp 到 0
#   - end < start          -> 提到 start
#   - 超长 cue（>30s）且区间内有其他 cue 起点 -> 删除（VAD 全量覆盖 fallback 产物）
#   - 相邻 cue 重叠        -> 前一条 end 截到后一条 start（截成零长则删除）
#   - 按 (start 升序, end 降序) 稳定排序并重编号
# 只改时间戳、不动文本（删除除外：被删 cue 是 fallback 冗余产物）；
# 无法完整解析的文件原样保留（宁可不动，不可改坏）。
#
# 超长 cue 背景（2026-09-09 PJAM-045 取证，任务线 09-09-srt-overlap-long-cues）：
# 引擎 VAD 空结果时走「整段覆盖」fallback，产出 chunk 全长 + 一两句的长 cue，
# 与同区域细粒度 cue 时间重叠（两路分段流），播放器表现为旧文本滞留叠压。
# 孤立长 cue（区间内无其他 cue 起点，如 40s 连续独白）是该时段唯一字幕，保留。
# ---------------------------------------------------------------------------

# 超长 cue 阈值：正常对话字幕时长 p90 ≈ 9s（PJAM-045 实测），30s ≈ 3×p90
LONG_CUE_MS = 30_000


_TS = r"(?:-?\d{1,2}:\d{2}:\d{2}[,.]\d{3})"
TS_LINE_RE = re.compile(rf"^\s*({_TS})\s*-->\s*({_TS})\s*$")


def _ts_to_ms(hms: str) -> int:
    """'1:02:03,456'（可带负号）-> 毫秒（可为负）"""
    neg = hms.startswith("-")
    h, m, s = hms.lstrip("-").split(":")
    s, ms = re.split(r"[,.]", s)
    v = (int(h) * 3600 + int(m) * 60 + int(s)) * 1000 + int(ms)
    return -v if neg else v


def _ms_to_ts(ms: int) -> str:
    assert ms >= 0
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _parse_srt_blocks(text: str) -> list[dict]:
    """严格解析 SRT。任何不符合 `序号(可选) + 时间戳行 + 文本(到空行)` 的结构
    都抛 ValueError —— 调用方据此放弃清洗，保证不改坏不认识的格式。"""
    lines = text.split("\n")
    if any("\r" in ln for ln in lines):
        raise ValueError("CRLF line endings")
    blocks: list[dict] = []
    i, n = 0, len(lines)
    while i < n:
        while i < n and not lines[i].strip():
            i += 1
        if i >= n:
            break
        j = i
        if lines[j].strip().isdigit():  # 可选序号行
            j += 1
        if j >= n:
            raise ValueError("index line without timestamp")
        m = TS_LINE_RE.match(lines[j])
        if not m:
            raise ValueError(f"bad timestamp line: {lines[j]!r}")
        j += 1
        text_lines = []
        while j < n and lines[j].strip():
            text_lines.append(lines[j])
            j += 1
        blocks.append(
            {
                "start": _ts_to_ms(m.group(1)),
                "end": _ts_to_ms(m.group(2)),
                "orig_ts": f"{m.group(1)} --> {m.group(2)}",
                "text": "\n".join(text_lines),
            }
        )
        i = j
    if not blocks:
        raise ValueError("no cues found")
    return blocks


def sanitize_srt_text(text: str, log: Optional[LogFn] = None) -> tuple[str, int]:
    """返回 (清洗后的 srt 文本, 修正的 cue 数)。完全合法的文件原样返回、计数 0。"""
    logf = log or (lambda _s: None)
    try:
        blocks = _parse_srt_blocks(text)
    except ValueError as ex:
        logf(f"[sanitize] 未修改（解析失败: {ex}）")
        return text, 0

    fixed = 0
    for b in blocks:
        new_start = max(0, b["start"])
        new_end = max(new_start, b["end"])
        if new_start != b["start"] or new_end != b["end"]:
            b["start"], b["end"] = new_start, new_end
            b["new_ts"] = f"{_ms_to_ts(new_start)} --> {_ms_to_ts(new_end)}"
            fixed += 1

    # start 升序；同 start 时长 cue 在前（同起点重叠时长的被截/删，保留细粒度）
    blocks.sort(key=lambda b: (b["start"], -b["end"]))
    total = len(blocks)

    dropped = 0
    # 防御二a：超长 cue（>30s）且区间内有其他 cue 起点 → 删除。
    # 排序后只需看相邻：前一个同 start（同起点组）或后一个 start 落在本条区间内。
    keep = []
    for i, b in enumerate(blocks):
        covered = b["end"] - b["start"] > LONG_CUE_MS and (
            (i > 0 and blocks[i - 1]["start"] == b["start"])
            or (i + 1 < len(blocks) and blocks[i + 1]["start"] < b["end"])
        )
        if covered:
            dropped += 1
            fixed += 1
            logf(
                f"[sanitize] 第{i + 1}条为超长 cue（{(b['end'] - b['start']) / 1000:.1f}s）"
                f"且区间被细粒度 cue 占用，删除: {b['text'].splitlines()[0][:30]}"
            )
        else:
            keep.append(b)
    blocks = keep

    # 防御二b：相邻重叠 → 前一条 end 截到后一条 start；截成零长则删除。
    # 按 start 排序后此规则保证输出任意两 cue 零重叠。
    out_blocks = []
    for i, b in enumerate(blocks):
        if i + 1 < len(blocks) and b["end"] > blocks[i + 1]["start"]:
            b["end"] = blocks[i + 1]["start"]
            b["new_ts"] = f"{_ms_to_ts(b['start'])} --> {_ms_to_ts(b['end'])}"
            if b["end"] <= b["start"]:
                dropped += 1
                fixed += 1
                logf(f"[sanitize] 第{i + 1}条被后一条完全覆盖，删除: {b['text'].splitlines()[0][:30]}")
                continue
            fixed += 1
            logf(f"[sanitize] 第{i + 1}条与后一条重叠，end 截断: {b['orig_ts']} → {b['new_ts']}")
        out_blocks.append(b)
    blocks = out_blocks

    out = []
    for idx, b in enumerate(blocks, 1):
        ts = b.get("new_ts", f"{_ms_to_ts(b['start'])} --> {_ms_to_ts(b['end'])}")
        out.append(f"{idx}\n{ts}\n{b['text']}\n\n")
    new_text = "".join(out)
    if new_text == text:
        return text, 0
    for idx, b in enumerate(blocks, 1):
        if "new_ts" in b:
            logf(f"[sanitize] 第{idx}条时间戳修正: {b['orig_ts']} → {b['new_ts']}")
    if fixed:
        logf(f"[sanitize] 共修正 {fixed}/{total} 条 cue（负值/倒挂/重叠截断，另删除 fallback 长 cue {dropped} 条）")
    return new_text, fixed


def sanitize_srt_file(path: Path, log: Optional[LogFn] = None) -> int:
    """对磁盘上的 .srt 就地清洗（仅在有修改时写回）。返回修正条数。"""
    logf = log or (lambda _s: None)
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as ex:
        logf(f"[sanitize] 读取失败，跳过: {path.name} ({ex})")
        return 0
    new_text, fixed = sanitize_srt_text(text, logf)
    if new_text != text:
        path.write_text(new_text, encoding="utf-8")
        logf(f"[sanitize] 已写回 {path.name}")
    return fixed

def existing_lang_sub(source: Path, lang: str, ext: str = "srt") -> Path | None:
    """Return the existing <stem>.<lang>.<ext> next to source, if any."""
    if lang in (None, "", "none"):
        return source.with_suffix(f".{ext}")
    p = source.with_name(f"{source.stem}.{lang}.{ext}")
    return p if p.is_file() else None
