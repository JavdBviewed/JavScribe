# JavScribe-Web

**JavScribe 中控室** — 独立 Web 服务：聚合管理 N 台字幕车间（JavScribe `serve` 端点），
浏览器里看进度大屏、上传派单、下载字幕。

> 与 [JavScribe](https://github.com/JavdBviewed/JavScribe)（字幕车间，跑在 GPU 机器上）
> 配套使用。本服务只做「采集与显示 + 派单转发」，不内置模型、不做字幕生成，
> 也不存储影片（上传链路只走提取后的音频轨）。

```
 浏览器 ──▶ JavScribe-Web（中控室: 端点表 + 进度大屏 + 派工单）
                │ 纯 HTTP 轮询 / 转发
     ┌──────────┼──────────┐
     ▼          ▼          ▼
  车间1     车间2     车间N          （每台 = 一个 JavScribe serve 实例）
```

## 两种部署形态

- **单机**：web 与车间跑在同一台机器（一个 compose 两个容器）
- **多机**：一个 web + N 个车间，`JAV_ENGINES` 环境变量参数化预置车间表

详见 [docs/deployment.md](docs/deployment.md)。

## 快速开始（Docker）

```bash
git clone https://github.com/JavdBviewed/JavScribe-Web.git && cd JavScribe-Web
JAV_ENGINES="车间A=http://<车间IP>:8300" docker compose -f docker/docker-compose.yml up -d
# 浏览器打开 http://<本机>:8400
```

## 许可

MIT（见 [LICENSE](LICENSE)）
