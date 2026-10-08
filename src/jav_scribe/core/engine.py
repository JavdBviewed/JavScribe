"""Headless pipeline engine (no Qt).

Pipeline per file:
  [pre-check]  skip if <stem>.<lang>.srt already exists
  [restore]    optional JASNA pass (command template)
  [infer]      one external process (ChickenRice infer) per job; its stdout is
               parsed for per-file progress (timeline-aware) and written files
  [finalize]   rename/copy outputs to <stem>.<lang>.<ext> next to the source
  [polish]     optional LLM proofread pass (OpenAI-compatible endpoint)
  [emby]       optional metadata refresh on the media server

One job = one infer process (model loaded once). Jobs run sequentially.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import shlex
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .. import __version__ as _VERSION
from ..constants import (
    ALL_EXTS_SET,
    DEFAULT_LANG_TAG,
    VIDEO_EXTS,
)
from .emby import EmbyConfig, refresh_for_video
from .finalize import existing_lang_sub, finalize_one
from .subprobe import probe_embedded_subs, should_skip_embedded
from .log_parser import LogParser
from .polish import PolishConfig, polish_srt
from .proc_runner import ProcRunner
from .rtf import RtfHistory
from .task import TERMINAL_STATUSES, Job, Task, TaskPhase, TaskStatus, new_job_id

LogFn = Callable[[str], None]

# Live sub-phase model (per task, driven by infer log events + a 1s ticker).
# ChickenRice dumps all segment lines only when transcribe() finishes, so the
# transcribing band is interpolated from an RTF estimate (measured history).
# (phase: (lo, hi, expected_s, detail)) — expected_s=None => RTF driven.
LIVE_PHASES: dict[str, tuple[float, float, float | None, str]] = {
    "preparing": (0.00, 0.25, 180.0, "模型加载中"),
    "vad": (0.25, 0.40, 90.0, "语音检测中"),
    "transcribing": (0.40, 0.95, None, "转写中"),
    "finalizing": (0.95, 1.00, 20.0, "合并写入字幕"),
}


# ---------------------------------------------------------------------------
# 任务历史持久化（<data_dir>/jobs.json）
# serve 重建/重启会丢内存任务表，历史任务（含已完成）从此文件恢复。
# 只恢复「全终态」任务——未完成任务的 worker 进程已不存在，恢复会误导用户，
# 由用户重新提交（客户端 uploads.json 保留本地提交/回写跟踪）。
# ---------------------------------------------------------------------------
JOBS_HISTORY_NAME = "jobs.json"
JOBS_HISTORY_MAX = 500  # 磁盘上限（内存表仍为 200，save 时一并修剪）
STATS_NAME = "stats.json"  # 累计终态统计（独立于 200 内存窗，看板统计单一真源）
PAUSE_NAME = "pause.json"  # 队列暂停状态（{"paused": bool}，重启恢复）
BATCH_PAUSE_NAME = "batch-pause.json"  # 批次（主任务）暂停态（{"paused": [batch_id, ...]}，重启恢复）


def job_from_dict(d: dict) -> "Job | None":
    """jobs.json 条目 → Job。字段缺失/非法返回 None（跳过该条，不炸启动）。"""
    try:
        files: list[Task] = []
        for f in d.get("files", []):
            files.append(
                Task(
                    path=Path(str(f.get("path", ""))),
                    status=TaskStatus(str(f.get("status", "pending"))),
                    phase=TaskPhase(str(f.get("phase", "queued"))),
                    progress=float(f.get("progress", 0.0) or 0.0),
                    message=str(f.get("message", "") or ""),
                    output_files=[Path(str(x)) for x in f.get("output_files", [])],
                    duration_s=f.get("duration_s"),
                    speech_s=f.get("speech_s"),
                    position_s=f.get("position_s"),
                    started=f.get("started"),
                    finished=f.get("finished"),
                )
            )
        if not files or "id" not in d:
            return None
        return Job(
            id=str(d["id"]),
            files=files,
            created=float(d.get("created") or time.time()),
            finished=d.get("finished"),
            source_kind=str(d.get("source_kind", "local")),
            label=str(d.get("label", "") or ""),
            cancel_requested=bool(d.get("cancel_requested", False)),
            paused=bool(d.get("paused", False)),
            batch_id=d.get("batch_id"),  # 旧 jobs.json 条目无此字段 → None（天然兼容）
            batch_label=d.get("batch_label"),
        )
    except (KeyError, ValueError, TypeError):
        return None


class Engine:
    def __init__(
        self,
        cfg: dict[str, Any],
        log: Optional[LogFn] = None,
        profile: str = "default",
        data_dir: Optional[Path] = None,
    ) -> None:
        self.cfg = cfg
        self.profile = profile
        self.log = log or print
        self.jobs: list[Job] = []
        # 在途推理进程数（>0 = 有已加载模型的进程；/metrics gauge 单一口径）
        self._model_procs = 0
        self._model_lock = threading.Lock()
        self._stop_evt = threading.Event()
        # 转译 worker 池：并发度 = 同时运行的模型实例数（infer.concurrency，
        # /config 热调，1~4）。_sched_lock 统一保护 _workers 与 _pending_jobs。
        self._workers: list[threading.Thread] = []
        self._pending_jobs: list[Job] = []
        self._sched_lock = threading.Lock()
        # 在途子进程登记（stop() 时全部终止；并发下多个 _run_command 互不覆盖）
        self._active_runners: set[ProcRunner] = set()
        self._runners_lock = threading.Lock()
        self._inflight_files: set[Path] = set()
        # retry_job 放行的文件：resubmit 时豁免内嵌字幕判定（一次性）
        self._force_embedded: set[Path] = set()
        self._inflight_lock = threading.Lock()
        # coalesce（模型预热）合并统计（R3 可观测：/metrics json + prometheus 单一口径）
        self._coalesce_lock = threading.Lock()
        self._coalesce_applied = 0   # 覆盖多 Job 的进程次数
        self._model_loads = 0        # 推理进程启动（模型加载）次数
        self._last_batch_files = 0   # 最近一次进程覆盖文件数
        self._last_batch_jobs = 0    # 最近一次进程覆盖 Job 数
        self._rtf = RtfHistory(Path(data_dir) / "rtf-history.json") if data_dir else None
        # 任务历史持久化：serve 重建后「已完成」任务仍在任务表可见
        self._jobs_path = Path(data_dir) / JOBS_HISTORY_NAME if data_dir else None
        self._jobs_lock = threading.Lock()
        self._restore_job_history()
        # 累计终态统计（done/skipped/failed，failed=error+canceled，与客户端 UI 口径一致）：
        # 内存任务表只留最近 200 条，大批量任务下客户端按行计数必然少算；
        # serve 在任务收尾时累计并持久化，作为看板统计的单一真源（/health.stats）。
        self._stats = {"done": 0, "skipped": 0, "failed": 0}
        self._counted: set[str] = set()
        self._stats_path = Path(data_dir) / STATS_NAME if data_dir else None
        self._load_stats()
        # 队列暂停（用户面）：运行中任务跑完、不再开新任务；状态持久化重启不丢
        self._paused = False
        self._pause_path = Path(data_dir) / PAUSE_NAME if data_dir else None
        self._load_pause_state()
        # 批次（主任务）级暂停：冻结该 batch 排队子任务（Job 级优雅暂停）；与队列暂停独立可叠加。
        # 状态持久化重启不丢；标记不剪枝——重启后该 batch 在途 Job 不在内存，标记仍须生效（验收 e）。
        self._batch_paused: set[str] = set()
        self._batch_pause_path = Path(data_dir) / BATCH_PAUSE_NAME if data_dir else None
        self._load_batch_pause_state()
        self._live_thread = threading.Thread(target=self._live_loop, daemon=True)
        self._live_thread.start()

    @property
    def model_loaded(self) -> bool:
        """当前是否有已加载模型的推理进程（/metrics gauge 单一口径）。"""
        with self._model_lock:
            return self._model_procs > 0

    def _model_up(self) -> None:
        with self._model_lock:
            self._model_procs += 1

    def _model_down(self) -> None:
        with self._model_lock:
            if self._model_procs > 0:
                self._model_procs -= 1

    @property
    def concurrency(self) -> int:
        """转译并发度（同时运行的转译任务/模型实例数），/config 热调，1~4。"""
        try:
            v = int(self.cfg.get("infer", {}).get("concurrency", 1))
        except (TypeError, ValueError):
            v = 1
        return max(1, min(4, v))

    @property
    def coalesce_max_jobs(self) -> int:
        """合并批任务数（模型复用）：Job 进入转写阶段时，把队列中最多 N-1 个
        同源排队任务并入本次推理进程（一次模型加载覆盖整批）。
        1 = 现行为（每任务一个进程）；1~50，/config 热调，保存后对后续任务生效。"""
        try:
            v = int(self.cfg.get("infer", {}).get("coalesce_max_jobs", 5))
        except (TypeError, ValueError):
            v = 5
        return max(1, min(50, v))

    def coalesce_stats(self) -> dict:
        """coalesce 合并统计快照（单锁保护；/metrics json 与 prometheus 渲染消费）。"""
        with self._coalesce_lock:
            return {
                "coalesce_applied": self._coalesce_applied,
                "model_loads": self._model_loads,
                "last_batch_files": self._last_batch_files,
                "last_batch_jobs": self._last_batch_jobs,
            }

    def active_workers(self) -> int:
        """当前正跑任务的 worker 数（≤ 并发度；监控快照用）。"""
        with self._sched_lock:
            return sum(1 for t in self._workers if t.is_alive())

    # ------------------------------------------------------------------
    # Submission
    # ------------------------------------------------------------------
    def expand(self, paths: list[Path | str]) -> list[Path]:
        out: list[Path] = []
        seen: set[Path] = set()
        for p in paths:
            p = Path(p).expanduser()
            if p.is_dir():
                for f in sorted(p.rglob("*")):
                    if f.is_file() and f.suffix.lower() in ALL_EXTS_SET:
                        self._add_unique(f, out, seen)
            elif p.is_file() and p.suffix.lower() in ALL_EXTS_SET:
                self._add_unique(p, out, seen)
        return out

    @staticmethod
    def _add_unique(p: Path, out: list[Path], seen: set[Path]) -> None:
        rp = p.resolve()
        if rp in seen:
            return
        seen.add(rp)
        out.append(p)

    def submit(
        self,
        files: list[Path],
        source_kind: str = "local",
        label: str = "",
        run_in_thread: bool = True,
        batch_id: str | None = None,
        batch_label: str | None = None,
    ) -> Job:
        job = Job(id=new_job_id(), files=[Task(path=f) for f in files], source_kind=source_kind, label=label,
                  batch_id=batch_id, batch_label=batch_label)
        self.jobs.append(job)
        if len(self.jobs) > 200:
            self.jobs.pop(0)
        self._save_jobs()
        if run_in_thread:
            # 一律先入队，由 _drain_pending 按并发度派发（有空槽立即开跑）
            with self._sched_lock:
                self._pending_jobs.append(job)
            if self._paused:
                self.log(f"[engine] 任务排队: {job.id}（{len(files)} 个文件）（队列已暂停）")
            self._drain_pending()
        else:
            self._run_job(job)
        return job


    def submit_remote_files(self, files: list[Path], source_name: str,
                             batch_id: str | None = None, batch_label: str | None = None) -> Job:
        return self.submit(files, source_kind="remote", label=source_name,
                           batch_id=batch_id, batch_label=batch_label)

    def retry_job(self, job_id: str) -> "Job | None":
        """重试：SKIPPED 文件（删旧字幕/放行内嵌判定）+ ERROR 文件重新入队。

        返回新任务；无可重试文件（或任务已滚出内存）时返回 None。
        DONE/CANCELED 不可重试。
        """
        job = self.job_by_id(job_id)
        if job is None:
            return None
        lang = self.cfg.get("subtitle", {}).get("lang_tag", DEFAULT_LANG_TAG)
        paths: list[Path] = []
        for task in job.files:
            if task.status == TaskStatus.SKIPPED:
                target = existing_lang_sub(task.path, lang)
                if target is not None:
                    target.unlink(missing_ok=True)
                    self.log(f"[engine] 重新生成：已删除旧字幕 {target}")
                elif str(task.message or "").startswith("跳过："):
                    # 内嵌字幕跳过的任务：无外部字幕可删，放行内嵌判定重生成
                    with self._inflight_lock:
                        self._force_embedded.add(task.path.resolve())
            elif task.status != TaskStatus.ERROR:
                # DONE/CANCELED/PENDING/RUNNING 不重试；ERROR 无副作用，直接重入
                continue
            paths.append(task.path)
        if not paths:
            return None
        self.log(f"[engine] 任务 {job_id} 重新生成 {len(paths)} 个文件")
        return self.submit(paths, source_kind=job.source_kind, label=job.label)

    # ------------------------------------------------------------------
    # Cancel（用户主动取消：排队任务立即收尾；运行任务设标志，检查点协作中止）
    # ------------------------------------------------------------------
    def cancel_job(self, job_id: str) -> "str | None":
        """取消任务。返回：None=任务不存在；"finished"=已结束；
        "canceled"=排队任务已立即取消；"canceling"=运行中，正在协作中止。"""
        job = self.job_by_id(job_id)
        if job is None:
            return None
        if job.finished is not None:
            return "finished"
        if job.cancel_requested:
            return "canceled" if all(
                t.status in (TaskStatus.DONE, TaskStatus.SKIPPED, TaskStatus.ERROR, TaskStatus.CANCELED)
                for t in job.files) else "canceling"
        job.cancel_requested = True
        with self._sched_lock:
            in_queue = job in self._pending_jobs
            if in_queue:
                self._pending_jobs.remove(job)
        if in_queue:
            self._cancel_pending_tasks(job, "已取消")
            job.finished = time.time()
            self._count_terminals([job])
            self._save_jobs()
            self.log(f"[engine] 任务 {job.id} 已取消（排队中，未占用推理资源）")
            self._drain_pending()  # 腾出位置，让后续任务立即补位
            return "canceled"
        self.log(f"[engine] 任务 {job.id} 收到取消请求（运行中，将在检查点中止）")
        return "canceling"

    @staticmethod
    def _cancel_pending_tasks(job: "Job", msg: str) -> None:
        now = time.time()
        for t in job.files:
            if t.status == TaskStatus.PENDING:
                t.status = TaskStatus.CANCELED
                t.message = msg
                t.finished = now
                t.eta_s = None

    # ------------------------------------------------------------------
    # 暂停 / 继续（用户面：队列级 + 单任务级）
    # ------------------------------------------------------------------
    @property
    def paused(self) -> bool:
        return self._paused

    def _load_pause_state(self) -> None:
        if self._pause_path is None or not self._pause_path.exists():
            return
        try:
            raw = json.loads(self._pause_path.read_text(encoding="utf-8"))
            self._paused = bool(raw.get("paused", False))
            if self._paused:
                self.log("[engine] 队列处于暂停状态（重启前已暂停）")
        except (OSError, ValueError, TypeError) as e:
            self.log(f"[engine] 暂停状态读取失败（忽略）: {e}")

    def _save_pause_state(self) -> None:
        if self._pause_path is None:
            return
        try:
            tmp = self._pause_path.with_name(self._pause_path.name + ".tmp")
            tmp.write_text(json.dumps({"paused": self._paused}), encoding="utf-8")
            os.replace(tmp, self._pause_path)
        except OSError as e:
            self.log(f"[engine] 暂停状态写入失败（忽略）: {e}")

    def pause_queue(self) -> bool:
        """暂停队列：运行中任务跑完，不再开新任务。返回是否从非暂停切换为暂停。"""
        if self._paused:
            return False
        self._paused = True
        self._save_pause_state()
        self.log("[engine] 队列已暂停（运行中任务继续跑完）")
        return True

    def resume_queue(self) -> bool:
        """继续队列。返回是否从暂停切换为继续。"""
        if not self._paused:
            return False
        self._paused = False
        self._save_pause_state()
        self.log("[engine] 队列已继续")
        self._drain_pending()
        return True

    def pause_job(self, job_id: str) -> "str | None":
        """挂起单个排队任务。返回：None=不存在；"finished"=已结束；
        "running"=运行中不可挂起；"paused"=已挂起。

        判定与置位都在 _sched_lock 内原子完成：与 _pipeline 的开跑提交
        （committed 位）互斥，杜绝「drain 派发后、开跑前」的挂起丢失窗口。
        """
        job = self.job_by_id(job_id)
        if job is None:
            return None
        if job.finished is not None or job.done:
            return "finished"
        with self._sched_lock:
            if job.committed or job.current() is not None or job.cancel_requested:
                return "running"
            job.paused = True
        self._save_jobs()
        self.log(f"[engine] 任务 {job.id} 已挂起（排队中）")
        return "paused"

    def resume_job(self, job_id: str) -> "str | None":
        """恢复单个挂起任务。返回：None=不存在；"finished"=已结束；
        "not_paused"=未在挂起状态；"resumed"=已恢复。"""
        job = self.job_by_id(job_id)
        if job is None:
            return None
        if job.finished is not None or job.done:
            return "finished"
        if not job.paused:
            return "not_paused"
        job.paused = False
        self._save_jobs()
        self.log(f"[engine] 任务 {job.id} 已恢复排队")
        self._drain_pending()
        return "resumed"

    # ------------------------------------------------------------------
    # 批次（主任务）级暂停 / 继续 / 取消（S2：Job 级优雅暂停）
    # ------------------------------------------------------------------
    def _load_batch_pause_state(self) -> None:
        if self._batch_pause_path is None or not self._batch_pause_path.exists():
            return
        try:
            raw = json.loads(self._batch_pause_path.read_text(encoding="utf-8"))
            for v in raw.get("paused", []):
                if isinstance(v, str) and v:
                    self._batch_paused.add(v)
            if self._batch_paused:
                self.log(f"[engine] 已恢复 {len(self._batch_paused)} 个 batch 暂停态（重启前已暂停）")
        except (OSError, ValueError, TypeError) as e:
            self.log(f"[engine] batch 暂停状态读取失败（忽略）: {e}")

    def _save_batch_pause(self) -> None:
        if self._batch_pause_path is None:
            return
        try:
            tmp = self._batch_pause_path.with_name(self._batch_pause_path.name + ".tmp")
            tmp.write_text(json.dumps({"paused": sorted(self._batch_paused)}, ensure_ascii=False),
                           encoding="utf-8")
            os.replace(tmp, self._batch_pause_path)
        except OSError as e:
            self.log(f"[engine] batch 暂停状态写入失败（忽略）: {e}")

    @property
    def batch_paused_ids(self) -> list[str]:
        return sorted(self._batch_paused)

    def _job_frozen(self, job: "Job") -> bool:
        """Job 级冻结判定：单任务挂起或其所属 batch 暂停（须在 _sched_lock 内调用）。"""
        return job.paused or (job.batch_id is not None and job.batch_id in self._batch_paused)

    def batch_pause(self, batch_id: str) -> bool:
        """暂停主任务：在跑子任务跑完、排队子任务不开跑。返回是否从非暂停切换为暂停。

        判定与置位都在 _sched_lock 内原子完成：与 _pipeline 的开跑提交（committed 位）
        互斥，杜绝「暂停成功但任务刚好开跑」的冻结丢失窗口。
        """
        with self._sched_lock:
            if batch_id in self._batch_paused:
                return False
            self._batch_paused.add(batch_id)
        self._save_batch_pause()
        self.log(f"[engine] 主任务 {batch_id} 已暂停（在跑子任务继续跑完）")
        return True

    def batch_resume(self, batch_id: str) -> bool:
        """继续主任务：解冻该 batch 排队子任务并补派。返回是否从暂停切换为继续。"""
        with self._sched_lock:
            if batch_id not in self._batch_paused:
                return False
            self._batch_paused.discard(batch_id)
        self._save_batch_pause()
        self.log(f"[engine] 主任务 {batch_id} 已继续")
        self._drain_pending()
        return True

    def batch_cancel(self, batch_id: str) -> dict:
        """取消主任务：batch 内未开始子任务的 PENDING 文件 → CANCELED（主任务已取消）。

        在跑子任务不动：不置 cancel_requested、不做协作中止（PRD 钉死语义）。
        取消同时清该 batch 暂停标记。返回 {"canceled_jobs": n, "canceled_files": m}。
        """
        now = time.time()
        canceled_jobs = 0
        canceled_files = 0
        with self._sched_lock:
            for job in self.jobs:
                if job.batch_id != batch_id or job.done:
                    continue
                if job in self._pending_jobs:
                    self._pending_jobs.remove(job)
                touched = 0
                for t in job.files:
                    if t.status == TaskStatus.PENDING:
                        t.status = TaskStatus.CANCELED
                        t.message = "主任务已取消"
                        t.finished = now
                        t.eta_s = None
                        touched += 1
                if touched:
                    canceled_files += touched
                if job.done:
                    job.finished = job.finished or now
                    self._count_terminals([job])
                    canceled_jobs += 1
            self._batch_paused.discard(batch_id)
        self._save_jobs()
        self._save_batch_pause()
        if canceled_jobs or canceled_files:
            self.log(f"[engine] 主任务 {batch_id} 已取消：{canceled_jobs} 个子任务、{canceled_files} 个文件（在跑的不受影响）")
        self._drain_pending()
        return {"canceled_jobs": canceled_jobs, "canceled_files": canceled_files}

    def _restore_job_history(self) -> None:
        if self._jobs_path is None or not self._jobs_path.exists():
            return
        try:
            raw = json.loads(self._jobs_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            self.log(f"[engine] 任务历史读取失败（忽略）: {e}")
            return
        if not isinstance(raw, list):
            return
        restored = 0
        for d in raw[-JOBS_HISTORY_MAX:]:
            if not isinstance(d, dict):
                continue
            job = job_from_dict(d)
            if job is None or not job.done:
                continue  # 未完成任务不恢复（worker 已随进程消亡，重新提交即可）
            self.jobs.append(job)
            restored += 1
        if self.jobs:
            self.jobs = self.jobs[-200:]
        if restored:
            self.log(f"[engine] 已恢复历史任务 {restored} 个（{self._jobs_path.name}）")

    def _save_jobs(self) -> None:
        if self._jobs_path is None:
            return
        with self._jobs_lock:
            try:
                payload = [j.to_dict(detail=True) for j in self.jobs[-JOBS_HISTORY_MAX:]]
                tmp = self._jobs_path.with_name(self._jobs_path.name + ".tmp")
                tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp, self._jobs_path)
            except OSError as e:
                self.log(f"[engine] 任务历史写入失败（忽略）: {e}")

    # ------------------------------------------------------------------
    # 累计终态统计（stats.json）
    # ------------------------------------------------------------------
    def _load_stats(self) -> None:
        if self._stats_path is None:
            return
        if self._stats_path.exists():
            try:
                raw = json.loads(self._stats_path.read_text(encoding="utf-8"))
                for k in ("done", "skipped", "failed"):
                    v = raw.get(k, 0)
                    if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                        self._stats[k] = int(v)
                c = raw.get("counted")
                if isinstance(c, list):
                    self._counted = {str(x) for x in c}
            except (OSError, ValueError, TypeError) as e:
                self.log(f"[engine] 统计读取失败（清零重来）: {e}")
                self._stats = {"done": 0, "skipped": 0, "failed": 0}
                self._counted = set()
            return
        # 旧版升级：stats.json 缺失但任务表已恢复 → 从恢复的全终态任务计基线
        self._count_terminals(self.jobs)

    def _count_terminals(self, jobs: list["Job"]) -> None:
        """累计任务终态文件计数（幂等：counted 集合按 job.id:序号 去重，
        多收尾路径/重试/取消交接不会重复计）。任务收尾时调用——不依赖
        200 内存窗，被窗口挤出的任务收尾也能计入。"""
        changed = False
        with self._jobs_lock:
            for job in jobs:
                for idx, t in enumerate(job.files):
                    if t.status not in TERMINAL_STATUSES:
                        continue
                    key = f"{job.id}:{idx}"
                    if key in self._counted:
                        continue
                    self._counted.add(key)
                    if t.status == TaskStatus.DONE:
                        self._stats["done"] += 1
                    elif t.status == TaskStatus.SKIPPED:
                        self._stats["skipped"] += 1
                    else:  # ERROR / CANCELED
                        self._stats["failed"] += 1
                    changed = True
            if changed:
                self._save_stats()

    def _save_stats(self) -> None:
        """调用方需已持有 _jobs_lock。"""
        if self._stats_path is None:
            return
        try:
            payload = {**self._stats, "counted": sorted(self._counted)}
            tmp = self._stats_path.with_name(self._stats_path.name + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self._stats_path)
        except OSError as e:
            self.log(f"[engine] 统计写入失败（忽略）: {e}")

    def stats(self) -> dict:
        """累计终态统计（客户端看板统计单一真源）。"""
        with self._jobs_lock:
            return dict(self._stats)

    def stop(self) -> None:
        self._stop_evt.set()
        with self._runners_lock:
            runners = list(self._active_runners)
        for r in runners:
            r.stop()

    # ------------------------------------------------------------------
    # Job execution
    # ------------------------------------------------------------------
    def _run_job(self, job: Job) -> None:
        if job.paused or (job.batch_id is not None and job.batch_id in self._batch_paused):
            # 交接窗口：drain 弹出后、开跑前被挂起 / batch 被暂停 → 回到队首，不占推理资源
            with self._sched_lock:
                self._pending_jobs.insert(0, job)
            self.log(f"[engine] 任务 {job.id} 已冻结（开跑前）")
            self._release_slot()
            return
        if job.cancel_requested:
            # 交接窗口：drain 弹出后、开跑前被取消 → 立即收尾，不占推理资源
            self._cancel_pending_tasks(job, "已取消")
            job.finished = time.time()
            self._count_terminals([job])
            self._save_jobs()
            self.log(f"[engine] 任务 {job.id} 已取消（开跑前）")
            self._release_slot()
            return
        self.log(f"[engine] ===== 任务 {job.id} 开始（{len(job.files)} 个文件） =====")
        try:
            self._pipeline(job)
        finally:
            job.finished = time.time()
            self._count_terminals([job])
            self._save_jobs()
            self.log(f"[engine] ===== 任务 {job.id} 结束 =====")
            self._release_slot()

    def _release_slot(self) -> None:
        """worker 退出：把自己移出池并补派队列（槽位释放的唯一出口）。"""
        with self._sched_lock:
            try:
                self._workers.remove(threading.current_thread())
            except ValueError:
                pass
        self._drain_pending()

    def _drain_pending(self) -> None:
        """按并发度补派：有空槽就从队头取非挂起任务开 worker（挂起者移尾）。"""
        if self._paused or self._stop_evt.is_set():
            return
        while True:
            with self._sched_lock:
                self._workers = [t for t in self._workers if t.is_alive()]
                cap = self.concurrency
                if len(self._workers) >= cap:
                    return
                job = None
                while self._pending_jobs:
                    cand = self._pending_jobs.pop(0)
                    if cand.done:
                        continue  # 队列里已收尾的 Job（取消等路径）：直接丢弃不派发
                    if self._job_frozen(cand):
                        if all(self._job_frozen(j) for j in self._pending_jobs):
                            # 全被冻结（挂起/batch 暂停）：放回去，等 resume
                            self._pending_jobs.insert(0, cand)
                            return
                        self._pending_jobs.append(cand)  # 移尾，找下一个
                        continue
                    job = cand
                    break
                if job is None:
                    return
                w = threading.Thread(target=self._run_job, args=(job,), daemon=True)
                self._workers.append(w)
                self.log(f"[engine] 派发任务 {job.id}（在途 {len(self._workers)}/{cap}）")
            w.start()

    def _precheck_job(self, job: Job, lang: str, sub_cfg: dict, mode: str) -> list[Task]:
        """预检：逐文件定跳过语义（已存在字幕 / 内嵌字幕 / 在途冲突）。

        必须在任何批量推理之前完成：_infer_one 会把全部 PENDING 文件拉进
        同一批次，检查若滞后于批次，应跳过的文件会被顺带生成字幕。
        """
        ready: list[Task] = []
        for task in job.files:
            if task.status != TaskStatus.PENDING:
                continue
            if self._stop_evt.is_set() or job.cancel_requested:
                task.status = TaskStatus.CANCELED
                task.message = "已取消"
                task.finished = time.time()
                continue
            key = task.path.resolve()
            forced = False
            with self._inflight_lock:
                # retry_job 放行的文件豁免内嵌判定（一次性消费）
                if key in self._force_embedded:
                    self._force_embedded.discard(key)
                    forced = True
            target = existing_lang_sub(task.path, lang)
            if target is not None and sub_cfg.get("skip_if_exists", True):
                task.status = TaskStatus.SKIPPED
                task.phase = TaskPhase.DONE
                task.progress = 1.0
                task.message = f"已存在 {target}"
                task.finished = time.time()
                self.log(f"[engine] 跳过（字幕已存在）: {task.path.name}")
                continue
            if not forced and mode != "off":
                subs = probe_embedded_subs(task.path, log=self.log)
                skip, reason = should_skip_embedded(
                    sub_cfg, [x["language"] for x in subs]
                )
                if skip:
                    task.status = TaskStatus.SKIPPED
                    task.phase = TaskPhase.DONE
                    task.progress = 1.0
                    task.message = f"跳过：{reason}"
                    task.finished = time.time()
                    self.log(f"[engine] 跳过（内嵌字幕）: {task.path.name} {reason}")
                    continue
            with self._inflight_lock:
                if key in self._inflight_files:
                    # 同一文件正被其他任务处理（watcher 重扫/重复提交），跳过
                    task.status = TaskStatus.SKIPPED
                    task.phase = TaskPhase.DONE
                    task.progress = 1.0
                    task.message = "其他任务正在处理，已跳过"
                    task.finished = time.time()
                    self.log(f"[engine] 跳过（其他任务正在处理）: {task.path.name}")
                    continue
                self._inflight_files.add(key)
            ready.append(task)
        return ready

    def _collect_coalesce(self, job: Job) -> list[Job]:
        """前瞻合并：取队列中最多 N-1 个后续同源排队任务并入本次推理进程（S1 模型预热）。

        不越暂停线：coalesce_max_jobs<=1 / 队列暂停 / 服务停止中均不合并。
        在 _sched_lock 内按入队顺序扫描候选（与 drain 派发 / pause_job 原子互斥，
        不重复派发、不丢挂起）：同源 source_kind、未挂起、未取消、未提交、
        仍有 PENDING 文件的 Job 被摘出队列并置 committed 位。
        """
        n = self.coalesce_max_jobs
        if n <= 1 or self._paused or self._stop_evt.is_set():
            return []
        picked: list[Job] = []
        with self._sched_lock:
            keep: list[Job] = []
            for cand in self._pending_jobs:
                if (
                    len(picked) < n - 1
                    and cand is not job
                    and cand.source_kind == job.source_kind
                    and not cand.paused
                    and not (cand.batch_id is not None and cand.batch_id in self._batch_paused)
                    and not cand.cancel_requested
                    and not cand.committed
                    and any(t.status == TaskStatus.PENDING for t in cand.files)
                ):
                    cand.committed = True
                    picked.append(cand)
                else:
                    keep.append(cand)
            if picked:
                self._pending_jobs = keep
        if not picked:
            return []
        total_files = 0
        detail: list[str] = []
        for c in picked:
            n_files = 0
            for t in c.files:
                if t.status == TaskStatus.PENDING:
                    t.phase_detail = "随批加载"  # R3：复用现有 phase_detail 展示路径
                    n_files += 1
            total_files += n_files
            detail.append(f"{c.id}（{n_files} 文件）")
        self.log(
            f"[engine] coalesce 合并：并入 {len(picked)} 个后续 Job，"
            f"一次模型加载覆盖 {total_files} 个文件: {'、'.join(detail)}"
        )
        return picked

    def _pipeline(self, job: Job) -> None:
        # 开跑门：与 pause_job 同一把锁，commit / requeue 二选一，零竞态窗口。
        # 若挂起发生在 drain 派发之后、此处提交之前 → 回到队首重排，不占资源。
        with self._sched_lock:
            if job.paused or (job.batch_id is not None and job.batch_id in self._batch_paused):
                self._pending_jobs.insert(0, job)
                job.committed = False
                requeue = True
            else:
                job.committed = True
                requeue = False
        if requeue:
            self.log(f"[engine] 任务 {job.id} 已冻结（开跑前，重新排队）")
            self._release_slot()
            return
        lang = self.cfg.get("subtitle", {}).get("lang_tag", DEFAULT_LANG_TAG)
        sub_cfg = self.cfg.get("subtitle", {})
        mode = str(sub_cfg.get("skip_embedded", "target") or "target").lower()

        # ---- 预检：逐文件定跳过语义（已存在字幕 / 内嵌字幕 / 在途冲突）。
        # 必须在任何批量推理之前完成（见 _precheck_job 注释）。
        ready = self._precheck_job(job, lang, sub_cfg, mode)

        # ---- coalesce：主任务有可转写文件时，把最多 N-1 个后续同源排队任务
        # 并入本次推理进程（一次模型加载覆盖整批；N=1 不合并，行为=现状）。
        extra_jobs = self._collect_coalesce(job) if ready else []
        batch: list[tuple[Job, Task]] = [(job, t) for t in ready]
        for ej in extra_jobs:
            batch.extend((ej, t) for t in self._precheck_job(ej, lang, sub_cfg, mode))

        # ---- 批量推理：一次加载模型处理全部预检通过的文件
        for j, task in batch:
            if task.status in (TaskStatus.PENDING, TaskStatus.RUNNING):
                if j.cancel_requested:
                    task.status = TaskStatus.CANCELED
                    task.message = "已取消"
                    task.finished = time.time()
                    self.log(f"[engine] 取消：跳过未开始文件 {task.path.name}")
                    with self._inflight_lock:
                        self._inflight_files.discard(task.path.resolve())
                    continue
                # 前一批次已统一收尾（DONE/ERROR）的文件直接跳过
                self._process_one(j, task, lang, batch=batch)
            with self._inflight_lock:
                self._inflight_files.discard(task.path.resolve())
        for j in (job, *extra_jobs):
            self._polish_job(j)
            self._emby_job(j)
            if j is not job:
                # 并入任务不经过 _run_job：在此收尾（finished/统计/持久化，幂等）
                j.finished = j.finished or time.time()
                self._count_terminals([j])
                self._save_jobs()
                self.log(f"[engine] ===== 任务 {j.id} 结束（coalesce 并入 {job.id}） =====")

    # ------------------------------------------------------------------
    # Stage 1: optional restore
    # ------------------------------------------------------------------
    def _process_one(self, job: Job, task: Task, lang: str,
                     batch: list[tuple[Job, Task]] | None = None) -> None:
        task.started = time.time()
        task.status = TaskStatus.RUNNING
        task.live_phase = "preparing"
        task.live_phase_started = task.started
        task.phase_detail = LIVE_PHASES["preparing"][3]
        task.eta_s = None
        task.est_transcribe_s = None
        task.transcribe_started = None
        task.last_progress_at = None
        if self._restore(task):
            self._infer_one(job, task, lang, batch=batch)
        if (self._stop_evt.is_set() or job.cancel_requested) and task.status == TaskStatus.RUNNING:
            task.status = TaskStatus.CANCELED
            task.message = "已取消"
        if task.status == TaskStatus.RUNNING:
            task.status = TaskStatus.DONE if task.output_files else TaskStatus.ERROR
            task.message = task.message or ("完成" if task.output_files else "无输出")
            task.progress = 1.0 if task.status == TaskStatus.DONE else task.progress
        task.finished = time.time()

    def _restore(self, task: Task) -> bool:
        jasna = self.cfg.get("jasna", {})
        if not jasna.get("enabled") or not jasna.get("command"):
            return True
        out_tpl = jasna.get("output") or "{stem}_restored{ext}"
        out = Path(
            out_tpl.replace("{path}", str(task.path))
            .replace("{stem}", task.path.stem)
            .replace("{ext}", task.path.suffix)
        ).expanduser()
        if not out.is_absolute():
            out = task.path.parent / out
        if out.exists() and jasna.get("skip_if_exists", True):
            task.restored_path = out
            task.message = "修复输出已存在，跳过"
            self.log(f"[engine] 修复跳过: {out.name}")
            return True
        task.phase = TaskPhase.RESTORING
        task.message = f"修复中: {task.path.name}"
        self.log(f"[engine] 修复: {task.path.name} -> {out.name}")
        tpl = jasna["command"]
        parts = shlex.split(tpl.replace("{path}", shlex.quote(str(task.path)))).copy()
        if "{out}" in tpl:
            parts = [p.replace("{out}", shlex.quote(str(out))) for p in parts]
        else:
            parts.append(str(out))  # default: last arg = output path
        ok = self._run_command(
            parts,
            on_line=lambda l: self.log(f"  [jasna] {l}"),
            on_progress=lambda p: setattr(task, "progress", p),
            timeout=None,
        )
        if ok and out.exists():
            task.restored_path = out
            task.phase = TaskPhase.RESTORED
            return True
        if ok:
            self.log(f"[engine] 修复完成但未找到输出 {out.name}，字幕基于原文件")
        else:
            task.message = "修复失败，字幕基于原文件"
        return True

    # ------------------------------------------------------------------
    # Stage 2: infer (one process per job for all pending files)
    # ------------------------------------------------------------------
    def _enter_transcribing(self, todo: list[Task], job: Job) -> None:
        """VAD finished (duration line seen): start the RTF-interpolated band."""
        inf = self.cfg.get("infer", {})
        device = str(inf.get("device") or "auto")
        model = str(inf.get("model") or "")
        now = time.time()
        for t in todo:
            if t.status not in (TaskStatus.PENDING, TaskStatus.RUNNING):
                continue
            if t.transcribe_started is None:
                t.transcribe_started = now
            if self._rtf is not None:
                est, _basis = self._rtf.estimate(device, model, t.duration_s, t.speech_s)
                t.est_transcribe_s = est
            t.live_phase = "transcribing"
            t.live_phase_started = now
            t.phase_detail = LIVE_PHASES["transcribing"][3]
            lo, hi, _exp, _det = LIVE_PHASES["transcribing"]
            t.progress = max(t.progress, lo)
            if t.est_transcribe_s:
                t.eta_s = t.est_transcribe_s + 20.0  # + finalize margin

    def _record_rtf(self, todo: list[Task], transcribe_started: float | None) -> None:
        """Persist measured speed samples (one per finished file with a duration)."""
        if self._rtf is None or not transcribe_started:
            return
        inf = self.cfg.get("infer", {})
        device = str(inf.get("device") or "auto")
        model = str(inf.get("model") or "")
        for t in todo:
            if not t.output_files or not t.transcribe_started:
                continue
            end = t.last_progress_at or t.finished or 0.0
            wall = end - t.transcribe_started
            if wall > 5 and (t.duration_s or t.speech_s):
                self._rtf.record(device, model, t.duration_s, t.speech_s, wall)

    def _infer_one(self, job: Job, task: Task, lang: str,
                   batch: list[tuple[Job, Task]] | None = None) -> None:
        # One infer process per batch: model loaded once, all files in the batch.
        # batch=None（默认，单任务）= 现行为：拉本任务全部 PENDING 文件；
        # batch=coalesce 合并批：拉整批（可能跨多个 Job）预检通过的文件。
        if batch is None:
            items: list[tuple[Job, Task]] = [
                (job, t) for t in job.files
                if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING) and not t.output_files
            ]
        else:
            items = [(j, t) for j, t in batch
                     if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING) and not t.output_files]
        if not items:
            return
        todo = [t for _j, t in items]
        # Job/Task 均为 eq dataclass（不可哈希）：按对象身份去重，不能用 dict 哈希
        jobs: list[Job] = []
        for j, _t in items:
            if not any(j is x for x in jobs):
                jobs.append(j)
        job_of: dict[int, Job] = {id(t): j for j, t in items}
        multi = len(jobs) > 1
        cmd, cwd = self._build_infer_command([t.source for t in todo])
        if multi:
            self.log(f"[engine] 字幕（{len(todo)} 个文件，一次加载模型，覆盖 {len(jobs)} 个任务）")
        else:
            self.log(f"[engine] 字幕（{len(todo)} 个文件，一次加载模型）")
        with self._coalesce_lock:
            self._model_loads += 1
            self._last_batch_files = len(todo)
            self._last_batch_jobs = len(jobs)
            if multi:
                self._coalesce_applied += 1
        # 日志解析与「当前文件」指针是 job 级私有的（并发 worker 互不串扰）
        parser = LogParser()
        cur: dict = {"t": None}
        shared = {"transcribe_started": None, "model_loaded": False}

        def on_line(line: str) -> None:
            self.log(f"  [infer] {line}")
            evt = parser.feed(line)
            t = self._match_task(evt.file_path, evt.file_idx, todo, cur)
            if evt.kind == "file_start":
                # 已取消 Job 的文件也要占「当前文件」位：否则后续无 path 的
                # segment 行会错归到上一个文件
                cur["t"] = t
            # coalesce：被取消的 Job 的文件事件全部丢弃（不推进状态、不记输出）；
            # 单任务模式保持现状（进程由 stop_check 终止，事件照常处理）。
            if multi and t is not None:
                cj = job_of.get(id(t))
                if cj is not None and cj.cancel_requested:
                    return
            now = time.time()
            if evt.kind == "file_start":
                if t is not None:
                    t.status = TaskStatus.RUNNING
                    t.phase = TaskPhase.SUBTITLING
                    t.position_s = None
                    # 不重置 progress：批量后续文件时，前置阶段进度要保留
                    if t.transcribe_started is not None:
                        t.live_phase = "transcribing"
                        t.live_phase_started = now
                        t.phase_detail = LIVE_PHASES["transcribing"][3]
                    elif shared.get("model_loaded") and t.live_phase == "preparing":
                        # 同批后续文件：模型已加载，跳过「模型加载中」直接进 VAD 阶段
                        t.live_phase = "vad"
                        t.live_phase_started = now
                        t.phase_detail = LIVE_PHASES["vad"][3]
            elif evt.kind == "batch_probe":
                shared["model_loaded"] = True
                for tt in todo:
                    if tt.status in (TaskStatus.PENDING, TaskStatus.RUNNING) and tt.transcribe_started is None:
                        tt.live_phase = "vad"
                        tt.live_phase_started = now
                        tt.phase_detail = LIVE_PHASES["vad"][3]
            elif evt.kind == "duration":
                if t is not None:
                    if evt.duration_s:
                        t.duration_s = evt.duration_s
                    if evt.speech_s:
                        t.speech_s = evt.speech_s
                    # 每个文件各自在「自己的 Duration 行」进入转写带：
                    # 同批后续文件此刻还在排队，不能给它们插 RTF 估算
                    if evt.duration_s and t.transcribe_started is None:
                        shared["transcribe_started"] = shared["transcribe_started"] or now
                        self._enter_transcribing([t], job)
            elif evt.kind == "file_progress":
                if t is not None and evt.progress is not None:
                    lo, hi, _e, _d = LIVE_PHASES["transcribing"]
                    actual = lo + (hi - lo) * evt.progress  # 真实位置映射进转写带
                    t.progress = max(t.progress, actual)
                    t.last_progress_at = now
                    if t.duration_s:
                        t.position_s = evt.progress * t.duration_s
                    t.eta_s = max(0.0, (t.est_transcribe_s or 0.0) * (1 - evt.progress)) + 20.0
            elif evt.kind == "file_written":
                if t is not None and evt.file_path:
                    p = Path(evt.file_path)
                    if p not in t.output_files:
                        t.output_files.append(p)
                    t.live_phase = "finalizing"
                    t.live_phase_started = now
                    t.phase_detail = LIVE_PHASES["finalizing"][3]
                    t.progress = max(t.progress, 0.97)
                    t.eta_s = None
            elif evt.kind == "model_load":
                shared["model_loaded"] = True
                self.log("  [infer] 模型加载中…")

        self._model_up()
        # 单任务：任一取消即杀进程（现状）；合并批：全部 Job 都取消才终止，
        # 单个被取消 Job 不得杀整个进程（R2）
        ok = self._run_command(cmd, cwd=cwd, on_line=on_line,
                               stop_check=lambda: all(j.cancel_requested for j in jobs))
        self._model_down()  # 推理进程已退出，模型随进程释放
        if not ok:
            for t in todo:
                j = job_of[id(t)]
                if t.status == TaskStatus.RUNNING:
                    if j.cancel_requested or self._stop_evt.is_set():
                        # 取消/停止时已产出字幕的文件保留：留给 finalize 循环收尾为 DONE
                        # （合并批：被取消任务的文件不算交付，直接 CANCELED）
                        if t.output_files and not multi:
                            continue
                        t.status = TaskStatus.CANCELED
                        t.message = "已取消" if j.cancel_requested else "服务停止"
                    else:
                        t.status = TaskStatus.ERROR
                        t.message = t.message or "引擎退出非零"
                    t.finished = time.time()
        self._record_rtf(todo, shared["transcribe_started"])

        # Finalize outputs for every file that got something written.
        for t in todo:
            j = job_of[id(t)]
            if t.output_files and not (multi and j.cancel_requested):
                self._finalize_task(t, lang, j)
            if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING):
                if multi and j.cancel_requested:
                    # 被取消的并入任务：不收尾、不保留输出（孤儿 srt 留在原处，
                    # 不带语言标签，后续重跑预检不会误判为已交付）
                    t.status = TaskStatus.CANCELED
                    t.message = "已取消"
                    t.output_files = []
                elif t.output_files:
                    # 与旧代码同序：已产出字幕一律收尾为 DONE（取消/停止亦然）；
                    # 单任务模式 multi=False 时本分支与 5913fdd 逐字等价
                    t.status = TaskStatus.DONE
                    t.message = t.message or "完成"
                    t.progress = 1.0
                elif j.cancel_requested or self._stop_evt.is_set():
                    # 取消/停止时未开始的文件（同批后续项）：不报错，标已取消
                    t.status = TaskStatus.CANCELED
                    t.message = "已取消" if j.cancel_requested else "服务停止"
                else:
                    t.status = TaskStatus.ERROR
                    t.message = t.message or "无字幕输出"
                t.eta_s = None
                t.finished = time.time()

    # ------------------------------------------------------------------
    # Live progress ticker: 1s heartbeat so the UI sees smooth progress and
    # a ticking ETA between infer log events (segment lines only arrive when
    # a batched transcribe() finishes).
    # ------------------------------------------------------------------
    def _live_loop(self) -> None:
        while not self._stop_evt.wait(1.0):
            try:
                self._live_tick()
            except Exception:  # noqa: BLE001 - ticker must never kill the engine
                pass

    def _live_tick(self) -> None:
        now = time.time()
        for job in list(self.jobs):
            for t in job.files:
                if t.status == TaskStatus.RUNNING and t.phase == TaskPhase.SUBTITLING:
                    self._update_live_task(t, now)

    def _update_live_task(self, t: Task, now: float) -> None:
        phase = t.live_phase if t.live_phase in LIVE_PHASES else "preparing"
        lo, hi, exp, detail = LIVE_PHASES[phase]
        t.phase_detail = detail
        if phase == "transcribing":
            if t.est_transcribe_s and t.transcribe_started:
                frac = max(0.0, min(0.999, (now - t.transcribe_started) / t.est_transcribe_s))
                t.progress = max(t.progress, lo + (hi - lo) * frac)
                t.eta_s = max(0.0, t.est_transcribe_s * (1.0 - frac)) + 20.0
            # 无估算（旧配置/无历史）：保持事件驱动的值，不插值
        else:
            started = t.live_phase_started or now
            if exp:
                frac = max(0.0, min(1.0, (now - started) / exp))
                t.progress = max(t.progress, lo + (hi - lo) * frac)
            t.eta_s = None

    def _match_task(self, path: Optional[str], idx: Optional[int],
                    todo: list[Task], cur: dict) -> Task | None:
        if path:
            target = Path(path).resolve()
            for t in todo:
                if t.source.resolve() == target or t.path.resolve() == target:
                    return t
            name = Path(path).name
            for t in todo:
                if t.source.name == name or t.path.name == name:
                    return t
        if idx is not None and 0 <= idx < len(todo):
            return todo[idx]
        return cur["t"]

    def _build_infer_command(self, files: list[Path]) -> tuple[list[str], Optional[str]]:
        inf = self.cfg.get("infer", {})
        sub = self.cfg.get("subtitle", {})
        base = inf.get("command", "")
        parts = shlex.split(base)
        args: list[str] = []
        if inf.get("model"):
            args.append(f"--model_name_or_path={inf['model']}")
        if inf.get("device"):
            args.append(f"--device={inf['device']}")
        if sub.get("formats"):
            args.append(f"--sub_formats={','.join(sub['formats'])}")
        args.append(f"--audio_suffixes={','.join(sorted(e.lstrip('.') for e in ALL_EXTS_SET))}")
        if sub.get("output_dir"):
            args.append(f"--output_dir={sub['output_dir']}")
        if sub.get("overwrite"):
            args.append("--overwrite")
        if inf.get("batch"):
            args.append("--enable_batching")
            if inf.get("max_batch_size"):
                args.append(f"--max_batch_size={inf['max_batch_size']}")
        if inf.get("log_level"):
            args.append(f"--log_level={inf['log_level']}")
        # VAD 参数（服务设置可调；不填则用 ChickenRice 默认阈值 0.5）
        vad = self.cfg.get("vad", {})
        for key, flag in (
            ("threshold", "--vad_threshold"),
            ("min_speech_duration_ms", "--vad_min_speech_duration_ms"),
            ("min_silence_duration_ms", "--vad_min_silence_duration_ms"),
            ("speech_pad_ms", "--vad_speech_pad_ms"),
        ):
            v = vad.get(key)
            if v is not None:
                args.append(f"{flag}={v}")
        for a in inf.get("extra_args", []):
            args.append(a)
        # cwd: explicit wins. Otherwise, for a bare executable (e.g.
        # infer.exe) use its own directory so relative `models/` resolves;
        # for interpreter-style commands (python -m ..., uv run ...) do not
        # guess — the config must set cwd when the tool needs one.
        cwd = inf.get("cwd")
        if not cwd and parts:
            first = parts[0]
            if (len(parts) == 1 or first.endswith(".exe")) and Path(first).is_file():
                cwd = str(Path(first).resolve().parent)
        return parts + args + [str(f) for f in files], (cwd or None)

    def _finalize_task(self, task: Task, lang: str, job: Job) -> None:
        task.phase = TaskPhase.FINALIZING
        written = [p for p in task.output_files]
        sub_cfg = self.cfg.get("subtitle", {})
        meta = self._marker_meta(task, job) if sub_cfg.get("marker", True) else None
        res = finalize_one(
            task.source, written, sub_cfg, log=self.log, marker_meta=meta
        )
        task.output_files = res.final_paths or task.output_files
        if res.skipped:
            task.message = f"目标已存在: {res.skipped[0].name}"
        elif res.final_paths:
            task.message = "完成"

    def _marker_meta(self, task: Task, job: Job) -> dict:
        """指纹元数据：版本/引擎/job/时间/音轨 sha1/源大小。"""
        audio_sha1 = "-"
        src = task.source
        # 远程上传走内容寻址 inbox：<sha1>.<ext>，stem 即音轨 sha1
        if re.fullmatch(r"[0-9a-f]{40}", src.stem) and src.suffix.lower() in (
            ".opus", ".m4a", ".mp3", ".wav", ".flac", ".aac", ".ogg", ".mp4", ".mkv",
        ):
            audio_sha1 = src.stem
        if audio_sha1 == "-":
            # 本地 watch/run：客户端可能在源旁留 .javscribe.opus 侧车
            sidecar = src.with_name(src.stem + ".javscribe.opus")
            if sidecar.is_file():
                try:
                    h = hashlib.sha1()
                    with open(sidecar, "rb") as fh:
                        for chunk in iter(lambda: fh.read(1 << 20), b""):
                            h.update(chunk)
                    audio_sha1 = h.hexdigest()
                except OSError:
                    pass
        src_size = "-"
        try:
            src_size = task.path.stat().st_size
        except OSError:
            pass
        return {
            "version": _VERSION,
            "engine": self.profile,
            "job_id": job.id,
            "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "audio_sha1": audio_sha1,
            "src_size": src_size,
        }

    # ------------------------------------------------------------------
    # Stage 3/4: polish + emby
    # ------------------------------------------------------------------
    def _polish_job(self, job: Job) -> None:
        pol = self.cfg.get("polish", {})
        if not pol.get("enabled"):
            return
        cfg = PolishConfig.from_dict(pol)
        for t in job.files:
            if t.status != TaskStatus.DONE:
                continue
            for p in t.output_files:
                if p.suffix.lower() == ".srt" and p.is_file():
                    t.phase = TaskPhase.POLISHING
                    try:
                        polish_srt(p, cfg, log=self.log)
                    except Exception as e:
                        self.log(f"[polish] 失败（保留原字幕）: {e}")
            t.phase = TaskPhase.DONE

    def _emby_job(self, job: Job) -> None:
        emb = self.cfg.get("emby", {})
        if not emb.get("enabled"):
            return
        cfg = EmbyConfig(url=emb.get("url", ""), api_key=emb.get("api_key", ""))
        if not cfg.usable:
            return
        for t in job.files:
            if t.status != TaskStatus.DONE or t.path.suffix.lower().lstrip(".") not in VIDEO_EXTS:
                continue
            refresh_for_video(cfg, t.path, log=self.log)

    # ------------------------------------------------------------------
    # Generic command runner
    # ------------------------------------------------------------------
    def _run_command(
        self,
        cmd: list[str],
        cwd: Optional[str] = None,
        on_line: Optional[LogFn] = None,
        on_progress: Optional[Callable[[float], None]] = None,
        timeout: float | None = None,
        stop_check: Optional[Callable[[], bool]] = None,
    ) -> bool:
        # 并发 worker 各自持有 ProcRunner 与退出码（不再用引擎级单例）
        exit_box: dict = {"code": None}
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        runner = ProcRunner(
            " ".join(shlex.quote(c) for c in cmd),
            cwd=cwd,
            on_line=on_line,
            on_progress_pct=on_progress,
            on_exit=lambda code: exit_box.__setitem__("code", code),
            env=env,
        )
        with self._runners_lock:
            self._active_runners.add(runner)
        try:
            if not runner.start():
                return False
            start = time.time()
            while runner.running:
                runner.wait(1.0)
                if timeout and time.time() - start > timeout:
                    self.log("[engine] 超时，终止")
                    runner.stop()
                    break
                if self._stop_evt.is_set():
                    runner.stop()
                    break
                if stop_check is not None and stop_check():
                    self.log("[engine] 收到取消，终止子进程")
                    runner.stop()
                    break
            return exit_box["code"] in (0, None)
        finally:
            with self._runners_lock:
                self._active_runners.discard(runner)

    # ------------------------------------------------------------------
    # API helpers
    # ------------------------------------------------------------------
    def job_by_id(self, job_id: str) -> Job | None:
        for j in self.jobs:
            if j.id == job_id:
                return j
        return None

    def result_srt_bytes(self, job: Job) -> bytes | None:
        for t in job.files:
            for p in t.output_files:
                if p.suffix.lower() == ".srt" and p.is_file():
                    return p.read_bytes()
        return None

    def snapshot(self) -> dict:
        return {
            "profile": self.profile,
            "device": self.cfg.get("infer", {}).get("device", "auto"),
            "jobs": [j.to_dict() for j in self.jobs],
        }
