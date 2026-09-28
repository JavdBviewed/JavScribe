#!/usr/bin/env bash
# JavScribe container entrypoint: first-boot model bootstrap, then the service.
set -euo pipefail

MODELS_DIR=/opt/chickenrice/models
MAIN_MODEL=whisper-large-v2-translate-zh-v0.2-st-ct2
DATA_DIR=/opt/jav-scribe

# 持久化数据目录（compose bind 到宿主机）：config + 上传音轨/字幕缓存（inbox）。
# 首启把镜像内置 config 播种进来；之后 /config 的修改与上传缓存都落在这里，
# 跨镜像重建不丢。
mkdir -p "${DATA_DIR}/inbox"
if [[ ! -f "${DATA_DIR}/config.server.json" ]]; then
  cp /etc/jav-scribe/config.server.json "${DATA_DIR}/config.server.json"
fi

# ---- 外网代理（可选）：首启下载模型 + 容器内所有出站请求（如公共 LLM API）----
# JAV_PROXY    完整代理地址，如 http://192.168.0.1:10808（支持账号密码）
# JAV_NO_PROXY 追加的 NO_PROXY 条目（逗号分隔）；局域网/内网 CIDR 默认自动豁免，
#              因此 Emby / 本地 Ollama 等内网地址不受代理影响。
if [[ -n "${JAV_PROXY:-}" ]]; then
  export HTTP_PROXY="$JAV_PROXY" HTTPS_PROXY="$JAV_PROXY"
  export http_proxy="$JAV_PROXY" https_proxy="$JAV_PROXY"
  export NO_PROXY="${JAV_NO_PROXY:-}:localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
  export no_proxy="$NO_PROXY"
  echo "[entrypoint] JAV_PROXY in effect: ${JAV_PROXY}（内网/局域网经 NO_PROXY 自动豁免）"
fi

cd /opt/chickenrice
mkdir -p "${MODELS_DIR}"

if [[ ! -f "${MODELS_DIR}/whisper_vad.onnx" \
   || ! -d "${MODELS_DIR}/whisper-base" \
   || ! -f "${MODELS_DIR}/${MAIN_MODEL}/model.bin" ]]; then
  echo "[entrypoint] Models incomplete in ${MODELS_DIR} — downloading from HuggingFace (~3.4 GB)..."
  python3 download_models.py
  python3 download_models.py --hf-model "chickenrice0721/${MAIN_MODEL}"
  echo "[entrypoint] Model download finished."
else
  echo "[entrypoint] Models present in ${MODELS_DIR}, skipping download."
fi

exec jav-scribe "$@"
