# JavScribe Serve — 本机部署说明

`JavScribeServe.exe`（Windows）/ `jav-scribe-serve`（Linux）是 JavScribe 的
**headless 服务端**：目录监听 + 字幕流水线调度 + 进度/上传 HTTP 接口（默认
`http://127.0.0.1:8300`）。**没有图形界面**——可视化全部由 JavScribe Client
（桌面端 / 浏览器工作台）承担，它必须连一个 serve 才能工作。

## 前置要求（服务端本体零依赖，以下三项按需在「本机」装好）

1. **ffmpeg**（抽音频用）：Windows 装进 PATH 即可
2. **ChickenRice 字幕引擎**（ja→zh ASR，真正吃算力的部分）：
   从 ChickenRice 仓库 Releases 下载**翻译版**发布包（含 `infer.exe` +
   VAD + 海南鸡 v2 模型，见仓库 `docs/models.md` 方案 A），例如装到
   `C:\Tools\ChickenRice\`
3. **模型**：ChickenRice 发布包已含常用模型；缺模型时按其说明下载放置
   （服务端不内置任何权重）

> 没有 NVIDIA 显卡也能跑（`device: cpu`），只是慢；有卡则 `device: cuda`。

## 启动（不需要人工操作）

- **Windows**：双击 `JavScribeServe.exe`。无控制台窗口，日志写到
  `%USERPROFILE%\.jav_scribe\serve.log`。
- **Linux**：`./jav-scribe-serve`（前台）或加 `nohup ... &` 后台。
- 端口默认 8300；被占用时用 `JavScribeServe.exe --port 8301`（Linux 同理）。
- 验证：浏览器或命令行访问 `http://127.0.0.1:8300/health`。

**首启零配置**：没有 `~/.jav_scribe/config.json` 也能启动（接口活着，
任务会提示未配置引擎）。两种配法：

- 推荐：用 JavScribe Client 连上后，在「服务设置」里填
  `infer.command`（如 `C:\Tools\ChickenRice\infer.exe`）、`device` 等
  （服务端设了 API Key 时填对应 Key）
- 或手动：把 `config.example.json` 复制为
  `%USERPROFILE%\.jav_scribe\config.json`（Linux：`~/.jav_scribe/config.json`），
  按需改 `local` profile 的 `infer.command` / `watch.dirs` / `emby`

## 与 JavScribe Client 配合（推荐用法）

把本包里的 `JavScribeServe.exe` 放到 **JavScribe Client 同一目录**：
客户端启动时会自动检测 → 没运行就自动拉起 → 自动连接 `127.0.0.1:8300`，
全程不用手动填地址。Client 找不到同目录服务端时，会在服务区提示
「下载 JavScribe Serve 放同目录」或手动填远程服务器地址
（`http://<服务器IP>:<端口>`，比如公司 3090 GPU 服务器）。

## 停止 / 常见问题

- 停止：任务管理器结束 `JavScribeServe.exe`；或命令行
  `taskkill /F /IM JavScribeServe.exe`（Linux：`pkill jav-scribe-serve`）
- 字幕没生成：看 `serve.log`——多数是 `infer.command` 没配或路径不对；
  引擎需 `log_level: DEBUG` 才有细粒度进度
- 已有字幕的影片默认跳过（`skip_if_exists`），强制重做在配置里开 `overwrite`
