"""ChickenRice --server 常驻模型池（warm pool，serve 0.2.16）。

经典路径每个批起一次推理进程：模型加载（large-v2 int8 数十秒）随进程生灭。
warm pool 让推理进程常驻：

  - 懒启动：服务启动不占显存；首个转写批才 spawn 常驻进程（等 [SERVER] ready）
  - 批复用：acquire 后经 stdin JSON 批协议（{"files": [...]}）投批，
    [SERVER] batch_done 后 release 回池——后续批零模型加载等待
  - 空闲释放：ChickenRice 进程 keepalive_s 无批自行退出（idle_exit，释放显存）；
    池侧 reap 对账（bookkeeping 清理，不杀进程）
  - 崩溃回收：常驻进程崩溃/取消/服务停止 → discard 终止，下一批重建
  - 容量 = infer.concurrency（与经典路径同「同时模型实例数」口径）
  - 显存闸：已有 ≥1 个模型实例驻留时起第 2+ 常驻进程仍走 _vram_gate_open；
    闸关 → 该批回退经典一次性进程（加载完即退，显存压力更小）

平台：仅 Linux（Popen stdin 管道路径）。Windows/ConPTY 不支持 stdin 写，
engine.warm_pool_enabled 恒 False，自动回退经典路径，行为与 0.2.15 一致。
"""
from __future__ import annotations

import os
import shlex
import threading
import time
from typing import TYPE_CHECKING, Callable, Optional

from .proc_runner import ProcRunner

if TYPE_CHECKING:  # pragma: no cover
    from .engine import Engine

# 常驻进程就绪等待上限：模型加载（含冷缓存）的保守上界；超时按「启动失败」
# 处理（杀进程、本批回退一次性进程）。
READY_TIMEOUT_S = 600.0


class ModelPool:
    """ChickenRice --server 常驻进程池。

    鸭子类型依赖 engine：log / concurrency / model_keepalive_s / _model_procs /
    _model_up / _model_down / _vram_gate_open / _stop_evt / _runners_lock /
    _active_runners / _build_infer_command(files, server=True)。
    """

    # 空闲对账间隔：keepalive 自退（idle_exit）后 bookkeeping 的清理上界
    REAP_INTERVAL_S = 5.0

    def __init__(self, engine: "Engine") -> None:
        self._engine = engine
        self._lock = threading.Lock()
        self._idle: list[ProcRunner] = []
        self._busy: set[ProcRunner] = set()
        self._spawning = 0          # 在途 spawn（未 ready），计入容量防止超发
        self.loads = 0              # 成功 spawn 次数（= 真实模型加载次数，metrics 口径）
        self._stopped = threading.Event()
        self._reaper = threading.Thread(
            target=self._reaper_loop, name="warm-pool-reaper", daemon=True
        )
        self._reaper.start()

    # ------------------------------------------------------------------
    @property
    def size(self) -> int:
        with self._lock:
            return len(self._idle) + len(self._busy) + self._spawning

    @property
    def idle_count(self) -> int:
        with self._lock:
            return len(self._idle)

    def acquire(self, on_line: Callable[[str], None]) -> Optional[ProcRunner]:
        """取一个就绪常驻进程（空闲复用优先，无则按需 spawn）。

        返回 None = 常驻不可用（容量满 / 显存闸关 / 启动失败 / 就绪超时），
        调用方回退经典一次性进程路径。
        """
        eng = self._engine
        with self._lock:
            self._reap_locked()
            for r in list(self._idle):
                if r.proc_alive:
                    self._idle.remove(r)
                    self._busy.add(r)
                    r.on_line = on_line
                    return r
            # 注意：此处已持 _lock，不得再走 self.size 属性（非重入锁自锁）
            total = len(self._idle) + len(self._busy) + self._spawning
            if total >= eng.concurrency:
                eng.log("[warm] 常驻池满且无空闲进程，本批回退一次性进程")
                return None
            if eng._model_procs > 0 and not eng._vram_gate_open():
                eng.log("[warm] 显存预检不通过，本批回退一次性进程")
                return None
            self._spawning += 1
        try:
            return self._spawn(on_line)
        finally:
            with self._lock:
                self._spawning -= 1

    def release(self, runner: ProcRunner) -> None:
        """批完成后回池（进程继续存活，keepalive 超时自动释放）。"""
        with self._lock:
            self._busy.discard(runner)
            if runner.proc_alive and runner not in self._idle:
                self._idle.append(runner)

    def discard(self, runner: ProcRunner, reason: str = "") -> None:
        """逐出常驻进程并终止（崩溃 / 取消 / 服务停止 / 发送失败）。

        幂等：shutdown 与 worker 并发 discard 同一 runner 不双减计数。
        """
        eng = self._engine
        with self._lock:
            was_tracked = runner in self._busy or runner in self._idle
            self._busy.discard(runner)
            self._idle = [r for r in self._idle if r is not runner]
        runner.stop()
        with eng._runners_lock:
            eng._active_runners.discard(runner)
        if was_tracked:
            eng._model_down()
        if reason:
            eng.log(f"[warm] 常驻进程回收（{reason}）")

    def shutdown(self) -> None:
        """服务停止：终止全部常驻进程（空闲 + 在批）并停 reaper。"""
        self._stopped.set()
        with self._lock:
            runners = list(self._idle) + list(self._busy)
            self._idle.clear()
            self._busy.clear()
            tracked = len(runners)
        # 清表后 discard 的 was_tracked 恒 False（不再 _model_down），
        # 计数在此显式对账；与 worker 并发 discard 由 was_tracked 防双减
        for _ in range(tracked):
            self._engine._model_down()
        for r in runners:
            self.discard(r, "服务停止")

    def _reaper_loop(self) -> None:
        """周期清扫空闲常驻进程（keepalive 自退/崩溃）：model_loaded 等
        metrics 在进程退出后 REAP_INTERVAL_S 内回到真实值。"""
        while not self._stopped.wait(self.REAP_INTERVAL_S):
            try:
                with self._lock:
                    self._reap_locked()
            except Exception:
                pass

    # ------------------------------------------------------------------
    def _reap_locked(self) -> None:
        """清扫已死的空闲常驻进程（keepalive 自退 / 崩溃）。调用方持 _lock。"""
        eng = self._engine
        dead = [r for r in self._idle if not r.proc_alive]
        if not dead:
            return
        for r in dead:
            self._idle.remove(r)
            with eng._runners_lock:
                eng._active_runners.discard(r)
            eng._model_down()
        eng.log(f"[warm] {len(dead)} 个空闲常驻进程已退出（keepalive 释放/崩溃），对账完成")

    def _spawn(self, on_line: Callable[[str], None]) -> Optional[ProcRunner]:
        """起一个常驻进程并等 [SERVER] ready。失败返回 None（已自行清理）。"""
        eng = self._engine
        cmd, cwd = eng._build_infer_command([], server=True)
        ready_evt = threading.Event()

        def on_ready(line: str) -> None:
            eng.log(f"  [warm] {line}")
            if "[SERVER] ready" in line:
                ready_evt.set()

        runner = ProcRunner(
            " ".join(shlex.quote(c) for c in cmd),
            cwd=cwd,
            on_line=on_ready,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
            stdin=True,
        )
        with eng._runners_lock:
            eng._active_runners.add(runner)
        eng.log(f"[warm] 启动常驻模型进程（空闲 {eng.model_keepalive_s}s 自动释放）")
        if not runner.start():
            with eng._runners_lock:
                eng._active_runners.discard(runner)
            eng.log("[warm] 常驻进程启动失败，本批回退一次性进程")
            return None
        eng._model_up()
        try:
            deadline = time.time() + READY_TIMEOUT_S
            while not ready_evt.wait(1.0):
                if eng._stop_evt.is_set():
                    self._drop_spawned(runner, "就绪等待期服务停止")
                    return None
                if not runner.proc_alive:
                    self._drop_spawned(runner, f"就绪前退出（code {runner.exit_code}）")
                    return None
                if time.time() > deadline:
                    self._drop_spawned(runner, f"就绪超时（{READY_TIMEOUT_S:.0f}s）")
                    return None
        except Exception:
            self._drop_spawned(runner, "就绪等待异常")
            return None
        with self._lock:
            self._busy.add(runner)
            self.loads += 1
        # ready 后才换调用方行回调：就绪前无业务行（模型加载日志已透传），无丢失
        runner.on_line = on_line
        eng.log("[warm] 常驻模型进程就绪")
        return runner

    def _drop_spawned(self, runner: ProcRunner, reason: str) -> None:
        """spawn 失败清理：终止 + 注销 + 模型计数回退（尚未入池，无池成员关系）。"""
        eng = self._engine
        runner.stop()
        with eng._runners_lock:
            eng._active_runners.discard(runner)
        eng._model_down()
        eng.log(f"[warm] 常驻进程启动中止（{reason}）")
