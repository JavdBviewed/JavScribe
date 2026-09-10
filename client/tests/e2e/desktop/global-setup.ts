// e2e fixture 安全副本：所有 test 统一读 /tmp 下的副本；副本每次运行覆盖，与仓库原件解耦。
// 背景（2026-09-10 定位）：e2e 运行中 fixture 整目录消失的根因是客户端自身 bug——
// upload-audio 的 finally 曾对 opus 源目录做递归 rmSync，把整个 fixture 目录删掉
//（历史 e2e 里 FIXTURES 直指仓库目录时，仓库原件也是被它删的）。该 bug 已修复
//（main.ts isOwnTempDir：只清理应用自建 mkdtemp），此处副本+自愈保留为纵深防御。
// 副本路径确定性推导（tmpdir + 固定名），worker 与 globalSetup 无需传参。
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
export const REPO_FIXTURES = join(ROOT, "client/tests/e2e/fixtures");
export const SAFE_FIXTURES = join(tmpdir(), "javscribe-e2e-fixtures");
export const FIXTURE_FILES = ["video-a.mp4", "video-b.mkv", "sine.opus", "folder/video-c.mp4", "folder/video-c.zh.srt"];

export function copyFixturesToSafe(): void {
  for (const f of FIXTURE_FILES) {
    const src = join(REPO_FIXTURES, f);
    if (!existsSync(src)) {
      try {
        execFileSync("git", ["restore", "--", "client/tests/e2e/fixtures"], { cwd: ROOT, stdio: "pipe" });
      } catch { /* 下面统一校验 */ }
      if (!existsSync(src)) throw new Error(`fixture 缺失且 git restore 失败：${f}`);
    }
    const dst = join(SAFE_FIXTURES, f);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst); // 每次运行覆盖 → 跨 run 无状态残留
  }
}

export default function globalSetup(): void {
  copyFixturesToSafe();
}
