# 部署

JavScribe-Web 只有一个容器（字幕工作台）。字幕服务（JavScribe `serve`）各自跑在
GPU 机器上，两种形态任选：

## 形态一：单机（web 与服务同一台机器）

```yaml
# docker-compose.yml（节选）
services:
  service:                    # JavScribe 字幕服务，配置见 JavScribe 仓库 docker/
    image: javscribe:latest
    # …模型卷、监听目录、GPU 直通
    environment:
      JAVSCRIBE_API_KEY: "xxxx"   # 可选：启用 /config 设置管理鉴权
  web:
    image: javscribe-web:latest
    environment:
      JAV_ENGINES: "本地服务=http://service:8300"   # compose 网络内寻址
    ports: ["8400:8400"]
    volumes: [javweb-data:/data]
volumes: {javweb-data: {}}
```

## 形态二：多机（一个工作台 + N 个服务）

```bash
JAV_ENGINES="服务A=http://<IP_A>:8300,服务B=http://<IP_B>:8300" \
docker compose -f docker/docker-compose.yml up -d --build
```

浏览器打开 `http://<本机IP>:8400`。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JAV_ENGINES` | 空 | 出厂服务表：`名称=URL` 逗号分隔；启动时幂等合并，页面可再增删改 |
| `JAV_WEB_PORT` | `8400` | 工作台监听端口 |
| `JAV_POLL_INTERVAL_S` | `5` | 轮询服务间隔（秒） |
| `JAV_UPLOAD_MAX_GB` | `10` | 生成字幕上传原片上限 |
| `JAV_DATA_DIR` | `/data` | 服务登记表持久化目录（数据卷，含各服务 API Key） |

## 上传两条链路

- **页面生成字幕**（2 段式，全程有进度）：
  1. 浏览器把整片传到工作台（本地传输，不跨网络）→ `POST /api/upload` 立即返回
     `202 {upload_id, duration_s, ...}`
  2. 工作台后台提取 16kHz mono opus 音轨（ffmpeg `-progress` 实时进度），完成后把
     音轨 PUT 给服务。前端每 1s 轮询 `GET /api/uploads/{upload_id}` 展示
     `phase: extracting(带 0-1 progress) → dispatching → done(带 job_id)/error`
  适合工作台与文件同网段（局域网内秒传）；跨网络时见下条。
- **CLI 远端流程**（跨网络推荐）：`jav-scribe upload 影片.mkv --remote http://<服务>:8300`
  ——在本地提取音轨，只传 ~35MB 的 opus，不传整片。任务同样出现在工作台看板。

## 服务设置管理（/config）

服务（JavScribe `serve`）提供白名单设置项的读写接口，工作台的服务卡片「⚙ 服务设置」
按 schema 渲染/保存：

- 服务侧：`GET /config`（敏感项打码）/ `PUT /config {"values": {...}}`（类型校验，
  通过后写回配置文件活动 profile 段 + 内存热更，**对之后新提交的任务生效**）。
- 鉴权：请求带 `X-Api-Key`，与服务端 `api.key` 比对——推荐 env
  `JAVSCRIBE_API_KEY`（compose `environment` 或宿主机环境），也可写进配置文件
  `profiles.<活动profile>.api.key`。未设 key → 403；不符 → 401。
  工作台在添加/编辑服务时登记该 Key（只存 `JAV_DATA_DIR` 数据卷，接口不回显明文）。
- 可改项：字幕语言标签/跳过策略/命名、推理设备/模型/日志级别/批量参数、
  AI 润色开关与参数、Emby 开关与地址、JASNA 开关。
  服务器内部项（infer 命令、watch 目录、output_dir 等）不暴露，仍走配置文件。
- 旧版服务镜像没有 /config 端点：工作台会提示「该服务版本过旧，不支持配置管理」。
- 容器化部署注意：容器内配置文件在可写层，PUT 落盘重启后保留、镜像重建后丢失。

工作台代理路由：`GET/PUT /api/engines/{name}/config`（Key 由工作台按服务自动携带）。

其余接口：`GET /api/health`、`GET/POST/PUT/DELETE /api/engines`、`GET /api/jobs`、
`GET /api/jobs/{engine}/{job_id}/result`（代理服务 srt 下载）、
`POST /api/jobs/{engine}/{job_id}/retry`（跳过任务重新生成）。

## 安全

本服务**无鉴权**（与服务一致），只应暴露在内网 / VPN。`/api/upload` 可向服务
派发 GPU 任务，暴露面等同服务的 `/upload`。`/config` 有 `X-Api-Key` 鉴权，
但 Key 是服务级共享密钥，不要随意指派给不可信方。
