# 部署教程

一套代码、多份 profile 配置：`--profile <name>` 切换（默认读配置文件的
`profile` 字段；`config/jav_scribe.example.json` 内置 `local` / `server` 两套示例）。

## 通用步骤

1. 安装 [uv](https://docs.astral.sh/uv/) 与 ffmpeg
2. 按 [docs/models.md](models.md) 准备字幕引擎与模型（方案 A 发布包 / 方案 B Python 源码）
3. 建配置：

```bash
# Linux
cp config/jav_scribe.example.json ~/.jav_scribe/config.json
# Windows
copy config\jav_scribe.example.json %USERPROFILE%\.jav_scribe\config.json
```

按需修改 `infer.command` / `infer.model` / `watch.dirs` / `emby`。

## 本地：GUI（Windows，拖拽批处理）

```bat
uv sync --extra gui
run.bat
```

拖入影片或目录即可，带进度条、引擎日志、JASNA 修复面板（GUI 模式可用）。

## 本地：headless（任意系统）

```bash
uv run jav-scribe run "D:\Videos\JAV" --profile local   # 一次性批处理（文件/目录，目录递归）
uv run jav-scribe watch --profile local                  # 常驻监听 watch.dirs
```

Windows 可用任务计划程序配置开机自启 `watch`（headless 无 GUI 依赖，CPU 即可跑）。

## 服务器：Docker（NVIDIA GPU，推荐）

见 [docs/docker.md](docker.md)：一条命令构建启动，模型首启自动下载（或离线放置）。

## 服务器：手动（非 Docker）

```bash
git clone https://github.com/JavdBviewed/JavScribe && cd JavScribe && uv sync
# 按 docs/models.md 方案 B 准备引擎与模型
uv run jav-scribe serve --profile server     # 监听 watch.dirs + 进度接口 :8300
```

## 远端处理（本地算力不够时）

```bash
jav-scribe upload "影片.mkv" --remote http://<服务器>:8300
```

流程：本地 ffmpeg 抽 16kHz opus 音频（2.5h 影片约 30–80MB）→ PUT 到服务器 →
服务器 ASR + 翻译 → SRT 回传并落到本地影片同目录。**不传整片。**

## 进度接口

```bash
curl http://<服务器>:8300/health
curl http://<服务器>:8300/jobs             # 所有任务
curl http://<服务器>:8300/jobs/<id>        # 逐文件：状态/进度/已翻到第几分钟
curl http://<服务器>:8300/jobs/<id>/result # 下载该任务的 SRT
```

## 安全提示

8300 端口接口（进度 + 上传）**无鉴权**（v0.1）：`PUT /upload` 会接收音频并提交
处理，`GET /jobs` 暴露任务与文件路径。只暴露给内网/VPN；必须对外时在前面加
一层带鉴权的反向代理。
