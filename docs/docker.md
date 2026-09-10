# Docker 部署（GPU 服务器）

一个容器 = ChickenRice 引擎（faster-whisper/CTranslate2 + ASMR-VAD）+ JavScribe
服务（目录监听 + 进度 API + 远端上传）。模型不进镜像：首启自动下载到宿主机
volume，也可以先手动放好（见下）。

## 前置条件

- Docker + compose v2 + nvidia-container-toolkit
  （自检：`docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi`）
- 驱动 ≥ 525（ctranslate2 的 pip wheel 自带 CUDA 12 运行时）
- 显存 ≥ 8G 可用（gpu_batch × 8，可与其他服务共卡）
- 磁盘 ≥ 15G（镜像 ~6G + 模型 ~3.4G）
- 构建期网络：apt 源 + pip 源可达（默认走清华 pip 镜像）；模型下载走
  HuggingFace，服务器访问不了时按下面"离线放置模型"手动准备。

## 离线放置模型（服务器访问不了 HF 时）

在有网的机器上按 `models/` 结构下载（ChickenRice 的 download_models.py 原生
支持，HF 不可达时自动回退 hf-mirror）：

```bash
git clone https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice
cd Faster-Whisper-TransWithAI-ChickenRice
python download_models.py                                  # VAD + whisper-base 配置
python download_models.py --hf-model chickenrice0721/whisper-large-v2-translate-zh-v0.2-st-ct2
```

把 `models/` 整个目录上传到宿主机 `/opt/jav-scribe/models/`，结构必须为：

```
models/
├── whisper_vad.onnx
├── whisper_vad_metadata.json
├── whisper-large-v2-translate-zh-v0.2-st-ct2/   # model.bin 等 5 个文件
└── whisper-base/                                 # 4 个 json 配置
```

## 部署步骤

镜像由 CI 发布到 GitHub Container Registry（`serve-v*` tag 触发，见
`.github/workflows/docker-image.yml`），服务器只拉镜像，不用本地构建。

```bash
# 1. 代码（compose 文件所在；镜像走 ghcr 拉取）
git clone https://github.com/JavdBviewed/JavScribe.git /opt/JavScribe && cd /opt/JavScribe

# 2. 拉镜像并启动（JAV_WATCH_DIR 改成你的影片落盘目录）
export JAV_WATCH_DIR=/your/media/dir
docker compose -f docker/docker-compose.yml pull
docker compose -f docker/docker-compose.yml up -d
```

指定版本：把 compose 里 `image:` 的 `latest` 改成 `v0.1.3` 这类具体 tag
（`ghcr.io/javdbviewed/jav-scribe-serve:v0.1.3`），升级 = 改 tag → `pull` → `up -d`。

本地构建（离线 / 需要改引擎版本 CHICKENRICE_REF 时）：`up -d --build`。

可选环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `JAV_WATCH_DIR` | `/media/jav` | 监听目录（BT/PT 落盘处），`.zh.srt` 生成在同级 |
| `JAV_MODELS_DIR` | `/opt/jav-scribe/models` | 模型权重存放目录（volume） |
| `JAV_PORT` | `8300` | 进度/上传 API 宿主机端口 |
| `JAV_DATA_DIR` | `/opt/jav-scribe/data` | 持久化数据目录（`/config` 设置 + 上传音轨/字幕缓存 inbox），跨镜像重建不丢 |
| `JAVSCRIBE_API_KEY` | 空 | `/config` 设置接口鉴权 Key（不设则 /config 不可用，上传/进度不受影响） |
| `JAVSCRIBE_HOST_ROOT` | 空 | 设 `/hostfs` 后 `/scan` 可解析容器外宿主机路径 |

上传缓存：`PUT /upload` 按内容寻址存到数据目录 `inbox/<sha1>.<ext>`，同内容只存一份；
客户端/工作台上传前会先 `GET /cache/check` 预检，命中直接 `POST /upload/submit` 建任务
（免传字节）。缓存与 `.zh.srt` 一起受「缓存保留天数」（默认 7 天 + 活跃任务保护）清理。

## 验证

```bash
docker logs -f jav-scribe        # 首启会先下模型（~3.4G），之后看到 "进度接口: http://...:8300"
curl http://127.0.0.1:8300/health
nvidia-smi                       # 处理任务时显存约 4–6G
```

## 日常使用

- 影片丢进 `JAV_WATCH_DIR` → 自动处理 → 同级出现 `<片名>.zh.srt`（Emby 扫描即可挂上）
- 进度：`curl http://<服务器>:8300/jobs`，单个任务 `/jobs/<id>`（含每个文件的时间轴进度）
- 远端影片（客户端）：`jav-scribe upload 电影.mp4 --remote http://<服务器>:8300`
  （本地抽 opus 音频上传，服务器翻译，srt 回传下载）

## 常用操作

```bash
# 升级到新版 CI 镜像
cd /opt/JavScribe && git pull
docker compose -f docker/docker-compose.yml pull
docker compose -f docker/docker-compose.yml up -d

# 手动跑单个文件（不走监听）
docker exec -it jav-scribe jav-scribe run /media/jav/xxx.mp4 --config /etc/jav-scribe/config.server.json

# 日志（引擎 DEBUG 输出，含每文件翻译进度）
docker logs -f jav-scribe
```

## 安全

- 8300 端口**无鉴权**：`PUT /upload` 会接收任意音频并提交处理，`GET /jobs` 暴露任务与文件路径。
  只暴露给 VPN/内网；必须对外时前面加一层带鉴权的反代。
- compose 默认把宿主机根**只读**挂载在容器 `/hostfs`（`${JAV_HOSTFS:-/}:/hostfs:ro`），
  用于 `/scan` 的宿主机路径映射（`JAVSCRIBE_HOST_ROOT=/hostfs` 时启用，需 API Key）。
  只读、不写不执行；不需要该能力时可删掉这行卷映射。
