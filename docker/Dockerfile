# JavScribe server image — JAV subtitle generation (ASR + ja→zh)
#
# Contents:
#   - ChickenRice v1.9 (TransWithAI, MIT): faster-whisper / CTranslate2 (CUDA)
#     + Whisper-Vad-EncDec-ASMR (ONNX) — the subtitle engine
#   - JavScribe (this repo): headless watch + progress API + remote upload service
#
# Model weights are NOT baked into the image. On first boot entrypoint.sh
# downloads them into the /opt/chickenrice/models volume (or place them there
# yourself beforehand). See docs/docker.md.
#
# Build (from the repo root):
#   docker build -f docker/Dockerfile -t javscribe:latest .

# Base already present on the target server (no Docker Hub pull needed).
# The `base` flavor only carries the CUDA driver stub; CTranslate2's pip
# wheel (CUDA build) dlopens cuBLAS 12 from the system at inference time,
# so it is installed from PyPI below and linked into the default path.
ARG CUDA_BASE=nvidia/cuda:12.8.0-base-ubuntu24.04
FROM ${CUDA_BASE}

# ChickenRice release to bake in — bump deliberately.
ARG CHICKENRICE_REF=v1.9
# pypi.org is unreachable on the target network; use the TUNA mirror by default.
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---- ChickenRice (pinned release) ----
WORKDIR /opt
RUN git clone --depth 1 --branch "${CHICKENRICE_REF}" \
        https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice.git \
        chickenrice

# ---- JavScribe patches (applied on top of the pinned ChickenRice) ----
# VAD empty-result fallback: without it, batched inference silently
# degrades to single-stream when the enhanced VAD finds no speech.
COPY docker/chickenrice-patches/ /tmp/chickenrice-patches/
RUN for p in /tmp/chickenrice-patches/*.patch; do \
        (cd /opt/chickenrice && git apply -p1 "$p" && echo "[build] applied ${p##*/}"); \
    done && rm -rf /tmp/chickenrice-patches

WORKDIR /opt/chickenrice
RUN python3 -m pip install --no-cache-dir --index-url ${PIP_INDEX} \
        "faster-whisper>=1.0.0" \
        "ctranslate2>=4.5.0" \
        "transformers>=4.30.0" \
        "librosa>=0.10.0" \
        "onnxruntime>=1.17.0" \
        pyjson5 \
        requests

# cuBLAS 12 runtime for CTranslate2's CUDA wheel: the pip package dlopens
# libcublas.so.12 at inference time and does not bundle it (absent from the
# `base` CUDA image flavor). Install from PyPI and link into /usr/local/lib.
RUN python3 -m pip install --no-cache-dir --index-url ${PIP_INDEX} \
        "nvidia-cublas-cu12>=12.8" \
    && CUBLAS_LIB_DIR=$(find /usr -type d -path "*/nvidia/cublas/lib" 2>/dev/null | head -1) \
    && [ -n "${CUBLAS_LIB_DIR}" ] \
    && ln -sf "${CUBLAS_LIB_DIR}/libcublas.so.12" "${CUBLAS_LIB_DIR}/libcublasLt.so.12" /usr/local/lib/ \
    && ldconfig

# ---- JavScribe (this repo; headless path is stdlib-only, no GUI deps) ----
COPY . /opt/JavScribe
WORKDIR /opt/JavScribe
RUN python3 -m pip install --no-cache-dir --index-url ${PIP_INDEX} .

# ---- Runtime files ----
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/config.server.json /etc/jav-scribe/config.server.json
RUN chmod +x /entrypoint.sh

# Model weights live on a volume (first-boot download or pre-placed files)
VOLUME ["/opt/chickenrice/models"]
EXPOSE 8300

ENTRYPOINT ["/entrypoint.sh"]
CMD ["serve", "--config", "/etc/jav-scribe/config.server.json"]
