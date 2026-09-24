"""_Gate 在途封顶 + 多服务公平（v0.2.13）：防一个服务长队列饿死另一个。"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe_web.api import _Gate  # noqa: E402


def test_gate_capacity_and_rehold() -> None:
    """满员等待 → release 唤醒 → rehold 占槽（重启恢复语义）。"""

    async def scenario() -> None:
        g = _Gate(2)
        await g.acquire("a", "svc-a")
        g.rehold("b", "svc-b")  # 重启恢复：同步认领槽
        assert g.held_count() == 2
        got = asyncio.Event()

        async def waiter() -> None:
            await g.acquire("c", "svc-a")
            got.set()

        t = asyncio.create_task(waiter())
        await asyncio.sleep(0.02)
        assert not got.is_set(), "满员时新任务应等待"
        g.release("a")
        await asyncio.wait_for(got.wait(), 1.0)
        assert g.held_count() == 2  # b + c

    asyncio.run(scenario())


def test_gate_fairness_prevents_starvation() -> None:
    """svc-a 10 条排队 vs svc-b 1 条排队，且 svc-a 在途更多：
    空槽必须给负载更轻的 svc-b，而不是被 svc-a 长队列 FIFO 吞掉。"""

    async def scenario() -> None:
        g = _Gate(2)
        await g.acquire("a1", "svc-a")  # svc-a 在途 2 占满（127 长队列场景）
        await g.acquire("a2", "svc-a")
        order: list[str] = []

        async def wait_and_record(tid: str, eng: str) -> None:
            await g.acquire(tid, eng)
            order.append(eng)

        tasks = [asyncio.create_task(wait_and_record(f"a{i}", "svc-a")) for i in range(3, 13)]
        tasks.append(asyncio.create_task(wait_and_record("b1", "svc-b")))
        for _ in range(100):
            await asyncio.sleep(0)
            if g._waiters.get("svc-a") and g._waiters.get("svc-b") and g.held_count() == 2:  # noqa: SLF001 测试白盒
                break
        assert g._waiters.get("svc-a") and g._waiters.get("svc-b"), "等待者未全部入队"

        g.release("a1")  # 放出 1 个槽：svc-a 在途 1 > svc-b 在途 0
        await asyncio.sleep(0.05)
        assert order, "空槽未被消费"
        assert order[0] == "svc-b", f"空槽应给负载更轻的 svc-b，实际: {order}"

        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())


def test_gate_burst_resume_free_slot_to_lighter_engine() -> None:
    """批量恢复竞态：恢复瞬间有空槽 + 长队列服务大量等待者同时涌入——
    空槽必须给在途更轻的服务，而不是被首个登记的长队列任务「独自判定」抢走。"""

    async def scenario() -> None:
        g = _Gate(4)
        await g.acquire("a1", "svc-a")  # svc-a 在途 3 占多数（重启恢复场景）
        await g.acquire("a2", "svc-a")
        await g.acquire("a3", "svc-a")
        order: list[str] = []

        async def wait_and_record(tid: str, eng: str) -> None:
            await g.acquire(tid, eng)
            order.append(eng)

        # 一次性涌入（等价于 bulk resume）：svc-a 长队列在前，svc-b 仅 1 条
        tasks = [asyncio.create_task(wait_and_record(f"a{i}", "svc-a")) for i in range(4, 14)]
        tasks.append(asyncio.create_task(wait_and_record("b1", "svc-b")))
        await asyncio.sleep(0.05)
        assert order, "空槽未被消费"
        assert order[0] == "svc-b", f"恢复瞬间空槽应给 svc-b，实际: {order}"

        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(scenario())


def test_gate_fairness_converges_balanced() -> None:
    """交替释放后两服务在途数应收敛到均衡（差 ≤1），而非一家独大。"""

    async def scenario() -> None:
        g = _Gate(3)
        await g.acquire("a1", "svc-a")
        await g.acquire("b1", "svc-b")
        order: list[str] = []

        async def wait_and_record(tid: str, eng: str) -> None:
            await g.acquire(tid, eng)
            order.append(eng)

        tasks = [asyncio.create_task(wait_and_record(f"a{i}", "svc-a")) for i in range(2, 7)]
        tasks.append(asyncio.create_task(wait_and_record("b2", "svc-b")))
        for _ in range(100):
            await asyncio.sleep(0)
            if g._waiters.get("svc-a") and g._waiters.get("svc-b"):  # noqa: SLF001
                break

        # 依次放出 3 个槽：应交替补给而非 svc-a 连吃
        g.release("a1")
        await asyncio.sleep(0.03)
        g.release("b1")
        await asyncio.sleep(0.03)
        g.release("a2")  # 此时 a2 已在途（第一轮被 svc-a 拿走的话）
        await asyncio.sleep(0.05)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        loads = {"svc-a": 0, "svc-b": 0}
        for tid, eng in g._held.items():
            loads[eng] = loads.get(eng, 0) + 1
        assert abs(loads["svc-a"] - loads["svc-b"]) <= 1, f"未收敛均衡: {loads}, order={order}"

    asyncio.run(scenario())


def test_gate_set_limit_wakes() -> None:
    """调大上限立即唤醒等待者（设置弹窗即时生效语义）。"""

    async def scenario() -> None:
        g = _Gate(1)
        await g.acquire("a", "svc-a")
        got = asyncio.Event()

        async def waiter() -> None:
            await g.acquire("b", "svc-b")
            got.set()

        t = asyncio.create_task(waiter())
        await asyncio.sleep(0.02)
        assert not got.is_set()
        g.set_limit(2)
        await asyncio.wait_for(got.wait(), 1.0)
        assert g.held_count() == 2

    asyncio.run(scenario())


if __name__ == "__main__":
    test_gate_capacity_and_rehold()
    test_gate_fairness_prevents_starvation()
    test_gate_fairness_converges_balanced()
    test_gate_set_limit_wakes()
    print("test_gate: ALL OK")
