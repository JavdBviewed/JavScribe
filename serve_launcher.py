"""PyInstaller 入口：headless serve exe（JavScribeServe）。

无参数时 `jav_scribe` 默认进 serve 模式，所以双击 exe 即零操作启动
进度/上传 HTTP 接口。冻结态（PyInstaller）下重定向日志到
~/.jav_scribe/serve.log——Windows 窗口态 exe 没有控制台。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

if getattr(sys, "frozen", False):
    log_path = Path.home() / ".jav_scribe" / "serve.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    _log_file = open(log_path, "a", encoding="utf-8", buffering=1)
    _log_file.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} serve 启动 =====\n")
    sys.stdout = _log_file
    sys.stderr = _log_file

from jav_scribe.cli import main  # noqa: E402

if __name__ == "__main__":
    argv = sys.argv[1:]
    # 双击启动（无参）或只给 flag（如 --port 8311）时，默认进 serve 子命令
    if not argv or argv[0].startswith("-"):
        argv = ["serve", *argv]
    raise SystemExit(main(argv))
