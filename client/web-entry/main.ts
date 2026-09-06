// web 形态构建入口：
//  - CSS / extract / app 全部来自共享 ui 层（desktop 形态二期提供独立入口 + transport-desktop）
//  - 构建产物 client/dist 由 scripts/sync-static.mjs 镜像进 web/src/jav_scribe_web/static/
import "../ui/style.css";
import "../ui/extract"; // 挂 window.JavExtract（ffmpeg.wasm 本地提音轨），先于任何 dispatch 就绪
import { initApp } from "../ui/app";
import { webTransport } from "../transport-web";
import { webPlatform } from "../platform-web";

initApp(webTransport, webPlatform);
