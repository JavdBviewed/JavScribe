"""Inbox 缓存清理：音轨/字幕缓存文件到期自动删除。

serve 的 inbox 只存「客户端上传音轨 → 服务端生成字幕」链路的中间缓存：
  - 音轨（.opus 等，客户端本地抽取后上传的音频）
  - 字幕（.srt 等，生成后经下载/写回交付给客户端、服务端留存的副本）
交付后这些文件不再需要，按保留期清理。watch/扫描模式下「落在影片旁」的
srt 是交付物（在 inbox 之外），永不触碰。

配置项：storage.retention_days（默认 7，/config 热调，每轮清理重新读取）。
清理循环由 ProgressHTTP.start() 以 daemon 线程启动：启动 60s 后首轮，
此后每 6 小时一轮。属于活跃任务（pending/running）的文件即使超期也不删。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

from ..constants import AUDIO_EXTS
from .task import TaskStatus

if TYPE_CHECKING:
    from .engine import Engine

# 参与清理的缓存扩展名：音轨 + 字幕（与 constants 对齐）
CACHE_EXTS: set[str] = {e.lower() for e in AUDIO_EXTS} | {"srt", "vtt", "lrc", "txt"}

ACTIVE_STATUSES = (TaskStatus.PENDING, TaskStatus.RUNNING)

INITIAL_DELAY_S = 60
INTERVAL_S = 6 * 3600


def active_source_paths(engine: "Engine") -> set[str]:
    """所有活跃任务涉及的文件绝对路径（str）：源文件 / 还原后 / 已产出。"""
    paths: set[str] = set()
    for job in getattr(engine, "jobs", None) or []:
        for t in getattr(job, "files", None) or []:
            if t.status not in ACTIVE_STATUSES:
                continue
            for p in (t.path, t.restored_path, *t.output_files):
                if p is not None:
                    paths.add(str(p))
    return paths


def cleanup_inbox(
    inbox_dir: Path,
    retention_days: int,
    active_paths: Optional[set[str]] = None,
    log: Optional[Callable[[str], None]] = None,
) -> tuple[int, int]:
    """删除 inbox 顶层中超过保留期（按 mtime）的音轨/字幕缓存文件。

    只处理 inbox 顶层文件（不递归）；不触碰其他扩展名、保留期内文件、
    以及属于活跃任务的文件。retention_days <= 0 时不清理。
    返回 (删除文件数, 释放字节数)。
    """
    logf = log or (lambda _s: None)
    if retention_days <= 0:
        return (0, 0)
    cutoff = time.time() - retention_days * 86400
    active = active_paths or set()
    deleted = 0
    freed = 0
    try:
        entries = list(inbox_dir.iterdir())
    except OSError as ex:
        logf(f"[retention] inbox 不可读: {ex}")
        return (0, 0)
    for p in entries:
        try:
            if not p.is_file():
                continue
            if p.suffix.lower().lstrip(".") not in CACHE_EXTS:
                continue
            st = p.stat()
            if st.st_mtime >= cutoff:
                continue
            if str(p) in active:
                logf(f"[retention] 跳过活跃任务文件（已超期）: {p.name}")
                continue
            p.unlink()
            deleted += 1
            freed += st.st_size
            logf(f"[retention] 清理超期缓存 {p.name} ({st.st_size / 1048576:.1f} MB)")
        except OSError as ex:
            logf(f"[retention] 删除失败 {p.name}: {ex}")
    return (deleted, freed)


def retention_loop(
    engine: "Engine",
    inbox_dir: Path,
    initial_delay_s: float = INITIAL_DELAY_S,
    interval_s: float = INTERVAL_S,
) -> None:
    """后台清理循环（daemon 线程体）：每轮重新读取 storage.retention_days。"""
    time.sleep(initial_delay_s)
    while True:
        try:
            days = int((engine.cfg.get("storage") or {}).get("retention_days", 7))
            deleted, freed = cleanup_inbox(
                inbox_dir, days, active_source_paths(engine), engine.log
            )
            if deleted:
                engine.log(f"[retention] 本轮清理 {deleted} 个超期缓存文件，释放 {freed / 1048576:.1f} MB")
        except Exception as ex:  # 单轮失败不杀循环
            try:
                engine.log(f"[retention] 清理轮失败: {ex}")
            except Exception:
                pass
        time.sleep(interval_s)
