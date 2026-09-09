// 拉取 BtbN 静态 ffmpeg 构建到 client/packaging/ffmpeg/（electron-builder extraResources 源）。
//   node scripts/fetch-ffmpeg.mjs [win|linux]   （缺省 = 当前平台）
// 幂等：目标已存在且 JAVSCRIBE_FFMPEG_FORCE !== "1" 时直接跳过。
// 下载源：BtbN/FFmpeg-Builds latest release（GPL 静态构建，非 shared）：
//   linux: 资产名以 -linux64-gpl.tar.xz 结尾  → ffmpeg
//   win:   资产名以 -win64-gpl.zip 结尾       → bin/ffmpeg.exe
// BtbN 2026-09 起资产更名（ffmpeg-master-latest-* → ffmpeg-N-<build>-g<hash>-*），
// 不再硬编码资产文件名：走 GitHub API 查 browser_download_url，
// 同名匹配中取 size 最大者（BtbN 存在同名重复上传，静态构建是大的那个）。
// 覆盖：JAVSCRIBE_FFMPEG_URL（直接指定完整下载 URL，跳过 API）。
// 解压依赖系统 tar（linux GNU tar 自动识别 xz；win10+ bsdtar 识别 zip/xz）。
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plat = process.argv[2] || (process.platform === "win32" ? "win" : "linux");
if (!["win", "linux"].includes(plat)) {
  console.error("用法: node scripts/fetch-ffmpeg.mjs [win|linux]");
  process.exit(2);
}
const isWin = plat === "win";
const ASSET_SUFFIX = isWin ? "-win64-gpl.zip" : "-linux64-gpl.tar.xz";
const LEGACY_NAME = isWin
  ? "ffmpeg-master-latest-win64-gpl.zip"
  : "ffmpeg-master-latest-linux64-gpl.tar.xz";
const API_URL = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest";
const BIN_NAME = isWin ? "ffmpeg.exe" : "ffmpeg";
const STAGE = resolve(ROOT, "client/packaging/ffmpeg");
const TARGET = join(STAGE, BIN_NAME);

if (existsSync(TARGET) && process.env.JAVSCRIBE_FFMPEG_FORCE !== "1") {
  console.log(`[fetch-ffmpeg] 已存在，跳过：${TARGET}`);
  process.exit(0);
}

// 解析下载 URL：env 覆盖 > GitHub API（重试 3 次）> 回退旧命名 URL
let srcUrl = process.env.JAVSCRIBE_FFMPEG_URL || "";
if (!srcUrl) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(API_URL, {
        headers: { accept: "application/vnd.github+json", "user-agent": "javscribe-fetch-ffmpeg" },
      });
      if (!res.ok) throw new Error(`API HTTP ${res.status}`);
      const rel = await res.json();
      const matches = (rel.assets || []).filter((a) => a.name.endsWith(ASSET_SUFFIX));
      if (!matches.length) throw new Error(`release ${rel.tag_name} 无 ${ASSET_SUFFIX} 结尾资产`);
      matches.sort((a, b) => b.size - a.size);
      srcUrl = matches[0].browser_download_url;
      console.log(
        `[fetch-ffmpeg] 解析 ${rel.tag_name}: ${matches[0].name} (${Math.round(matches[0].size / 1048576)} MB)`,
      );
      break;
    } catch (e) {
      if (attempt >= 3) {
        srcUrl = `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${LEGACY_NAME}`;
        console.warn(`[fetch-ffmpeg] API 解析失败（${e}）→ 回退旧 URL`);
      } else {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
}

const work = join(tmpdir(), `javscribe-ffmpeg-${plat}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const archive = join(work, isWin ? "ffmpeg-src.zip" : "ffmpeg-src.tar.xz");
try {
  // curl：自动跟随重定向、遵循 HTTP(S)_PROXY 环境代理（CI 无代理时直连）
  console.log(`[fetch-ffmpeg] 下载 ${srcUrl}`);
  const dl = spawnSync(
    "curl",
    ["-sSL", "--fail", "--retry", "5", "--retry-delay", "2", "--retry-all-errors", "--connect-timeout", "30", "-o", archive, srcUrl],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (dl.status !== 0) throw new Error(`curl 下载失败（exit ${dl.status}）`);
  const size = statSync(archive).size;
  if (size < 30 * 1024 * 1024) throw new Error(`下载文件过小（${size} B），疑似错误页`);
  console.log(`[fetch-ffmpeg] 下载完成 ${Math.round(size / 1048576)} MB，解压…`);
  const t = spawnSync("tar", ["-xf", archive, "-C", work], { stdio: "inherit" });
  if (t.status !== 0) process.exit(t.status ?? 1);

  // fs 遍历（不依赖系统 find——Windows 的 find 是文本搜索工具）
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === BIN_NAME) found.push(full);
    }
  };
  walk(work);
  if (!found.length) throw new Error(`解压产物中未找到 ${BIN_NAME}`);
  mkdirSync(STAGE, { recursive: true });
  rmSync(TARGET, { force: true });
  copyFileSync(found[0], TARGET);
  if (!isWin) chmodSync(TARGET, 0o755);
  const finalSize = statSync(TARGET).size;
  if (finalSize < 20 * 1024 * 1024) throw new Error(`ffmpeg 过小（${finalSize} B）`);
  // 冒烟：确认可执行
  const v = spawnSync(TARGET, ["-version"], { encoding: "utf8" });
  if (v.status !== 0 || v.error) {
    throw new Error(
      `ffmpeg -version 失败（status=${v.status} spawnErr=${v.error ? v.error.code + ":" + v.error.message : "none"}）` +
      ` stdout=${(v.stdout || "").slice(0, 300)} stderr=${(v.stderr || "").slice(0, 300)}`,
    );
  }
  console.log(`[fetch-ffmpeg] 完成 → ${TARGET}（${Math.round(finalSize / 1048576)} MB，${v.stdout.split("\n")[0]}）`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
