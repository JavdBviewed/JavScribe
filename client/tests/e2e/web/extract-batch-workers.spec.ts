// 「主任务级本机提取并发」输入接线 web e2e（0.2.53 需求③）：
//  - 派发栏 #batch-extract-workers / 扫描栏 #scan-extract-workers 存在且
//    min=1 max=8 placeholder=跟随设置（两端共享同一份 client/ui/index.html 构建产物）；
//  - 填合法 N（=2）文件夹派发链正常：主任务行出现、mock 侧任务创建并跑完；
//  - 非法/空值（0 / 9 / abc / 空）不报错、照常派发（parseExtractWorkers 落
//    undefined = 跟随客户端设置；number 输入框对 abc 由浏览器归一为空串）。
// web 形态 #extract-select 固定 server（绕 WASM 本地提取）：本 spec 验的是输入
// 接线与解析口径，执行路径与现有 batch-parallel web spec 同款。
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  waitForEngineOnline, waitForEngineKey, mockReset, mockSpeed, cleanEngines,
  waitForJobsEmpty, resetPipelinePause, goTab, WEB_URL, FIXTURES,
} from "../helpers";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const VIDEO_A = join(FIXTURES, "video-a.mp4");

let req: APIRequestContext;
test.beforeEach(async ({ page, request }) => {
  req = request;
  await mockReset(request);
  await resetPipelinePause(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  await mockSpeed(request, { step: 0.0125, tickMs: 100 }); // 8s/任务：完成等待口径稳定
  await page.goto("/");
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
});
// pipeline_paused 与扫描规则 minsize 均持久化在共享 client_config.json：用例中途失败也要复位
test.afterEach(async () => {
  await resetPipelinePause(req);
  await req.put("/api/client-config", { data: { scan_min_size_mb: 200 } }).catch(() => {});
});

/** 临时目录铺 N 个无字幕视频夹具（webkitdirectory 选目录用） */
function mkVideos(tag: string, n: number, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `javweb-bew-${tag}-`));
  for (let i = 1; i <= n; i++) {
    copyFileSync(VIDEO_A, join(dir, `${prefix}-${String(i).padStart(3, "0")}.mp4`));
  }
  return dir;
}

/** 「忽略小于」置 0（文件夹 too_small 判定走客户端本地已加载配置 → 须走设置 UI） */
async function setMinSize0(page: Page) {
  await goTab(page, "ccfg");
  await expect(page.locator("#cc-scan-minsize")).toHaveValue("200", { timeout: 10_000 });
  await page.locator("#cc-scan-minsize").fill("0");
  await page.locator("#cc-scan-save").click();
  await expect(page.locator("#toasts .toast.ok", { hasText: "扫描规则已保存" })).toBeVisible({ timeout: 10_000 });
  await goTab(page, "dispatch");
}

/** 等 mock（经工作台 /api/jobs）出现 n 个文件任务 */
async function waitMockJobCount(n: number, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const jobs: any[] = await (await req.get(`${WEB_URL}/api/jobs`)).json();
    if (jobs.length >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`mock 任务数 ${jobs.length} < ${n}`);
    await new Promise((rs) => setTimeout(rs, 200));
  }
}

test("输入框结构：min/max/placeholder 口径正确，扫描框初始隐藏（与 scan-submit 同显隐）", async ({ page }) => {
  await setMinSize0(page);
  const bw = page.locator("#batch-extract-workers");
  const sw = page.locator("#scan-extract-workers");
  await expect(bw, "batch 输入框").toBeVisible();
  // 扫描框初始隐藏：无扫描结果时占 0 高度（监听卡片布局零漂移守卫）
  await expect(sw, "scan 输入框").toBeAttached();
  await expect(sw).toBeHidden();
  for (const [label, inp] of [["batch", bw], ["scan", sw]] as const) {
    await expect(inp).toHaveAttribute("min", "1");
    await expect(inp).toHaveAttribute("max", "8");
    await expect(inp).toHaveAttribute("placeholder", "跟随设置");
  }
});

test("填 N=2 文件夹派发链正常：主任务行出现、任务创建并跑完", async ({ page }) => {
  await setMinSize0(page);
  const dir = mkVideos("w1", 2, "BEW");
  try {
    await page.setInputFiles("#folder", dir);
    await expect(page.locator("#folder-chip-text")).toHaveText("已选 2 / 2");
    await page.selectOption("#engine-select", "mock");
    await page.selectOption("#extract-select", "server");
    await page.locator("#batch-extract-workers").fill("2");
    await page.click("#dispatch-go");
    // 主任务行出现（发送时刻消费勾选 → 派发页收掉待选表）
    await goTab(page, "jobs");
    const row = page.locator(".job-batch-row", { hasText: basename(dir) });
    await expect(row).toHaveCount(1);
    // mock 侧 2 个文件任务创建，且两个文件行都跑完（派发链端到端正常）
    await waitMockJobCount(2);
    for (const f of ["BEW-001.mp4", "BEW-002.mp4"]) {
      await expect(
        page.locator(".job-row", { has: page.locator(".fn", { hasText: f }) }).locator(".pill.p-done"),
      ).toBeVisible({ timeout: 90_000 });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("非法/空值（0/9/abc/空）不报错、照常派发（=跟随设置）", async ({ page }) => {
  await setMinSize0(page);
  const dir = mkVideos("w2", 1, "BEW");
  try {
    for (let i = 0; i < 4; i++) {
      const v = ["0", "9", "abc", ""][i];
      await page.setInputFiles("#folder", dir);
      await expect(page.locator("#folder-chip-text")).toHaveText("已选 1 / 1");
      await page.selectOption("#engine-select", "mock");
      await page.selectOption("#extract-select", "server");
      if (v === "abc") {
        // number 输入框：浏览器对非法文本 value 归一为空串（= 用户敲 abc 的真实效果）；
        // Playwright fill 会直接拒绝 text 入 number 框，故走 value 赋值 + 事件
        await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLInputElement;
          el.value = "abc";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, "#batch-extract-workers");
      } else if (v !== "") {
        await page.locator("#batch-extract-workers").fill(v);
      }
      await page.click("#dispatch-go");
      // 每轮照常派发：主任务行 +1（number 框对 abc 由浏览器归一空串 = 跟随设置口径）
      await goTab(page, "jobs");
      const rows = page.locator(".job-batch-row", { hasText: basename(dir) });
      await expect(rows).toHaveCount(i + 1, { timeout: 20_000 });
      // 无报错 toast
      await expect(page.locator("#toasts .toast.err")).toHaveCount(0);
      await goTab(page, "dispatch");
    }
    // 4 轮派发全部落到 mock（4 个文件任务）
    await waitMockJobCount(4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
