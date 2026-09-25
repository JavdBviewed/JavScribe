"""Subtitle workbench HTTP API + static frontend."""
from __future__ import annotations

import asyncio
import copy
import itertools
import json
import logging
import os
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import __version__, localscan
from .audio import extract_audio_progress, probe_duration
from .config import EngineStore
from .engines.javscribe import JavScribeEngine
from .poller import Poller
from .srt_sanitizer import sanitize_srt_bytes
from .update_check import UpdateChecker

STATIC_DIR = Path(__file__).parent / "static"
_log = logging.getLogger("jav-scribe-web")
UPLOAD_MAX_GB = float(os.environ.get("JAV_UPLOAD_MAX_GB", "10"))
UPLOAD_TTL_S = 24 * 3600  # finished upload entries kept this long, then pruned
LOCAL_WB_MAX_FAILS = 6  # 回写连续失败 N 次（约 N*轮询间隔）后放弃并标记 failed
# 服务端任务表只留最近 200 条内存窗：本地在途任务远超此数时，早期任务会被挤出
# 任务表，字幕回写永远等不到终态（行永久卡「进行中」）。派发完成超此时长仍
# 查不到服务任务 → 判失败放行重新提交。
LOCAL_WB_JOB_GONE_S = 15 * 60

# ---- 客户端并发设置（本机工作台专属，不进 serve /config 白名单） ----
# extract_workers：本机同时跑 ffmpeg 提取音轨的数量（封顶 1..8）
# queue_cap：serve 串行转译；此项为「同时在途任务数上限」≈ 服务队列深度（封顶 1..16）
# 默认：env 可覆盖提取并发（JAV_LOCAL_EXTRACT_CONCURRENCY，部署期设定）；
# 界面保存的 client_config.json 优先于 env 默认。
ENV_EXTRACT_CONCURRENCY = max(1, min(8, int(os.environ.get("JAV_LOCAL_EXTRACT_CONCURRENCY", "2"))))
CLIENT_CONFIG_NAME = "client_config.json"
CLIENT_CONFIG_DEFAULTS = {"extract_workers": ENV_EXTRACT_CONCURRENCY, "queue_cap": 4, "pipeline_paused": False}
CLIENT_CONFIG_LIMITS = {"extract_workers": (1, 8), "queue_cap": (1, 16)}


def _load_client_config(path: Path) -> dict:
    """读客户端并发设置；文件缺失/损坏回落默认（值按预置封顶 clamp）。"""
    cfg = dict(CLIENT_CONFIG_DEFAULTS)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return cfg
    if isinstance(raw, dict):
        for k, (lo, hi) in CLIENT_CONFIG_LIMITS.items():
            v = raw.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                cfg[k] = max(lo, min(hi, int(v)))
        v = raw.get("pipeline_paused")
        if isinstance(v, bool):
            cfg["pipeline_paused"] = v
    return cfg


class _Limiter:
    """可 resize 的异步并发闸（asyncio.Semaphore 建成后无法改限）。

    set_limit 立即生效：调小不中断已持有者、新获取者等待；调大唤醒等待者。
    """

    def __init__(self, limit: int) -> None:
        self._limit = max(1, int(limit))
        self._active = 0
        self._cv = asyncio.Condition()

    @property
    def limit(self) -> int:
        return self._limit

    def set_limit(self, limit: int) -> None:
        limit = max(1, int(limit))
        if limit == self._limit:
            return
        self._limit = limit
        try:
            asyncio.get_running_loop().create_task(self._wake())
        except RuntimeError:
            pass  # 无运行中的事件循环（启动期）：无等待者可唤醒

    async def _wake(self) -> None:
        async with self._cv:
            self._cv.notify_all()

    async def __aenter__(self) -> "_Limiter":
        async with self._cv:
            # asyncio.Condition.wait() 无谓词参数（与 threading 不同）：手动轮询条件
            while self._active >= self._limit:
                await self._cv.wait()
            self._active += 1
        return self

    async def __aexit__(self, *exc: object) -> bool:
        async with self._cv:
            self._active -= 1
            self._cv.notify_all()
        return False


class _Gate:
    """在途任务封顶：按 task id 持槽，字幕回写终态才释放。

    serve 逐条串行转译，客户端在途数 ≈ 服务队列深度：封顶队列深度 →
    保护 serve 内存/磁盘，也压缩「服务重启丢队列」的风险面。

    公平性（v0.2.13）：多服务同时排队时，空槽优先给在途（held）最少的
    等待服务，同服务内 FIFO——防止一个服务的长队列独占全部槽位、
    让另一个服务 GPU 全程空转（如 127 的 87 条先跑完、158 的 88 条干等）。
    """

    def __init__(self, limit: int) -> None:
        self._limit = max(1, int(limit))
        self._held: dict[str, str] = {}  # task_id -> 服务名
        self._waiters: dict[str, set[str]] = {}  # 服务名 -> 等待中的 task_id
        self._cv = asyncio.Condition()

    @property
    def limit(self) -> int:
        return self._limit

    def set_limit(self, limit: int) -> None:
        limit = max(1, int(limit))
        if limit == self._limit:
            return
        self._limit = limit
        try:
            asyncio.get_running_loop().create_task(self._wake())
        except RuntimeError:
            pass

    async def _wake(self) -> None:
        async with self._cv:
            self._cv.notify_all()

    def held_count(self) -> int:
        return len(self._held)

    def _load(self, engine: str) -> int:
        return sum(1 for e in self._held.values() if e == engine)

    def _min_waiter_load(self) -> int:
        loads = [self._load(e) for e in self._waiters if self._waiters[e]]
        return min(loads) if loads else 0

    def rehold(self, task_id: str, engine: str = "") -> None:
        """工作台重启恢复在途任务时认领槽位（启动期同步调用，尚无等待者）。"""
        self._held[task_id] = engine

    async def acquire(self, task_id: str, get_engine) -> None:
        """get_engine 每次唤醒重读：排队期间任务被「改派」时，等待登记与公平
        判定立即跟随新服务组（实时改道，无需重提交）。"""
        async with self._cv:
            if task_id in self._held:
                return
            self._waiters.setdefault(get_engine(), set()).add(task_id)
        try:
            # 批量恢复场景：让并发等待者先完成登记，再做公平判定——否则恢复瞬间
            # 的空槽会被登记最早的长队列服务在「独自判定」时抢先吃掉
            await asyncio.sleep(0)
            async with self._cv:
                # asyncio.Condition.wait() 无谓词参数（与 threading 不同）：手动轮询条件。
                # 有空槽且本服务在途数不超过等待服务中最少者 → 让位更轻的、取槽
                while True:
                    engine = get_engine()
                    if task_id not in self._waiters.get(engine, ()):
                        # 改派生效：等待登记迁移到新服务组
                        for s in self._waiters.values():
                            s.discard(task_id)
                        self._waiters.setdefault(engine, set()).add(task_id)
                    if (
                        len(self._held) < self._limit
                        and self._load(engine) <= self._min_waiter_load()
                    ):
                        self._held[task_id] = engine
                        break
                    await self._cv.wait()
        finally:
            for s in list(self._waiters.values()):
                s.discard(task_id)

    def release(self, task_id: str) -> None:
        if task_id not in self._held:
            return
        self._held.pop(task_id, None)
        try:
            asyncio.get_running_loop().create_task(self._wake())
        except RuntimeError:
            pass
SRT_EXTS = {".srt", ".subrip", ".vtt", ".ass", ".ssa"}  # 预览只允许字幕扩展名
SRT_MAX_MB = 2.0  # 预览大小上限（正常 srt 远小于此）


def _job_rows(
    engine: str,
    job: dict,
    local_writeback: dict[str, str] | None = None,
    local_sub_status: dict[str, str] | None = None,
) -> list[dict]:
    """Flatten one job into dashboard rows (one per file when detailed).

    local_writeback: job_id -> 本地扫描任务的回写状态（工作台本机回写专用）。
    local_sub_status: job_id -> 提交前检测到的字幕状态（external/embedded/named，
    制作图「已有字幕」提示用；仅本地扫描任务有）。
    """
    base = {
        "engine": engine,
        "job_id": job.get("id"),
        "label": job.get("label") or "",
        "state": job.get("state"),
        "created": job.get("created"),
        "finished": job.get("finished"),
        "source_kind": job.get("source_kind"),
        "sub_status": (local_sub_status or {}).get(job.get("id") or ""),
        "paused": bool(job.get("paused", False)),  # serve 单任务挂起（0.2.3+）
    }
    files = job.get("files")
    if not files:
        total = job.get("total") or 0
        done = job.get("done") or 0
        finished = job.get("state") == "finished"
        return [
            {
                **base,
                "writeback": (local_writeback or {}).get(job.get("id") or ""),
                "file": job.get("label") or str(job.get("id")),
                "status": "done" if finished else "running",
                "progress": (done / total) if total else (1.0 if finished else 0.0),
                "position": "",
                "duration_s": None,
                "position_s": None,
                "phase_detail": "",
                "eta_s": None,
                "message": f"{done}/{total}",
                "output_files": [],
            }
        ]
    rows = []
    for t in files:
        rows.append(
            {
                **base,
                "writeback": (local_writeback or {}).get(job.get("id") or ""),
                "file": t.get("name") or "",
                "status": t.get("status"),
                "phase": t.get("phase"),
                "progress": t.get("progress") or 0.0,
                "position": t.get("position") or "",
                "duration_s": t.get("duration_s"),
                "position_s": t.get("position_s"),
                "phase_detail": t.get("phase_detail") or "",
                "eta_s": t.get("eta_s"),
                "message": t.get("message") or "",
                "finished": t.get("finished"),
                "output_files": t.get("output_files") or [],
            }
        )
    return rows


# -- 字幕生成流水线（上传 → 本地提取音频 → 转发服务）----------------------------------

@dataclass
class UploadTask:
    """One subtitle-generation pipeline run; phases: extracting -> dispatching -> done/error."""

    id: str
    engine: str
    name: str
    size_mb: float
    phase: str = "extracting"
    progress: float = 0.0
    created: float = field(default_factory=time.time)
    finished: float | None = None
    audio_mb: float | None = None
    job_id: str | None = None
    error: str | None = None
    cached: bool = False  # 服务端命中内容缓存（免上传）
    # 「扫描目录」任务专用：视频在工作台部署机上的实际可读路径；完成后字幕
    # 由工作台自动写回该路径旁（浏览器上传任务无此字段，写回由浏览器端做）。
    local_path: str | None = None
    # 提交前（扫描时）检测到的字幕状态：external / embedded / named；制作图提示用
    sub_status: str | None = None
    writeback: str | None = None  # None=不适用 / pending / ok / skipped_exists / skipped / failed:…
    wb_fails: int = 0  # 回写连续失败计数（内部，不外发）
    # 用户主动暂停（区别于重启中断的 paused）：恢复时前端据此展示「继续」
    task_paused: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "engine": self.engine,
            "name": self.name,
            "size_mb": self.size_mb,
            "phase": self.phase,
            "progress": round(self.progress, 4),
            "created": self.created,
            "finished": self.finished,
            "audio_mb": self.audio_mb,
            "job_id": self.job_id,
            "error": self.error,
            "cached": self.cached,
            "local_path": self.local_path,
            "sub_status": self.sub_status,
            "writeback": self.writeback,
            "task_paused": self.task_paused,
        }


def build_app(store: EngineStore, poller: Poller, updater: UpdateChecker | None = None, lifespan=None,
            data_dir: str | os.PathLike = "/data") -> FastAPI:
    app = FastAPI(title="JavScribe-Web", version=__version__, lifespan=lifespan)

    @app.middleware("http")
    async def _no_cache_frontend(request: Request, call_next):
        # 前端页面/脚本/样式强制每次校验（no-cache=带 ETag 回源校验，304 很轻），
        # 避免浏览器启发式缓存导致「已部署但看不到更新」
        resp = await call_next(request)
        p = request.url.path
        if p == "/" or p.endswith((".html", ".js", ".css", ".png")):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    _uploads: dict[str, UploadTask] = {}
    _upload_locks: dict[str, asyncio.Lock] = {}
    # 本地管线状态落盘（<data_dir>/uploads.json）：_uploads/_local_wb 是内存态，
    # 工作台重启/重部署即丢——不持久化的话，已在 serve 排队的「扫描目录」任务
    # 会失去字幕回写跟踪（字幕不再自动落回本机影片旁），提取阶段失败行也消失。
    # 重启恢复语义：
    #   - 已拿到 job_id 且回写未完成 → 继续回写跟踪；
    #   - 提取/派发中途中断（无 job_id）→ 标记失败并显示行，用户可重新提交；
    #   - 服务已删除 → 丢弃。
    _state_path = Path(data_dir) / "uploads.json"

    def _save_uploads_state() -> None:
        try:
            payload = {"uploads": [t.to_dict() for t in _uploads.values()]}
            tmp = _state_path.with_name(_state_path.name + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            tmp.replace(_state_path)
        except OSError:
            pass  # 状态落盘失败不阻塞主管线

    def _load_uploads_state() -> None:
        try:
            raw = json.loads(_state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        entries = raw.get("uploads") if isinstance(raw, dict) else None
        if not isinstance(entries, list):
            return
        now = time.time()
        for e in entries:
            if not isinstance(e, dict) or not e.get("id"):
                continue
            try:
                t = UploadTask(
                    id=str(e["id"]),
                    engine=str(e.get("engine") or ""),
                    name=str(e.get("name") or ""),
                    size_mb=float(e.get("size_mb") or 0.0),
                    phase=str(e.get("phase") or "extracting"),
                    progress=float(e.get("progress") or 0.0),
                    created=float(e.get("created") or now),
                    finished=float(e["finished"]) if e.get("finished") is not None else None,
                    audio_mb=float(e["audio_mb"]) if e.get("audio_mb") is not None else None,
                    job_id=str(e["job_id"]) if e.get("job_id") else None,
                    error=e.get("error"),
                    cached=bool(e.get("cached")),
                    local_path=e.get("local_path"),
                    sub_status=e.get("sub_status"),
                    writeback=e.get("writeback"),
                    task_paused=bool(e.get("task_paused")),
                )
            except (TypeError, ValueError):
                continue
            if store.get(t.engine) is None:
                continue  # 服务已删除：无轮询目标，行会永远滞留
            if not t.job_id:
                # 重启中断（含暂停中）：标「已暂停」而非失败——点「继续」即可
                # 重新提取音轨并提交（视频在本机，不丢任务）
                t.phase = "paused"
                t.error = "工作台重启中断（点「继续」恢复：重新提取音轨并提交）"
                t.finished = None
            _uploads[t.id] = t
            if t.local_path and t.job_id and not t.writeback:
                _local_wb[t.id] = t
                _gate.rehold(t.id, t.engine)  # 重启恢复的在途任务继续占服务队列槽
        _prune_uploads()

    def _lock_for(engine_name: str) -> asyncio.Lock:
        return _upload_locks.setdefault(engine_name, asyncio.Lock())

    # ---- 多服务自动负载均衡（v0.2.11+）--------------------------------------
    # engine=auto：派发时刻按「在线 + 参与均衡」里在途任务最少者选服务；
    # 同负载按注册顺序轮转（round-robin），避免总是砸向同名排序靠前者。
    AUTO = "auto"
    _rr = itertools.count()

    def _auto_candidates() -> list[tuple[int, str]]:
        """候选 = 在线且参与均衡的服务；负载 = 服务端在途任务数 + 本机已承诺给
        该服务的在途槽（提取完待派发/等回写），比只看 serve 快照更贴近真实排队。"""
        out: list[tuple[int, str]] = []
        for entry in store.engines:
            if not entry.get("enabled", True):
                continue
            info = poller.engines.get(entry["name"])
            if info is None or not info.online:
                continue
            base = max(0, info.jobs_running)
            local = sum(1 for e in _gate._held.values() if e == entry["name"])
            out.append((base + local, entry["name"]))
        return out

    def pick_engine() -> str:
        """从候选服务里挑在途任务最少的一个；无候选抛 503。"""
        cands = _auto_candidates()
        if not cands:
            raise HTTPException(503, "没有可分配的服务（全部离线或未参与均衡）")
        cands.sort()
        min_load = cands[0][0]
        group = [n for load, n in cands if load == min_load]
        return group[next(_rr) % len(group)]

    def resolve_engine(engine: str) -> str:
        """endpoint 入口校验：auto → 候选存在性检查（全离线直接 503，避免 202 后
        后台派发才失败）；显式名 → 存在性检查。"""
        if engine == AUTO:
            if not store.engines:
                raise HTTPException(404, "请先添加字幕服务")
            if not _auto_candidates():
                raise HTTPException(503, "没有可分配的服务（全部离线或未参与均衡）")
            return AUTO
        if store.get(engine) is None:
            raise HTTPException(404, "服务不存在")
        return engine


    # 客户端并发设置（设置弹窗「客户端（本机工作台）」卡片可调，立即生效）：
    # 提取并发闸 + 在途封顶门，替代原固定 Semaphore（部署期只能 env 配）
    _client_cfg_path = Path(data_dir) / CLIENT_CONFIG_NAME
    _client_cfg = _load_client_config(_client_cfg_path)
    _local_limiter = _Limiter(_client_cfg["extract_workers"])
    _gate = _Gate(_client_cfg["queue_cap"])
    # 全局暂停闸：set()=未暂停。暂停时新任务停在闸前（不占槽、不提取），
    # 运行中任务跑完；重启后状态随 client_config.json 恢复
    _pause_evt = asyncio.Event()
    if not _client_cfg["pipeline_paused"]:
        _pause_evt.set()

    def _set_pipeline_paused(want: bool) -> bool:
        if bool(_client_cfg.get("pipeline_paused")) == want:
            return False
        _client_cfg["pipeline_paused"] = want
        _save_client_config()
        if want:
            _pause_evt.clear()
        else:
            _pause_evt.set()
        return True

    def _save_client_config() -> None:
        try:
            tmp = _client_cfg_path.with_name(_client_cfg_path.name + ".tmp")
            tmp.write_text(json.dumps(_client_cfg, ensure_ascii=False), encoding="utf-8")
            tmp.replace(_client_cfg_path)
        except OSError:
            pass  # 落盘失败不阻塞主管线（内存值仍生效）

    def _prune_uploads() -> None:
        cutoff = time.time() - UPLOAD_TTL_S
        stale = [k for k, t in _uploads.items() if (t.finished or 0) and t.finished < cutoff]
        for k in stale:
            _uploads.pop(k, None)
            # 泄漏兜底：回写表里还挂着 TTL 外任务（服务任务早被挤出 200 窗）→
            # 一并移除并释放在途槽，防止槽位被永久占用
            if k in _local_wb:
                _local_wb.pop(k, None)
                _gate.release(k)

    @app.get("/api/health")
    async def api_health() -> dict:
        infos = list(poller.engines.values())
        return {
            "ok": True,
            "app": "JavScribe-Web",
            "version": __version__,
            "engines": len(infos),
            "online": sum(1 for i in infos if i.online),
        }

    @app.get("/api/update")
    async def api_update() -> dict:
        # 版本对比 + 更新引导（桌面端另有 electron-updater 真自动更新，见 client/desktop/main.ts）
        if updater is None:
            return {"enabled": False, "current": __version__, "has_update": False}
        versions = [i.version for i in poller.engines.values() if i.version]
        return updater.snapshot(versions)

    @app.get("/api/engines")
    async def api_list_engines() -> list[dict]:
        out = []
        for info in sorted(poller.engines.values(), key=lambda e: e.name):
            d = info.to_dict()
            d["enabled"] = (store.get(info.name) or {}).get("enabled", True)
            out.append(d)
        return out

    @app.post("/api/engines", status_code=201)
    async def api_add_engine(body: dict) -> dict:
        entry = store.add(
            str(body.get("name", "")),
            str(body.get("url", "")),
            body.get("api_key", ""),
        )
        if entry is None:
            raise HTTPException(400, "name/url 无效，或该名称已指向其它地址")
        return {"ok": True, "name": entry["name"], "url": entry["url"], "has_key": bool(entry["api_key"])}

    @app.put("/api/engines/{name}")
    async def api_update_engine(name: str, body: dict) -> dict:
        body = body or {}
        entry = None
        if "api_key" in body:
            entry = store.set_api_key(name, str(body.get("api_key", "")))
        if "enabled" in body:
            entry = store.set_enabled(name, bool(body.get("enabled"))) or entry
        if entry is None:
            raise HTTPException(404, "服务不存在")
        return {
            "ok": True,
            "name": entry["name"],
            "has_key": bool(entry["api_key"]),
            "enabled": entry.get("enabled", True),
        }

    @app.delete("/api/engines/{name}")
    async def api_remove_engine(name: str) -> dict:
        if not store.remove(name):
            raise HTTPException(404, "服务不存在")
        return {"ok": True}

    @app.get("/api/jobs")
    async def api_list_jobs() -> list[dict]:
        rows: list[dict] = []
        # 本地扫描任务回写状态索引：job_id -> writeback
        wb_index: dict[str, str] = {}
        # 提交前检测到的字幕状态索引：job_id -> external/embedded/named（制作图提示）
        sub_index: dict[str, str] = {}
        for t in _uploads.values():
            if t.job_id and t.local_path and t.writeback:
                wb_index[t.job_id] = t.writeback
            if t.job_id and t.sub_status:
                sub_index[t.job_id] = t.sub_status
        for name, details in poller.jobs.items():
            for job in details:
                rows.extend(_job_rows(name, job, wb_index, sub_index))
        # 本机上传管线在「服务端任务出现之前」的阶段（提取音轨 / 派发 / 失败）
        # 也渲染成任务行——否则提交后任务表空白，用户会以为没提交成功而重复提交。
        live_job_ids = {
            job.get("id") for details in poller.jobs.values() for job in details
        }
        now = time.time()
        for t in _uploads.values():
            if t.phase not in ("queued", "extracting", "dispatching", "error", "paused"):
                continue
            if t.phase == "error" and t.finished and now - t.finished > UPLOAD_TTL_S:
                continue
            if t.job_id and t.job_id in live_job_ids:
                continue  # 服务端任务行已出现，避免双行
            rows.append(
                {
                    "engine": t.engine,
                    "job_id": t.job_id or "",
                    "task_id": t.id,
                    "local_path": t.local_path,
                    "label": t.name,
                    "state": "error" if t.phase == "error" else (
                        "paused" if t.phase == "paused" else "running"),
                    "created": t.created,
                    "finished": t.finished,
                    "source_kind": "upload",
                    "sub_status": t.sub_status,
                    "writeback": None,
                    "file": t.name,
                    "status": "error" if t.phase == "error" else (
                        "paused" if t.phase == "paused" else "running"),
                    "phase": t.phase,
                    "progress": t.progress,
                    "position": "",
                    "duration_s": None,
                    "position_s": None,
                    "phase_detail": {
                        "queued": "排队中（等待转译并发位）",
                        "extracting": "提取音轨（本机）",
                        "dispatching": "派发到服务",
                        "paused": "已暂停（等待继续）",
                    }.get(t.phase, ""),
                    "eta_s": None,
                    "message": t.error or "",
                    "output_files": [],
                }
            )
        rows.sort(
            key=lambda r: (
                0 if r["status"] == "running" else 1,
                -(r.get("created") or 0),
            )
        )
        return rows

    @app.get("/api/jobs/summary")
    async def api_jobs_summary() -> dict:
        """看板统计（单一真源聚合）：进行中=当前在途行数；完成/跳过/失败=
        serve 累计终态计数（独立于 200 内存窗，大批量任务不再少算）。

        老 serve（/health 无 stats 字段）退回现行行计数，保持兼容。
        """
        running = done = skipped = failed = 0
        for name, info in poller.engines.items():
            has_stats = bool(info.stats)
            if has_stats:
                done += int(info.stats.get("done", 0) or 0)
                skipped += int(info.stats.get("skipped", 0) or 0)
                failed += int(info.stats.get("failed", 0) or 0)
            for job in poller.jobs.get(name, []):
                files = job.get("files")
                if files:
                    statuses = [t.get("status") for t in files]
                else:
                    statuses = ["done" if job.get("state") == "finished" else "running"]
                for st in statuses:
                    if st in ("running", "pending"):
                        running += 1
                    elif not has_stats:
                        # 老 serve 回退：终态也按行计数
                        if st == "done":
                            done += 1
                        elif st == "skipped":
                            skipped += 1
                        elif st in ("error", "canceled"):
                            failed += 1
        # 本机在途管线行（排队/提取/派发）计入进行中；终态唯一真源是 serve
        # 累计 stats（含老 serve 的行计数回退），本地不再按 writeback 重复计。
        # 仅「无 job_id 的本机管线失败」（提取/派发/内部错误/重启中断，
        # serve 无记录）计入失败，避免与 serve stats 双重计数。
        paused_local = 0
        for t in _uploads.values():
            if t.phase in ("queued", "extracting", "dispatching"):
                running += 1
            elif t.phase == "paused":
                paused_local += 1
            elif t.phase == "error" and t.job_id is None:
                failed += 1
        return {
            "running": running,
            "done": done,
            "skipped": skipped,
            "failed": failed,
            "paused": paused_local,
            "paused_all": bool(_client_cfg["pipeline_paused"]),
            "engines_paused": {n: bool(i.paused) for n, i in poller.engines.items()},
        }

    # -- 客户端并发设置（本机工作台；不进 serve /config 白名单） -------------------
    @app.get("/api/client-config")
    async def api_client_config_get() -> dict:
        return {"ok": True, "config": dict(_client_cfg), "limits": CLIENT_CONFIG_LIMITS}

    @app.put("/api/client-config")
    async def api_client_config_put(body: dict) -> dict:
        if not isinstance(body, dict):
            raise HTTPException(400, "body 需要是 JSON 对象")
        changed = False
        for k, (lo, hi) in CLIENT_CONFIG_LIMITS.items():
            if k not in body:
                continue
            v = body.get(k)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise HTTPException(400, f"{k} 需要整数")
            v = int(v)
            if not (lo <= v <= hi):
                raise HTTPException(400, f"{k} 需在 {lo} ~ {hi} 之间")
            if v != _client_cfg.get(k):
                _client_cfg[k] = v
                if k == "extract_workers":
                    _local_limiter.set_limit(v)
                else:
                    _gate.set_limit(v)
                changed = True
        if changed:
            _save_client_config()
        return {"ok": True, "config": dict(_client_cfg)}

    # -- 全局暂停 / 继续（本机管线 + 所有在线服务队列） -------------------------
    @app.post("/api/pause")
    async def api_pause(body: dict) -> dict:
        """body {paused: bool}。本机管线立即生效（持久化，重启不丢）；
        同时代理所有在线服务的 serve 队列暂停/继续（serve 0.2.3+，
        旧镜像 404 → 该引擎标记不支持，不阻塞整体）。"""
        want = bool((body or {}).get("paused"))
        _set_pipeline_paused(want)
        engines_out: list[dict] = []
        for name, info in sorted(poller.engines.items(), key=lambda kv: kv[0]):
            if not info.online or store.get(name) is None:
                engines_out.append({"engine": name, "ok": False, "error": "服务离线"})
                continue
            entry = store.get(name)
            eng = JavScribeEngine(name, entry["url"])
            try:
                res = await (eng.pause_queue() if want else eng.resume_queue())
                engines_out.append({"engine": name, "ok": True,
                                    "paused": bool(res.get("paused"))})
            except httpx.HTTPStatusError as ex:
                if ex.response.status_code == 404:
                    engines_out.append({"engine": name, "ok": False,
                                        "error": "服务版本过旧，不支持队列暂停"})
                else:
                    engines_out.append({"engine": name, "ok": False,
                                        "error": f"服务请求失败: HTTP {ex.response.status_code}"})
            except httpx.HTTPError as ex:
                engines_out.append({"engine": name, "ok": False, "error": f"服务不可达: {ex}"})
            finally:
                await eng.close()
        return {"ok": True, "paused": bool(_client_cfg["pipeline_paused"]),
                "engines": engines_out}

    # -- 生成字幕：浏览器上传 → 本地提取音频 → 转发服务（2 段式，进度可查）-----------

    async def _pause_gate_wait(task: UploadTask, resume_phase: str) -> None:
        """全局暂停闸：暂停期间停留（不占槽、不提取）；恢复后进入 resume_phase。"""
        while _client_cfg.get("pipeline_paused"):
            task.phase = "paused"
            await _pause_evt.wait()
        task.phase = resume_phase

    async def _dispatch_task(task: UploadTask, audio_tmp: Path) -> None:
        """把已提取好的 opus 转发给所选服务（两路上传共用）。"""
        if task.engine == AUTO:
            # 派发时刻才解析：此时 poller 负载快照最新（提取耗时数分钟，入队时的
            # 选择早已过期）；解析后持久化，任务跟踪/回写按真实服务走。
            # 入队后服务全离线 → 标错误行（可重试），不让 503 裸奔到后台任务
            try:
                task.engine = pick_engine()
            except HTTPException as ex:
                task.phase = "error"
                task.error = str(ex.detail)
                return
            _save_uploads_state()
        entry = store.get(task.engine)
        assert entry is not None
        task.phase = "dispatching"
        eng = JavScribeEngine(task.engine, entry["url"])
        try:
            async with _lock_for(task.engine):
                res = await eng.upload_audio(
                    audio_tmp.read_bytes(), task.name or "remote"
                )
                task.job_id = res["job_id"]
                task.cached = bool(res.get("cached"))
        except Exception as ex:
            task.phase = "error"
            task.error = f"服务拒绝任务: {ex}"
            return
        finally:
            await eng.close()
        task.phase = "done"
        task.progress = 1.0

    async def _run_upload(task: UploadTask, video_tmp: Path) -> None:
        audio_tmp = video_tmp.with_suffix(".opus")
        try:
            try:
                await _pause_gate_wait(task, "extracting")
                size = await extract_audio_progress(
                    video_tmp,
                    audio_tmp,
                    on_progress=lambda frac: setattr(task, "progress", frac),
                )
                task.audio_mb = round(size / 1048576, 1)
            except Exception as ex:
                task.phase = "error"
                task.error = f"提取音频失败: {ex}"
                return
            await _dispatch_task(task, audio_tmp)
        finally:
            task.finished = time.time()
            video_tmp.unlink(missing_ok=True)
            audio_tmp.unlink(missing_ok=True)

    async def _run_audio(task: UploadTask, audio_tmp: Path) -> None:
        try:
            await _dispatch_task(task, audio_tmp)
        finally:
            task.finished = time.time()
            audio_tmp.unlink(missing_ok=True)

    _local_wb: dict[str, UploadTask] = {}  # upload_id -> task（本地扫描且已拿到 job_id）
    _run_tasks: dict[str, asyncio.Task] = {}  # task.id -> 在跑的管线协程（暂停时 cancel）

    def _spawn_local(task: UploadTask, video_path: Path) -> None:
        '''启动本机管线并登记协程（暂停需要 cancel 到具体协程）；结束自动清表。'''
        rt = asyncio.get_running_loop().create_task(_run_local(task, video_path))
        _run_tasks[task.id] = rt

        def _cleanup(_rt: asyncio.Task) -> None:
            if _run_tasks.get(task.id) is _rt:
                _run_tasks.pop(task.id, None)

        rt.add_done_callback(_cleanup)

    async def _run_local(task: UploadTask, video_path: Path) -> None:
        """本地扫描管线：直接读工作台机器上的视频（不复制、不出本机），
        提取 opus 后派发给所选服务；完成后由 _local_writeback_tick 写回字幕。

        并发约束：先拿「在途槽」（转译并发=服务队列上限），超额的排队等待；
        音轨提取受 extract_workers 闸限制（本机 ffmpeg 并发）。
        """
        fd, fname = tempfile.mkstemp(suffix=".opus", prefix="javweb_loc_")
        audio_tmp = Path(fname)
        os.close(fd)
        task.phase = "queued"
        try:
            await _pause_gate_wait(task, "queued")
            await _gate.acquire(task.id, lambda: task.engine)
            try:
                async with _local_limiter:
                    task.phase = "extracting"  # 拿到槽后进入提取阶段（行状态区分排队/提取）
                    try:
                        size = await extract_audio_progress(
                            video_path,
                            audio_tmp,
                            on_progress=lambda frac: setattr(task, "progress", frac),
                        )
                        task.audio_mb = round(size / 1048576, 1)
                    except Exception as ex:
                        task.phase = "error"
                        task.error = f"提取音频失败: {ex}"
                        return
                await _dispatch_task(task, audio_tmp)
                if task.job_id:
                    _local_wb[task.id] = task
                    # 槽位继续持有，直到回写终态（_local_writeback_tick 统一释放）
            finally:
                if not task.job_id:
                    # 无 job_id 的终态路径（提取失败/派发被拒）：立即释放在途槽
                    _gate.release(task.id)
                task.finished = time.time()
                audio_tmp.unlink(missing_ok=True)
        except asyncio.CancelledError:
            # 用户暂停（单任务/批量暂停）：
            #  - 已拿到 job_id：服务侧任务不受影响，按正常在途收尾（保留回写跟踪）
            #  - 未拿到：停「已暂停」，释放可能占用的在途槽，点「继续」重提取重提交
            if task.job_id:
                task.phase = "done"
                task.progress = 1.0
                task.error = None
                _local_wb[task.id] = task
            else:
                _gate.release(task.id)
                task.phase = "paused"
                task.task_paused = True
                task.error = "用户暂停（点「继续」重新提取音轨并提交）"
                task.progress = 0.0
                task.finished = None
            _save_uploads_state()
            return  # 吞掉 CancelledError：以明确终态收尾，不再向上传播
        except BaseException:
            # 预期外异常兜底：未拿到 job_id 就释放槽，防止槽位泄漏；
            # 显式标 error，避免任务行永久卡在「排队中」
            if not task.job_id:
                _gate.release(task.id)
                task.phase = "error"
                task.error = task.error or "内部错误（任务中断，可重新提交）"
                task.finished = task.finished or time.time()
                _save_uploads_state()
            raise

    @app.post("/api/upload", status_code=202)
    async def api_upload(file: UploadFile = File(...), engine: str = Form(...)) -> dict:
        resolve_engine(engine)
        _prune_uploads()
        max_bytes = int(UPLOAD_MAX_GB * 1024**3)
        fd, name = tempfile.mkstemp(
            suffix=Path(file.filename or "").suffix or ".bin", prefix="javweb_up_"
        )
        tmp = Path(name)
        os.close(fd)
        received = 0
        try:
            with open(tmp, "wb") as fh:
                while chunk := await file.read(4 * 1024 * 1024):
                    received += len(chunk)
                    if received > max_bytes:
                        raise HTTPException(413, f"file too large (max {UPLOAD_MAX_GB:g}GB)")
                    fh.write(chunk)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        task = UploadTask(
            id=uuid.uuid4().hex[:8],
            engine=engine,
            name=file.filename or "remote",
            size_mb=round(received / 1048576, 1),
        )
        _uploads[task.id] = task
        _save_uploads_state()
        asyncio.create_task(_run_upload(task, tmp))
        return {
            "ok": True,
            "upload_id": task.id,
            "engine": engine,
            "name": task.name,
            "size_mb": task.size_mb,
            "duration_s": round(probe_duration(tmp), 1),
        }

    @app.post("/api/upload-audio", status_code=202)
    async def api_upload_audio(
        audio: UploadFile = File(...),
        engine: str = Form(...),
        name: str = Form("remote"),
        size_mb: float = Form(0),
        duration_s: float = Form(0),
    ) -> dict:
        """浏览器本地提音轨后只传 opus：跳过服务端提取，直接派发服务。"""
        resolve_engine(engine)
        _prune_uploads()
        max_bytes = int(UPLOAD_MAX_GB * 1024**3)
        fd, fname = tempfile.mkstemp(suffix=".opus", prefix="javweb_aud_")
        tmp = Path(fname)
        os.close(fd)
        received = 0
        try:
            with open(tmp, "wb") as fh:
                while chunk := await audio.read(4 * 1024 * 1024):
                    received += len(chunk)
                    if received > max_bytes:
                        raise HTTPException(413, f"file too large (max {UPLOAD_MAX_GB:g}GB)")
                    fh.write(chunk)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        task = UploadTask(
            id=uuid.uuid4().hex[:8],
            engine=engine,
            name=name or "remote",
            size_mb=size_mb or round(received / 1048576, 1),
            phase="dispatching",
            audio_mb=round(received / 1048576, 1),
        )
        _uploads[task.id] = task
        _save_uploads_state()
        asyncio.create_task(_run_audio(task, tmp))
        return {
            "ok": True,
            "upload_id": task.id,
            "engine": engine,
            "name": task.name,
            "size_mb": task.size_mb,
            "duration_s": round(duration_s, 1),
        }

    @app.get("/api/uploads/{upload_id}")
    async def api_upload_status(upload_id: str) -> dict:
        task = _uploads.get(upload_id)
        if task is None:
            raise HTTPException(404, "upload not found (已过期或 id 无效)")
        return task.to_dict()

    # -- srt 下载（代理服务 /result）-------------------------------------------

    @app.get("/api/jobs/{engine}/{job_id}/result")
    async def api_result(engine: str, job_id: str) -> Response:
        entry = store.get(engine)
        if entry is None:
            raise HTTPException(404, "engine not found")
        eng = JavScribeEngine(engine, entry["url"])
        try:
            data, suggested = await eng.result(job_id)
        except httpx.HTTPStatusError as ex:
            if ex.response.status_code == 404:
                raise HTTPException(404, "no result yet (任务未完成或无输出)")
            raise HTTPException(502, f"服务请求失败: HTTP {ex.response.status_code}")
        except httpx.HTTPError as ex:
            raise HTTPException(502, f"服务不可达: {ex}")
        finally:
            await eng.close()
        # 防御兜底：服务引擎偶发产出负时间戳 srt（见 srt_sanitizer 注释），
        # 下载代理处统一清洗，保证用户拿到的文件合法。
        data, _fixed = sanitize_srt_bytes(data, log=_log.warning)
        # 文件名：新服务直接透传服务端 Content-Disposition（源视频名）；
        # 旧服务无该头 → suggested 为 {job_id}.srt，退回 label 推导。
        if suggested and suggested != f"{job_id}.srt":
            filename = suggested
        else:
            label = next(
                (j.get("label", "") for j in poller.jobs.get(engine, []) if j.get("id") == job_id),
                "",
            )
            # label 须为真实视频名（带扩展名）：裸 "remote" 等占位值退回任务 id
            lab = Path(label).name if label else ""
            stem = Path(lab).stem if lab and Path(lab).suffix else Path(suggested).stem
            filename = f"{stem}.zh.srt"
        if filename.isascii():
            cd = f'attachment; filename="{filename}"'
        else:
            cd = f"attachment; filename*=UTF-8''{quote(filename)}"
        return Response(
            content=data,
            media_type="application/x-subrip",
            headers={"Content-Disposition": cd},
        )

    # -- 跳过任务「仍要重新生成」(代理服务 POST /jobs/<id>/retry) --------------
    # 成功 201（新建了一个任务，与 serve 契约一致）；4xx/5xx 由 HTTPException 覆盖

    @app.post("/api/jobs/{engine}/{job_id}/retry", status_code=201)
    async def api_retry(engine: str, job_id: str) -> dict:
        entry = store.get(engine)
        if entry is None:
            raise HTTPException(404, "engine not found")
        eng = JavScribeEngine(engine, entry["url"])
        try:
            return await eng.retry(job_id)
        except httpx.HTTPStatusError as ex:
            if ex.response.status_code == 404:
                raise HTTPException(404, "任务不存在（已过期）")
            if ex.response.status_code == 409:
                raise HTTPException(409, "无可重新生成的文件（非跳过或已处理）")
            raise HTTPException(502, f"服务请求失败: HTTP {ex.response.status_code}")
        except httpx.HTTPError as ex:
            raise HTTPException(502, f"服务不可达: {ex}")
        finally:
            await eng.close()

    # -- 任务取消 (代理服务 POST /jobs/<id>/cancel) ---------------------------

    @app.post("/api/jobs/{engine}/{job_id}/cancel")
    async def api_cancel(engine: str, job_id: str) -> dict:
        entry = store.get(engine)
        if entry is None:
            raise HTTPException(404, "engine not found")
        eng = JavScribeEngine(engine, entry["url"])
        try:
            return await eng.cancel(job_id)
        except httpx.HTTPStatusError as ex:
            if ex.response.status_code == 404:
                raise HTTPException(404, "任务不存在（已过期）")
            if ex.response.status_code == 409:
                raise HTTPException(409, "任务已结束，无需取消")
            raise HTTPException(502, f"服务请求失败: HTTP {ex.response.status_code}")
        except httpx.HTTPError as ex:
            raise HTTPException(502, f"服务不可达: {ex}")
        finally:
            await eng.close()

    # -- 任务挂起 / 恢复（代理服务 POST /jobs/<id>/pause|resume，serve 0.2.3+）--

    async def _job_pause_resume(kind: str, engine: str, job_id: str) -> dict:
        entry = store.get(engine)
        if entry is None:
            raise HTTPException(404, "engine not found")
        eng = JavScribeEngine(engine, entry["url"])
        try:
            return await (eng.pause_job(job_id) if kind == "pause" else eng.resume_job(job_id))
        except httpx.HTTPStatusError as ex:
            if ex.response.status_code == 404:
                raise HTTPException(404, "任务不存在（已过期）")
            if ex.response.status_code == 409:
                try:
                    detail = ex.response.json().get("error")
                except (ValueError, AttributeError):
                    detail = None
                raise HTTPException(409, detail or "任务当前状态不允许此操作")
            raise HTTPException(502, f"服务请求失败: HTTP {ex.response.status_code}")
        except httpx.HTTPError as ex:
            raise HTTPException(502, f"服务不可达: {ex}")
        finally:
            await eng.close()

    @app.post("/api/jobs/{engine}/{job_id}/pause")
    async def api_job_pause(engine: str, job_id: str) -> dict:
        return await _job_pause_resume("pause", engine, job_id)

    @app.post("/api/jobs/{engine}/{job_id}/resume")
    async def api_job_resume(engine: str, job_id: str) -> dict:
        return await _job_pause_resume("resume", engine, job_id)

    # -- 本机任务 暂停 / 继续 / 重试 -------------------------------------------

    def _reset_local_task(task: UploadTask) -> None:
        """重置本机任务到可重跑状态（不启动；调用方负责 _spawn_local）。"""
        task.phase = "queued"
        task.error = None
        task.progress = 0.0
        task.finished = None
        task.job_id = None
        task.writeback = None
        task.audio_mb = None
        task.wb_fails = 0
        task.cached = False
        task.task_paused = False
        _local_wb.pop(task.id, None)
        _gate.release(task.id)  # 防御：确保无槽位残留

    def _pause_local(task: UploadTask) -> tuple[bool, str]:
        """暂停本机管线（仅限未提交服务的：排队/提取/派发阶段）。"""
        if task.job_id:
            return False, "已提交服务队列，请在服务任务行上操作"
        if task.phase == "paused":
            return True, "已是暂停状态"
        if task.phase not in ("queued", "extracting", "dispatching"):
            return False, f"任务非进行中（{task.phase}），无法暂停"
        task.phase = "paused"
        task.task_paused = True
        task.error = None
        _save_uploads_state()
        rt = _run_tasks.get(task.id)
        if rt is not None and not rt.done():
            rt.cancel()
        return True, "ok"

    @app.post("/api/local/{task_id}/pause")
    async def api_local_pause(task_id: str) -> dict:
        task = _uploads.get(task_id)
        if task is None:
            raise HTTPException(404, "任务不存在（已过期）")
        ok, msg = _pause_local(task)
        if not ok:
            raise HTTPException(409, msg)
        return {"ok": True, "task_id": task.id, "already": msg == "已是暂停状态"}

    @app.post("/api/local/{task_id}/rerun")
    async def api_local_rerun(task_id: str) -> dict:
        """重试 / 继续：error 或 paused（重启中断、用户暂停）→ 重提取音轨并提交。"""
        task = _uploads.get(task_id)
        if task is None:
            raise HTTPException(404, "任务不存在（已过期）")
        if task.phase not in ("error", "paused"):
            raise HTTPException(409, "任务进行中，无需重试")
        if not task.local_path:
            raise HTTPException(409, "该任务无本机视频路径（浏览器上传任务请重新上传）")
        video = Path(task.local_path)
        if not video.is_file():
            raise HTTPException(404, "本机视频不存在，无法重试")
        _reset_local_task(task)
        _save_uploads_state()
        _spawn_local(task, video)
        return {"ok": True, "task_id": task.id}

    def _reassign_local(task: UploadTask, engine: str) -> tuple[bool, str]:
        """改派目的地服务：仅限未提交服务的任务（queued/paused，无 job_id）。
        排队中任务的等待登记立即跟随新服务（_Gate 动态重读）；auto 在派发时刻
        按实时负载解析。已进入提取/派发的不可改（上传可能已在途）。"""
        if task.job_id:
            return False, "已提交服务队列，等其完成即可"
        if task.phase not in ("queued", "paused"):
            return False, f"当前状态（{task.phase}）不支持改派（仅限排队/已暂停）"
        if engine == AUTO:
            if not _auto_candidates():
                return False, "没有可分配的服务（全部离线或未参与均衡）"
        elif store.get(engine) is None:
            return False, "服务不存在"
        task.engine = engine
        _save_uploads_state()
        return True, "ok"

    @app.post("/api/local/{task_id}/reassign")
    async def api_local_reassign(task_id: str, body: dict) -> dict:
        """改派本机任务的目的地服务（排队/已暂停可用；auto=派发时刻实时选最闲）。"""
        task = _uploads.get(task_id)
        if task is None:
            raise HTTPException(404, "任务不存在（已过期）")
        engine = str((body or {}).get("engine") or "").strip()
        if not engine:
            raise HTTPException(400, "engine 必填（auto 或已注册服务名）")
        if engine != AUTO and store.get(engine) is None:
            raise HTTPException(404, "服务不存在")
        ok, msg = _reassign_local(task, engine)
        if not ok:
            raise HTTPException(409, msg)
        await _gate._wake()  # 排队中的等待者立即按新服务重判
        return {"ok": True, "task_id": task.id, "engine": engine}

    @app.post("/api/jobs/bulk")
    async def api_jobs_bulk(body: dict) -> dict:
        """批量操作（大批量任务场景）：action=pause/resume/retry/cancel/assign。

        task_ids → 本机扫描任务（pause/resume/retry；assign=改派目的地服务，
        仅排队/已暂停可用，body 需带 engine；本机行未入服务队列，
        无「取消」语义 → cancel 返回 error 说明）；
        jobs → 服务任务 [{engine, job_id}]（其余动作都代理到服务侧，
        404/409 语义与单任务端点一致；assign 不适用）。并发上限 8，单条失败不拖垮整批。
        """
        action = body.get("action")
        task_ids = body.get("task_ids") or []
        jobs = body.get("jobs") or []
        if action not in ("pause", "resume", "retry", "cancel", "assign"):
            raise HTTPException(400, "action 需要 pause/resume/retry/cancel/assign")
        if not isinstance(task_ids, list) or not isinstance(jobs, list):
            raise HTTPException(400, "task_ids/jobs 需要数组")
        assign_engine = ""
        if action == "assign":
            assign_engine = str(body.get("engine") or "").strip()
            if not assign_engine:
                raise HTTPException(400, "assign 需要 engine（auto 或已注册服务名）")
            if assign_engine == AUTO:
                pass  # 候选存在性在逐条 _reassign_local 内校验（可给出更细错误）
            elif store.get(assign_engine) is None:
                raise HTTPException(404, "服务不存在")

        sem = asyncio.Semaphore(8)
        results: list[dict] = []

        async def _one(key: str, fn) -> None:
            async with sem:
                try:
                    ok, err = await fn()
                    if ok:
                        results.append({"key": key, "ok": True})
                    else:
                        results.append({"key": key, "ok": False, "error": err})
                except HTTPException as ex:
                    results.append({"key": key, "ok": False, "error": str(ex.detail)})
                except Exception as ex:  # noqa: BLE001 单条失败不拖垮整批
                    results.append({"key": key, "ok": False, "error": str(ex)})

        async def _local_one(tid: str) -> None:
            t = _uploads.get(tid)
            key = f"local:{tid}"
            if t is None:
                await _one(key, lambda: (False, "任务不存在（已过期）"))
                return
            if action == "pause":
                async def _p():
                    return _pause_local(t)  # 同步助手：包成协程再交给 _one await
                await _one(key, _p)
            elif action in ("resume", "retry"):
                async def _r():
                    if t.phase not in ("error", "paused"):
                        verb = "恢复" if action == "resume" else "重试"
                        return False, f"当前状态（{t.phase}）不可{verb}"
                    if not t.local_path:
                        return False, "无本机视频路径（浏览器上传任务请重新上传）"
                    if not Path(t.local_path).is_file():
                        return False, "本机视频不存在，无法重试"
                    _reset_local_task(t)
                    _save_uploads_state()
                    _spawn_local(t, Path(t.local_path))
                    return True, "ok"
                await _one(key, _r)
            elif action == "assign":
                async def _a():
                    ok2, msg2 = _reassign_local(t, assign_engine)
                    return ok2, msg2
                await _one(key, _a)
            else:
                async def _c():
                    return False, "本机任务尚未入服务队列，无「取消」；可「重试」重跑"
                await _one(key, _c)

        async def _serve_one(item: dict) -> None:
            eng_name = str(item.get("engine") or "")
            jid = str(item.get("job_id") or "")
            key = f"{eng_name}:{jid}"
            if not eng_name or not jid:
                await _one(key or "invalid", lambda: (False, "缺少 engine/job_id"))
                return

            async def _s():
                entry = store.get(eng_name)
                if entry is None:
                    return False, "服务不存在（已删除）"
                eng = JavScribeEngine(eng_name, entry["url"])
                try:
                    if action == "pause":
                        await eng.pause_job(jid)
                    elif action == "resume":
                        await eng.resume_job(jid)
                    elif action == "retry":
                        await eng.retry(jid)
                    elif action == "assign":
                        return False, "改派仅支持本机排队/暂停任务（已入服务队列的不可改道）"
                    else:
                        await eng.cancel(jid)
                    return True, "ok"
                except httpx.HTTPStatusError as ex:
                    code = ex.response.status_code
                    try:
                        msg = ex.response.json().get("error", "")
                    except (ValueError, AttributeError):
                        msg = ""
                    if code == 404:
                        return False, msg or "任务不存在（已过期/服务重启）"
                    if code == 409:
                        return False, msg or "任务当前状态不允许此操作"
                    return False, f"服务请求失败: {msg or ('HTTP ' + str(code))}"
                except httpx.HTTPError as ex:
                    return False, f"服务不可达: {ex.__class__.__name__}"
                finally:
                    await eng.close()

            await _one(key, _s)

        coros = ([_local_one(str(x)) for x in task_ids if str(x)]
                 + [_serve_one(j) for j in jobs if isinstance(j, dict)])
        if coros:
            await asyncio.gather(*coros)
        succeeded = sum(1 for r in results if r["ok"])
        return {
            "ok": True,
            "action": action,
            "total": len(results),
            "succeeded": succeeded,
            "failed": len(results) - succeeded,
            "results": results,
        }

    # -- 服务设置（代理 /config，X-Api-Key 鉴权在服务侧执行）-----------------

    def _map_config_error(ex: httpx.HTTPStatusError) -> HTTPException:
        code = ex.response.status_code
        if code in (401, 403):
            detail = "该服务尚未设置 API Key，或工作台登记的 Key 不正确"
            if code == 403:
                detail = "该服务尚未设置 API Key（需在服务端配置 JAVSCRIBE_API_KEY）"
            else:
                detail = "API Key 不正确：请核对服务端的 JAVSCRIBE_API_KEY 与工作台登记值"
            return HTTPException(400, detail)
        if code == 404:
            return HTTPException(400, "该服务版本过旧，不支持配置管理（请升级 JavScribe 服务）")
        try:
            msg = ex.response.json().get("error", "")
        except Exception:  # noqa: BLE001
            msg = ""
        return HTTPException(code if 400 <= code < 500 else 502, f"服务请求失败: {msg or code}")

    _metrics_cache: dict[str, tuple[float, dict]] = {}  # name -> (ts, payload)

    @app.get("/api/engines/{name}/metrics")
    async def api_engine_metrics(name: str) -> dict:
        """服务监控快照（GPU/显存/调度/1h 历史）→ 前端服务卡片迷你趋势图。

        旧版 serve 无 /metrics/json → unsupported（前端降级隐藏监控块）；
        网络错误 → unreachable。2s 内存缓存摊平刷新风暴。
        """
        entry = store.get(name)
        if entry is None:
            raise HTTPException(404, "服务不存在")
        now = time.time()
        hit = _metrics_cache.get(name)
        if hit is not None and now - hit[0] < 2.0:
            return hit[1]
        eng = JavScribeEngine(name, entry["url"])
        try:
            try:
                data = await eng.metrics()
                payload = {"ok": True, "metrics": data}
            except httpx.HTTPStatusError as ex:
                if ex.response.status_code == 404:
                    payload = {"ok": False, "error": "unsupported"}
                else:
                    payload = {"ok": False, "error": f"服务返回 HTTP {ex.response.status_code}"}
            except httpx.HTTPError:
                payload = {"ok": False, "error": "unreachable"}
        finally:
            await eng.close()
        _metrics_cache[name] = (now, payload)
        return payload

    @app.get("/api/engines/{name}/config")
    async def api_engine_config(name: str) -> dict:
        entry = store.get(name)
        if entry is None:
            raise HTTPException(404, "服务不存在")
        eng = JavScribeEngine(name, entry["url"], entry.get("api_key", ""))
        try:
            return await eng.config()
        except httpx.HTTPStatusError as ex:
            raise _map_config_error(ex)
        except httpx.HTTPError as ex:
            raise HTTPException(502, f"服务不可达: {ex}")
        finally:
            await eng.close()

    @app.put("/api/engines/{name}/config")
    async def api_engine_config_update(name: str, body: dict) -> dict:
        entry = store.get(name)
        if entry is None:
            raise HTTPException(404, "服务不存在")
        values = body.get("values") if isinstance(body, dict) else None
        if not isinstance(values, dict) or not values:
            raise HTTPException(400, "values 不能为空")
        eng = JavScribeEngine(name, entry["url"], entry.get("api_key", ""))
        try:
            return await eng.config_update(values)
        except httpx.HTTPStatusError as ex:
            raise _map_config_error(ex)
        except httpx.HTTPError as ex:
            raise HTTPException(502, f"服务不可达: {ex}")
        finally:
            await eng.close()

    # -- 本地扫描（扫描工作台部署所在机器的磁盘；服务端只收音轨）----------------
    # 架构约定：服务端不做文件交互；「扫描目录」= 客户端（本机）路径。
    # 完成后字幕由工作台自动写回本机影片旁（_local_writeback_tick）。

    async def _engine_scan_cfg(name: str) -> tuple[dict, bool]:
        """取引擎侧扫描规则（与「服务设置」同源）；不可达时退回内置默认。"""
        entry = store.get(name)
        assert entry is not None
        eng = JavScribeEngine(name, entry["url"], entry.get("api_key", ""))
        try:
            c = await eng.config()
            return localscan.cfg_from_items(c.get("items") or []), True
        except httpx.HTTPError:
            return copy.deepcopy(localscan.DEFAULT_SCAN_CFG), False
        finally:
            await eng.close()

    @app.get("/api/fs/read-srt")
    async def api_fs_read_srt(path: str) -> dict:
        """字幕预览：读客户端部署机上的字幕文件内容（前端预览弹窗用）。

        只放行字幕扩展名（SRT_EXTS）且 ≤ SRT_MAX_MB 的常规文件，
        不开放任意文件读取；解析与展示在客户端完成。
        """
        if not path or not path.strip():
            raise HTTPException(400, "path 必填")
        p = Path(path).expanduser()
        if p.suffix.lower() not in SRT_EXTS:
            raise HTTPException(400, "仅可预览 .srt / .vtt / .ass / .ssa 字幕文件")
        if not p.is_file():
            raise HTTPException(404, "文件不存在")
        try:
            st = p.stat()
        except OSError as ex:
            raise HTTPException(404, f"无法读取文件: {ex}")
        if st.st_size > SRT_MAX_MB * 1048576:
            raise HTTPException(413, f"文件超过 {SRT_MAX_MB:.0f}MB，无法预览")
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError as ex:
            raise HTTPException(500, f"读取失败: {ex}")
        return {
            "ok": True,
            "path": str(p.resolve()),
            "name": p.name,
            "size_mb": round(st.st_size / 1048576, 2),
            "text": text,
        }

    @app.get("/api/scan/local")
    async def api_local_scan(
        engine: str,
        path: str,
        min_size_mb: float | None = None,
        naming_c: str | None = None,
    ) -> dict:
        resolve_engine(engine)
        # auto：扫描规则取自当前负载最轻的服务（规则各服务一致时等价于任选）
        cfg, from_engine = await _engine_scan_cfg(pick_engine() if engine == AUTO else engine)
        # 客户端侧文件属性规则覆盖（扫描面板设置；非法值拒绝而非静默回退）
        if min_size_mb is not None:
            if not (min_size_mb >= 0) or min_size_mb == float("inf"):
                raise HTTPException(400, "min_size_mb 需要 >=0 的有限数字")
            cfg.setdefault("scan", {})["min_size_mb"] = min_size_mb
        if naming_c is not None:
            if naming_c not in localscan.NAMING_C_MODES:
                raise HTTPException(
                    400, f"naming_c 需要 {' / '.join(localscan.NAMING_C_MODES)} 之一")
            cfg.setdefault("scan", {})["naming_c"] = naming_c
        try:
            root, mapped = localscan.resolve_scan_root(path)
        except localscan.ScanError as ex:
            raise HTTPException(400, str(ex))
        try:
            result = await asyncio.to_thread(localscan.scan_dir, root, cfg)
        except Exception as ex:  # noqa: BLE001
            raise HTTPException(500, f"扫描失败: {ex}")
        _sc = localscan._scan_cfg(cfg)
        result["mapped"] = mapped
        result["rules"] = "engine" if from_engine else "defaults"
        result["min_size_mb"] = _sc["min_size_mb"]
        result["naming_c"] = _sc["naming_c"]
        return result

    @app.post("/api/scan/local/submit")
    async def api_local_scan_submit(body: dict) -> dict:
        name = body.get("engine") if isinstance(body, dict) else None
        files = body.get("files") if isinstance(body, dict) else None
        if not name:
            raise HTTPException(404, "服务不存在")
        resolve_engine(name)
        if not isinstance(files, list) or not files:
            raise HTTPException(400, "files 需要非空数组（绝对路径列表）")
        # auto：扩展名/字幕判定规则取自当前负载最轻的服务；任务行保留 auto，
        # 实际服务在各自派发时刻按负载解析
        cfg, _from_engine = await _engine_scan_cfg(pick_engine() if name == AUTO else name)
        try:
            paths = localscan.validate_submit_files(files, cfg)
        except localscan.ScanError as ex:
            raise HTTPException(400, str(ex))
        # 提交前检测到的字幕状态（{path: external/embedded/named}）：只做展示提示，
        # 不影响受理（用户已在扫描确认过）。
        sub_raw = body.get("sub_status") if isinstance(body, dict) else None
        sub_map: dict[str, str] = (
            {str(k): str(v) for k, v in sub_raw.items() if isinstance(v, str)}
            if isinstance(sub_raw, dict) else {}
        )
        _prune_uploads()
        # 防重：同一影片在跑/在队（含提取中）时跳过，已终态（完成回写 / 提取失败）
        # 的允许重新提交（在跑的任务可先经任务行取消按钮取消，serve v0.1.7+ 支持）。
        active_paths: set[str] = set()
        for t in _uploads.values():
            if not t.local_path or t.phase == "error":
                continue
            if not t.finished or t.id in _local_wb:
                active_paths.add(str(Path(t.local_path).resolve()))
        skip: list[str] = []
        fresh: list[Path] = []
        for p in paths:
            (skip if str(p) in active_paths else fresh).append(p)
        created: list[str] = []
        for p in fresh:
            task = UploadTask(
                id=uuid.uuid4().hex[:8],
                engine=name,
                name=p.name,
                size_mb=round(p.stat().st_size / 1048576, 1),
                local_path=str(p),
                sub_status=sub_map.get(str(p)),
            )
            _uploads[task.id] = task
            created.append(task.id)
            _save_uploads_state()
            _spawn_local(task, p)
        return {
            "ok": True,
            "files": len(created),
            "upload_ids": created,
            "skipped": [p.name for p in skip],
        }

    @app.get("/api/fs/browse")
    async def api_fs_browse(path: str = "") -> dict:
        """目录浏览器（Web 形态「浏览」按钮）：列客户端部署机目录下的子目录/文件。

        只列目录名与文件大小，不读文件内容；暴露面与 /api/scan/local 等价
        （该端点本就可指定任意路径扫描）。path 为空 → 当前用户家目录。
        """
        p = (Path(path) if path.strip() else Path.home()).expanduser()
        try:
            p = p.resolve()
        except (OSError, RuntimeError):
            raise HTTPException(400, "路径无效")
        if not p.is_dir():
            raise HTTPException(400, "目录不存在或不可访问")
        try:
            with os.scandir(p) as it:
                items = list(it)
        except OSError as ex:
            raise HTTPException(400, f"无法读取目录: {ex}")
        items.sort(key=lambda d: (not d.is_dir(), d.name.casefold()))
        entries: list[dict] = []
        truncated = False
        for d in items:
            if len(entries) >= 4000:
                truncated = True
                break
            try:
                if d.is_dir():
                    entries.append({"name": d.name, "is_dir": True, "size_mb": None})
                else:
                    st = d.stat()
                    entries.append({"name": d.name, "is_dir": False,
                                    "size_mb": round(st.st_size / 1048576, 1)})
            except OSError:
                entries.append({"name": d.name, "is_dir": False, "size_mb": None})
        parent = str(p.parent) if p.parent != p else ""
        return {
            "ok": True,
            "path": str(p),
            "parent": parent,
            "home": str(Path.home()),
            "entries": entries,
            "truncated": truncated,
        }

    async def _local_writeback_tick() -> None:
        """轮询快照就绪后：把已完成的本地扫描任务字幕写回本机影片旁。

        所有终态出口统一走 _wb_close：离开回写表 + 释放在途槽（槽释放唯一出口）。
        """
        _prune_uploads()

        def _wb_close(task: UploadTask) -> None:
            _local_wb.pop(task.id, None)
            _gate.release(task.id)

        for task in list(_local_wb.values()):
            if task.writeback is not None:
                _wb_close(task)
                continue
            if not task.local_path or not task.job_id:
                continue
            job = next(
                (j for j in poller.jobs.get(task.engine, [])
                 if j.get("id") == task.job_id),
                None,
            )
            if job is None:
                # 服务任务表里查不到：要么刚派发还没进快照（秒级内出现），
                # 要么已被 200 内存窗挤出 / 服务重启丢失。派发完成超
                # LOCAL_WB_JOB_GONE_S 仍查不到 → 判失败放行重新提交
                # （避免行永久卡「进行中」）。
                if (task.finished or 0) and time.time() - task.finished > LOCAL_WB_JOB_GONE_S:
                    task.phase = "error"
                    task.error = "服务任务已从任务表过期（任务量大时被服务端任务窗口挤出或服务重启丢失），请重新提交"
                    task.writeback = "failed: 服务任务已过期"
                    _save_uploads_state()
                    _wb_close(task)
                continue
            files = job.get("files") or []
            fstatus = files[0].get("status") if files else None
            if job.get("state") != "finished":
                if fstatus in ("error", "canceled"):
                    task.writeback = (
                        "failed: 生成失败" if fstatus == "error"
                        else "failed: 生成已取消"
                    )
                    _wb_close(task)
                continue
            if fstatus == "skipped":
                task.writeback = "skipped"
                _wb_close(task)
                continue
            if fstatus in ("error", "canceled"):
                task.writeback = "failed: 生成失败" if fstatus == "error" else "failed: 生成已取消"
                _wb_close(task)
                continue
            vid = Path(task.local_path)
            entry = store.get(task.engine)
            if entry is None or not vid.is_file():
                task.writeback = "failed: 视频已不存在"
                _wb_close(task)
                continue
            eng = JavScribeEngine(task.engine, entry["url"])
            try:
                data, suggested = await eng.result(task.job_id)
            except Exception as ex:  # noqa: BLE001
                task.wb_fails += 1
                if task.wb_fails >= LOCAL_WB_MAX_FAILS:
                    task.writeback = f"failed: 字幕暂不可下载（{ex}）"
                    _wb_close(task)
                continue
            finally:
                await eng.close()
            # 目标文件名：优先服务端 Content-Disposition（与服务端落盘命名一致），
            # 旧服务占位名 {job_id}.srt 退回 <stem>.zh.srt。
            name = (suggested if suggested and suggested != f"{task.job_id}.srt"
                    and Path(suggested).suffix == ".srt"
                    else vid.stem + ".zh.srt")
            target = vid.parent / Path(name).name
            if target.is_file() and target.stat().st_size > 0:
                task.writeback = "skipped_exists"
                _wb_close(task)
                continue
            data, _fixed = sanitize_srt_bytes(data, log=_log.warning)
            try:
                target.write_bytes(data)
                task.writeback = "ok"
                _log.info("[writeback] %s -> %s", vid.name, target)
            except OSError as ex:
                task.wb_fails += 1
                if task.wb_fails >= LOCAL_WB_MAX_FAILS:
                    task.writeback = f"failed: 写入失败（{ex}）"
                    _wb_close(task)
                continue
            _wb_close(task)
        _save_uploads_state()

    try:
        poller.set_on_jobs(_local_writeback_tick)
    except AttributeError:  # 旧版 Poller（测试夹具）无钩子时跳过
        pass

    # 从磁盘恢复本地管线状态（重启恢复：回写跟踪 / 失败行可见）
    _load_uploads_state()
    _save_uploads_state()

    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app
