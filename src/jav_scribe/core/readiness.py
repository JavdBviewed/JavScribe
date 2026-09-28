"""组件就绪自检（GET /ready，serve 0.2.6+）。

供客户端「服务设置」弹窗一眼确认服务端各组件与模型是否就绪：
模型 / VAD / 特征提取器 / ffmpeg / GPU / 磁盘 / 监听目录 / 润色 / Emby /
音频修复 / 外网代理。

约定：
  - 全部为本地检查（文件存在性 / 命令探测），不做网络探测（LLM/Emby 的
    连通性不在这里验，保持 /ready 毫秒级返回）；连通性由任务级失败体现。
  - 与 /health 同敏感级：无鉴权、仅内网（暴露路径与 GPU 名，与 /jobs 同级）。

status 语义：
  ok   = 就绪
  warn = 可用但需注意（如 auto 设备下无 GPU 会退 CPU、磁盘偏紧）
  fail = 不就绪，任务必然跑不起来
  off  = 不适用（可选组件未启用 / 纯 CPU 模式的 GPU 项）

required 项全部 ok 才算 ready=true。
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

from ..constants import APP_VERSION

# 磁盘告警线：模型 ~3.4GB + 推理临时文件，低于 5GB 提醒
_DISK_WARN_GB = 5.0

# 代理凭据掩码：scheme://user:pass@host → scheme://***@host
_CRED_RE = re.compile(r"^(?P<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*://)(?P<cred>[^/@]+@)")


def _mask_proxy(url: str) -> str:
    return _CRED_RE.sub(lambda m: m.group("scheme") + "***@", url)


def _item(key: str, label: str, status: str, detail: str = "", *, required: bool = False) -> dict:
    return {"key": key, "label": label, "status": status, "detail": detail, "required": required}


def _model_root(cfg: dict[str, Any]) -> Path:
    """infer.cwd（引擎工作目录）；相对模型路径以此为基准。"""
    cwd = str((cfg.get("infer") or {}).get("cwd") or "").strip()
    return Path(cwd) if cwd else Path(".")


def _check_model(cfg: dict[str, Any]) -> dict:
    infer = cfg.get("infer") or {}
    root = _model_root(cfg)
    rel = str(infer.get("model") or "").strip()
    p = Path(rel) if os.path.isabs(rel) else root / rel
    if p.is_dir():
        weights = [f for f in ("model.bin", "model.safetensors") if (p / f).is_file()]
        if weights:
            size_gb = sum((p / f).stat().st_size for f in weights) / 1024 ** 3
            return _item("model", "ASR 主模型", "ok", f"{rel}（{size_gb:.1f} GB）", required=True)
    return _item(
        "model", "ASR 主模型", "fail",
        f"缺失：{rel or '未配置 infer.model'}（请先放置模型；Docker 部署首启由 entrypoint 自动下载）",
        required=True,
    )


def _check_vad(cfg: dict[str, Any]) -> dict:
    p = _model_root(cfg) / "models" / "whisper_vad.onnx"
    if p.is_file():
        return _item("vad", "VAD 语音检测", "ok", f"{p.name}（{p.stat().st_size / 1024 ** 2:.0f} MB）", required=True)
    return _item("vad", "VAD 语音检测", "fail", f"缺失：{p}", required=True)


def _check_feature(cfg: dict[str, Any]) -> dict:
    p = _model_root(cfg) / "models" / "whisper-base"
    if (p / "config.json").is_file():
        return _item("fe", "特征提取器（whisper-base）", "ok", p.name, required=True)
    return _item("fe", "特征提取器（whisper-base）", "fail", f"缺失：{p}/config.json", required=True)


def _check_ffmpeg(cfg: dict[str, Any]) -> dict:
    exe = shutil.which("ffmpeg")
    if exe:
        return _item("ffmpeg", "ffmpeg", "ok", exe, required=True)
    return _item("ffmpeg", "ffmpeg", "fail", "PATH 中未找到 ffmpeg", required=True)


def _check_gpu(cfg: dict[str, Any]) -> dict:
    device = str((cfg.get("infer") or {}).get("device") or "auto")
    if device == "cpu":
        return _item("gpu", "GPU / 驱动", "off", "CPU 模式（无需 GPU）")
    nvidia = shutil.which("nvidia-smi")
    if nvidia:
        try:
            out = subprocess.run([nvidia, "-L"], capture_output=True, text=True, timeout=5)
            if out.returncode == 0:
                lines = [l for l in out.stdout.strip().splitlines() if l.strip()]
                names = "; ".join(dict.fromkeys(l.split(" (UUID:", 1)[0] for l in lines)) or "NVIDIA GPU"
                detail = f"{names}（{len(lines)} 块）"
                return _item("gpu", "GPU / 驱动", "ok", detail, required=(device == "cuda"))
        except (subprocess.SubprocessError, OSError):
            pass
    if device == "cuda":
        return _item("gpu", "GPU / 驱动", "fail", "nvidia-smi 不可用（安装驱动或配置容器 GPU 映射）", required=True)
    return _item("gpu", "GPU / 驱动", "warn", "nvidia-smi 不可用，引擎将自动退回 CPU（慢）")


def _check_disk(cfg: dict[str, Any]) -> dict:
    root = _model_root(cfg)
    try:
        du = shutil.disk_usage(root)
    except OSError:
        return _item("disk", "磁盘空间（模型目录）", "warn", "无法读取磁盘占用")
    free_gb = du.free / 1024 ** 3
    total_gb = du.total / 1024 ** 3
    if free_gb < _DISK_WARN_GB:
        return _item("disk", "磁盘空间（模型目录）", "warn",
                     f"剩余 {free_gb:.1f} GB / 共 {total_gb:.0f} GB（建议 ≥ {_DISK_WARN_GB:.0f} GB）",
                     required=True)
    return _item("disk", "磁盘空间（模型目录）", "ok", f"剩余 {free_gb:.0f} GB / 共 {total_gb:.0f} GB", required=True)


def _check_watch(cfg: dict[str, Any]) -> dict:
    dirs = (cfg.get("watch") or {}).get("dirs") or []
    if not dirs:
        return _item("watch", "监听目录", "off", "未配置（远端/工作台模式可忽略）")
    missing = [str(d) for d in dirs if not Path(d).is_dir()]
    if missing:
        return _item("watch", "监听目录", "warn", "不存在：" + "、".join(missing))
    return _item("watch", "监听目录", "ok", "、".join(str(d) for d in dirs))


def _check_polish(cfg: dict[str, Any]) -> dict:
    p = cfg.get("polish") or {}
    if not p.get("enabled"):
        return _item("polish", "AI 润色（LLM）", "off", "未启用")
    missing = [n for n, v in (("地址", p.get("base_url")), ("模型", p.get("model"))) if not str(v or "").strip()]
    if missing:
        return _item("polish", "AI 润色（LLM）", "warn", "配置不全：" + " / ".join(missing) + "（不探测连接）")
    return _item("polish", "AI 润色（LLM）", "ok", f"{p.get('base_url')} · {p.get('model')}（不探测连接）")


def _check_emby(cfg: dict[str, Any]) -> dict:
    e = cfg.get("emby") or {}
    if not e.get("enabled"):
        return _item("emby", "Emby 刷新", "off", "未启用")
    missing = [n for n, v in (("地址", e.get("url")), ("API Key", e.get("api_key"))) if not str(v or "").strip()]
    if missing:
        return _item("emby", "Emby 刷新", "warn", "配置不全：" + " / ".join(missing) + "（不探测连接）")
    return _item("emby", "Emby 刷新", "ok", str(e.get("url")) + "（不探测连接）")


def _check_jasna(cfg: dict[str, Any]) -> dict:
    j = cfg.get("jasna") or {}
    if not j.get("enabled"):
        return _item("jasna", "音频修复（JASNA）", "off", "未启用")
    if not str(j.get("command") or "").strip():
        return _item("jasna", "音频修复（JASNA）", "warn", "已启用但未配置命令")
    return _item("jasna", "音频修复（JASNA）", "ok", "命令已配置")


def _check_proxy() -> tuple[dict, Optional[str]]:
    """外网代理：JAV_PROXY 优先，其次标准 HTTPS/HTTP_PROXY。"""
    for var in ("JAV_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        val = (os.environ.get(var) or "").strip()
        if val:
            item = _item("proxy", "外网代理", "ok", _mask_proxy(val) + "（局域网/内网自动豁免）")
            return item, val
    return _item("proxy", "外网代理", "off", "直连（未配置代理）"), None


def build_readiness_report(cfg: dict[str, Any]) -> dict[str, Any]:
    """汇总各组件状态。cfg = 活动 profile 段（与 /health 同口径）。"""
    proxy_item, proxy = _check_proxy()
    items: list[dict] = [
        _check_model(cfg),
        _check_vad(cfg),
        _check_feature(cfg),
        _check_ffmpeg(cfg),
        _check_gpu(cfg),
        _check_disk(cfg),
        _check_watch(cfg),
        _check_polish(cfg),
        _check_emby(cfg),
        _check_jasna(cfg),
        proxy_item,
    ]
    ready = all(it["status"] == "ok" for it in items if it["required"])
    return {
        "ok": True,
        "ready": ready,
        "version": APP_VERSION,
        "device": str((cfg.get("infer") or {}).get("device") or "auto"),
        "proxy": _mask_proxy(proxy) if proxy else None,
        "items": items,
    }
