// JavScribe Client 桌面端构建：
//   ① 从 client/ui/index.html 确定性字符串替换生成 client/dist-desktop-src/index-desktop.html
//      （文案改为桌面措辞、去 /lib/ffmpeg.js、换入口；目标串缺失立即报错——防止漂移）
//   ② vite build --config vite.desktop.config.ts（renderer，file:// 相对路径）
//   ③ esbuild main.ts → main.cjs、preload.ts → preload.cjs（--external:electron）
//   ④ 写 dist-desktop/package.json（app.getVersion() 依赖）
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import esbuild from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_HTML = resolve(ROOT, "client/ui/index.html");
// 临时输入 html 放 client/（= vite root）下 → 产物平铺在 dist 根；构建后删除
const OUT_HTML = resolve(ROOT, "client/index-desktop.html");

// [原串, 桌面串]——顺序无关，全部必须命中恰好一次
// ---------- 桌面 shell 注入块（frameless 自定义标题栏 + 侧边栏导航；仅桌面构建出现） ----------
const TITLEBAR_NAV = `
<div id="titlebar">
  <div class="tb-left">
    <img class="tb-logo" src="./favicon.png" alt="" draggable="false">
    <span class="tb-app">JavScribe Client</span>
  </div>
  <div class="tb-right">
    <span id="up-chip" class="up-chip" role="button" tabindex="0" hidden></span>
    <span id="health" class="hud-item tb-chip">连接中…</span>
    <span id="clock" class="hud-item mono tb-chip">--:--:--</span>
    <div class="tb-win" role="group" aria-label="窗口控制">
      <button type="button" id="win-min" class="tb-btn" title="最小化" aria-label="最小化"><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" aria-hidden="true"><path d="M2.75 8.25h6.5"/></svg></button>
      <button type="button" id="win-max" class="tb-btn" title="最大化" aria-label="最大化"><svg class="wi-max" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><rect x="2.9" y="2.9" width="6.2" height="6.2" rx="1.2"/></svg><svg class="wi-restore" viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1" aria-hidden="true"><rect x="3.6" y="4.6" width="5.2" height="5.2" rx="1.2"/><path d="M4.6 3.4V3a1.1 1.1 0 0 1 1.1-1.1h2.8A1.1 1.1 0 0 1 9.6 3v2.8a1.1 1.1 0 0 1-1.1 1.1h-.6"/></svg></button>
      <button type="button" id="win-close" class="tb-btn close" title="关闭" aria-label="关闭"><svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" aria-hidden="true"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"/></svg></button>
    </div>
  </div>
</div>
<aside id="nav" aria-label="主导航">
  <div class="nav-label">工作台</div>
  <nav class="nav-items">
    <button type="button" class="nav-item" data-view="engines"><svg class="nav-ico" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="6.5" rx="2"/><rect x="3" y="13.5" width="18" height="6.5" rx="2"/><path d="M7 7.25h.01M7 16.75h.01" stroke-width="2.2"/></svg><span>字幕服务</span></button>
    <button type="button" class="nav-item" data-view="dispatch"><svg class="nav-ico" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.75"/><path d="M10.2 9.2v5.6l4.9-2.8z" fill="currentColor" stroke="none"/></svg><span>生成字幕</span></button>
    <button type="button" class="nav-item" data-view="jobs"><svg class="nav-ico" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.6"/></svg><span>字幕任务</span><span id="nav-badge" class="nav-badge" hidden>0</span></button>
  </nav>
  <div class="nav-up" id="nav-up">
    <label class="nav-up-auto" title="启用后启动时自动检查新版本（只检查，不自动下载）"><input type="checkbox" id="up-auto"><span>自动更新</span></label>
    <button type="button" id="up-check" class="nav-up-check">检查更新</button>
  </div>
  <div class="nav-foot">
    <span class="nav-id">JAVSCRIBE-CLIENT</span>
    <span id="foot-ver" class="muted mono"></span>
    <span class="muted small nav-tick">看板 5s · 生成 1s</span>
  </div>
</aside>
`;

// 原 web header 块（brand + hud）——桌面构建整体替换为 titlebar + nav（#health/#clock 迁入 titlebar）
const WEB_HEADER_BLOCK = `<header>
  <div class="brand">
    <span class="brand-dot" id="brand-dot"></span>
    <div class="brand-text">
      <h1>字幕工作台</h1>
      <span class="brand-sub">JAVSCRIBE · SUBTITLE CONSOLE</span>
    </div>
  </div>
  <div class="hud">
    <span id="health" class="hud-item">连接中…</span>
    <span id="clock" class="hud-item mono">--:--:--</span>
  </div>
</header>
`;

// 原 web footer 块（版本 + 更新 chip + 节奏提示）——桌面构建整体移除（#foot-ver/#up-chip 迁入新壳）
const WEB_FOOTER_BLOCK = `<footer>
  <span class="mono">JAVSCRIBE-WEB</span>
  <span id="foot-ver" class="muted mono"></span>
  <span id="up-chip" class="up-chip" role="button" tabindex="0" hidden></span>
  <span class="muted">看板 5s · 生成 1s</span>
</footer>
`;

const REWRITES = [
  ["<title>JavScribe 字幕工作台</title>", "<title>JavScribe Client</title>"],
  ['<link rel="icon" type="image/png" href="/favicon.png">\n', ""],
  ["<html lang=\"zh-CN\">", "<html lang=\"zh-CN\" class=\"desktop\">"],
  ["<body>", "<body class=\"desktop\">"],
  [WEB_HEADER_BLOCK, TITLEBAR_NAV],
  [WEB_FOOTER_BLOCK, ""],
  ["mp4 / mkv / ts / mov … 默认在你的浏览器里本地提取音轨，只上传 ~35MB 音频（≤1.6GB）；更大的文件自动改传整片（原片只到本服务，不出本机）",
   "mp4 / mkv / ts / mov … 在本机提取音轨，只上传 ~35MB 音频（无大小限制）；选「整片直传字幕服务」时完整视频直接传给所选服务"],
  ['<select id="extract-select" title="小文件在你自己的浏览器里提取音轨，只上传音频；大文件或本地提取失败时改传整片（由本服务提取）">',
   '<select id="extract-select" title="本机提取音轨，只上传音频（无大小限制）；「整片直传字幕服务」= 完整视频直接传给所选服务，由服务端提取">'],
  ['<option value="auto">自动（推荐，≤1.6GB 本地）</option>',
   '<option value="auto">自动（推荐，本机提取）</option>'],
  ['<option value="local">仅浏览器本地</option>',
   '<option value="local">仅本机提取</option>'],
  ['<option value="server">整片上传本服务</option>',
   '<option value="server">整片直传字幕服务</option>'],
  ["勾选后：用「选择文件 / 选择文件夹」上传的影片，任务完成时自动把 srt 写回影片原目录（页面需以 https 访问并保持打开；拖入或浏览器不支持时改为自动下载，需手动放到影片旁）。扫描任务无需勾选——字幕本就落在服务器上的影片旁。",
   "勾选后：用「选择文件 / 选择文件夹」选取或拖入的本机影片，任务完成时自动把 srt 写回影片原目录；写回失败时改为自动下载（保存对话框）。扫描任务无需勾选——字幕本就落在服务器上的影片旁。"],
  ["「音轨提取」：浏览器本地 = 在你这台电脑上用网页内嵌的 ffmpeg 提 opus（首次约需下载 30MB 引擎，之后有缓存），2.5 小时影片只传 ~35MB 音频；整片上传 = 视频先传到本服务（不出本服务），在这里提完音轨再发给字幕服务。",
   "「音轨提取」：本机提取 = 在本机用系统 ffmpeg 提 opus（需已安装 ffmpeg；未安装或提取失败时提示，可改用「整片直传字幕服务」），2.5 小时影片只传 ~35MB 音频；整片直传字幕服务 = 完整视频直接传给所选服务，由服务端提取音轨。"],
  ['用上方表单添加，或用环境变量 <span class="mono">JAV_ENGINES="名称=URL"</span> 预置',
   '用上方表单添加，或用环境变量 <span class="mono">JAVSCRIBE_ENGINES="名称=URL"</span> 预置'],
  ["<script src=\"/lib/ffmpeg.js\"></script>\n", ""],
  // 临时 html 位于 client/（比 client/ui/ 高一层），入口相对路径随之变化
  ['<script type="module" src="../web-entry/main.ts"></script>',
   '<script type="module" src="./desktop-entry/main.ts"></script>'],
];

function rewriteHtml() {
  // Windows runner checkout 可能展开 CRLF（text=auto + git 自动检测）；
  // 统一归一化 LF 再做精确匹配，产物恒为 LF
  let html = readFileSync(SRC_HTML, "utf8").replace(/\r\n/g, "\n");
  for (const [from, to] of REWRITES) {
    const n = html.split(from).length - 1;
    if (n !== 1) throw new Error(`HTML 替换失败：命中 ${n} 次（应为 1）：${from.slice(0, 60)}…`);
    html = html.replace(from, to);
  }
  writeFileSync(OUT_HTML, html, "utf8");
  console.log("[build-desktop] index-desktop.html 生成完毕");
}

function run(cmd, args) {
  console.log(`[build-desktop] $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

rewriteHtml();
// brand mark 资产：vendor/favicon.png 临时拷到 client/favicon.png，
// 让 vite 把 <img src="./favicon.png"> 解析为 dist-desktop 内的哈希资产；构建后删除
const FAV_TMP = resolve(ROOT, "client/favicon.png");
copyFileSync(resolve(ROOT, "client/vendor/favicon.png"), FAV_TMP);
// vite JS 入口直跑（等价 `pnpm vite build`，但绕开 Windows .cmd shim 的 spawn 问题）
run(process.execPath, [
  resolve(ROOT, "node_modules/vite/bin/vite.js"),
  "build", "--config", "vite.desktop.config.ts",
]);
// vite 按输入文件名产出 index-desktop.html；main 进程 loadFile 固定找 index.html
import { existsSync, renameSync, rmSync } from "node:fs";
const emitted = resolve(ROOT, "client/dist-desktop/index-desktop.html");
if (existsSync(emitted)) renameSync(emitted, resolve(ROOT, "client/dist-desktop/index.html"));
rmSync(OUT_HTML, { force: true });
rmSync(FAV_TMP, { force: true });
for (const [entry, out] of [
  ["client/desktop/main.ts", "client/dist-desktop/main.cjs"],
  ["client/desktop/preload.ts", "client/dist-desktop/preload.cjs"],
]) {
  console.log(`[build-desktop] $ esbuild ${entry} → ${out}`);
  await esbuild.build({
    entryPoints: [resolve(ROOT, entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
    outfile: resolve(ROOT, out),
  });
}
// 版本跟随根 package.json（electron-builder 打出的安装包版本一致）
const rootPkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
writeFileSync(
  resolve(ROOT, "client/dist-desktop/package.json"),
  JSON.stringify({ name: "jav-scribe-client", version: rootPkg.version, main: "main.cjs" }, null, 2) + "\n",
);
console.log("[build-desktop] 完成 → client/dist-desktop/");
