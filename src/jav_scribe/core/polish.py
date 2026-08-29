"""Optional LLM polish pass for generated subtitles (OFF by default).

Calls any OpenAI-compatible chat endpoint (a self-hosted Ollama/vLLM
instance, a commercial API, ...). Batches SRT blocks, asks the model
to fix mistranslations / awkward phrasing while preserving the line count and
all timecodes, then validates and writes back atomically.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

POLISH_PROMPT = (
    "你是日剧/影片字幕校对员。下面是机器翻译生成的 SRT 字幕块。\n"
    "请逐条校对并修正：错译、漏译、不通顺、错别字、标点。\n"
    "严格要求：\n"
    "1. 保持字幕条数完全不变，时间码原样保留；\n"
    "2. 只输出修正后的 SRT 文本，不要任何解释、前缀或代码块标记；\n"
    "3. 人名/专有名词保持音译一致；语气符合字幕口语习惯。"
)


@dataclass
class PolishConfig:
    base_url: str
    api_key: str
    model: str
    batch_lines: int = 60
    timeout_s: int = 600

    @classmethod
    def from_dict(cls, d: dict) -> "PolishConfig":
        return cls(
            base_url=(d.get("base_url") or "").rstrip("/"),
            api_key=d.get("api_key") or os.environ.get("JAVSCRIBE_LLM_API_KEY", ""),
            model=d.get("model") or "",
            batch_lines=int(d.get("batch_lines", 60)),
            timeout_s=int(d.get("timeout_s", 600)),
        )

    @property
    def usable(self) -> bool:
        return bool(self.base_url and self.model)


class PolishError(Exception):
    pass


def _srt_blocks(text: str, batch_lines: int) -> list[str]:
    blocks: list[str] = []
    cur: list[str] = []
    for line in text.splitlines():
        if re.match(r"^\d+\s*$", line.strip()):
            cur.append(line)
            if len(cur) // 4 >= batch_lines and len(cur) >= 4:
                blocks.append("\n".join(cur))
                cur = []
        else:
            cur.append(line)
    if cur:
        blocks.append("\n".join(cur))
    return [b for b in blocks if b.strip()]


def _validate(original: str, polished: str) -> bool:
    def counts(s: str) -> tuple[int, int]:
        n_lines = len([l for l in s.splitlines() if l.strip() and not re.match(r"^\d+\s*$", l.strip()) and "-->" not in l])
        n_ts = len(re.findall(r"-->", s))
        return n_lines, n_ts

    lo, lo_ts = counts(original)
    po, po_ts = counts(polished)
    return po_ts == lo_ts and abs(po - lo) <= max(2, lo // 20)


def _call(cfg: PolishConfig, block: str, on_note: Callable[[str], None]) -> str:
    url = cfg.base_url.rstrip("/") + "/chat/completions"
    body = json.dumps(
        {
            "model": cfg.model,
            "temperature": 0.2,
            "messages": [
                {"role": "system", "content": POLISH_PROMPT},
                {"role": "user", "content": block},
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {cfg.api_key}"} if cfg.api_key else {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=cfg.timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"]
    except Exception as e:
        raise PolishError(f"LLM 调用失败: {e}") from e
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\n?", "", content)
        content = re.sub(r"\n?```$", "", content)
        content = content.strip()
    on_note(f"[polish] LLM 返回 {len(content)} 字符")
    return content


def polish_srt(
    path: Path,
    cfg: PolishConfig,
    log: Optional[Callable[[str], None]] = None,
) -> bool:
    """Polish the SRT in place. Returns True if it was rewritten."""
    logf = log or (lambda _s: None)
    if not cfg.usable:
        logf("[polish] 未配置 base_url/model，跳过润色")
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    blocks = _srt_blocks(text, cfg.batch_lines)
    if not blocks:
        return False
    polished: list[str] = []
    for i, b in enumerate(blocks, 1):
        logf(f"[polish] 块 {i}/{len(blocks)} …")
        out = _call(cfg, b, logf)
        if not _validate(b, out):
            logf(f"[polish] 块 {i} 校验未通过（行数/时间码不一致），保留原文")
            out = b
        polished.append(out)
    new_text = "\n".join(polished).strip() + "\n"
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(new_text, encoding="utf-8")
    os.replace(tmp, path)
    logf(f"[polish] 已写回 {path.name}（{len(blocks)} 块）")
    return True
