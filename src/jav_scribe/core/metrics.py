"""Prometheus text-format metrics for serve（方案 A：stdlib 手拼，零依赖）。

挂 progress_api 的 /metrics（与 /jobs 同敏感级：无鉴权、仅内网）。
数据底座 = Engine 内存态（Job/Task dataclass，现成）。

Counter 语义说明：/jobs 列表有 200 条上限（超出弹最旧），若每次渲染直接
从 jobs 累加，Counter 会倒退。这里用「单调累加 + 终态去重」：每次渲染扫描
jobs，仅对「尚未计过的终态文件」计入累计器（去重键 job_id+path+finished+
status），job 被弹出后计数不丢、重复渲染不重复计。
"""
from __future__ import annotations

import shutil
import subprocess
import threading
import time
from collections import deque
from typing import Any, Optional

# 单文件处理耗时分布桶（秒）
_BUCKETS: tuple[float, ...] = (0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0)
_TERMINAL = ("done", "skipped", "error", "canceled")
_SEEN_CAP = 50_000  # 去重键上限，超出整体清空（计数不重置，极端重放可能重复计，可接受）


def _esc(s: str) -> str:
    """Prometheus label 值转义：\\、"、换行。"""
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _fmt(v: float) -> str:
    if v == int(v):
        return str(int(v))
    return repr(v)


class MetricsRegistry:
    """进程内指标累加器（线程安全；渲染时从 engine 拉快照）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seen: set[tuple[str, str, float, str]] = set()
        self._completed: dict[str, int] = {"done": 0, "skipped": 0, "failed": 0, "canceled": 0}
        self._hist: list[int] = [0] * (len(_BUCKETS) + 1)  # 各桶累计（含 +Inf 末位）
        self._hist_count = 0
        self._hist_sum = 0.0
        self._upload_bytes = 0
        self._scan_requests = 0
        self._config_changes = 0

    # -- 计数入口（handler 埋点） ------------------------------------------
    def add_upload_bytes(self, n: int) -> None:
        with self._lock:
            self._upload_bytes += max(0, n)

    def inc_scan_requests(self) -> None:
        with self._lock:
            self._scan_requests += 1

    def inc_config_changes(self, n: int = 1) -> None:
        with self._lock:
            self._config_changes += max(0, n)

    def totals(self) -> dict[str, int]:
        """终态累计快照（done/skipped/failed/canceled；供 JSON 监控端点）。"""
        with self._lock:
            return dict(self._completed)

    # -- 渲染 ----------------------------------------------------------------
    def render(self, engine: Any) -> str:
        e = engine
        jobs = list(getattr(e, "jobs", []) or [])
        jobs_state: dict[str, int] = {}
        files_status: dict[str, int] = {}
        progress_lines: list[str] = []
        batch_active = 0
        with self._lock:
            for j in jobs:
                state = "finished" if j.done else "running"
                jobs_state[state] = jobs_state.get(state, 0) + 1
                for t in j.files:
                    st = t.status.value
                    files_status[st] = files_status.get(st, 0) + 1
                    if st == "running":
                        batch_active += 1
                        if 0.0 <= t.progress <= 1.0:
                            progress_lines.append(
                                'javscribe_file_progress{job_id="%s",file="%s"} %s'
                                % (_esc(j.id), _esc(t.path.name), _fmt(t.progress))
                            )
                    if st in _TERMINAL:
                        key = (j.id, str(t.path), float(t.finished or 0.0), st)
                        if key in self._seen:
                            continue
                        self._seen.add(key)
                        if len(self._seen) > _SEEN_CAP:
                            self._seen.clear()
                        result = {"done": "done", "skipped": "skipped",
                                  "error": "failed", "canceled": "canceled"}[st]
                        self._completed[result] += 1
                        dur: Optional[float] = None
                        if t.started is not None and t.finished is not None:
                            dur = max(0.0, t.finished - t.started)
                        if dur is not None:
                            self._observe(dur)
            upload_bytes = self._upload_bytes
            scan_requests = self._scan_requests
            config_changes = self._config_changes
            hist = list(self._hist)
            hist_count = self._hist_count
            hist_sum = self._hist_sum

        L: list[str] = []
        ap = L.append
        ap("# HELP javscribe_jobs_total 当前各状态 job 数。")
        ap("# TYPE javscribe_jobs_total gauge")
        for st in ("running", "finished"):
            ap(f'javscribe_jobs_total{{status="{st}"}} {jobs_state.get(st, 0)}')
        ap("# HELP javscribe_files_total 当前各状态文件数。")
        ap("# TYPE javscribe_files_total gauge")
        for st in ("pending", "running", "done", "error", "skipped", "canceled"):
            ap(f'javscribe_files_total{{status="{st}"}} {files_status.get(st, 0)}')
        if progress_lines:
            ap("# HELP javscribe_file_progress 进行中文件的时间轴进度（0-1）。")
            ap("# TYPE javscribe_file_progress gauge")
            L.extend(progress_lines)
        ap("# HELP javscribe_files_completed_total 终态文件累计（done/skipped/failed）。")
        ap("# TYPE javscribe_files_completed_total counter")
        for result in ("done", "skipped", "failed", "canceled"):
            ap(f'javscribe_files_completed_total{{result="{result}"}} {self._completed[result]}')
        ap("# HELP javscribe_file_duration_seconds 单文件处理耗时（秒）。")
        ap("# TYPE javscribe_file_duration_seconds histogram")
        for b, c in zip(_BUCKETS, hist):
            ap(f'javscribe_file_duration_seconds_bucket{{le="{b:g}"}} {c}')
        ap(f'javscribe_file_duration_seconds_bucket{{le="+Inf"}} {hist[-1]}')
        ap(f"javscribe_file_duration_seconds_count {hist_count}")
        ap(f"javscribe_file_duration_seconds_sum {_fmt(hist_sum)}")
        ap("# HELP javscribe_upload_bytes_total 接收音轨字节累计。")
        ap("# TYPE javscribe_upload_bytes_total counter")
        ap(f"javscribe_upload_bytes_total {upload_bytes}")
        ap("# HELP javscribe_scan_requests_total /scan 请求累计。")
        ap("# TYPE javscribe_scan_requests_total counter")
        ap(f"javscribe_scan_requests_total {scan_requests}")
        ap("# HELP javscribe_config_changes_total /config 成功更新项累计。")
        ap("# TYPE javscribe_config_changes_total counter")
        ap(f"javscribe_config_changes_total {config_changes}")
        ap("# HELP javscribe_engine_batch_active 当前并发处理文件数。")
        ap("# TYPE javscribe_engine_batch_active gauge")
        ap(f"javscribe_engine_batch_active {batch_active}")
        ap("# HELP javscribe_engine_batch_max 配置的最大批处理文件数。")
        ap("# TYPE javscribe_engine_batch_max gauge")
        try:
            maxb = int((getattr(e, "cfg", None) or {}).get("infer", {}).get("max_batch_size", 8))
        except (TypeError, ValueError, AttributeError):
            maxb = 8
        ap(f"javscribe_engine_batch_max {maxb}")
        ap("# HELP javscribe_model_loaded 当前是否有已加载的推理模型（1/0）。")
        ap("# TYPE javscribe_model_loaded gauge")
        ap(f"javscribe_model_loaded {1 if bool(getattr(e, 'model_loaded', False)) else 0}")
        aw = getattr(e, "active_workers", None)
        ap("# HELP javscribe_infer_active 当前在途转译任务数。")
        ap("# TYPE javscribe_infer_active gauge")
        ap(f"javscribe_infer_active {int(aw()) if callable(aw) else 0}")
        ap("# HELP javscribe_infer_concurrency 配置的转译并发度。")
        ap("# TYPE javscribe_infer_concurrency gauge")
        ap(f"javscribe_infer_concurrency {int(getattr(e, 'concurrency', 1) or 1)}")
        return "\n".join(L) + "\n"

    def _observe(self, dur: float) -> None:
        self._hist_count += 1
        self._hist_sum += dur
        # Prometheus bucket 为累计语义：le="X" 桶 = 观测值 <= X 的个数。
        # 找到首个 dur <= b 的桶，从该桶起（含 +Inf 末位）全部 +1。
        for i, b in enumerate(_BUCKETS):
            if dur <= b:
                for k in range(i, len(self._hist)):
                    self._hist[k] += 1
                return
        self._hist[-1] += 1



# ---------------------------------------------------------------------------
# LiveSampler：5s 采样 GPU 利用率/显存 + 调度状态（在途文件数），环形缓冲 1h。
# 供 GET /metrics/json（前端服务卡片迷你趋势图）。stdlib 零依赖：nvidia-smi
# 子进程轮询（每次 ~50ms，仅 GPU 机器存在该命令；CPU 机器 gpu=None，
# 前端退化为队列深度曲线）。
# ---------------------------------------------------------------------------


class LiveSampler:
    def __init__(self, engine: Any, interval_s: float = 5.0, maxlen: int = 720) -> None:
        self._engine = engine
        self._interval = max(1.0, float(interval_s))
        self._history: deque[dict[str, Any]] = deque(maxlen=max(10, int(maxlen)))
        self._lock = threading.Lock()
        self._started = time.time()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._nvidia = shutil.which("nvidia-smi")
        self._gpu_name: str | None = None
        self._last_mem_total: float | None = None

    # -- 生命周期 -------------------------------------------------------------
    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._loop, daemon=True, name="javscr-live")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None

    def _loop(self) -> None:
        self._tick()  # 立即首采（首个请求就有 1 个点）
        while not self._stop.wait(self._interval):
            try:
                self._tick()
            except Exception:  # noqa: BLE001 采样异常不得杀死监控线程
                pass

    # -- 采样 -----------------------------------------------------------------
    def _sample_gpu(self) -> dict[str, Any] | None:
        if not self._nvidia:
            return None
        try:
            out = subprocess.run(
                [self._nvidia,
                 "--query-gpu=name,utilization.gpu,memory.used,memory.total",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=3,
            )
            if out.returncode != 0:
                return None
            first = out.stdout.strip().splitlines()[0]
            name, util, used, total = (x.strip() for x in first.split(","))
            return {
                "name": name,
                "util_pct": float(util),
                "mem_used_mb": float(used),
                "mem_total_mb": float(total),
            }
        except Exception:  # noqa: BLE001 命令缺失/超时/解析失败 → 无 GPU 数据
            return None

    def _tick(self) -> None:
        gpu = self._sample_gpu()
        engine = self._engine
        running = queued = 0
        for j in list(getattr(engine, "jobs", []) or []):
            for t in j.files:
                st = t.status.value
                if st == "running":
                    running += 1
                elif st == "pending":
                    queued += 1
        if gpu is not None:
            self._gpu_name = gpu["name"]
            self._last_mem_total = gpu["mem_total_mb"]
        sample = {
            "ts": round(time.time(), 1),
            "gpu_util": gpu["util_pct"] if gpu else None,
            "gpu_mem_used_mb": gpu["mem_used_mb"] if gpu else None,
            "running": running,
            "queued": queued,
        }
        with self._lock:
            self._history.append(sample)

    # -- 快照 -----------------------------------------------------------------
    def snapshot(self, registry: "MetricsRegistry") -> dict[str, Any]:
        e = self._engine
        with self._lock:
            hist = list(self._history)
        last = hist[-1] if hist else None
        gpu: dict[str, Any] | None = None
        if last is not None and last.get("gpu_util") is not None:
            gpu = {
                "present": True,
                "name": self._gpu_name,
                "util_pct": last["gpu_util"],
                "mem_used_mb": last.get("gpu_mem_used_mb"),
                "mem_total_mb": self._last_mem_total,
            }
        elif self._nvidia:
            # 有 nvidia-smi 但尚无采样点（刚启动）：现取一次
            g = self._sample_gpu()
            if g:
                self._gpu_name = g["name"]
                self._last_mem_total = g["mem_total_mb"]
                gpu = {"present": True, **g}
        paused_jobs = sum(1 for j in list(getattr(e, "jobs", []) or []) if getattr(j, "paused", False))
        aw = getattr(e, "active_workers", None)
        return {
            "ok": True,
            "uptime_s": int(time.time() - self._started),
            "paused": bool(getattr(e, "paused", False)),
            "model_loaded": bool(getattr(e, "model_loaded", False)),
            "concurrency": int(getattr(e, "concurrency", 1) or 1),
            "active_workers": int(aw()) if callable(aw) else 0,
            "jobs": {
                "running": last["running"] if last else 0,
                "queued": last["queued"] if last else 0,
                "paused": paused_jobs,
                **registry.totals(),
            },
            "gpu": gpu,
            "history": hist,
        }

