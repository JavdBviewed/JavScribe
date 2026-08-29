from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# infer.exe stdout patterns (see latest.log for samples)
PATTERN_TOTAL = re.compile(r"找到\s+(\d+)\s+个文件待处理")
PATTERN_TRANSLATING = re.compile(
    r"正在翻译\s*[（(]\s*(\d+)\s*/\s*(\d+)\s*[)）]\s*[：:]\s*(.+?)\s*$"
)
PATTERN_DURATION = re.compile(r"时长\s*[：:]\s*([^→]+?)\s*→")
PATTERN_TIMESTAMP = re.compile(
    r"\[\s*(\d+):(\d+(?:\.\d+)?)\s*-->\s*(\d+):(\d+(?:\.\d+)?)\s*\]"
)
PATTERN_DEVICE = re.compile(
    r"模型运行精度\s*[：:]\s*(\S+)\s*[，,]\s*设备\s*[：:]\s*(\S+)"
)
PATTERN_LOAD_MODEL = re.compile(r"正在加载\s*Whisper\s*模型")
PATTERN_VAD_READY = re.compile(r"增强\s*VAD\s*已激活")
PATTERN_WRITING = re.compile(r"正在写入\s*[：:]\s*(.+?)\s*$")
PATTERN_CN_DUR = re.compile(
    r"(?:(\d+)\s*小时)?\s*(?:(\d+)\s*分)?\s*(?:(\d+(?:\.\d+)?)\s*秒)?"
)


def parse_chinese_duration(s: str) -> Optional[float]:
    """Parse strings like '3小时27分25秒' / '1小时' / '25秒' → seconds."""
    s = s.strip()
    if not s:
        return None
    m = PATTERN_CN_DUR.match(s)
    if not m:
        return None
    h = int(m.group(1) or 0)
    mi = int(m.group(2) or 0)
    se = float(m.group(3) or 0.0)
    total = h * 3600 + mi * 60 + se
    return total if total > 0 else None


@dataclass
class LogEvent:
    kind: str  # info | file_start | file_progress | duration | model_load | file_written | raw
    raw: str = ""
    file_idx: Optional[int] = None
    file_total: Optional[int] = None
    file_path: Optional[str] = None
    progress: Optional[float] = None
    duration_s: Optional[float] = None
    detail: Optional[str] = None
    output_format: Optional[str] = None  # for file_written


class LogParser:
    """Stateful parser — keeps current-file duration for % progress computation."""

    def __init__(self) -> None:
        self.current_duration_s: Optional[float] = None
        self.current_file: Optional[str] = None
        self.total_files: Optional[int] = None

    def feed(self, line: str) -> LogEvent:
        line = line.rstrip()

        m = PATTERN_TRANSLATING.search(line)
        if m:
            self.current_file = m.group(3).strip()
            self.current_duration_s = None
            return LogEvent(
                kind="file_start",
                raw=line,
                file_idx=int(m.group(1)),
                file_total=int(m.group(2)),
                file_path=self.current_file,
            )

        m = PATTERN_DURATION.search(line)
        if m:
            dur = parse_chinese_duration(m.group(1))
            if dur:
                self.current_duration_s = dur
            return LogEvent(kind="duration", raw=line, duration_s=dur)

        m = PATTERN_TIMESTAMP.search(line)
        if m and self.current_duration_s:
            end_min = int(m.group(3))
            end_sec = float(m.group(4))
            end_total = end_min * 60 + end_sec
            progress = max(0.0, min(1.0, end_total / self.current_duration_s))
            return LogEvent(
                kind="file_progress",
                raw=line,
                file_path=self.current_file,
                progress=progress,
            )

        m = PATTERN_TOTAL.search(line)
        if m:
            self.total_files = int(m.group(1))
            return LogEvent(
                kind="info",
                raw=line,
                file_total=self.total_files,
                detail=f"找到 {self.total_files} 个文件",
            )

        m = PATTERN_WRITING.search(line)
        if m:
            out_path = m.group(1).strip()
            ext = ""
            dot = out_path.rfind(".")
            if dot >= 0:
                ext = out_path[dot + 1 :].lower()
            return LogEvent(
                kind="file_written",
                raw=line,
                file_path=out_path,
                output_format=ext or None,
            )

        if PATTERN_LOAD_MODEL.search(line):
            return LogEvent(kind="model_load", raw=line, detail="加载模型中…")

        return LogEvent(kind="raw", raw=line)
