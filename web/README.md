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

## 许可

MIT（见 [LICENSE](LICENSE)）
