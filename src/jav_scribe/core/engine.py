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

import os
import shlex
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from ..constants import (
    ALL_EXTS_SET,
    DEFAULT_LANG_TAG,
    VIDEO_EXTS,
)
from .emby import EmbyConfig, refresh_for_video
from .finalize import existing_lang_sub, finalize_one
from .log_parser import LogParser
from .polish import PolishConfig, polish_srt
from .proc_runner import ProcRunner
from .rtf import RtfHistory
from .task import Job, Task, TaskPhase, TaskStatus, new_job_id

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
        self._parser = LogParser()
        self._current_task: Task | None = None
        self._runner: ProcRunner | None = None
        self._stop_evt = threading.Event()
        self._job_thread: threading.Thread | None = None
        self._pending_jobs: list[Job] = []
        self._inflight_files: set[Path] = set()
        self._inflight_lock = threading.Lock()
        self._rtf = RtfHistory(Path(data_dir) / "rtf-history.json") if data_dir else None
        self._live_thread = threading.Thread(target=self._live_loop, daemon=True)
        self._live_thread.start()

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
    ) -> Job:
        job = Job(id=new_job_id(), files=[Task(path=f) for f in files], source_kind=source_kind, label=label)
        self.jobs.append(job)
        if len(self.jobs) > 200:
            self.jobs.pop(0)
        if run_in_thread:
            if self._job_thread is not None and self._job_thread.is_alive():
                # queue behind the running job
                self._pending_jobs.append(job)
                self.log(f"[engine] 任务排队: {job.id}（{len(files)} 个文件）")
            else:
                self._job_thread = threading.Thread(target=self._run_job, args=(job,), daemon=True)
                self._job_thread.start()
        else:
            self._run_job(job)
        return job


    def submit_remote_files(self, files: list[Path], source_name: str) -> Job:
        return self.submit(files, source_kind="remote", label=source_name)

    def retry_job(self, job_id: str) -> "Job | None":
        """「仍要重新生成」：对任务中 SKIPPED 的文件删掉已存在字幕并重新入队。

        返回新任务；无跳过的文件（或任务已滚出内存）时返回 None。
        """
        job = self.job_by_id(job_id)
        if job is None:
            return None
        lang = self.cfg.get("subtitle", {}).get("lang_tag", DEFAULT_LANG_TAG)
        paths: list[Path] = []
        for task in job.files:
            if task.status != TaskStatus.SKIPPED:
                continue
            target = existing_lang_sub(task.path, lang)
            if target is not None:
                target.unlink(missing_ok=True)
                self.log(f"[engine] 重新生成：已删除旧字幕 {target}")
            paths.append(task.path)
        if not paths:
            return None
        self.log(f"[engine] 任务 {job_id} 重新生成 {len(paths)} 个文件")
        return self.submit(paths, source_kind=job.source_kind, label=job.label)

    def stop(self) -> None:
        self._stop_evt.set()
        if self._runner is not None:
            self._runner.stop()

    # ------------------------------------------------------------------
    # Job execution
    # ------------------------------------------------------------------
    def _run_job(self, job: Job) -> None:
        self.log(f"[engine] ===== 任务 {job.id} 开始（{len(job.files)} 个文件） =====")
        try:
            self._pipeline(job)
        finally:
            job.finished = time.time()
            self.log(f"[engine] ===== 任务 {job.id} 结束 =====")
            self._drain_pending()

    def _drain_pending(self) -> None:
        while self._pending_jobs:
            job = self._pending_jobs.pop(0)
            self._job_thread = threading.Thread(target=self._run_job, args=(job,), daemon=True)
            self._job_thread.start()
            break

    def _pipeline(self, job: Job) -> None:
        lang = self.cfg.get("subtitle", {}).get("lang_tag", DEFAULT_LANG_TAG)
        for task in job.files:
            if self._stop_evt.is_set():
                task.status = TaskStatus.CANCELED
                task.message = "已取消"
                continue
            if task.status != TaskStatus.PENDING:
                # 批量推理一次处理任务内全部文件：处理第一个文件时，
                # 其余文件已随该批次统一收尾（DONE/ERROR），直接跳过
                continue
            target = existing_lang_sub(task.path, lang)
            if target is not None and self.cfg.get("subtitle", {}).get("skip_if_exists", True):
                task.status = TaskStatus.SKIPPED
                task.phase = TaskPhase.DONE
                task.progress = 1.0
                task.message = f"已存在 {target}"
                task.finished = time.time()
                self.log(f"[engine] 跳过（字幕已存在）: {task.path.name}")
                continue
            key = task.path.resolve()
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
            try:
                self._process_one(job, task, lang)
            finally:
                with self._inflight_lock:
                    self._inflight_files.discard(key)
        self._polish_job(job)
        self._emby_job(job)

    # ------------------------------------------------------------------
    # Stage 1: optional restore
    # ------------------------------------------------------------------
    def _process_one(self, job: Job, task: Task, lang: str) -> None:
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
            self._infer_one(job, task, lang)
        if self._stop_evt.is_set() and task.status == TaskStatus.RUNNING:
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

    def _infer_one(self, job: Job, task: Task, lang: str) -> None:
        # One infer process per job: model loaded once, all files in the batch.
        todo = [t for t in job.files if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING) and not t.output_files]
        if not todo:
            return
        cmd, cwd = self._build_infer_command([t.source for t in todo])
        self.log(f"[engine] 字幕（{len(todo)} 个文件，一次加载模型）")
        self._parser = LogParser()
        self._current_task = None
        shared = {"transcribe_started": None, "model_loaded": False}

        def on_line(line: str) -> None:
            self.log(f"  [infer] {line}")
            evt = self._parser.feed(line)
            t = self._match_task(job, evt.file_path, evt.file_idx, todo)
            now = time.time()
            if evt.kind == "file_start":
                self._current_task = t
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

        ok = self._run_command(cmd, cwd=cwd, on_line=on_line)
        if not ok:
            for t in todo:
                if t.status == TaskStatus.RUNNING:
                    t.status = TaskStatus.ERROR
                    t.message = t.message or "引擎退出非零"
                    t.finished = time.time()
        self._record_rtf(todo, shared["transcribe_started"])

        # Finalize outputs for every file that got something written.
        for t in todo:
            if t.output_files:
                self._finalize_task(t, lang)
            if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING):
                t.status = TaskStatus.DONE if t.output_files else TaskStatus.ERROR
                t.message = t.message or ("完成" if t.output_files else "无字幕输出")
                t.progress = 1.0 if t.status == TaskStatus.DONE else t.progress
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

    def _match_task(self, job: Job, path: Optional[str], idx: Optional[int], todo: list[Task]) -> Task | None:
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
        return self._current_task

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

    def _finalize_task(self, task: Task, lang: str) -> None:
        task.phase = TaskPhase.FINALIZING
        written = [p for p in task.output_files]
        res = finalize_one(task.source, written, self.cfg.get("subtitle", {}), log=self.log)
        task.output_files = res.final_paths or task.output_files
        if res.skipped:
            task.message = f"目标已存在: {res.skipped[0].name}"
        elif res.final_paths:
            task.message = "完成"

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
    ) -> bool:
        self._last_exit_code = None
        env = {**os.environ, "PYTHONUNBUFFERED": "1"}
        self._runner = ProcRunner(
            " ".join(shlex.quote(c) for c in cmd),
            cwd=cwd,
            on_line=on_line,
            on_progress_pct=on_progress,
            on_exit=lambda code: setattr(self, "_last_exit_code", code),
            env=env,
        )
        if not self._runner.start():
            return False
        start = time.time()
        while self._runner.running:
            self._runner.wait(1.0)
            if timeout and time.time() - start > timeout:
                self.log("[engine] 超时，终止")
                self._runner.stop()
                break
            if self._stop_evt.is_set():
                self._runner.stop()
                break
        self._runner = None
        return self._last_exit_code in (0, None)

    _last_exit_code: int | None = None

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
