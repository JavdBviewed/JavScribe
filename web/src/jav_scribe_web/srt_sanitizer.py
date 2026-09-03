"""SRT 防御性清洗（中控下载代理侧兜底）。

与主仓 `jav_scribe/core/finalize.py` 的同名逻辑保持一致（中控与车间是两个
独立部署体，各自内置一份，避免跨包依赖）。

背景：上游引擎（faster-whisper 批量推断 + translate 任务）偶发产出负的 cue
起点——模型输出未以时间戳 token 开头时，首个子段 start 被算成
`偏移 + (文本token_id - 时间戳token_begin) * 0.02`，得到大负数。非法 SRT
会让 Emby/Jellyfin/Plex 行为不可预期。兜底规则：

  - start < 0   -> clamp 到 0
  - end < start -> 提到 start
  - 按 (start, end) 稳定排序并重编号

只改时间戳，不动文本；无法完整解析的内容原样放行（宁可不动，不可改坏）。
"""
from __future__ import annotations

import re
from typing import Callable, Optional

LogFn = Callable[[str], None]

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
    """严格解析 SRT；任何不符合 `序号(可选) + 时间戳行 + 文本(到空行)` 的
    结构都抛 ValueError —— 调用方据此放弃清洗。"""
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
        return text, 0

    fixed = 0
    for b in blocks:
        new_start = max(0, b["start"])
        new_end = max(new_start, b["end"])
        if new_start != b["start"] or new_end != b["end"]:
            b["start"], b["end"] = new_start, new_end
            b["new_ts"] = f"{_ms_to_ts(new_start)} --> {_ms_to_ts(new_end)}"
            fixed += 1

    blocks.sort(key=lambda b: (b["start"], b["end"]))  # 稳定排序 + 下方重编号
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
        logf(f"[sanitize] 共修正 {fixed}/{len(blocks)} 条 cue（负值/乱序）")
    return new_text, fixed


def sanitize_srt_bytes(data: bytes, log: Optional[LogFn] = None) -> tuple[bytes, int]:
    """bytes 进出（utf-8）；解码失败或无需修改时原样返回。"""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return data, 0
    new_text, fixed = sanitize_srt_text(text, log)
    return new_text.encode("utf-8"), fixed
