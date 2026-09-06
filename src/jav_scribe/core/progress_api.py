"""Progress / remote-job HTTP API (stdlib only).

Endpoints (all JSON unless noted):
  GET  /health                 -> {ok, version, profile, device, jobs}
  GET  /jobs                   -> list of job summaries
  GET  /jobs/<id>              -> job detail (per-file status/progress/position)
  GET  /jobs/<id>/result       -> raw bytes of the primary finished SRT
  POST /jobs/<id>/retry       -> re-queue SKIPPED files (force regenerate)
  PUT  /upload?source=<name>   -> body = audio bytes; creates a remote job
                                   (X-Source-Name header or ?source=, ?ext=)
  GET  /jobs/<id>/result.srt   -> alias of /result
  GET  /config                 -> manageable settings (X-Api-Key required)
  PUT  /config                 -> {"values": {path: value}} whitelist-validated
                                   (X-Api-Key required); persists to the config
                                   file (active profile section) + hot-applies
                                   to in-memory cfg for subsequent jobs.
  GET  /scan?path=<dir>        -> video files under a local directory with
                                   subtitle detection (X-Api-Key required)
  POST /scan/submit            -> {"files": [abs paths]} queue local videos
                                   (X-Api-Key required)

Used for: watching progress from a browser/`curl` on the server box, and the
remote flow (the client extracts audio with ffmpeg and PUTs it here; only
audio crosses the network, ~30-80MB per 2.5h movie).

Config API auth: `X-Api-Key` header must equal `api.key` (env
`JAVSCRIBE_API_KEY` preferred, config file as fallback; see config/loader.py).
When the service has no key set, /config returns 403. Other endpoints stay
unauthenticated (LAN policy).
"""
from __future__ import annotations

import hmac
import json
import re
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from ..constants import APP_NAME, APP_VERSION
from . import retention as retentionlib
from . import scan as scanlib

if TYPE_CHECKING:
    from .engine import Engine

MAX_UPLOAD_MB = 400

# ---------------------------------------------------------------------------
# /config whitelist
#
# Every item here is read by the engine *per job* (infer command build,
# finalize, polish, emby refresh), so updates take effect for jobs submitted
# afterwards; running jobs are untouched. Server-internal settings
# (infer.command/cwd/extra_args, watch.*, progress.*, subtitle.output_dir)
# are deliberately NOT exposed.
#
# (path, label, type, options|None, secret)
# ---------------------------------------------------------------------------
CONFIG_ITEMS: list[tuple[str, str, str, Optional[list[str]], bool]] = [
    ("subtitle.lang_tag", "字幕语言标签", "string", None, False),
    ("subtitle.skip_if_exists", "字幕已存在时跳过", "bool", None, False),
    ("subtitle.overwrite", "覆盖已存在字幕", "bool", None, False),
    ("subtitle.naming", "输出命名方式", "enum", ["rename", "keep"], False),
    ("infer.device", "推理设备", "enum", ["auto", "cpu", "cuda"], False),
    ("infer.model", "字幕模型", "string", None, False),
    ("infer.log_level", "日志级别", "enum", ["DEBUG", "INFO", "WARNING", "ERROR"], False),
    ("infer.batch", "批量推理", "bool", None, False),
    ("infer.max_batch_size", "批处理大小", "int", None, False),
    ("vad.threshold", "VAD 语音检测阈值", "float", None, False),
    ("polish.enabled", "启用 AI 润色", "bool", None, False),
    ("polish.base_url", "润色服务地址", "string", None, False),
    ("polish.model", "润色模型", "string", None, False),
    ("polish.batch_lines", "润色批行数", "int", None, False),
    ("polish.api_key", "润色 API Key", "secret", None, True),
    ("emby.enabled", "启用 Emby 刷新", "bool", None, False),
    ("emby.url", "Emby 地址", "string", None, False),
    ("emby.api_key", "Emby API Key", "secret", None, True),
    ("jasna.enabled", "启用音频修复（JASNA）", "bool", None, False),
    ("scan.video_exts", "视频扩展名（逗号分隔）", "list", None, False),
    ("scan.subtitle_patterns", "已有字幕判定后缀（逗号分隔）", "list", None, False),
    ("scan.recurse", "扫描时进入子目录", "bool", None, False),
    ("storage.retention_days", "缓存保留天数（音轨/字幕）", "int", None, False),
]

CONFIG_SPEC = {path: (label, ftype, options, secret) for path, label, ftype, options, secret in CONFIG_ITEMS}

_LANG_TAG_RE = re.compile(r"^[A-Za-z0-9]{2,16}$")


class ConfigError(ValueError):
    """PUT /config payload rejected (unknown path / bad type / bad value)."""


def validate_config_updates(values: dict[str, Any]) -> list[tuple[str, str, Any]]:
    """Validate a {path: value} dict against CONFIG_ITEMS.

    Returns the accepted updates as [(section, key, value), ...] (ordered as
    given). Secret paths with an empty string mean "keep current" and are
    dropped. Raises ConfigError on the first problem.
    """
    if not isinstance(values, dict):
        raise ConfigError("values 必须是对象 {path: value}")
    out: list[tuple[str, str, Any]] = []
    for path, value in values.items():
        spec = CONFIG_SPEC.get(path)
        if spec is None:
            raise ConfigError(f"不支持的配置项: {path}")
        _label, ftype, options, secret = spec
        if ftype == "bool":
            if not isinstance(value, bool):
                raise ConfigError(f"{path} 需要布尔值")
        elif ftype == "int":
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ConfigError(f"{path} 需要正整数")
            if path == "infer.max_batch_size" and value > 128:
                raise ConfigError(f"{path} 最大 128")
            if path == "polish.batch_lines" and value > 1000:
                raise ConfigError(f"{path} 最大 1000")
            if path == "storage.retention_days" and value > 3650:
                raise ConfigError(f"{path} 最大 3650")
        elif ftype == "float":
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ConfigError(f"{path} 需要数字")
            v = float(value)
            if not (0.01 <= v <= 0.99):
                raise ConfigError(f"{path} 需在 0.01 ~ 0.99 之间")
            value = v
        elif ftype == "enum":
            if not isinstance(value, str) or value not in (options or []):
                raise ConfigError(f"{path} 需要取值为 {options} 之一")
        elif ftype == "secret":
            if not isinstance(value, str) or len(value) > 512:
                raise ConfigError(f"{path} 需要字符串（≤512 字符）")
            if value == "":
                continue  # empty = keep current
        elif ftype == "list":
            try:
                if path == "scan.video_exts":
                    value = scanlib.normalize_video_exts(value)
                elif path == "scan.subtitle_patterns":
                    value = scanlib.normalize_subtitle_patterns(value)
                else:  # 通用 list（预留）
                    raise scanlib.ScanError(f"{path} 暂不支持列表更新")
            except scanlib.ScanError as ex:
                raise ConfigError(str(ex))
        else:  # string
            if not isinstance(value, str):
                raise ConfigError(f"{path} 需要字符串")
            value = value.strip()
            if len(value) > 512:
                raise ConfigError(f"{path} 过长（≤512 字符）")
            if path == "subtitle.lang_tag" and not _LANG_TAG_RE.match(value):
                raise ConfigError("subtitle.lang_tag 需要 2-16 位字母数字（如 zh / ja）")
        section, key = path.split(".", 1)
        out.append((section, key, value))
    return out


def build_config_view(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """Current values for the GET /config view; secret items are masked."""
    items: list[dict[str, Any]] = []
    for path, label, ftype, options, secret in CONFIG_ITEMS:
        section, key = path.split(".", 1)
        cur = (cfg.get(section) or {}).get(key)
        if secret:
            value = "***" if (isinstance(cur, str) and cur) else ""
        else:
            value = cur
        item: dict[str, Any] = {"path": path, "label": label, "type": ftype, "value": value}
        if options is not None:
            item["options"] = options
        if secret:
            item["secret"] = True
        items.append(item)
    return items


def apply_config_updates(cfg: dict[str, Any], updates: list[tuple[str, str, Any]]) -> None:
    """Hot-apply updates to the in-memory cfg dict (read per job by engine)."""
    for section, key, value in updates:
        cfg.setdefault(section, {})[key] = value


def persist_config_updates(
    config_path: Path, profile: str, updates: list[tuple[str, str, Any]]
) -> None:
    """Write updates into the config file under the active profile section."""
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ConfigError("配置文件结构异常（顶层不是对象）")
    profiles = raw.get("profiles")
    if isinstance(profiles, dict) and profile in profiles and isinstance(profiles[profile], dict):
        target = profiles[profile]
    else:
        target = raw
    for section, key, value in updates:
        sec = target.get(section)
        if not isinstance(sec, dict):
            sec = {}
            target[section] = sec
        sec[key] = value
    tmp = config_path.with_name(config_path.name + ".tmp")
    tmp.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(config_path)


class _Handler(BaseHTTPRequestHandler):
    engine: "Engine"  # set by ProgressHTTP
    profile: str = ""
    inbox_dir: Path
    config_path: Optional[Path] = None

    def log_message(self, fmt: str, *args) -> None:  # quieter default logging
        self.engine.log(f"[http] {self.address_string()} {fmt % args}")

    # -- helpers ---------------------------------------------------------
    def _send(self, code: int, payload, ctype: str = "application/json") -> None:
        if isinstance(payload, (dict, list)):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        elif isinstance(payload, str):
            data = payload.encode("utf-8")
        else:
            data = bytes(payload)
        self.send_response(code)
        self.send_header("Content-Type", f"{ctype}; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _check_api_key(self) -> bool:
        """X-Api-Key gate for /config. False means an error was already sent."""
        expected = str((self.engine.cfg.get("api") or {}).get("key") or "")
        if not expected:
            self._send(403, {"ok": False, "error": "服务未设置 API Key（JAVSCRIBE_API_KEY）"})
            return False
        got = self.headers.get("X-Api-Key") or ""
        if not hmac.compare_digest(got, expected):
            self._send(401, {"ok": False, "error": "API Key 不正确"})
            return False
        return True

    def _read_json_body(self, max_bytes: int = 1024 * 1024) -> Optional[dict]:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > max_bytes:
            self._send(400, {"ok": False, "error": f"bad body size (max {max_bytes // 1024}KB)"})
            return None
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send(400, {"ok": False, "error": "body 不是合法 JSON"})
            return None
        if not isinstance(body, dict):
            self._send(400, {"ok": False, "error": "body 必须是 JSON 对象"})
            return None
        return body

    # -- GET -------------------------------------------------------------
    def do_GET(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        if not parts or parts[0] == "health":
            e = self.engine
            self._send(
                200,
                {
                    "ok": True,
                    "app": APP_NAME,
                    "version": APP_VERSION,
                    "profile": self.profile,
                    "device": e.cfg.get("infer", {}).get("device", "auto"),
                    "jobs": [j.to_dict() for j in e.jobs],
                },
            )
            return
        if len(parts) == 1 and parts[0] == "config":
            if not self._check_api_key():
                return
            self._send(200, {"ok": True, "profile": self.profile, "items": build_config_view(self.engine.cfg)})
            return
        if len(parts) == 1 and parts[0] == "scan":
            if not self._check_api_key():
                return
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            raw = (q.get("path") or [""])[0]
            try:
                root, mapped = scanlib.resolve_scan_root(raw)
                result = scanlib.scan_dir(root, self.engine.cfg)
            except scanlib.ScanError as ex:
                self._send(400, {"ok": False, "error": str(ex)})
                return
            self._send(200, {"ok": True, "mapped": mapped, **result})
            return
        if parts[0] == "jobs":
            if len(parts) == 1:
                self._send(200, [j.to_dict() for j in self.engine.jobs])
                return
            job = self.engine.job_by_id(parts[1])
            if job is None:
                self._send(404, {"ok": False, "error": "job not found"})
                return
            if len(parts) >= 3 and parts[2] in ("result", "result.srt"):
                data = self.engine.result_srt_bytes(job)
                if data is None:
                    self._send(404, {"ok": False, "error": "no result srt yet"})
                else:
                    self._send(200, data, "text/plain")
                return
            self._send(200, job.to_dict(detail=True))
            return
        self._send(404, {"ok": False, "error": "not found"})

    # -- POST /jobs/<id>/retry + /scan/submit ---------------------------------
    def do_POST(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 2 and parts[0] == "scan" and parts[1] == "submit":
            if not self._check_api_key():
                return
            body = self._read_json_body()
            if body is None:
                return
            try:
                files = scanlib.validate_submit_files(body.get("files"), self.engine.cfg)
            except scanlib.ScanError as ex:
                self._send(400, {"ok": False, "error": str(ex)})
                return
            job = self.engine.submit(
                files, source_kind="local", label=f"文件夹扫描 · {len(files)} 项"
            )
            self._send(201, {"ok": True, "job_id": job.id, "files": len(files)})
            return
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "retry":
            if self.engine.job_by_id(parts[1]) is None:
                self._send(404, {"ok": False, "error": "job not found（任务不存在或已过期）"})
                return
            job = self.engine.retry_job(parts[1])
            if job is None:
                self._send(409, {"ok": False, "error": "no retryable file（无跳过的文件，或任务已过期）"})
            else:
                self._send(201, {"ok": True, "job_id": job.id})
            return
        self._send(404, {"ok": False, "error": "not found"})

    # -- PUT /upload ------------------------------------------------------
    def do_PUT(self) -> None:
        parts = self.path.split("?")[0].strip("/").split("/")
        if len(parts) == 1 and parts[0] == "config":
            if not self._check_api_key():
                return
            body = self._read_json_body()
            if body is None:
                return
            values = body.get("values")
            if values is None:
                self._send(400, {"ok": False, "error": "缺少 values 字段"})
                return
            try:
                updates = validate_config_updates(values)
            except ConfigError as ex:
                self._send(400, {"ok": False, "error": str(ex)})
                return
            if updates:
                if self.config_path is None or not self.config_path.is_file():
                    self._send(500, {"ok": False, "error": "未找到配置文件，无法持久化"})
                    return
                try:
                    persist_config_updates(self.config_path, self.profile, updates)
                except (OSError, ConfigError, json.JSONDecodeError) as ex:
                    self._send(500, {"ok": False, "error": f"写入配置文件失败: {ex}"})
                    return
                apply_config_updates(self.engine.cfg, updates)
            self._send(
                200,
                {"ok": True, "updated": [f"{s}.{k}" for s, k, _ in updates]},
            )
            return
        if not self.path.startswith("/upload"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        q = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_UPLOAD_MB * 1024 * 1024:
            self._send(400, {"ok": False, "error": f"bad body size (max {MAX_UPLOAD_MB}MB)"})
            return
        body = self.rfile.read(length)
        source_name = (
            self.headers.get("X-Source-Name")
            or (q.get("source") or ["remote"])[0]
        )
        ext = (q.get("ext") or ["opus"])[0].lstrip(".")
        self.inbox_dir.mkdir(parents=True, exist_ok=True)
        safe = "".join(c for c in source_name if c.isalnum() or c in "._-") or "remote"
        audio_path = self.inbox_dir / f"{safe}.{ext}"
        audio_path.write_bytes(body)
        job = self.engine.submit_remote_files([audio_path], source_name=source_name)
        self._send(201, {"ok": True, "job_id": job.id, "file": audio_path.name})


class ProgressHTTP:
    def __init__(
        self,
        engine: "Engine",
        host: str = "0.0.0.0",
        port: int = 8300,
        profile: str = "",
        inbox_dir: Optional[Path] = None,
        config_path: Optional[Path] = None,
    ) -> None:
        self.engine = engine
        self.profile = profile
        self.inbox_dir = inbox_dir or (Path.home() / ".jav_scribe" / "inbox")
        self.config_path = config_path
        h = _Handler
        h.engine = engine
        h.profile = profile
        h.inbox_dir = self.inbox_dir
        h.config_path = config_path
        self.server = ThreadingHTTPServer((host, port), h)
        self.thread: threading.Thread | None = None
        self.host, self.port = host, port

    def start(self) -> None:
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()
        self.engine.log(f"[progress] HTTP 服务已启动 http://{self.host}:{self.port} (health/jobs/upload/config)")
        # inbox 缓存清理（音轨/字幕，storage.retention_days 热调；见 core/retention.py）
        self.retention_thread = threading.Thread(
            target=retentionlib.retention_loop,
            args=(self.engine, self.inbox_dir),
            daemon=True,
        )
        self.retention_thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
