// desktop 形态构建入口：共享 ui 层 + desktop transport/platform + 原生提音轨 shim。
// 与 web-entry 唯一差异：不引 /lib/ffmpeg.js（index-desktop.html 已去掉该 script），
// 音轨提取由 main 进程系统 ffmpeg 承担（无 1.6GB 上限）。
import "../ui/style.css";
import "./native-extract"; // 挂 window.JavExtract，先于任何 dispatch 就绪
import { initApp } from "../ui/app";
import { desktopTransport } from "../transport-desktop";
import { desktopPlatform } from "../platform-desktop";
import { SRT_SUFFIX } from "../core/constants";
import type { JavDesktop } from "../core/desktop-bridge";

initApp(desktopTransport, desktopPlatform);

// 「下载 srt」按钮：web 形态 <a href download> 走 8400 工作台代理；
// desktop 的 href 是 serve 直连地址，浏览器下载语义不合适 → capture 阶段拦截，
// 交给 main 进程（拉 srt + 清洗 + 原生保存对话框）。
const desktop = (window as { javDesktop?: JavDesktop }).javDesktop;
document.addEventListener("click", (ev) => {
  const el = ev.target as HTMLElement | null;
  const a = el && el.closest ? (el.closest("a.dl-btn") as HTMLAnchorElement | null) : null;
  if (!a || !desktop) return;
  ev.preventDefault();
  ev.stopPropagation();
  const row = a.closest(".job-row");
  const fn = row ? row.querySelector(".job-name .fn") : null;
  const videoName = (fn?.textContent || "").trim();
  const srtName = videoName ? videoName.replace(/\.[^.]+$/, "") + SRT_SUFFIX : "subtitle.srt";
  void desktop.download(a.href, srtName);
}, true);
