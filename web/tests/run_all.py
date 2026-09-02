"""Run all test modules (no pytest dependency). Usage: python3 tests/run_all.py"""
from __future__ import annotations

import importlib
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

MODULES = ["test_config", "test_adapter", "test_api", "test_audio"]


def main() -> int:
    failed = []
    for name in MODULES:
        t0 = time.time()
        try:
            mod = importlib.import_module(name)
            for fn_name in sorted(
                n for n, v in vars(mod).items()
                if n.startswith("test_") and callable(v) and v.__module__ == name
            ):
                getattr(mod, fn_name)()
        except Exception as ex:  # noqa: BLE001
            failed.append(name)
            print(f"  {name} FAILED: {ex!r}")
        else:
            print(f"  {name} PASSED ({time.time() - t0:.1f}s)")
    if failed:
        print(f"FAILED: {', '.join(failed)}")
        return 1
    print("ALL TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
