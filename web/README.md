# JavScribe-Web

**JavScribe 字幕工作台** — 独立 Web 服务：聚合管理 N 台字幕服务（JavScribe `serve` 端点），
浏览器里看进度看板、上传生成字幕、下载字幕、管理服务端设置项。

> 与 [JavScribe](https://github.com/JavdBviewed/JavScribe)（字幕服务，跑在 GPU 机器上）
> 配套使用。本服务只做「采集与显示 + 生成转发」，不内置模型、不做字幕生成，
> 也不存储影片（上传链路只走提取后的音频轨）。

```
 浏览器 ──▶ JavScribe-Web（字幕工作台: 服务表 + 进度看板 + 生成字幕）
                │ 纯 HTTP 轮询 / 转发
     ┌──────────┼──────────┐
     ▼          ▼          ▼
  服务1     服务2     服务N          （每台 = 一个 JavScribe serve 实例）
```

## 两种部署形态

- **单机**：web 与服务跑在同一台机器（一个 compose 两个容器）
- **多机**：一个 web + N 个服务，`JAV_ENGINES` 环境变量参数化预置服务表

详见 [docs/deployment.md](docs/deployment.md)。

## 快速开始（Docker）

```bash
git clone https://github.com/JavdBviewed/JavScribe.git && cd JavScribe/web
JAV_ENGINES="服务A=http://<服务IP>:8300" docker compose -f docker/docker-compose.yml up -d
# 浏览器打开 http://<本机>:8400
```

## 服务设置管理

服务卡片上的「⚙ 服务设置」可按 schema 读取/修改服务端白名单设置项
（字幕语言、跳过策略、推理设备/模型、AI 润色、Emby 等），敏感项打码。
需在服务端设置 `JAVSCRIBE_API_KEY`，并在添加/编辑服务时登记同一个 Key
（`X-Api-Key` 鉴权；旧版服务镜像会提示版本过旧）。详见
[docs/deployment.md](docs/deployment.md)。

## 文件夹扫描与批量生成

「生成字幕」区支持三种投喂方式，共用同一个服务选择：

- **拖入/选择单个文件**：本机提取音轨后只把 opus 发给服务（原流程）。
- **选择文件夹**（浏览器本地）：`<input webkitdirectory>` 选中整个文件夹，
  浏览器内按扩展名过滤视频并识别同目录 `<片名>.zh.srt / <片名>.srt`，
  chip 显示「N 个视频（M 个已有字幕，将跳过）」，开始后**顺序**逐个走单文件
  上传链路（文件 1/N · 2/N …），后端零改动。需要 Chrome/Edge/Safari
  （Firefox 不支持目录选择）。
- **扫描服务机器上的目录**：填服务运行机器上的绝对路径（如 BT/PT 落地目录
  `/media/jav`），服务按 `scan.*` 规则列出视频并标记「已有字幕」，勾选后
  一键批量入队。扫描规则（视频扩展名、字幕判定后缀、是否递归）在
  「⚙ 服务设置」里热调，对新扫描立即生效。

> 浏览器只能访问**本地电脑**上的文件夹；服务端的 `/scan` 只能访问
> **服务所在机器**上的目录，两者不可跨机。

## 许可

MIT（见 [LICENSE](LICENSE)）
