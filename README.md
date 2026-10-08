# JavScribe

**JAV 视频字幕自动生成** — ja→zh 一步翻译（日转中专用模型）、`.zh.srt` 原位落位、下载目录监听、多服务端自动均衡调度。

> **本仓库只做「功能」，不内置任何模型权重。** 模型获取、部署、配置、常见问题全部在[文档站](https://docs.we-together.club/javscribe/)。

![字幕工作台界面预览](docs/web-ui.png)

## 产品与形态

两个角色：**服务端**负责模型与处理（有显卡 / 已对接模型 API 的机器），**客户端**负责扫描与上传音轨（用户自己的机器），经 HTTP（API Key 鉴权）对接。

| 角色 | 部署在哪 | 职责 |
|---|---|---|
| **服务端** JavScribe Serve（headless 常驻） | GPU 服务器 | 持有/调用模型跑 ASR，接收客户端上传的音轨，产出字幕 |
| **客户端** 字幕工作台（Docker 形态 / 桌面安装形态，同一产品） | 用户自选的客户端部署机 / 本地电脑 | 扫描本机影片、提取音轨上传、任务看板、字幕落回本机影片旁 |

- 「扫描目录」扫的是**客户端部署机**上的目录；「选择文件/文件夹」用**浏览器/桌面端所在机器**的本地文件。
- 多客户端可连同一服务端：任务状态以服务端为单一真源，服务端操作（暂停/继续/重试）对所有客户端即时生效。
- 服务端无图形界面：所有可视化（看板、设置、更新提示）都落在客户端前端。

## 最新版下载

<!-- release-latest:client -->
🖥️ **JavScribe Client**（桌面客户端）v0.2.27：[Windows 安装包](https://github.com/JavdBviewed/JavScribe/releases/download/client-v0.2.27/jav-scribe-client-0.2.27-win-x64-setup.exe) · [Windows 便携版](https://github.com/JavdBviewed/JavScribe/releases/download/client-v0.2.27/jav-scribe-client-0.2.27-win-x64-portable.exe) · [Linux AppImage](https://github.com/JavdBviewed/JavScribe/releases/download/client-v0.2.27/jav-scribe-client-0.2.27-linux-x64.AppImage) · [Linux deb](https://github.com/JavdBviewed/JavScribe/releases/download/client-v0.2.27/jav-scribe-client_0.2.27_amd64.deb) · [全部资产](https://github.com/JavdBviewed/JavScribe/releases/tag/client-v0.2.27)
（客户端 · Docker 形态从本仓库 `web/` 构建，版本与安装形态同步，见 [web/README.md](web/README.md)）

<!-- release-latest:serve -->
⚙️ **JavScribe Serve**（headless 服务端）v0.2.7：[Windows](https://github.com/JavdBviewed/JavScribe/releases/download/serve-v0.2.7/JavScribe-Serve-0.2.7-win-x64.zip) · [Linux](https://github.com/JavdBviewed/JavScribe/releases/download/serve-v0.2.7/JavScribe-Serve-0.2.7-linux-x64.zip) · [全部资产](https://github.com/JavdBviewed/JavScribe/releases/tag/serve-v0.2.7)

[全部 Release →](https://github.com/JavdBviewed/JavScribe/releases)（发布后本区自动钉到最新 tag）

## 快速开始（各 3 行）

```bash
# 服务端（Docker，NVIDIA GPU 服务器，首启自动下载模型 ~3.4G）
git clone https://github.com/JavdBviewed/JavScribe && cd JavScribe
JAV_WATCH_DIR=/你的影片目录 docker compose -f docker/docker-compose.yml up -d --build

# 客户端（Docker 形态，部署在客户端部署机，浏览器访问 :8400）
cd JavScribe/web
JAV_ENGINES="服务A=http://<服务端IP>:8300" docker compose -f docker/docker-compose.yml up -d --build
```

完整步骤（本地 exe、手动部署、离线放模型、外网代理、安全加固）见[文档站 · 部署](https://docs.we-together.club/javscribe/deployment)。

## 文档

| 主题 | 链接 |
|---|---|
| 部署（服务端 / 客户端 / 离线 / 代理） | [docs.we-together.club/javscribe/deployment](https://docs.we-together.club/javscribe/deployment) |
| 客户端工作台使用 | [docs.we-together.club/javscribe/workbench](https://docs.we-together.club/javscribe/workbench) |
| 配置项（config / env） | [docs.we-together.club/javscribe/config](https://docs.we-together.club/javscribe/config) |
| 常见问题 | [docs.we-together.club/javscribe/faq](https://docs.we-together.club/javscribe/faq) |
| 服务端 HTTP API | [docs.we-together.club/javscribe/api](https://docs.we-together.club/javscribe/api) |

仓库内参考：[config/jav_scribe.example.json](config/jav_scribe.example.json)（完整配置字段与注释）、[web/README.md](web/README.md)（web 形态接口与开发）。

## 特性

- **一步 ja→zh**：日转中专用模型（CTranslate2，CUDA/CPU），不经过通用 ASR + LLM 两遍
- **媒体库友好**：输出固定 `<影片名>.zh.srt`（可配），与影片同目录；Emby/Jellyfin/Plex 扫描即用
- **下载目录监听**：大小稳定检测、存量追平、已生成字幕自动跳过
- **进度可见**：精确到影片时间轴（"已翻到 47:12 / 共 150:20"）
- **远端处理**：客户端只上传 ~35MB opus 音轨，**不传整片**
- **客户端看板**：多服务聚合、自动均衡调度、批量操作（暂停/继续/重试/取消/改派）、srt 在线预览、服务端设置热改、组件就绪自检、监控趋势图
- **可选增强**：LLM 润色第二遍（OpenAI 兼容端点）、Emby Refresh 联动、JASNA 马赛克修复、外网代理（`JAV_PROXY`）

## 版本与发布

| 组件 | 版本号 | 发布方式 |
|---|---|---|
| 服务端 `serve` | 独立 `vX.Y.Z` | tag `serve-v*` → CI 打 headless exe（win/linux）+ GitHub Release + ghcr 镜像 |
| 客户端（桌面安装 + web 部署形态） | **同号同发** | tag `client-v*` → CI 出桌面安装包；web 无独立 tag，版本随 client，部署机 `docker compose --build` |

## 安全要点

- 服务端进度/上传接口（默认 8300）**无鉴权**，`GET/PUT /config`、`GET /scan` 有 `X-Api-Key`（env `JAVSCRIBE_API_KEY`）——`/scan` 可列举服务机任意目录，**切勿对外暴露**。
- 只暴露给内网/VPN；必须对外时加带鉴权的反向代理。详见[文档站 · 部署](https://docs.we-together.club/javscribe/deployment)。

## 致谢与许可

- 基于 [**JAVSubTool**](https://github.com/maudslice/JAVSubTool)（maudslice，MIT）二次开发，原作者版权保留
- 字幕引擎：[**TransWithAI ChickenRice**](https://github.com/TransWithAI/Faster-Whisper-TransWithAI-ChickenRice)（MIT）；模型权重不在本仓库，见[文档站 · 部署](https://docs.we-together.club/javscribe/deployment)
- 修复引擎：[**JASNA**](https://github.com/Kruk2/jasna)（**AGPL-3.0**）——仅外部调用用户自装的 jasna-cli，不打包不分发
- JavScribe 本体：**MIT**（见 [LICENSE](LICENSE)）

## Roadmap

- [ ] 字幕时间轴对齐精修（word 级对齐）
- [ ] 多语言输出（zh+ja 双语 SRT/ASS）
- [ ] Jellyfin/Plex 联动（Emby 已支持）
