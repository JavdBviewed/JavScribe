# JavScribe-Web control room image (no GPU required — runs on any node).
#
# The base defaults to nvidia/cuda:12.8.0-base-ubuntu24.04: already present on
# the reference server, so no Docker Hub pull is needed. If your network can
# pull Docker Hub directly, use a smaller base:
#   docker build --build-arg BASE_IMAGE=python:3.12-slim -f docker/Dockerfile .

ARG BASE_IMAGE=nvidia/cuda:12.8.0-base-ubuntu24.04
FROM ${BASE_IMAGE}

# pypi.org is unreachable on the reference network; use the TUNA mirror.
ARG PIP_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    TZ=Asia/Shanghai

# ffmpeg is needed for server-side audio track extraction (派工单 upload path)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 python3-pip ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md LICENSE ./
COPY src ./src
RUN python3 -m pip install --no-cache-dir --index-url ${PIP_INDEX} .

# Engine registry persistence (engines added via the web page)
VOLUME ["/data"]
EXPOSE 8400

ENTRYPOINT ["jav-scribe-web"]
