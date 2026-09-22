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

## 文件夹扫描（「扫描目录」）

**架构契约（2026-09-22 定稿）**：服务端（serve）只负责模型/模型渠道对接与处理
客户端上传的音轨，**不做任何文件交互**；用户侧文件夹交互全部由客户端承担，
且分两条路径、分属两台机器：

- **选择文件夹** = **浏览器所在机器**（File System Access API 物理约束）；
  原片不出该电脑，前端本地提取音轨后只上传 opus。
- **扫描目录** = **工作台（本页面服务）部署所在机器**：服务端按规则列出目录内
  视频、勾选入队，工作台直接读本机视频提 opus 派发给所选服务，**完成后字幕由
  工作台自动写回本机影片旁**（不占浏览器下载、不依赖用户在场）。

### Web 形态端点

- `GET /api/scan/local?engine=<服务>&path=<绝对路径>` → 按扫描规则列出视频
  （`{path, items[…], truncated, mapped, rules}`，上限 5000 项）；每项含字幕
  三态 `subtitle_status: external / embedded / none`（外部 srt 与内嵌轨都探测，
  内嵌轨走 ffprobe 并行探测，缺 ffprobe 时自动降级为仅外部判定）。
  扫描规则优先取所选服务的 `/config`（与「服务设置」同源），服务不可达时退回
  内置默认（`rules: "engine" | "defaults"` 可辨）。
- `POST /api/scan/local/submit {"engine": <服务>, "files": [绝对路径...]}` →
  200 `{ok, files, upload_ids}`；每个文件 = 独立上传任务 + 独立服务端 job
  （复用音轨上传链路，含 sha1 内容缓存免传）。完成后字幕自动落回影片旁，
  状态经 `GET /api/jobs` 行的 `writeback` 字段 / 任务表标签展示
  （`ok` 已落回 / `skipped_exists` 已存在不覆盖 / `skipped` 生成被跳过 /
  `failed:…` 回写失败）。

### 容器化部署的宿主机路径映射

web 容器默认只能看到挂载卷内的路径。要扫描宿主机目录：

```yaml
services:
  web:
    environment:
      JAVSCRIBE_HOST_ROOT: "/hostfs"          # 宿主机根只读挂载前缀
    volumes:
      - "/:/hostfs:ro"                          # 只读映射：扫描可达
      - "/home/ryen/emby-test:/home/ryen/emby-test"  # 读写映射：字幕回写可达
```

- 字面可见的路径永远优先；字面不存在且配置了 `JAVSCRIBE_HOST_ROOT` 时，
  透明映射到 `<前缀>/<路径>`，前端扫描结果顶部提示实际扫描路径（`mapped: true`）。
- **只读映射只能扫、不能回写**：要字幕落回本机影片旁，对应目录必须另给读写
  挂载（如示例中的第二行）。回写连续失败 6 个轮询周期后该任务标记 failed。

### 环境变量（web 容器）

| 变量 | 默认 | 说明 |
|---|---|---|
| `JAVSCRIBE_HOST_ROOT` | 空 | 宿主机只读挂载前缀（容器化扫描必需，见上） |
| `JAV_LOCAL_EXTRACT_CONCURRENCY` | `2` | 「扫描目录」音轨提取并发（ffmpeg CPU 密集） |

### 桌面形态（serve 与用户同机）

`serve` 的 `GET /scan` / `POST /scan/submit` 保留给桌面端使用（桌面形态 serve
就装在用户本机，「扫描目录」扫描的同样是本机磁盘），鉴权与 `/config` 同级
（`X-Api-Key`），规则、内嵌字幕判定、宿主机映射（serve 容器化部署时
`JAVSCRIBE_HOST_ROOT`）行为与 web 形态一致。web 工作台**不再代理**这两个端点。

- 规则（活动 profile `scan` 段，均可在工作台「服务设置」热调）：
  - `video_exts`：视频扩展名列表（默认 11 种 mp4/mkv/avi/mov/webm/flv/wmv/ts/m2ts/mpg/mpeg）
  - `subtitle_patterns`：字幕判定后缀（默认 `.zh.srt`、`.srt`）
  - `recurse`：是否递归子目录（默认 true）

- 安全定位：`/scan`（桌面）与 `/api/scan/local`（web）都能枚举对应机器上的
  **任意目录**（含文件名与大小）并把任意本地文件入队处理，敏感性与 `/config`
  相当，**不要对外暴露**；web 容器读宿主盘同样依赖挂载范围控制（只映射需要的
  目录，不要把 `/` 整体读写挂进容器）。

其余接口：`GET /api/health`、`GET/POST/PUT/DELETE /api/engines`、`GET /api/jobs`、
`GET /api/jobs/{engine}/{job_id}/result`（代理服务 srt 下载）、
`POST /api/jobs/{engine}/{job_id}/retry`（跳过任务重新生成）。

## 安全

本服务**无鉴权**（与服务一致），只应暴露在内网 / VPN。`/api/upload` 可向服务
派发 GPU 任务，暴露面等同服务的 `/upload`。`/config` 与 `/scan`、`/scan/submit`
有 `X-Api-Key` 鉴权，但 Key 是服务级共享密钥，不要随意指派给不可信方；
`/scan` 可枚举（桌面形态）服务机器任意目录，`/api/scan/local` 可枚举（web 形态）
工作台部署机任意目录，泄露即等于交出对应机器的媒体库清单。
