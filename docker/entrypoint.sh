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
