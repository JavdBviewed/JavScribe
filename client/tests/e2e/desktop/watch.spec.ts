// 文件夹监控 e2e（仅 desktop 形态）：main 进程轮询检测 → renderer 排队串行派发 → 完成后强制写回影片同目录。
// 覆盖四类：
//   功能 —— set 校验 / 默认态 / 全链路（候选→派发→done→srt 落盘）/ 字幕跳过 / 稳定性 / 重启去重
//   交互 —— 无服务排队→补选服务自动消费 / UI 按钮启停 + watch.json 持久化
//   样式 —— 卡片 off / on 截图基线（style-14/15）
// 节奏说明：JAVSCRIBE_WATCH_MIN_POLL_MS=300（helpers launchApp 注入）允许短轮询；
//           候选需 (size, mtime) 连续两次轮询不变（稳定性基线），故 pollMs=800 时首个候选 ≈2s。
// 口径说明：0.2.63 起 watch 候选对齐 min_size_mb 扫描规则（默认 200MB），72KB 夹具天然
//           too_small → 派发类用例统一先 putClientConfig 置 scan_min_size_mb=0 放行。
import { test, expect, goView, mockJobs, mockSpeed, relaunch, freezeForShot, shot, MOCK, MOCK_KEY, FIXTURES } from "./helpers";
import type { APIRequestContext } from "./helpers";
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";

const fx = (n: string) => join(FIXTURES, n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SRT_TEXT = "テスト字幕 video-a.mp4"; // mock 生成的 srt 内嵌影片名（与 interaction.spec 一致）

// 小夹具 < 默认 min_size_mb(200MB)：派发类用例先关闭「忽略小于」扫描规则（与 interaction.spec 同款）
async function scanMinSizeZero(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const r = await (window as any).javDesktop.call("putClientConfig", [JSON.stringify({ scan_min_size_mb: 0 })]);
    if (!r.ok) throw new Error(r.error || "putClientConfig 失败");
  });
}

// 写回触发依赖渲染端 5s 轮询观察到 running→done；mock 默认速度 ~0.4s 完成，job 常被首次
// 观察到时已 done（写回漏触发）。step 是每 100ms tick 的进度增量：0.005 → 200 tick ≈ 20s/job，
// 保证派发后的刷新与 5s 周期刷新都落在 running 段（生产 job 为分钟级，无此问题）。
const slowJobs = (request: APIRequestContext) => mockSpeed(request, { step: 0.005, tickMs: 100 });

async function watchState(page: Page) {
  return page.evaluate(async () => (window as any).javDesktop.watch.state());
}
async function watchSet(page: Page, partial: { enabled?: boolean; path?: string; pollMs?: number }) {
  return page.evaluate(async (q) => (window as any).javDesktop.watch.set(q), partial);
}
function tmpWatchDir() {
  return mkdtempSync(join(tmpdir(), "javscribe-watch-"));
}

// ---------------------------------------------------------------------------
// 功能类
// ---------------------------------------------------------------------------

test("watch 默认态 + set 校验（坏目录 / 文件路径 / 无目录启用）", async ({ page, userData }) => {
  const st0 = await watchState(page);
  expect(st0).toMatchObject({
    enabled: false, path: "", paths: [], on: false, processed: 0, failed: 0,
    lastScan: null, lastError: null, errors: {},
  });
  expect(st0.pollMs).toBe(15_000);

  const badDir = await watchSet(page, { path: join(tmpdir(), "no-such-dir-xxx") });
  expect(badDir.ok).toBe(false);
  expect(badDir.error).toContain("不存在");
  const badEnable = await watchSet(page, { enabled: true });
  expect(badEnable.ok).toBe(false);
  expect(badEnable.error).toContain("请先添加");
  const badFile = await watchSet(page, { path: fx("video-a.mp4") });
  expect(badFile.ok).toBe(false);
  expect(badFile.error).toContain("不是文件夹");

  const dir = realpathSync(tmpWatchDir()); // realpath 归一后落盘（set 校验归一化）
  const ok = await watchSet(page, { path: dir });
  expect(ok.ok).toBe(true);
  expect(ok.state).toMatchObject({ enabled: false, path: dir, paths: [dir], on: false });
  // 新结构落盘：paths 数组，不再写单 path 键；默认 enabled=false 起步
  const raw = JSON.parse(readFileSync(join(userData, "watch.json"), "utf-8"));
  expect(raw.paths).toEqual([dir]);
  expect(raw.path).toBeUndefined();
  expect(raw.enabled).toBe(false);
});

test("watch 全链路：新视频 → 候选 → 自动派发 → done → srt 写回影片同目录 + processed", async ({ page, request }) => {
  await scanMinSizeZero(page);
  await slowJobs(request);
  const dir = tmpWatchDir();
  copyFileSync(fx("video-a.mp4"), join(dir, "video-a.mp4"));
  await page.selectOption("#engine-select", "mock");

  const r = await watchSet(page, { enabled: true, path: dir, pollMs: 800 });
  expect(r.ok).toBe(true);
  expect(r.state).toMatchObject({ enabled: true, on: true });

  await expect(page.locator("#watch-status", { hasText: "监听中" })).toBeVisible({ timeout: 10_000 });
  // 派发（本机 ffmpeg 提取 + 上传 + mock 秒级完成）
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 60_000 });
  await goView(page, "jobs");
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) });
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });

  // 写回落盘：watch 派发强制写回（不勾选 autoSave 也生效）
  const srt = join(dir, "video-a.zh.srt");
  await expect.poll(() => existsSync(srt), { timeout: 20_000 }).toBe(true);
  expect(readFileSync(srt, "utf-8")).toContain(SRT_TEXT);
  expect(await page.locator("#autosave")).not.toBeChecked();

  const st = await watchState(page);
  expect(st.processed).toBe(1);
  expect(st.lastError).toBeNull();
});

test("同 stem 已有字幕：永不派发；删除字幕后变为候选并派发", async ({ page, request }) => {
  await scanMinSizeZero(page);
  const dir = tmpWatchDir();
  copyFileSync(fx("folder/video-c.mp4"), join(dir, "video-c.mp4"));
  writeFileSync(join(dir, "video-c.zh.srt"), "1\n00:00:00,000 --> 00:00:01,000\n旧字幕\n");
  await page.selectOption("#engine-select", "mock");
  await watchSet(page, { enabled: true, path: dir, pollMs: 600 });
  await expect(page.locator("#watch-status", { hasText: "监听中" })).toBeVisible({ timeout: 10_000 });

  // ≥3 个轮询周期：有字幕 → 不派发
  await sleep(3_500);
  expect(await mockJobs(request)).toHaveLength(0);

  // 删字幕 → 下两个轮询确认稳定 → 派发
  rmSync(join(dir, "video-c.zh.srt"));
  await goView(page, "jobs");
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-c.mp4" }) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
});

test("稳定性：轮询中途改写文件 → 稳定后仅派发一次（无重复任务）", async ({ page, request }) => {
  await scanMinSizeZero(page);
  const dir = tmpWatchDir();
  await page.selectOption("#engine-select", "mock");
  const r = await watchSet(page, { enabled: true, path: dir, pollMs: 800 });
  expect(r.ok).toBe(true);
  await sleep(1_000); // 基线轮询（空目录）

  const f = join(dir, "video-b.mkv");
  copyFileSync(fx("video-b.mkv"), f);
  await sleep(900);   // 首见：记录 (size, mtime)，还不稳定
  copyFileSync(fx("video-b.mkv"), f); // 同尺寸改写 → mtime 变化，稳定性重置
  // 尚未稳定：不应有任务（此刻处于「已记录 → 待二次确认」窗口）
  expect((await mockJobs(request)).filter((j) => String(j.label ?? "").startsWith("video-b.mkv"))).toHaveLength(0);

  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-b.mkv" }) });
  await goView(page, "jobs");
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
  await sleep(2_500); // 留足窗口：若稳定性失效会看到重复任务
  const dup = (await mockJobs(request)).filter((j) => String(j.label ?? "").startsWith("video-b.mkv"));
  expect(dup).toHaveLength(1);
});

test("重启：watch 自动恢复 + 已处理视频不重复派发（processed 跨重启去重）", async ({ page, request, userData }) => {
  await slowJobs(request);
  await scanMinSizeZero(page);
  const dir = tmpWatchDir();
  copyFileSync(fx("video-a.mp4"), join(dir, "video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await watchSet(page, { enabled: true, path: dir, pollMs: 800 });

  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) });
  await goView(page, "jobs");
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 60_000 });
  await goView(page, "dispatch");
  await expect(page.locator("#watch-status", { hasText: /已处理 1/ })).toBeVisible({ timeout: 15_000 });

  // 移除写回产物：此时若重复派发，唯一能拦住的就是 processed 去重
  // （processed 标记先于写回落盘，须先等 srt 写出再删）
  await expect.poll(() => existsSync(join(dir, "video-a.zh.srt")), { timeout: 20_000 }).toBe(true);
  rmSync(join(dir, "video-a.zh.srt"));
  await page.close();
  const { app: app2, page: page2 } = await relaunch(userData);
  try {
    const st2 = await watchState(page2);
    expect(st2).toMatchObject({ enabled: true, on: true, processed: 1, path: dir });
    // ≥6 个轮询周期（seen 重新预热 2 轮 + 冗余）
    await sleep(6_000);
    const dup = (await mockJobs(request)).filter((j) => String(j.label ?? "").startsWith("video-a.mp4"));
    expect(dup).toHaveLength(1);
    expect(existsSync(join(dir, "video-a.zh.srt"))).toBe(false);
  } finally {
    await app2.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 交互类
// ---------------------------------------------------------------------------

test("未选择服务：候选留队列显示「未选择服务」；补选服务后自动消费", async ({ page, request }) => {
  await scanMinSizeZero(page);
  const dir = tmpWatchDir();
  copyFileSync(fx("video-a.mp4"), join(dir, "video-a.mp4"));
  const del = await page.evaluate(async () => {
    const r = await (window as any).javDesktop.call("deleteEngine", ["mock"]);
    return r;
  });
  expect(del.ok).toBe(true);
  await goView(page, "engines");
  await expect(page.locator("#engines-empty")).toBeVisible({ timeout: 15_000 });

  await watchSet(page, { enabled: true, path: dir, pollMs: 800 });
  await goView(page, "dispatch");
  await expect(page.locator("#watch-status", { hasText: "未选择服务" })).toBeVisible({ timeout: 15_000 });
  await sleep(1_500);
  expect(await mockJobs(request)).toHaveLength(0); // 排队中，不派发

  const add = await page.evaluate(async ([name, url, key]) => {
    const r = await (window as any).javDesktop.call("addEngine", [name, url, key]);
    return r;
  }, ["mock", MOCK, MOCK_KEY] as [string, string, string]);
  expect(add.ok).toBe(true);
  await page.waitForFunction(() => !!document.querySelector('#engine-select option[value="mock"]'), { timeout: 15_000 });
  await page.selectOption("#engine-select", "mock"); // onchange → 消费泵

  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) });
  await goView(page, "jobs");
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 60_000 });
});

test("UI 操作：添加目录 → 开始监听 → 停止（paths 保留、enabled 落盘）", async ({ page, userData }) => {
  const dir = realpathSync(tmpWatchDir());
  await expect(page.locator("#watch-toggle")).toBeDisabled(); // 初始无目录
  await page.fill("#watch-add-input", dir);
  await page.click("#watch-add");
  // 目录行渲染 + 输入清空 + 总开关解锁
  await expect(page.locator("#watch-rows .watch-row", { hasText: dir })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator("#watch-add-input")).toHaveValue("");
  await expect(page.locator("#watch-toggle")).toBeEnabled();
  await page.click("#watch-toggle");
  await expect(page.locator("#watch-status", { hasText: "监听中" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#watch-toggle")).toHaveText("停止监听");
  await page.click("#watch-toggle");
  await expect(page.locator("#watch-status", { hasText: "未监听" })).toBeVisible({ timeout: 10_000 });
  // 停止后目录行保留（paths 持久化，仅 enabled 切换）
  await expect(page.locator("#watch-rows .watch-row", { hasText: dir })).toBeVisible();

  const raw = JSON.parse(readFileSync(join(userData, "watch.json"), "utf-8"));
  expect(raw.enabled).toBe(false);
  expect(raw.paths).toEqual([dir]);
  expect(raw.path).toBeUndefined();
});

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

test("迁移：旧 watch.json 单 path 启动后 paths=[path] 且监听照常（派发全链路）", async ({ page, request, userData }) => {
  await slowJobs(request);
  await scanMinSizeZero(page);
  const dir = realpathSync(tmpWatchDir());
  // 手工写 0.2.62 及以前的旧结构（path 单值）
  writeFileSync(join(userData, "watch.json"), JSON.stringify({
    enabled: true, path: dir, pollMs: 800, processed: [],
  }), "utf-8");
  copyFileSync(fx("video-a.mp4"), join(dir, "video-a.mp4"));
  await page.close();
  const { app: app2, page: page2 } = await relaunch(userData);
  try {
    await page2.selectOption("#engine-select", "mock");
    const st = await watchState(page2);
    // 旧 path 迁移进 paths（enabled 原样恢复，监听自动起）
    expect(st).toMatchObject({ enabled: true, on: true, path: dir, processed: 0 });
    expect(st.paths).toEqual([dir]);
    // 迁移后全链路照常：候选 → 派发 → done
    const row = page2.locator(".job-row", { has: page2.locator(".fn", { hasText: "video-a.mp4" }) });
    await goView(page2, "jobs");
    await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 60_000 });
    const st2 = await watchState(page2);
    expect(st2.processed).toBe(1);
    // 迁移落盘为一次性：下次 save 后不再写单 path 键（本次派发 markProcessed 已触发 save）
    const raw = JSON.parse(readFileSync(join(userData, "watch.json"), "utf-8"));
    expect(raw.paths).toEqual([dir]);
    expect(raw.path).toBeUndefined();
  } finally {
    await app2.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 样式类
// ---------------------------------------------------------------------------

test("watch 卡片：关闭态（桌面基线）", async ({ page, request }) => {
  await freezeForShot(page, request);
  await shot(page, "style-14-watch-panel-off", { element: "#watch-panel" });
});

test("watch 卡片：监听中（状态行 + 灯）", async ({ page, request }) => {
  // 固定目录名（非 mkdtemp 随机后缀）：路径文本进截图，随机名会导致基线 diff
  const dir = join(tmpdir(), "javscribe-watch-shot");
  mkdirSync(dir, { recursive: true });
  await watchSet(page, { enabled: true, path: dir, pollMs: 800 });
  await expect(page.locator("#watch-status", { hasText: "监听中" })).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await freezeForShot(page, request); // 「上次扫描」时间由 freeze 隐藏，基线可比
  await shot(page, "style-15-watch-panel-on", { element: "#watch-panel" });
});
