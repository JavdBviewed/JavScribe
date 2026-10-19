// 「扫描目录」auto 分发回归（10-17-javscribe-0243-scan-auto-balance）
// 缺陷：「扫描目录」选 auto 时客户端提交前 probe 一次，整批钉死单台服务
//       （用户报告「已绑定「158」：整批只发该服务」+ 旧 serve 1MB bad body size），
//       与「选择文件夹」per-file 派发时刻实时均衡不对称。
// 回归（双在线引擎：mock 8302 + 第二 mock 8305，同脚本换端口；workers=1 串行无端口冲突）：
//   1. 扫描 3 项（两服务在途均 0）提交 → 摊平 mock:2 / second:1（0246 B 派发时刻实时选机：在途最少 + 平手注册序），
//      两 serve /jobs 文件齐全、共享同一 batch_id/label（主任务不断链）
//   2. 路径两服务都 400（__notfound__）→ 全进本机提取回退（假 ffmpeg），
//      主任务复用 batch，逐文件 auto 解析（在途记账）最终 mock:2 / second:1 全部完成
import { test, expect, _electron as electron } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeScanDir, MOCK_KEY } from "./helpers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const DIST = join(ROOT, "client", "dist-desktop");
const MOCK_URL = "http://127.0.0.1:8302";
const SECOND_PORT = 8305; // engine-select 同款第二 mock 端口（webServer 注释已登记占用）
const SECOND_URL = `http://127.0.0.1:${SECOND_PORT}`;
const ENGINES = `mock=${MOCK_URL},second=${SECOND_URL}`;
const NAMES = ["AKDL-001.mp4", "AKDL-002.mp4", "SUB-001.mkv"];

let secondMock: ChildProcess | null = null;

test.beforeAll(async () => {
  secondMock = spawn(
    process.execPath,
    [join(ROOT, "client", "tests", "e2e", "mock-serve.mjs"), String(SECOND_PORT)],
    { stdio: "ignore" },
  );
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${SECOND_URL}/health`);
      if (r.ok) break;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 15_000) throw new Error("第二 mock serve 未就绪");
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(() => {
  secondMock?.kill();
});

/** 双引擎 userData（注册序 mock 在前：平手时 pickAutoEngine/resolveAutoEngine 取它） */
function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-scanbal-"));
  writeFileSync(
    join(dir, "engines.json"),
    JSON.stringify({
      engines: [
        { name: "mock", url: MOCK_URL, api_key: MOCK_KEY },
        { name: "second", url: SECOND_URL, api_key: MOCK_KEY },
      ],
    }, null, 1),
    "utf-8",
  );
  return dir;
}

async function launch(userData: string, extraEnv: Record<string, string> = {}) {
  const app = await electron.launch({
    args: [DIST, "--no-sandbox"],
    env: {
      ...process.env,
      JAVSCRIBE_CLIENT_USERDATA: userData,
      JAVSCRIBE_ENGINES: ENGINES,
      JAVSCRIBE_CLIENT_FRAMELESS: "1",
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  // 双引擎在线（helpers 的 waitForReady 只认 1/1，这里直接等 2/2）
  await page.getByText(/服务 2\/2 在线/).first().waitFor({ timeout: 25_000 });
  return { app, page };
}

interface JobDict {
  id: string;
  batch_id: string | null;
  batch_label: string | null;
  files?: { name: string; status: string }[];
}

async function jobsOf(url: string): Promise<JobDict[]> {
  // detail=1 才带 files（与真实 serve 同口径）
  return (await (await fetch(`${url}/jobs?detail=1`)).json()) as JobDict[];
}

const fileNames = (jobs: JobDict[]): string[] =>
  jobs.flatMap((j) => (j.files || []).map((t) => t.name));

/** 双 mock 清场（本 spec 不用基础 fixture 的 userData/mockReset，手动对齐其语义：每 test 全新 mock 状态） */
async function resetMocks(): Promise<void> {
  for (const u of [MOCK_URL, SECOND_URL]) {
    const r = await fetch(`${u}/_mock/reset`, { method: "POST", body: "{}" });
    if (!r.ok) throw new Error(`mock reset ${u} -> ${r.status}`);
  }
}

/** 扫描目录 → 全选 → 提交（调用前须已装 dialog 自动接受；engine 需已选 auto） */
async function submitScanAuto(page: import("@playwright/test").Page, dir: string): Promise<void> {
  await page.locator("#scan-path").fill(dir);
  await page.selectOption("#engine-select", "auto");
  await page.click("#scan-go");
  await expect(page.locator("#scan-table tbody tr")).toHaveCount(3, { timeout: 20_000 });
  await page.locator("#scan-select-all").check();
  await expect(page.locator("#scan-count")).toContainText("已选 3 / 3");
  await page.click("#scan-submit");
}

test("扫描 auto 提交 3 项：摊平双服务（mock:2/second:1）且主任务 batch 不断链", async () => {
  const dir = freshUserData();
  // 「忽略小于」默认 200MB 会把夹具小文件判「过小」→ 置 0 使扫描表可全选
  writeFileSync(join(dir, "client-config.json"), JSON.stringify({ scan_min_size_mb: 0 }), "utf-8");
  await resetMocks();
  const scanDir = makeScanDir("javscribe-scanbal-dist");
  const { app, page } = await launch(dir);
  try {
    page.on("dialog", (d) => d.accept()); // AKDL-002 同目录已有 srt → 提交前确认
    await submitScanAuto(page, scanDir);

    // 两 serve 合计收满 3 文件（客户端顺序提交：先 mock 组后 second 组）
    await expect
      .poll(async () => (await jobsOf(MOCK_URL)).concat(await jobsOf(SECOND_URL))
        .reduce((n, j) => n + (j.files?.length || 0), 0), { timeout: 30_000, intervals: [200] })
      .toBe(3);

    const mj = await jobsOf(MOCK_URL);
    const sj = await jobsOf(SECOND_URL);
    // 摊平：3 项 / 2 台在途均 0 → 注册序靠前的 mock 拿 2、second 拿 1（确定性）
    expect(fileNames(mj).length).toBe(2);
    expect(fileNames(sj).length).toBe(1);
    expect([...fileNames(mj), ...fileNames(sj)].sort()).toEqual([...NAMES].sort());
    // 主任务不断链：两 serve 的 job 共享同一 batch_id（非空）+ 同一 label
    const all = [...mj, ...sj];
    const ids = new Set(all.map((j) => j.batch_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBeNull();
    expect(new Set(all.map((j) => j.batch_label)).size).toBe(1);
    expect(all[0].batch_label).not.toBeNull();

    // 客户端侧：自动进任务看板，1 主任务 + 3 子行（跨服务行合并在同一主任务下）
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    await expect(page.locator(".job-batch-row")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(".job-row")).toHaveCount(3, { timeout: 15_000 });
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("扫描 auto 提交 3 项：两服务全 400 → 本机提取回退（复用主任务 batch，逐文件 auto 全完成）", async () => {
  const dir = freshUserData();
  writeFileSync(join(dir, "client-config.json"), JSON.stringify({ scan_min_size_mb: 0 }), "utf-8");
  await resetMocks();
  // 假 ffmpeg：把本机提取撑到 ~3s（dispatch-rows 同款，逐字抄用）；
  // 输出内容含源路径 → 三 opus 互不相同，不撞 serve 内容缓存
  const ff = makeFakeFfmpeg();
  const scanDir = makeScanDir("javscribe-scanbal-__notfound__"); // 路径含 __notfound__ → 两 mock 恒 400
  const { app, page } = await launch(dir, { JAVSCRIBE_FFMPEG: ff.bin });
  try {
    page.on("dialog", (d) => d.accept());
    await submitScanAuto(page, scanDir);

    // 全 400 → 本机提取回退提示 + 任务看板出现主任务（3 子任务）
    await expect(page.locator("#toasts .toast", { hasText: /本机提取后上传/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    await expect(page.locator(".job-batch-row")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator(".job-batch-row .batch-sub-n")).toHaveText("3 子任务");
    await expect(page.locator(".job-row")).toHaveCount(3);

    // 回退逐文件 auto 解析（客户端在途记账）：1→mock、2→second、3→平手回 mock
    // → 最终 mock:2 / second:1，全部完成（假 ffmpeg 每条 ~3s + mock 100ms tick，并发跑）
    await expect(page.locator(".job-row .pill.p-done")).toHaveCount(3, { timeout: 120_000 });
    const mj = await jobsOf(MOCK_URL);
    const sj = await jobsOf(SECOND_URL);
    expect(fileNames(mj).length).toBe(2);
    expect(fileNames(sj).length).toBe(1);
    expect([...fileNames(mj), ...fileNames(sj)].sort()).toEqual([...NAMES].sort());
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    rmSync(ff.dir, { recursive: true, force: true });
  }
});

/**
 * 显存感知回归（0.2.47，生产 158 场景：RTX4090 被外部进程占 15G、空闲 9G < 旧阈值 10G
 * → 整批被钉死 127，用户报「自动均衡没有效果」）。
 *   3. 缺省阈值 5：4G 空闲服务被滤出 auto 候选 → 3 项全给 22G 空闲服务
 *   4. 阈值 0（设置 vram_free_min_gb=0）：4G 空闲服务重新参选 → 2/1 摊平
 */
async function setGpu(url: string, usedMb: number, totalMb: number): Promise<void> {
  const r = await fetch(`${url}/_mock/metrics`, {
    method: "POST",
    body: JSON.stringify({ gpu_present: true, gpu_util: 12, mem_used_mb: usedMb, mem_total_mb: totalMb }),
  });
  if (!r.ok) throw new Error(`mock metrics ${url} -> ${r.status}`);
}

interface MetricsShimState {
  _metrics?: Record<string, { metrics?: { gpu?: { mem_used_mb?: number } | null } }>;
}

/** 等客户端 5s 轮询已采到两服务的目标显存值（选机过滤依赖最近采样） */
async function waitMetricsSampled(page: import("@playwright/test").Page, mockUsed: number, secondUsed: number): Promise<void> {
  await page.waitForFunction(
    (args: [number, number]) => {
      const [mm, ss] = args;
      const s = (window as unknown as { state?: MetricsShimState }).state;
      const gm = s?._metrics?.mock?.metrics?.gpu;
      const gs = s?._metrics?.second?.metrics?.gpu;
      return !!gm && !!gs && gm.mem_used_mb === mm && gs.mem_used_mb === ss;
    },
    [mockUsed, secondUsed] as [number, number],
    { timeout: 30_000 },
  );
}

test("显存过滤：4G 空闲（低于缺省 5G 阈值）服务被滤出，整批 3 项全给 22G 服务", async () => {
  const dir = freshUserData();
  writeFileSync(join(dir, "client-config.json"), JSON.stringify({ scan_min_size_mb: 0 }), "utf-8");
  await resetMocks();
  await setGpu(MOCK_URL, 20480, 24576);  // 空闲 4G < 5
  await setGpu(SECOND_URL, 2048, 24576); // 空闲 22G
  const scanDir = makeScanDir("javscribe-scanbal-vram");
  const { app, page } = await launch(dir);
  try {
    page.on("dialog", (d) => d.accept());
    await waitMetricsSampled(page, 20480, 2048);
    await submitScanAuto(page, scanDir);
    await expect
      .poll(async () => (await jobsOf(MOCK_URL)).concat(await jobsOf(SECOND_URL))
        .reduce((n, j) => n + (j.files?.length || 0), 0), { timeout: 30_000, intervals: [200] })
      .toBe(3);
    const mj = await jobsOf(MOCK_URL);
    const sj = await jobsOf(SECOND_URL);
    expect(fileNames(mj).length).toBe(0); // 4G 空闲服务被显存过滤，0 接收
    expect(fileNames(sj).length).toBe(3); // 22G 空闲服务全收 3 项
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("显存过滤可关：vram_free_min_gb=0 → 4G 空闲服务重新参选（2/1 摊平）", async () => {
  const dir = freshUserData();
  writeFileSync(join(dir, "client-config.json"), JSON.stringify({ scan_min_size_mb: 0, vram_free_min_gb: 0 }), "utf-8");
  await resetMocks();
  await setGpu(MOCK_URL, 20480, 24576);
  await setGpu(SECOND_URL, 2048, 24576);
  const scanDir = makeScanDir("javscribe-scanbal-vram0");
  const { app, page } = await launch(dir);
  try {
    page.on("dialog", (d) => d.accept());
    await waitMetricsSampled(page, 20480, 2048);
    await submitScanAuto(page, scanDir);
    await expect
      .poll(async () => (await jobsOf(MOCK_URL)).concat(await jobsOf(SECOND_URL))
        .reduce((n, j) => n + (j.files?.length || 0), 0), { timeout: 30_000, intervals: [200] })
      .toBe(3);
    const mj = await jobsOf(MOCK_URL);
    const sj = await jobsOf(SECOND_URL);
    // 在途最少 + 平手注册序（mock 在前）：1→mock、2→second、3→mock
    expect(fileNames(mj).length).toBe(2); // 阈值 0 不过滤 → mock 重新参选
    expect(fileNames(sj).length).toBe(1);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 假 ffmpeg：argv 末位 = 输出路径、第 3 位 = -i 的输入路径（dispatch-rows.spec.ts 同款） */
function makeFakeFfmpeg(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-e2e-fakeff-"));
  const bin = join(dir, "ffmpeg");
  const lines = [
    "#!/bin/bash",
    'out="${@: -1}"',
    'src="$3"',
    "printf 'Duration: 00:00:10.00, start: 0.000000, bitrate: 128 kb/s\\n' >&2",
    "printf 'size= 10kB time=00:00:02.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 20kB time=00:00:04.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 30kB time=00:00:06.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 40kB time=00:00:08.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 50kB time=00:00:10.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    'head -c 4096 /dev/zero > "$out"',
    'printf %s "$src" >> "$out"',
    "exit 0",
  ];
  writeFileSync(bin, lines.join("\n") + "\n", "utf8");
  chmodSync(bin, 0o755);
  return { dir, bin };
}
