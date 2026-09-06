// 拉取 BtbN 静态 ffmpeg 构建到 client/packaging/ffmpeg/（electron-builder extraResources 源）。
//   node scripts/fetch-ffmpeg.mjs [win|linux]   （缺省 = 当前平台）
// 幂等：目标已存在且 JAVSCRIBE_FFMPEG_FORCE !== "1" 时直接跳过。
// 下载源（BtbN/FFmpeg-Builds "latest" 指针，GPL 静态构建）：
//   linux: ffmpeg-master-latest-linux64-gpl.tar.xz  → ffmpeg
//   win:   ffmpeg-master-latest-win64-gpl.zip       → bin/ffmpeg.exe
// 解压依赖系统 tar（linux GNU tar 自动识别 xz；win10+ bsdtar 识别 zip/xz）。
import { execSync, spawnSync } from "node:child_process";
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
const SRC_NAME = isWin ? "ffmpeg-master-latest-win64-gpl.zip" : "ffmpeg-master-latest-linux64-gpl.tar.xz";
const SRC_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${SRC_NAME}`;
const BIN_NAME = isWin ? "ffmpeg.exe" : "ffmpeg";
const STAGE = resolve(ROOT, "client/packaging/ffmpeg");
const TARGET = join(STAGE, BIN_NAME);

if (existsSync(TARGET) && process.env.JAVSCRIBE_FFMPEG_FORCE !== "1") {
  console.log(`[fetch-ffmpeg] 已存在，跳过：${TARGET}`);
  process.exit(0);
}

const work = join(tmpdir(), `javscribe-ffmpeg-${plat}-${Date.now()}`);
mkdirSync(work, { recursive: true });
const archive = join(work, SRC_NAME);
try {
  // curl：自动跟随重定向、遵循 HTTP(S)_PROXY 环境代理（CI 无代理时直连）
  console.log(`[fetch-ffmpeg] 下载 ${SRC_URL}`);
  const dl = spawnSync(
    "curl",
    ["-sSL", "--fail", "--retry", "3", "--retry-delay", "2", "--connect-timeout", "30", "-o", archive, SRC_URL],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (dl.status !== 0) throw new Error(`curl 下载失败（exit ${dl.status}）`);
  const size = statSync(archive).size;
  if (size < 30 * 1024 * 1024) throw new Error(`下载文件过小（${size} B），疑似错误页`);
  console.log(`[fetch-ffmpeg] 下载完成 ${Math.round(size / 1048576)} MB，解压…`);
  const t = spawnSync("tar", ["-xf", archive, "-C", work], { stdio: "inherit" });
  if (t.status !== 0) process.exit(t.status ?? 1);

  const found = execSync(
    `find ${JSON.stringify(work)} -name ${JSON.stringify(BIN_NAME)} -type f`,
    { encoding: "utf8" },
  ).trim().split("\n").filter(Boolean);
  if (!found.length) throw new Error(`解压产物中未找到 ${BIN_NAME}`);
  mkdirSync(STAGE, { recursive: true });
  rmSync(TARGET, { force: true });
  copyFileSync(found[0], TARGET);
  if (!isWin) chmodSync(TARGET, 0o755);
  const finalSize = statSync(TARGET).size;
  if (finalSize < 20 * 1024 * 1024) throw new Error(`ffmpeg 过小（${finalSize} B）`);
  // 冒烟：确认可执行
  const v = spawnSync(TARGET, ["-version"], { encoding: "utf8" });
  if (v.status !== 0) throw new Error(`ffmpeg -version 失败：${v.stderr}`);
  console.log(`[fetch-ffmpeg] 完成 → ${TARGET}（${Math.round(finalSize / 1048576)} MB，${v.stdout.split("\n")[0]}）`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
