"""JavScribe command line.

  jav_scribe gui                  # GUI (Windows; needs the gui extra)
  jav_scribe run FILE|DIR [...]   # one-shot batch (headless)
  jav_scribe watch                # watch BT/PT dirs, process on arrival
  jav_scribe serve [--port 8300]  # watch + progress/remote HTTP API
  jav_scribe upload FILE          # extract audio, process on a remote server,
                                  # download the finished .zh.srt
  jav_scribe version

Config: ~/.jav_scribe/config.json or --config (see config/jav_scribe.example.json).
Profiles: --profile <name>  (one codebase, multiple machine configs, e.g. local/server).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import load_config
from .constants import APP_VERSION, DEFAULT_PROGRESS_PORT, REMOTE_AUDIO_KBITRATE


def _log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def _make_engine(args, cfg: dict[str, Any], profile: str) -> "Engine":
    from .core.engine import Engine

    inf = cfg.get("infer", {})
    if getattr(args, "device", None):
        inf["device"] = args.device
    if getattr(args, "model", None):
        inf["model"] = args.model
    sub = cfg.get("subtitle", {})
    if getattr(args, "lang", None):
        sub["lang_tag"] = args.lang
    if getattr(args, "formats", None):
        sub["formats"] = [f.strip() for f in args.formats.split(",") if f.strip()]
    if getattr(args, "output_dir", None):
        sub["output_dir"] = args.output_dir
    if getattr(args, "log_level", None):
        inf["log_level"] = args.log_level
    if args.overwrite:
        sub["overwrite"] = True
        sub["skip_if_exists"] = False
    if args.no_polish:
        cfg.setdefault("polish", {})["enabled"] = False
    elif args.polish:
        cfg.setdefault("polish", {})["enabled"] = True
    if args.no_emby:
        cfg.setdefault("emby", {})["enabled"] = False
    elif args.emby:
        cfg.setdefault("emby", {})["enabled"] = True
    if args.no_skip:
        sub["skip_if_exists"] = False
    return Engine(cfg, log=_log, profile=profile)


def _add_common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--config", help="config file path (default: ~/.jav_scribe/config.json)")
    p.add_argument("--profile", help="config profile (e.g. local / server)")
    p.add_argument("--device", choices=["auto", "cuda", "cpu", "amd"])
    p.add_argument("--model", help="model_name_or_path (default: models/ next to infer)")
    p.add_argument("--lang", help="subtitle language tag for output naming (zh/ja/en/none)")
    p.add_argument("--formats", help="comma list: srt,vtt,lrc,txt")
    p.add_argument("--output-dir", help="subtitle output dir (default: next to source)")
    p.add_argument("--log-level", choices=["DEBUG", "INFO", "WARNING", "ERROR"],
                   help="engine log level (DEBUG is required for progress)")
    p.add_argument("--overwrite", action="store_true", help="overwrite existing subtitles")
    p.add_argument("--no-skip", action="store_true", help="do not skip files that already have subtitles")
    p.add_argument("--polish", action="store_true", help="enable optional LLM polish pass")
    p.add_argument("--no-polish", action="store_true", help="disable LLM polish pass")
    p.add_argument("--emby", action="store_true", help="enable Emby refresh")
    p.add_argument("--no-emby", action="store_true", help="disable Emby refresh")


def cmd_run(args) -> int:
    if not args.files:
        print("run 需要至少一个文件或目录", file=sys.stderr)
        return 2
    cfg, profile = load_config(args.config, args.profile)
    engine = _make_engine(args, cfg, profile)
    files = engine.expand(args.files)
    if not files:
        print("没有可处理的媒体文件（支持 mkv/mp4/ts/mov/mp3/wav/flac/...）", file=sys.stderr)
        return 2
    print(f"[run] {len(files)} 个文件，profile={profile}，device={engine.cfg.get('infer', {}).get('device')}")
    if not engine.cfg.get("infer", {}).get("command"):
        print("错误：未配置 infer.command（字幕引擎命令），见 config/jav_scribe.example.json", file=sys.stderr)
        return 2
    job = engine.submit(files, source_kind="local", run_in_thread=False)
    n_ok = sum(1 for t in job.files if t.status.value == "done")
    n_skip = sum(1 for t in job.files if t.status.value == "skipped")
    n_err = sum(1 for t in job.files if t.status.value == "error")
    print(f"[run] 完成：成功 {n_ok}，跳过 {n_skip}，失败 {n_err}（任务 {job.id}）")
    return 0 if n_err == 0 else 1


def cmd_watch(args) -> int:
    cfg, profile = load_config(args.config, args.profile)
    engine = _make_engine(args, cfg, profile)
    watch = cfg.get("watch", {})
    dirs = watch.get("dirs") or []
    if args.dirs:
        dirs = args.dirs
    if not dirs:
        print("watch 需要 --dirs 或 config watch.dirs", file=sys.stderr)
        return 2
    from .core.watch import Watcher

    watcher = Watcher(
        dirs,
        interval_s=args.interval or watch.get("interval_s", 10),
        process_existing=not args.no_existing and watch.get("process_existing", True),
        log=_log,
        on_new_files=lambda files: engine.submit(
            engine.expand(files), source_kind="watch", label=str(files[0].parent)
        ),
    )
    _log(f"[watch] 监听: {[str(d) for d in watcher.valid_dirs]}（每 {watcher.interval_s}s 扫描）")
    watcher.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[watch] 停止中…")
        engine.stop()
        watcher.stop()
    return 0


def cmd_serve(args) -> int:
    cfg, profile = load_config(args.config, args.profile)
    engine = _make_engine(args, cfg, profile)
    prog = cfg.get("progress", {})
    host = args.host or prog.get("host", "0.0.0.0")
    port = args.port or prog.get("port", DEFAULT_PROGRESS_PORT)
    watch = cfg.get("watch", {})
    dirs = args.dirs or watch.get("dirs") or []
    from .core.watch import Watcher
    from .core.progress_api import ProgressHTTP

    watcher = Watcher(
        dirs,
        interval_s=args.interval or watch.get("interval_s", 10),
        process_existing=not args.no_existing and watch.get("process_existing", True),
        log=_log,
        on_new_files=lambda files: engine.submit(
            engine.expand(files), source_kind="watch", label=str(files[0].parent)
        ),
    )
    http = ProgressHTTP(engine, host=host, port=port, profile=profile)
    http.start()
    watcher.start()
    _log(f"[serve] 进度接口: http://<本机IP>:{port}/health | 上传: PUT /upload?source=NAME")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[serve] 停止中…")
        engine.stop()
        watcher.stop()
        http.stop()
    return 0


def cmd_upload(args) -> int:
    """Remote-flow client: extract audio from a local video, PUT it to a running
JavScribe server, poll until done, save the returned SRT next to the source."""
    src = Path(args.file).expanduser()
    if not src.is_file():
        print(f"文件不存在: {src}", file=sys.stderr)
        return 2
    if shutil.which("ffmpeg") is None:
        print("需要 ffmpeg 抽音频（客户端安装 ffmpeg 即可）", file=sys.stderr)
        return 2
    remote = args.remote.rstrip("/")
    audio_tmp = src.with_suffix(".javscribe.opus")
    kbr = args.kbr or REMOTE_AUDIO_KBITRATE
    print(f"[upload] 抽音频: {src.name} (16kHz mono opus {kbr}kbps)")
    r = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", f"{kbr}k",
         str(audio_tmp)],
    )
    if r.returncode != 0 or not audio_tmp.is_file():
        print("ffmpeg 抽音频失败", file=sys.stderr)
        return 1
    size_mb = audio_tmp.stat().st_size / 1024 / 1024
    print(f"[upload] 上传到 {remote}（{size_mb:.1f} MB，只传音频不传影片）…")

    def http(method: str, url: str, data: bytes | None = None, headers=None) -> tuple[int, bytes]:
        req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    audio = audio_tmp.read_bytes()
    q = f"?source={urllib.request.quote(src.stem, safe='')}&ext=opus"
    code, body = http("PUT", f"{remote}/upload{q}", audio, {"X-Source-Name": src.name})
    if code != 201:
        print(f"上传失败 HTTP {code}: {body[:300]!r}", file=sys.stderr)
        return 1
    job_id = json.loads(body)["job_id"]
    print(f"[upload] 远程任务 {job_id}，轮询进度…")
    t0 = time.time()
    last = ""
    while time.time() - t0 < args.wait:
        code, body = http("GET", f"{remote}/jobs/{job_id}")
        if code == 200:
            j = json.loads(body)
            cur = j.get("current") or {}
            line = (
                f"状态 {j['state']} | 已翻到 {cur.get('position') or '-'}"
                f" | 进度 {int((cur.get('progress') or 0) * 100)}%"
            )
            if line != last:
                print(f"[upload] {line}")
                last = line
            if j["state"] == "finished":
                break
        time.sleep(args.poll)
    else:
        print("等待超时（任务可能仍在服务器运行，可稍后用 curl 查询）", file=sys.stderr)
        return 1
    code, data = http("GET", f"{remote}/jobs/{job_id}/result")
    if code != 200 or not data:
        print(f"结果下载失败 HTTP {code}", file=sys.stderr)
        return 1
    lang = args.lang or "zh"
    dest = src.with_name(f"{src.stem}.{lang}.srt")
    dest.write_bytes(data)
    audio_tmp.unlink(missing_ok=True)
    print(f"[upload] 完成：字幕已写入 {dest}（等 Emby 扫描即可）")
    return 0


def cmd_gui(_args) -> int:
    try:
        from .app import main
    except ImportError as e:
        print(f"GUI 依赖缺失（{e}）。Windows 上请先: uv sync --extra gui，然后 jav_scribe gui", file=sys.stderr)
        return 2
    return main()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="jav_scribe",
        description="JavScribe — JAV 字幕生成与媒体库联动（ASR + 翻译，模型自持）",
    )
    p.add_argument("--version", action="version", version=f"{APP_VERSION}")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("gui", help="启动图形界面（Windows）")
    s.set_defaults(func=cmd_gui)

    s = sub.add_parser("run", help="一次性批处理（文件或目录）")
    s.add_argument("files", nargs="*", help="媒体文件或目录（目录递归扫描）")
    _add_common(s)
    s.set_defaults(func=cmd_run)

    s = sub.add_parser("watch", help="监听目录，新文件自动处理")
    s.add_argument("--dirs", nargs="*", help="监听目录（覆盖 config watch.dirs）")
    s.add_argument("--interval", type=float, help="扫描间隔秒")
    s.add_argument("--no-existing", action="store_true", help="不处理启动时已存在的文件")
    _add_common(s)
    s.set_defaults(func=cmd_watch)

    s = sub.add_parser("serve", help="watch + 进度/远程 HTTP 接口（服务器用）")
    s.add_argument("--dirs", nargs="*", help="监听目录（覆盖 config watch.dirs）")
    s.add_argument("--interval", type=float, help="扫描间隔秒")
    s.add_argument("--no-existing", action="store_true", help="不处理启动时已存在的文件")
    s.add_argument("--host", help="bind address (default 0.0.0.0)")
    s.add_argument("--port", type=int, help=f"HTTP port (default {DEFAULT_PROGRESS_PORT})")
    _add_common(s)
    s.set_defaults(func=cmd_serve)

    s = sub.add_parser("upload", help="抽音频上传到远程服务器处理（客户端用）")
    s.add_argument("file", help="本地影片文件")
    s.add_argument("--remote", required=True, help="服务器地址，如 http://10.0.0.20:8300")
    s.add_argument("--kbr", type=int, help=f"opus 码率 kbps (default {REMOTE_AUDIO_KBITRATE})")
    s.add_argument("--lang", help="字幕语言标签 (default zh)")
    s.add_argument("--poll", type=float, default=10, help="轮询间隔秒")
    s.add_argument("--timeout", type=float, default=120, help="单次 HTTP 超时秒")
    s.add_argument("--wait", type=float, default=5400, help="最长等待秒 (default 90 分钟)")
    s.set_defaults(func=cmd_upload)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not getattr(args, "func", None):
        build_parser().print_help()
        print("\n提示: 先按 config/jav_scribe.example.json 写好 ~/.jav_scribe/config.json（或 --config 指定）")
        return 0
    return args.func(args)
