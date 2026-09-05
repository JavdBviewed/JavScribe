"""Watcher 回归测试：每个路径只能被交给处理一次。

09-05 事故：稳定文件 ready 后从 _seen 删除，下次扫描又被当新文件，
每 2 个扫描周期重新入队一次（127 上 3 个文件 20s/job × 200 个 job）。

Run: python3 tests/test_watch.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from jav_scribe.core.watch import Watcher  # noqa: E402


def _mk(dirs: list[Path], process_existing: bool, got: list) -> Watcher:
    return Watcher(
        [d for d in dirs],
        interval_s=9999,
        process_existing=process_existing,
        log=lambda _s: None,
        on_new_files=lambda files: got.extend(files),
    )


def test_existing_file_queued_exactly_once_no_catchup() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        f = d / "a.mp4"
        f.write_bytes(b"x" * 100)
        got: list[Path] = []
        w = _mk([d], process_existing=False, got=got)
        assert w.scan_once() == []            # 第一次见到：开始跟踪
        assert w.scan_once() == [f]           # 稳定一次：交出一回
        for _ in range(6):
            assert w.scan_once() == [], "稳定文件被重复入队（09-05 事故回归）"
        assert got == [f]


def test_existing_file_catchup_once() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        f = d / "b.mkv"
        f.write_bytes(b"y" * 100)
        got: list[Path] = []
        w = _mk([d], process_existing=True, got=got)
        assert w.scan_once() == [f]           # 存量文件：首扫即交
        for _ in range(5):
            assert w.scan_once() == []
        assert got == [f]


def test_new_file_after_start() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        got: list[Path] = []
        w = _mk([d], process_existing=True, got=got)
        assert w.scan_once() == []            # 空目录
        f = d / "c.mp4"
        f.write_bytes(b"z" * 100)
        assert w.scan_once() == []            # 新文件：待稳定
        assert w.scan_once() == [f]
        for _ in range(4):
            assert w.scan_once() == []
        assert got == [f]


def test_growing_file_queued_only_when_stable() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        got: list[Path] = []
        w = _mk([d], process_existing=False, got=got)
        f = d / "grow.mp4"
        f.write_bytes(b"a" * 10)
        assert w.scan_once() == []            # scan1: 记录 10
        f.write_bytes(b"a" * 20)
        assert w.scan_once() == []            # scan2: 变 20（还在下载）
        f.write_bytes(b"a" * 30)
        assert w.scan_once() == []            # scan3: 变 30
        f.write_bytes(b"a" * 40)
        assert w.scan_once() == []            # scan4: 变 40
        assert w.scan_once() == [f]           # scan5: 连续两次一致 → 交出
        for _ in range(3):
            assert w.scan_once() == []        # 交出后不再重复入队
        assert got == [f]


def test_deleted_then_recreated_file() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        got: list[Path] = []
        w = _mk([d], process_existing=False, got=got)
        f = d / "d.mp4"
        f.write_bytes(b"1" * 10)
        w.scan_once()
        assert w.scan_once() == [f]           # 第一份交出
        f.unlink()
        assert w.scan_once() == []            # 消失：忘记
        f.write_bytes(b"2" * 10)              # 同路径新文件
        assert w.scan_once() == []
        assert w.scan_once() == [f]           # 重新跟踪后再次交出
        assert len(got) == 2 and got[0] == f == got[1]


def test_mixed_batch_order() -> None:
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        got: list[Path] = []
        w = _mk([d], process_existing=False, got=got)
        f1, f2 = d / "e1.mp4", d / "e2.mp4"
        f1.write_bytes(b"1")
        assert w.scan_once() == []             # scan1: f1 首次见到
        f2.write_bytes(b"2")
        assert w.scan_once() == [f1]           # scan2: f1 稳定；f2 刚出现
        assert w.scan_once() == [f2]           # scan3: f2 稳定
        assert w.scan_once() == []             # scan4: 无新文件
        assert got == [f1, f2]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"ALL {len(fns)} WATCH TESTS PASSED")
