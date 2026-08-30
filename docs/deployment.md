# 部署

JavScribe-Web 只有一个容器（中控室）。车间（JavScribe `serve`）各自跑在 GPU 机器上，
两种形态任选：

## 形态一：单机（web 与车间同一台机器）

```yaml
# docker-compose.yml（节选）
services:
  workshop:                    # JavScribe 车间，配置见 JavScribe 仓库 docker/
    image: javscribe:latest
    # …模型卷、监听目录、GPU 直通
  web:
    image: javscribe-web:latest
    environment:
      JAV_ENGINES: "本地车间=http://workshop:8300"   # compose 网络内寻址
    ports: ["8400:8400"]
    volumes: [javweb-data:/data]
volumes: {javweb-data: {}}
```

## 形态二：多机（一个中控 + N 个车间）

```bash
JAV_ENGINES="车间A=http://<IP_A>:8300,车间B=http://<IP_B>:8300" \
docker compose -f docker/docker-compose.yml up -d --build
```

浏览器打开 `http://<本机IP>:8400`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JAV_ENGINES` | 空 | 出厂车间表：`名称=URL` 逗号分隔；启动时幂等合并，页面可再增删改 |
| `JAV_WEB_PORT` | `8400` | 中控监听端口 |
| `JAV_POLL_INTERVAL_S` | `5` | 轮询车间间隔（秒） |
| `JAV_UPLOAD_MAX_GB` | `10` | 派工单上传原片上限 |
| `JAV_DATA_DIR` | `/data` | 车间表持久化目录（数据卷） |

## 上传两条链路

- **页面派工单**：浏览器把整片传到中控 → 中控抽音轨 → 音轨发给车间。
  适合中控与文件同网段（局域网内秒传）。
- **CLI 远端流程**（跨网络推荐）：`jav-scribe upload 影片.mkv --remote http://<车间>:8300`
  ——在本地抽音轨，只传 ~35MB 的 opus，不传整片。任务同样出现在中控大屏上。

## 安全

本服务**无鉴权**（与车间一致），只应暴露在内网 / VPN。`/api/upload` 可向车间
派发 GPU 任务，暴露面等同车间的 `/upload`。
