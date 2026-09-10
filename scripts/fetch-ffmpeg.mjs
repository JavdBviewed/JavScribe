// 拉取 BtbN 静态 ffmpeg 构建到 client/packaging/ffmpeg/（electron-builder extraResources 源）。
//   node scripts/fetch-ffmpeg.mjs [win|linux]   （缺省 = 当前平台）
// 幂等：目标已存在且 JAVSCRIBE_FFMPEG_FORCE !== "1" 时直接跳过。
// 下载源：BtbN/FFmpeg-Builds latest release（GPL 静态构建，非 shared）：
//   linux: 资产名以 -linux64-gpl.tar.xz 结尾  → ffmpeg
//   win:   资产名以 -win64-gpl.zip 结尾       → bin/ffmpeg.exe
// BtbN 2026-09 起资产命名多次变化（master-latest ↔ N-<build>-g<hash> 互换、标签互换、
// 资产原地重传），下载 URL 会瞬时 404/500：
//   1) 不硬编码资产文件名：走 GitHub API 查 browser_download_url，同名匹配取 size 最大者
//      （BtbN 存在同名重复上传，静态构建是大的那个）；
//   2) 「解析 + 下载」整体重试 5 次（15/30/45/60s 退避，每次重新解析拿新 SAS 重定向），
//      扛过资产重传的 CDN 切换窗口；
//   3) CI 侧另有 cache restore-keys 前缀兜底（上游变动直接复用历史缓存）。
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
const MAX_ATTEMPTS = 5;

if (existsSync(TARGET) && process.env.JAVSCRIBE_FFMPEG_FORCE !== "1") {
  console.log(`[fetch-ffmpeg] 已存在，跳过：${TARGET}`);
  process.exit(0);
}

/** 解析下载 URL：GitHub API，同名后缀匹配取最大 size；返回 { url, label } */
async function resolveFromApi() {
  const res = await fetch(API_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "javscribe-fetch-ffmpeg" },
  });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const rel = await res.json();
  const matches = (rel.assets || []).filter((a) => a.name.endsWith(ASSET_SUFFIX));
  if (!matches.length) throw new Error(`release ${rel.tag_name} 无 ${ASSET_SUFFIX} 结尾资产`);
  matches.sort((a, b) => b.size - a.size);
  const top = matches[0];
  console.log(
    `[fetch-ffmpeg] 解析 ${rel.tag_name}: ${top.name} (${Math.round(top.size / 1048576)} MB)`,
  );
  return { url: top.browser_download_url, label: top.name };
}

/** 下载到 archive（curl 跟随重定向、遵循代理；瞬时网络抖动由 curl --retry 吸收） */
function downloadTo(url, archive) {
  const dl = spawnSync(
    "curl",
    ["-sSL", "--fail", "--retry", "3", "--retry-delay", "2", "--retry-all-errors", "--connect-timeout", "30", "-o", archive, url],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (dl.status !== 0) throw new Error(`curl 下载失败（exit ${dl.status}）`);
  const size = statSync(archive).size;
  if (size < 30 * 1024 * 1024) throw new Error(`下载文件过小（${size} B），疑似错误页`);
  return size;
}

const work = join(tmpdir(), `javscribe-ffmpeg-${plat}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const archive = join(work, isWin ? "ffmpeg-src.zip" : "ffmpeg-src.tar.xz");
try {
  // 「解析 + 下载」整体重试：BtbN 资产原地重传时下载 URL 会瞬时 404/500，
  // 重新解析可拿到新资产的 SAS 重定向，退避等待 CDN 切换完成。
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let url, label;
    if (process.env.JAVSCRIBE_FFMPEG_URL) {
      url = process.env.JAVSCRIBE_FFMPEG_URL;
      label = "JAVSCRIBE_FFMPEG_URL";
    } else {
      try {
        ({ url, label } = await resolveFromApi());
      } catch (e) {
        lastErr = e;
        if (attempt >= MAX_ATTEMPTS) {
          url = `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${LEGACY_NAME}`;
          label = `回退旧 URL（API 解析失败：${e}）`;
        } else {
          const delay = 15000 * attempt;
          console.warn(`[fetch-ffmpeg] 第 ${attempt}/${MAX_ATTEMPTS} 次解析失败（${e}），${delay / 1000}s 后重试`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
    }
    try {
      console.log(`[fetch-ffmpeg] 下载（第 ${attempt}/${MAX_ATTEMPTS} 次）${label} ${url}`);
      const size = downloadTo(url, archive);
      console.log(`[fetch-ffmpeg] 下载完成 ${Math.round(size / 1048576)} MB，解压…`);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt >= MAX_ATTEMPTS) break;
      const delay = 15000 * attempt;
      console.warn(`[fetch-ffmpeg] 第 ${attempt}/${MAX_ATTEMPTS} 次下载失败（${e}），${delay / 1000}s 后重试（重新解析 URL）`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (lastErr) throw lastErr;

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
  console.log(`[fetch-ffmpeg] 完成 → ${TARGET}（${Math.round(finalSize / 1024 / 1024)} MB，${v.stdout.split("\n")[0]}）`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
