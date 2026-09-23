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
    marker_meta: Optional[dict] = None,
) -> FinalizeResult:
    """Move/copy engine output into <stem>.<lang>.<ext> form.

    sub_cfg keys used: naming (rename|keep), lang_tag, output_dir,
    skip_if_exists, overwrite, tag_formats, marker.
    marker_meta 非 None 且 marker 开启时，对落位的 srt 追加 JavScribe 指纹。
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

    # JavScribe 指纹：对落位的 srt 追加尾部 0 时长 cue + 注释（幂等，已有不动）
    if sub_cfg.get("marker", True) and marker_meta:
        for p in res.final_paths:
            if p.suffix.lower() == ".srt":
                append_javscribe_marker(p, marker_meta, log=logf)

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
#   - 重复幻觉折叠（collapse_repeat_loops）: whisper 在低信息音频（JAV 喘息/
#     噪声占比高）会把同一短语复读成串，只折叠「连续」重复，时间码不动
#   - 长 cue 智能切分（_split_cue）: 单条文本 >22 字（连续独白产出大字墙）按
#     句末 > 分句 > 空格 > 硬切 拆段，时长按字数比例分配，原 start/end 不变
# 时间戳只按上述规则修正，文本只动重复幻觉与长 cue 切分（删除除外：被删 cue 是 fallback 冗余产物）；
# 无法完整解析的文件原样保留（宁可不动，不可改坏）。
#
# 超长 cue 背景（2026-09-09 PJAM-045 取证，任务线 09-09-srt-overlap-long-cues）：
# 引擎 VAD 空结果时走「整段覆盖」fallback，产出 chunk 全长 + 一两句的长 cue，
# 与同区域细粒度 cue 时间重叠（两路分段流），播放器表现为旧文本滞留叠压。
# 孤立长 cue（区间内无其他 cue 起点，如 40s 连续独白）是该时段唯一字幕，保留，
# v0.1.9 起再按字数拆成播放器可读的短段（_split_cue，幂等）。
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


# ---------------------------------------------------------------------------
# ASR 重复幻觉折叠（repetition-loop collapse）
#
# whisper 系模型在低信息音频（喘息/噪声/音乐）上会复读同一短语。2026-09-23
# 取证（10 个存量生成 srt 中 9 个命中，最长单 cue 复读 68 次）两种形态：
#   1. 无空格连写: "要射了吗？要射了吗？要射出来了吗？要射了吗？..."（一个 token）
#   2. 空格分隔:   "要去了 要去了 要去了 要去了" / "来吧来吧 把鸡巴插进来" x3
# 规则（保守——只碰「连续」重复；正常对话里分散的重复如「同学」x5 不动）：
#   a. token 连跑: 同一 k-token(k∈1..3)模式连续重复 R>=3 次 -> 只留首份
#   b. token 内精确: token = U^N(N>=3,|U|>=2) 或 U^N+U 前缀 -> 只留首份 U
#   c. token 内主导周期: |norm|>=12 且 norm[o:o+p](2<=p<=10) 非重叠出现 >=4 次
#      且覆盖 >=40% -> 只留 前导+首个环单元（语气词扩展 <=4 字）。o 两路探测：
#      前向扫描 0<=o<=16（容忍首句变体 "要射了吗？"+"要射出来了吗？"xN）
#      + 尾部对齐（前导不限长，如 "够了吧？"+"对不起"xN）
# 纯文本、幂等、不动时间码；HTML 注释行（指纹 cue）跳过。
# ---------------------------------------------------------------------------

_PUNCT_RE = re.compile(r"[^\w]", re.UNICODE)
_PARTICLES = set("吗呢吧啊哦么了呀嘛")
_TERMINAL = set("？。！~～")
_MIN_LOOP_TOKEN = 12  # 规则 c 的最小 token 长度（norm 后）


def _norm_tok(tok: str) -> str:
    """token 归一化：去标点/空白、casefold（仅用于比较）。"""
    return _PUNCT_RE.sub("", tok).casefold()


def _first_units_display(tok: str, norm_end: int) -> str:
    """norm 前 norm_end 字对应的原文展示文本 + 语气词扩展（<=4 字，
    吃到句末标点为止），使 "要射了吗？要射了吗？..." 折成 "要射了吗？" 而非 "要射"。"""
    norm_idx = 0
    q = -1
    for i, ch in enumerate(tok):
        if not _PUNCT_RE.match(ch):
            norm_idx += 1
            if norm_idx == norm_end:
                q = i
                break
    if q < 0:
        return tok
    ext = 0
    while q + 1 < len(tok) and ext < 4:
        c = tok[q + 1]
        if c in _TERMINAL:
            q += 1
            ext += 1
            break
        if c in _PARTICLES:
            q += 1
            ext += 1
            continue
        break
    return tok[: q + 1]


def _collapse_in_token(tok: str) -> str:
    """规则 b/c：token 内重复折叠。"""
    norm = _norm_tok(tok)
    L = len(norm)
    if L < 6:
        return tok
    for p in range(2, L // 3 + 1):  # 精确 U^N / U^N+前缀
        u = norm[:p]
        n_full, r = divmod(L, p)
        if n_full >= 3 and norm == u * n_full + u[:r]:
            return _first_units_display(tok, p)
    if L >= _MIN_LOOP_TOKEN:  # 主导周期（容忍变体插桩：要射出来了吗）
        # 环起始偏移 o 两路探测：
        #   1. 前向扫描 o ∈ [0, 16]：whisper 常把首句说成环单元变体
        #      （"要射了吗？"+"要射出来了吗？"xN / "够了吧？"+"对不起"xN），
        #      只从 0 找周期会失手。
        #   2. 尾部对齐（o 不限）：环单元 = token 尾 p 字，向前扩展计数，
        #      兜底前导超过 16 字的情况。
        # 同一环有多个相位候选（o=2/3/4 覆盖率相同）：按 (覆盖率,
        # 前导与单元公共前缀长, o 小) 取最优——真起点的变体通常与单元
        # 同头（"要射"了吗 vs "要射"出来了吗），相位错位的不会。
        # 命中后保留 前导+首个环单元（o+p），不丢首句。
        best_key = None
        best_op = None
        for o in range(0, min(17, max(1, L - 11))):
            for p in range(2, min(10, L - o) + 1):
                u = norm[o : o + p]
                cnt, i = 0, o
                while i + p <= L:
                    if norm[i : i + p] == u:
                        cnt += 1
                        i += p
                    else:
                        i += 1
                if cnt >= 4 and cnt * p >= 0.4 * L:
                    pro = norm[:o]
                    lcp = 0
                    for a, b in zip(pro, u):
                        if a != b:
                            break
                        lcp += 1
                    key = (cnt * p, lcp, -o)
                    if best_key is None or key > best_key:
                        best_key, best_op = key, (o, p)
        for p in range(2, min(10, L - 3) + 1):  # 尾部对齐
            u = norm[L - p :]
            cnt, i = 1, L - p
            while i - p >= 0 and norm[i - p : i] == u:
                cnt += 1
                i -= p
            if cnt >= 4 and cnt * p >= 0.4 * L:
                pro = norm[:i]
                lcp = 0
                for a, b in zip(pro, u):
                    if a != b:
                        break
                    lcp += 1
                key = (cnt * p, lcp, -i)
                if best_key is None or key > best_key:
                    best_key, best_op = key, (i, p)
        if best_op is not None:
            return _first_units_display(tok, best_op[0] + best_op[1])
    return tok


def _collapse_token_runs(tokens: list[str]) -> list[str]:
    """规则 a：连续 k-token 模式复读 R>=3 -> 只留首份。"""
    n = len(tokens)
    if n < 3:
        return tokens
    norms = [_norm_tok(t) for t in tokens]
    out: list[str] = []
    i = 0
    while i < n:
        best = None  # (R*k, R, k)
        for k in (1, 2, 3):
            if i + k > n:
                continue
            pat = norms[i : i + k]
            if any(not x for x in pat):
                continue
            R = 1
            j = i + k
            while j + k <= n and all(norms[j + m] == pat[m] for m in range(k)):
                R += 1
                j += k
            if R >= 3:
                score = (R * k, R)
                if best is None or score > best[0]:
                    best = (score, R, k)
        if best is not None:
            _, R, k = best
            out.extend(tokens[i : i + k])
            i += R * k
        else:
            out.append(tokens[i])
            i += 1
    return out


def collapse_repeat_loops(text: str) -> str:
    """折叠 SRT cue 文本里的 ASR 重复幻觉。逐行处理，幂等；无变化原样返回。"""
    lines = text.split("\n")
    out_lines = []
    changed = False
    for ln in lines:
        if ln.lstrip().startswith("<!--"):  # 指纹注释行不碰
            out_lines.append(ln)
            continue
        toks = ln.split()
        new_toks = _collapse_token_runs(toks)
        new_toks = [_collapse_in_token(t) for t in new_toks]
        if new_toks != toks:
            changed = True
            out_lines.append(" ".join(new_toks))
        else:
            out_lines.append(ln)
    return "\n".join(out_lines) if changed else text


# ---------------------------------------------------------------------------
# 长 cue 智能切分
#
# 引擎 VAD 分段在连续独白/快语速上会产出 10~30s 单条 cue，播放器侧是一整块
# 大字墙（2026-09-23 取证：300MIUM-1266 09:17-09:49 32s 82 字、09:49-10:12
# 23s 82 字）。规则：
#   触发: body 字符数 > SPLIT_MAX_CHARS（含空格）。纯字数触发保证幂等——
#     拆完后每段 <=22 字，二跑不会再触发（时长不参与触发，避免二跑再拆）。
#   边界优先级: 句末（。！？!?~～）> 分句（，、,;）> 空格 > 硬切
#   时间: [start, end] 按字数比例分配，保留原 start/end，子 cue 零重叠且
#     严格递增（放不下则放弃切分，保持原条）
# 仅处理单行 cue；0 时长指纹 cue / <2s cue 不切。
# ---------------------------------------------------------------------------

SPLIT_MAX_CHARS = 22
SPLIT_MIN_DUR_MS = 2_000
_SPLIT_END = set("。！？!?~～")
_SPLIT_MID = "，、,;；"


def _subsplit_long_seg(text: str) -> list[str]:
    """单句超限时按 分句 > 空格 > 硬切 继续切，每段 <= SPLIT_MAX_CHARS。"""
    out: list[str] = []
    while len(text) > SPLIT_MAX_CHARS:
        window = text[:SPLIT_MAX_CHARS]
        cut = -1
        for i in range(len(window) - 1, 3, -1):  # 避免首段 <4 字
            if window[i] in _SPLIT_MID or window[i] == " ":
                cut = i + 1
                break
        if cut <= 3:
            cut = SPLIT_MAX_CHARS  # 完全无边界，硬切
        out.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        out.append(text)
    return out


def _split_cue(
    body: str, start_ms: int, end_ms: int
) -> tuple[list[str], list[tuple[int, int]]]:
    """超限的单条 cue body 拆成多个子 cue。

    返回 (子文本列表, 子时间戳列表 [(s_ms, e_ms), ...])；不切则
    ([body], [(start_ms, end_ms)])。幂等：子文本字数 <= SPLIT_MAX_CHARS，
    二次调用不会再拆。"""
    if (
        "\n" in body
        or len(body) <= SPLIT_MAX_CHARS
        or end_ms - start_ms < SPLIT_MIN_DUR_MS
    ):
        return [body], [(start_ms, end_ms)]

    # 1) 句末标点先切（标点随前段）
    segs: list[str] = []
    buf = ""
    for ch in body:
        buf += ch
        if ch in _SPLIT_END:
            segs.append(buf)
            buf = ""
    if buf:
        segs.append(buf)

    # 2) 单句仍超限按 分句/空格/硬切 再切
    parts = [p for s in segs for p in _subsplit_long_seg(s)]

    # 3) 相邻短段拼到上限，提高显示密度。两端均无标点时以空格连接——
    #    既避免 "…按摩一"+"样的…" 硬切段粘连，也让回拼长度核算真实
    #    （空格边界切割会吃掉一个空格，不计回会超限回拼、白切）。
    packed: list[str] = []
    buf = ""
    _punct = _SPLIT_END | set(_SPLIT_MID)
    for s in (p.strip() for p in parts):
        if not s:
            continue
        if not buf:
            buf = s
            continue
        sep = ""
        if buf[-1] not in _punct and s[0] not in _punct:
            sep = " "
        if len(buf) + len(sep) + len(s) <= SPLIT_MAX_CHARS:
            buf += sep + s
        else:
            packed.append(buf)
            buf = s
    if buf:
        packed.append(buf)
    if len(packed) < 2:
        return [body], [(start_ms, end_ms)]

    # 4) 时长按字数比例分配，保留原 start/end
    total = sum(len(p) for p in packed)
    bounds = [start_ms]
    acc = 0
    for p in packed[:-1]:
        acc += len(p)
        bounds.append(round(start_ms + (end_ms - start_ms) * acc / total))
    bounds.append(end_ms)
    for i in range(1, len(bounds)):  # 强制严格递增
        if bounds[i] <= bounds[i - 1]:
            bounds[i] = bounds[i - 1] + 1
    if bounds[-2] >= end_ms:  # 放不下，放弃切分
        return [body], [(start_ms, end_ms)]
    return packed, [(bounds[i], bounds[i + 1]) for i in range(len(packed))]


def sanitize_srt_text(text: str, log: Optional[LogFn] = None) -> tuple[str, int]:
    """返回 (清洗后的 srt 文本, 修正的 cue 数)。完全合法的文件原样返回、计数 0。"""
    logf = log or (lambda _s: None)
    # 旧版（v0.1.6 及以前）指纹 cue 时间戳为缩写 "00 --> 00"，先归一化，
    # 否则严格解析会拒绝整个文件（存量 srt 修复场景）
    text = re.sub(r"(?m)^\s*00\s*-->\s*00\s*$", "00:00:00,000 --> 00:00:00,000", text)
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
    collapsed = 0
    split_cnt = 0
    idx = 0
    for b in blocks:
        idx += 1
        ts = b.get("new_ts", f"{_ms_to_ts(b['start'])} --> {_ms_to_ts(b['end'])}")
        body = collapse_repeat_loops(b["text"])
        if body != b["text"]:
            collapsed += 1
            logf(
                f"[sanitize] 第{idx}条重复幻觉折叠: {b['text'].splitlines()[0][:40]}"
            )
        sub_bodies, sub_ts = _split_cue(body, b["start"], b["end"])
        if len(sub_bodies) > 1:
            split_cnt += 1
            logf(
                f"[sanitize] 第{idx}条长 cue 切分 {len(sub_bodies)} 段"
                f"（{(b['end'] - b['start']) / 1000:.1f}s/{len(body)}字）: {body[:30]}"
            )
            for n, (sb, (s, e)) in enumerate(zip(sub_bodies, sub_ts), idx):
                out.append(f"{n}\n{_ms_to_ts(s)} --> {_ms_to_ts(e)}\n{sb}\n\n")
            idx += len(sub_bodies) - 1
        else:
            out.append(f"{idx}\n{ts}\n{body}\n\n")
    new_text = "".join(out)
    if new_text == text:
        return text, 0
    for idx, b in enumerate(blocks, 1):
        if "new_ts" in b:
            logf(f"[sanitize] 第{idx}条时间戳修正: {b['orig_ts']} → {b['new_ts']}")
    changed_total = fixed + collapsed + split_cnt
    if changed_total:
        logf(
            f"[sanitize] 共修正 {changed_total}/{total} 条 cue"
            f"（时间戳/重叠修正 {fixed}，重复幻觉折叠 {collapsed}，"
            f"长 cue 切分 {split_cnt}，另删除 fallback 长 cue {dropped} 条）"
        )
    return new_text, changed_total


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


# ---------------------------------------------------------------------------
# JavScribe 指纹（srt 尾部 0 时长 cue + HTML 注释）
#
# 为什么尾部不选开头：SRT 无头部注释语法，头部放无时间戳块会让严格解析器
# （Aegisub 等）cue 索引整体错位；尾部追加时全部正式 cue 已解析完，
# 0 时长 cue（start=end）结构合法、播放器不显示，注释对 HTML 渲染器不可见。
# 检测签名 = 前缀 MARKER_PREFIX（与位置无关：客户端/工作台 sanitizer 重排
# cue 后前缀仍在，检测不受影响）。指纹含 audio_sha1：同名录名换源内容可判 stale。
# ---------------------------------------------------------------------------

MARKER_PREFIX = "<!-- jav-scribe"


def javscribe_marker_info(text: str) -> Optional[dict]:
    """检测 srt 文本内的 JavScribe 指纹。非 JavScribe 生成 -> None。

    返回 {"raw": 注释行, "version": str|None, "fields": {k: v}}。
    """
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith(MARKER_PREFIX):
            continue
        info: dict = {"raw": s, "version": None, "fields": {}}
        body = s[len(MARKER_PREFIX):]
        if body.rstrip().endswith("-->"):
            body = body.rstrip()[: -3]
        for part in body.split("|"):
            part = part.strip()
            if not part:
                continue
            if part.startswith("v") and "=" not in part:
                info["version"] = part[1:].strip()
            elif "=" in part:
                k, v = part.split("=", 1)
                info["fields"][k.strip()] = v.strip()
        return info
    return None


def render_javscribe_marker(meta: dict) -> str:
    """单行指纹注释。meta 键：version/engine/job_id/ts/audio_sha1/src_size。"""
    return (
        f"{MARKER_PREFIX} v{meta.get('version') or '?'}"
        f" | engine={meta.get('engine') or '-'}"
        f" | job={meta.get('job_id') or '-'}"
        f" | {meta.get('ts') or '-'}"
        f" | audio_sha1={meta.get('audio_sha1') or '-'}"
        f" | src_size={meta.get('src_size') or '-'} -->"
    )


def _next_cue_index(text: str) -> int:
    mx = 0
    for ln in text.splitlines():
        t = ln.strip()
        if t.isdigit():
            mx = max(mx, int(t))
    return mx + 1


def append_javscribe_marker(
    path: Path, meta: dict, log: Optional[LogFn] = None
) -> bool:
    """srt 尾部追加指纹 cue。幂等：已有 `<!-- jav-scribe` 不重复追加。

    返回 True=已写入；False=已有指纹/读取失败/写失败。
    """
    logf = log or (lambda _s: None)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        logf(f"[marker] 读取失败，跳过指纹: {path.name} ({e})")
        return False
    if MARKER_PREFIX in text:
        return False
    idx = _next_cue_index(text)
    head = text
    if not head.endswith("\n"):
        head += "\n"
    if not head.endswith("\n\n"):
        head += "\n"
    new = (
        head
        + f"{idx}\n00:00:00,000 --> 00:00:00,000\n"
        + render_javscribe_marker(meta)
        + "\n"
    )
    tmp = path.with_suffix(path.suffix + ".javscribe-tmp")
    try:
        tmp.write_text(new, encoding="utf-8")
        os.replace(tmp, path)
    except OSError as e:
        logf(f"[marker] 写入失败: {path.name} ({e})")
        tmp.unlink(missing_ok=True)
        return False
    logf(f"[marker] 指纹已写入: {path.name}")
    return True
