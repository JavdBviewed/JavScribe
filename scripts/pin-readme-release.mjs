// 钉 README 最新版下载区 tag（release workflow 上传成功后调用）
//   node scripts/pin-readme-release.mjs <client|serve> <tag>
// 行为：
//   1. fetch origin main 并在其上重放（tag 的 HEAD 可能落后 main，直接 push 必 non-ff）
//   2. 把 marker 注释（<!-- release-latest:client|serve -->）下一行替换为当前 tag/版本的下载链接行
//   3. 有变化才 commit + push（重试 3 次，应对 client/serve 两 workflow 并发推 main）
// 幂等：内容已一致 → 不产生 commit
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REPO = "JavdBviewed/JavScribe";
const DL = `https://github.com/${REPO}/releases/download`;
const TAG_URL = (tag) => `https://github.com/${REPO}/releases/tag/${tag}`;

const [kindRaw, tag] = process.argv.slice(2);
const kind = kindRaw === "serve" ? "serve" : "client";
if (!tag || !tag.startsWith(`${kind}-v`)) {
  console.error(`用法: node scripts/pin-readme-release.mjs <client|serve> <${kind}-vX.Y.Z>（收到: ${kindRaw} ${tag}）`);
  process.exit(1);
}
const ver = tag.slice(tag.indexOf("v") + 1);

let line;
if (kind === "client") {
  const base = `${DL}/${tag}/jav-scribe-client-${ver}`;
  line =
    `🖥️ **JavScribe Client**（桌面客户端）v${ver}：` +
    `[Windows 安装包](${base}-win-x64-setup.exe) · ` +
    `[Windows 便携版](${base}-win-x64-portable.exe) · ` +
    `[Linux AppImage](${base}-linux-x64.AppImage) · ` +
    `[Linux deb](${DL}/${tag}/jav-scribe-client_${ver}_amd64.deb) · ` +
    `[全部资产](${TAG_URL(tag)})`;
} else {
  const base = `${DL}/${tag}/JavScribe-Serve-${ver}`;
  line =
    `⚙️ **JavScribe Serve**（headless 服务端）v${ver}：` +
    `[Windows](${base}-win-x64.zip) · ` +
    `[Linux](${base}-linux-x64.zip) · ` +
    `[全部资产](${TAG_URL(tag)})`;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`[pin-readme] 命令失败（exit ${r.status}）: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
  return r;
}

// 以最新 origin/main 为基底（tag HEAD 可能落后 main）
run("git", ["fetch", "--no-tags", "origin", "main"]);
run("git", ["checkout", "-B", "main", "origin/main"]);

const readmePath = "README.md";
const before = readFileSync(readmePath, "utf8");
const marker = `<!-- release-latest:${kind} -->`;
const lines = before.split("\n");
const i = lines.findIndex((l) => l.trim() === marker);
if (i < 0 || i + 1 >= lines.length) {
  console.error(`[pin-readme] README 缺少 marker 行或 marker 后无链接行: ${marker}`);
  process.exit(1);
}
const changed = lines[i + 1] !== line;
if (changed) {
  lines[i + 1] = line;
  writeFileSync(readmePath, lines.join("\n"), "utf8");
  console.log(`[pin-readme] README ${kind} 行已更新 → ${tag}（v${ver}）`);
} else {
  console.log(`[pin-readme] README 已钉在 ${tag}，无需提交`);
  process.exit(0);
}

// 并发安全：push 失败（两 workflow 同推 main）→ rebase 重试
for (let attempt = 1; attempt <= 3; attempt++) {
  run("git", ["add", readmePath]);
  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { stdio: "ignore" });
  if (diff.status === 0) {
    console.log("[pin-readme] rebase 后无差异，退出");
    process.exit(0);
  }
  run("git", ["commit", "-m", `docs(readme): 钉最新版 ${tag}`]);
  const push = spawnSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });
  if (push.status === 0) {
    console.log("[pin-readme] 已推送 main");
    process.exit(0);
  }
  console.warn(`[pin-readme] 推送失败（第 ${attempt}/3 次），rebase 重试…`);
  run("git", ["fetch", "--no-tags", "origin", "main"]);
  run("git", ["rebase", "origin/main"]);
}
console.error("[pin-readme] 重试 3 次仍失败（README 并发冲突？）——请手动检查 main");
process.exit(1);
