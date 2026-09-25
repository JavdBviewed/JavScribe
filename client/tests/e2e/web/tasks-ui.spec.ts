// 任务列表 UI：合并筛选条（状态+计数一体）/ 勾选+批量操作条 / 服务卡监控 sparkline
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  WEB_URL, mockReset, mockSeed, mockPause, cleanEngines,
  waitForJobsEmpty, waitForEngineOnline, resetPipelinePause, mockControl, goTab,
} from "../helpers";

let req: APIRequestContext;
test.beforeEach(async ({ request }) => {
  req = request;
  await mockReset(request);
  await resetPipelinePause(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
});

const jobRows = (page: Page) => page.locator("#job-list .job-row");
const filterBtn = (page: Page, f: string) => page.locator(`#job-filter button[data-f="${f}"]`);

/** seed 6 行（running×3 / pending×2 / error×1 / skipped×1）并冻结 tick，计数不漂移 */
async function seedSix(page: Page) {
  await mockSeed(req, { n: 6, status: "running", pending: 2, errors: 1, skipped: 1 });
  await mockPause(req);
  await page.goto("/");
  await waitForEngineOnline(page);
  await expect.poll(
    async () => (await (await req.get(`${WEB_URL}/api/jobs`)).json() as unknown[]).length,
    { timeout: 15_000 },
  ).toBe(6);
  await goTab(page, "jobs");
  await expect(jobRows(page)).toHaveCount(6, { timeout: 15_000 });
}

test("筛选条：9 个状态按钮（内嵌计数）取代旧统计行，点击筛选生效", async ({ page }) => {
  await seedSix(page);

  // 旧「统计行」已删除，与筛选条合一
  expect(await page.locator("#job-stats").count()).toBe(0);
  await expect(page.locator("#job-filter button")).toHaveCount(9);

  // 按钮内计数：活跃态按现行、终态走 serve 累计 summary（mock 口径=行计数）
  // running×2=转译中、pending×2=排队中、error×1=失败、skipped×1=跳过
  await expect(filterBtn(page, "all")).toContainText("6");
  await expect(filterBtn(page, "active")).toContainText("4");
  await expect(filterBtn(page, "queued")).toContainText("2");
  await expect(filterBtn(page, "extracting")).toContainText("0");
  await expect(filterBtn(page, "transcribing")).toContainText("2");
  await expect(filterBtn(page, "done")).toContainText("0");
  await expect(filterBtn(page, "skipped")).toContainText("1");
  await expect(filterBtn(page, "failed")).toContainText("1");
  await expect(filterBtn(page, "paused")).toContainText("0");

  // 点击筛选：只留对应桶的行
  await filterBtn(page, "queued").click();
  await expect(jobRows(page)).toHaveCount(2);
  await filterBtn(page, "transcribing").click();
  await expect(jobRows(page)).toHaveCount(2);
  await filterBtn(page, "failed").click();
  await expect(jobRows(page)).toHaveCount(1);
  await filterBtn(page, "all").click();
  await expect(jobRows(page)).toHaveCount(6);
});

test("勾选 + 批量操作条：全选 3 行批量暂停（含运行中 → 2 成 1 败），暂停行进「已暂停」桶", async ({ page }) => {
  // 行序 created 降序：seed-003（running）在最前，seed-002/001（pending）在后
  await mockSeed(req, { n: 3, status: "running", pending: 2 });
  await mockPause(req);
  await page.goto("/");
  await waitForEngineOnline(page);
  await goTab(page, "jobs");
  await expect(jobRows(page)).toHaveCount(3, { timeout: 15_000 });

  const bar = page.locator("#job-bulk-bar");
  await expect(bar).toBeHidden();
  // 行内勾选 → 批量条出现（「已选 N 项」）
  await page.locator("#job-list input.job-chk").nth(1).check();
  await expect(bar).toBeVisible();
  await expect(page.locator("#job-bulk-info")).toHaveText("已选 1 项");
  // 表头全选当前筛选结果（跨页语义，此处=全部 3 行）
  await page.locator("#job-sel-all").check();
  await expect(page.locator("#job-bulk-info")).toHaveText("已选 3 项");

  // 批量暂停：2 个排队任务挂起成功；运行中任务 mock 返回 409 → 单条失败不拖垮整批
  await bar.locator(".bulk-act[data-act=\"pause\"]").click();
  await expect(page.locator("#toasts .toast").last()).toContainText("批量暂停：成功 2，失败 1", { timeout: 20_000 });

  // 挂起的 2 行进入「已暂停」桶（筛选条计数）
  await expect(filterBtn(page, "paused")).toContainText("2", { timeout: 15_000 });

  // 批量操作后选择自动清空 → 批量条隐藏、行内勾选复位
  await expect(bar).toBeHidden();
  expect(await page.locator("#job-list input.job-chk:checked").count()).toBe(0);
  expect(await page.locator("#job-sel-all").isChecked()).toBe(false);

  // 重新勾选一行 → 走「清除全部选择」路径
  await page.locator("#job-list input.job-chk").nth(1).check();
  await expect(bar).toBeVisible();
  await bar.locator(".bulk-clear").click();
  await expect(bar).toBeHidden();
});

test("服务卡监控：无 GPU → 队列深度曲线；开 GPU → 利用率+显存文案", async ({ page }) => {
  await page.goto("/");
  await waitForEngineOnline(page);
  await goTab(page, "engines");
  const box = page.locator(".eng-metrics");
  // mock 默认无 GPU + 历史预填 40 点 → sparkline 立即可见
  await expect(box.locator("svg.spark")).toBeVisible({ timeout: 15_000 });
  await expect(box.locator(".mm-main")).toHaveText("队列深度");
  await expect(box.locator(".mm-sub")).toHaveText("排队 0 · 运行 0");

  // 切到 GPU 状态：工作台 2s 缓存 + 页面 5s 轮询 → 终现 GPU 文案（5400MB=5.3G / 8192MB=8.0G）
  await mockControl(req, "metrics", { gpu_present: true, gpu_util: 43, mem_used_mb: 5400, mem_total_mb: 8192 });
  await expect(box.locator(".mm-main")).toContainText("GPU 43% · 显存 5.3/8.0G", { timeout: 20_000 });
});
