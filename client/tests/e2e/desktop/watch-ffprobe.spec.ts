// 文件夹监听「内嵌字幕探测」实跑 e2e（仅 desktop 形态；任务线 10-26-javscribe-watch-multifolder-retry D 项，P3）：
//   watch 派发前用本地 ffprobe 探测内嵌字幕轨（main.ts watchSkipEmbedded）：命中目标语言
//   （EMBED_DEFAULTS: target/zh）→ 跳过不派发；eng 等非目标语言、或探测失败（ffprobe 缺失 /
//   非零退出 / 输出非 JSON）→ fail-open 照常派发。e2e 环境无受控的 ffprobe 二进制，探测路径
//   此前恒走 fail-open，「探测命中 → 跳过」实跑零覆盖。本 spec 注入假 ffprobe（node 脚本），
//   让探测路径真实执行。
//
// 假 ffprobe 契约（与 main.ts findFfprobe + sub-embed.probeArgs 对齐）：
//   - findFfprobe 第一优先级读 env JAVSCRIBE_FFMPEG_DIR、要求 <dir>/ffprobe 存在 → 本 spec
//     在 app fixture 里 launchApp(userData, { JAVSCRIBE_FFMPEG_DIR: fakeDir })；extraEnv 在
//     launchApp 内 spread 最后，覆盖 ffmpegEnv() 与 PATH 兜底；
//   - main 以 execFile(ff, probeArgs(file), { timeout: 15000 }) 调用，最后一个 argv 是被探测
//     文件路径；stderr 忽略、只解析 stdout（parseProbeOutput：JSON streams[].codec_name 须在
//     SUBTITLE_CODECS 内、language 取 tags.language）；非零退出 → err → 结果 []（fail-open）；
//   - 脚本按文件名分支：含 zh → subrip/zh 轨 JSON、exit 0；含 eng → subrip/eng 轨 JSON、exit 0；
//     其他 → stdout 写 "THIS IS NOT JSON" 且 exit 1（fail-open 用例）；
//   - 脚本每次被调用向 <fakeDir>/calls.log 追加被探测文件名，用例据此断言「假 ffprobe 确实
//     被执行」，排除「无 ffprobe → 直接 fail-open」的假覆盖。
//
// 接法（已验证，侵入最小）：helpers.ts 的 app fixture 不接受 extraEnv，故本 spec 用
// baseTest.extend<{app}> 覆写 app fixture——先建假目录并 chmod 755，再带 extraEnv 的
// launchApp；userData（mock reset + engines.json 预置）与 page（firstWindow +
// waitForReady）原样继承自 helpers，不动其他 fixture/文件。
//
// 节奏说明：JAVSCRIBE_WATCH_MIN_POLL_MS=300（helpers launchApp 注入）允许 pollMs=800；
//           候选需 (size, mtime) 连续两次轮询不变（稳定性基线），首个候选 ≈2s；
//           派发类用例用 slowJobs 把 job 拉长 ~20s，保证写回观察窗口不被错过。
import {
  test as baseTest, expect, launchApp, mockJobs, mockSpeed, waitForMockJobFinished, FIXTURES,
} from "./helpers";
import type { ElectronApp, APIRequestContext } from "./helpers";
import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// step 是每 100ms tick 的进度增量：0.005 → 200 tick ≈ 20s/job（与 watch.spec 同款：
// mock 默认速度太快，job 常在首次观察时已 done，写回触发会漏）
const slowJobs = (request: APIRequestContext) => mockSpeed(request, { step: 0.005, tickMs: 100 });

async function watchState(page: Page) {
  return page.evaluate(async () => (window as any).javDesktop.watch.state());
}
async function watchSet(page: Page, partial: { enabled?: boolean; path?: string; pollMs?: number }) {
  return page.evaluate(async (q) => (window as any).javDesktop.watch.set(q), partial);
}
function tmpWatchDir() {
  return mkdtempSync(join(tmpdir(), "javscribe-watch-ffprobe-"));
}

// 客户端扫描规则「忽略小于」置 0：72KB 夹具 < 默认 min_size_mb 200MB，当前 dist 构建里 watch
// 候选循环在 ffprobe 探测前会按该口径拦 too_small（与文件夹扫描口径对齐），不置 0 候选会在
// 探测前被过滤、三个用例全部失去被测对象。watch 每 tick 用 clientScanCfg() 从磁盘现读配置，
// 运行期 putClientConfig 立即生效；若构建尚无该 gate，此调用为无害 no-op。
async function zeroMinSizeGate(page: Page) {
  await page.evaluate(async () => {
    const r = await (window as any).javDesktop.call("putClientConfig", [JSON.stringify({ scan_min_size_mb: 0 })]);
    if (!r.ok) throw new Error(r.error || "putClientConfig 失败");
  });
}

// ---------------------------------------------------------------------------
// 假 ffprobe（node 脚本）：按文件名分支输出字幕轨 JSON / 非 JSON 失败
// ---------------------------------------------------------------------------

const FAKE_FFMPEG_SCRIPT = `#!/usr/bin/env node
// fake ffprobe（watch e2e 专用）：main 以 execFile 调起，最后一个 argv = 被探测文件路径
const fs = require("fs");
const file = process.argv[process.argv.length - 1] || "";
const name = file.split("/").pop();
try { fs.appendFileSync(__dirname + "/calls.log", name + "\\n"); } catch (e) {}
if (name.includes("zh")) {
  process.stdout.write(JSON.stringify({ streams: [{ codec_name: "subrip", tags: { language: "zh" } }] }));
} else if (name.includes("eng")) {
  process.stdout.write(JSON.stringify({ streams: [{ codec_name: "subrip", tags: { language: "eng" } }] }));
} else {
  process.stdout.write("THIS IS NOT JSON");
  process.exitCode = 1;
}
`;

let fakeFfprobeDir: string | null = null;

function makeFakeFfprobe(): string {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-fake-ffprobe-"));
  // 显式 CJS：node 按「最近的 package.json」判定无扩展名脚本的模块类型，本机 /tmp 残留
  // type:module 的 package.json（electron 打包产物），不钉死会把 require() 当 ESM 跑挂
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf-8");
  const bin = join(dir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  writeFileSync(bin, FAKE_FFMPEG_SCRIPT, "utf-8");
  chmodSync(bin, 0o755); // findFfprobe 只查 existsSync，execFile 直接执行仍需可执行位
  return dir;
}

// 覆写 app fixture：带 JAVSCRIBE_FFMPEG_DIR 注入假 ffprobe 目录（相对 helpers.launchApp
// 的唯一差异）；userData/page 原样继承，每 test 一个全新 app + 一个假目录
const test = baseTest.extend<{ app: ElectronApp }>({
  app: async ({ userData }, use) => {
    const dir = makeFakeFfprobe();
    fakeFfprobeDir = dir;
    const app = await launchApp(userData, { JAVSCRIBE_FFMPEG_DIR: dir });
    await use(app);
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    fakeFfprobeDir = null;
  },
});

/** 等 watch 派发的 job 出现在 mock 侧（job label 即源文件名；UI 行前缀「监听 · 」） */
async function waitForWatchJob(request: APIRequestContext, file: string): Promise<any> {
  await expect.poll(
    async () => (await mockJobs(request)).filter((j) => String(j.label ?? "").includes(file)).length,
    { timeout: 60_000, message: `watch 候选 ${file} 未在 60s 内派发成 job` },
  ).toBe(1);
  const list = await mockJobs(request);
  return list.find((j) => String(j.label ?? "").includes(file));
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test("内嵌 zh 字幕轨：探测命中 → 不派发", async ({ page, request }) => {
  const dir = tmpWatchDir();
  copyFileSync(join(FIXTURES, "video-a.mp4"), join(dir, "emb-zh.mp4"));
  try {
    // 选服务保证「若跳过失效必会派发」（canary）：预期全程无 job
    await zeroMinSizeGate(page);
    await page.selectOption("#engine-select", "mock");
    const r = await watchSet(page, { enabled: true, path: dir, pollMs: 800 });
    expect(r.ok).toBe(true);
    await expect(page.locator("#watch-status", { hasText: "监听中" })).toBeVisible({ timeout: 10_000 });

    // 候选需 (size, mtime) 连续两次轮询不变（≈2s）；探测命中在发候选前被过滤；
    // ~6s 覆盖完整派发窗口——若跳过逻辑失效，此刻 job 已提交
    await sleep(6_000);
    expect(await mockJobs(request)).toHaveLength(0);

    // 假 ffprobe 确实被调用（钉实跑覆盖，排除「无 ffprobe → 直接 fail-open」路径）
    expect(readFileSync(join(fakeFfprobeDir!, "calls.log"), "utf-8")).toContain("emb-zh.mp4");

    const st = await watchState(page);
    expect(st).toMatchObject({ on: true, processed: 0, lastError: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("只有 eng 字幕轨：探测不命中 → 正常派发 + srt 写回影片同目录", async ({ page, request }) => {
  await slowJobs(request);
  const dir = tmpWatchDir();
  copyFileSync(join(FIXTURES, "video-a.mp4"), join(dir, "emb-eng.mp4"));
  try {
    await zeroMinSizeGate(page);
    await page.selectOption("#engine-select", "mock");
    const r = await watchSet(page, { enabled: true, path: dir, pollMs: 800 });
    expect(r.ok).toBe(true);
    await expect(page.locator("#watch-status", { hasText: "监听中" })).toBeVisible({ timeout: 10_000 });

    // 候选稳定（≈2s）→ 探测（eng 非目标语言，不拦）→ 派发 → slow job ≈20s → finished
    const job = await waitForWatchJob(request, "emb-eng.mp4");
    await waitForMockJobFinished(request, job.id, 60_000);
    expect(readFileSync(join(fakeFfprobeDir!, "calls.log"), "utf-8")).toContain("emb-eng.mp4");

    // 写回落盘：watch 派发强制写回（不勾选 autoSave 也生效），同 stem .zh.srt
    const srt = join(dir, "emb-eng.zh.srt");
    await expect.poll(() => existsSync(srt), { timeout: 20_000 }).toBe(true);
    expect(readFileSync(srt, "utf-8")).toContain("emb-eng");

    const st = await watchState(page);
    expect(st).toMatchObject({ on: true, processed: 1, lastError: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ffprobe 失败（exit 1 + 输出非 JSON）：fail-open 正常派发 + srt 写回", async ({ page, request }) => {
  // 同 eng 例；emb-bad.mp4 不含 zh/eng → 假 ffprobe 向 stdout 写非 JSON 且 exit 1
  // → main 的 execFile 回调 err（非零退出）→ 探测结果按 [] 处理 → fail-open，不挡派发
  await slowJobs(request);
  const dir = tmpWatchDir();
  copyFileSync(join(FIXTURES, "video-a.mp4"), join(dir, "emb-bad.mp4"));
  try {
    await zeroMinSizeGate(page);
    await page.selectOption("#engine-select", "mock");
    const r = await watchSet(page, { enabled: true, path: dir, pollMs: 800 });
    expect(r.ok).toBe(true);
    await expect(page.locator("#watch-status", { hasText: "监听中" })).toBeVisible({ timeout: 10_000 });

    const job = await waitForWatchJob(request, "emb-bad.mp4");
    await waitForMockJobFinished(request, job.id, 60_000);
    expect(readFileSync(join(fakeFfprobeDir!, "calls.log"), "utf-8")).toContain("emb-bad.mp4");

    const srt = join(dir, "emb-bad.zh.srt");
    await expect.poll(() => existsSync(srt), { timeout: 20_000 }).toBe(true);
    expect(readFileSync(srt, "utf-8")).toContain("emb-bad");

    const st = await watchState(page);
    expect(st).toMatchObject({ on: true, processed: 1, lastError: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
