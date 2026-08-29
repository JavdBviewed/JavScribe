#!/usr/bin/env bash
# JavScribe container entrypoint: first-boot model bootstrap, then the service.
set -euo pipefail

MODELS_DIR=/opt/chickenrice/models
MAIN_MODEL=whisper-large-v2-translate-zh-v0.2-st-ct2

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
