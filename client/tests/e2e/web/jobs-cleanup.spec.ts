// web 工作台「清理已完成」专测（10-21-javscribe-0251-task-history）
// C 线用户面验收：终态行整批清（服务端 fan-out 任务表收缩）+ 非终态不动
// + 抑制集持久化（服务端 reset 后同 id 残留行不再回来；刷新页面=重启等价验证）。
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  MOCK_URL, mockReset, mockSeed, mockSpeed, cleanEngines,
  waitForJobsEmpty, waitForEngineOnline, resetPipelinePause, goTab,
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

const ledgerSuppress = (page: Page) =>
  page.evaluate(() => {
    const raw = localStorage.getItem("javweb_dispatch_ledger_v1");
    if (!raw) return 0;
    return ((JSON.parse(raw) as { suppress?: string[] }).suppress || []).length;
  });

test("历史清理：3 终态清掉 + 1 非终态不动 + 服务表收缩 + 残留同 id 被抑制（刷新后仍生效）", async ({ page }) => {
  // 3 done（seed 批 1）+ 1 running（seed 批 2，减速保持不推进）
  await mockSeed(req, { n: 3, status: "done" });
  await mockSeed(req, { n: 1, status: "running", progress: 0.5 });
  await mockSpeed(req, { step: 0.001, tickMs: 1000 });
  await page.goto("/");
  await waitForEngineOnline(page);
  await goTab(page, "jobs");
  await expect(jobRows(page)).toHaveCount(4, { timeout: 15_000 });

  page.on("dialog", (d) => d.accept());
  await page.locator("#job-clear-done").click();
  await expect(page.locator("#job-cleanup-backdrop")).toBeVisible();
  await page.locator("#job-cleanup-ok").click();
  await expect(page.locator("#toasts .toast.ok", { hasText: "已清理 3 条本机任务；服务侧 1/1 成功（清 3 条）" }))
    .toBeVisible({ timeout: 15_000 });

  // 服务端任务表收缩：只剩 running 那条
  expect((await (await req.get(`${MOCK_URL}/jobs`)).json()) as unknown[]).toHaveLength(1);
  await expect(jobRows(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(".job-row .pill.p-running")).toHaveCount(1);
  // 0.2.58 回归：清理后筛选条终态桶回零——serve 清理同步归零累计统计
  // （stats.json 单一真源；mock 无驱逐/无持久化，/health.stats 实时口径 ≡ 归零后 serve 口径），
  // 列表已空时 chip 不再显示终身累计数（幽灵计数）。serve 侧持久化行为由 serve 单测钉死
  // （tests/test_jobs_history.py::test_cleanup_finished）。
  await expect(page.locator('#job-filter button[data-f="done"]')).toContainText("完成 0");
  await expect(page.locator('#job-filter button[data-f="failed"]')).toContainText("失败 0");
  await expect(page.locator('#job-filter button[data-f="all"]')).toContainText("全部 1");
  // 抑制集：3 条终态 key（engine|job_id）
  expect(await ledgerSuppress(page)).toBe(3);

  // 服务端「残留」：reset 后同 id 复现（seedSeq 重置 → 确定性 id）→ 被抑制不回来
  // （reset 同时清掉 running 那条，期望页面归零）
  await mockReset(req);
  await mockSeed(req, { n: 3, status: "done" });
  await mockSpeed(req, { step: 0.001, tickMs: 1000 });
  await expect
    .poll(async () => jobRows(page).count(), { timeout: 30_000 })
    .toBe(0);

  // 刷新页面（web 形态的重启等价）：抑制集随 localStorage 持久，残留仍不回来
  await page.reload();
  await waitForEngineOnline(page);
  await goTab(page, "jobs");
  await expect
    .poll(async () => jobRows(page).count(), { timeout: 30_000 })
    .toBe(0);
});

test("无终态任务时「历史清理」按钮隐藏", async ({ page }) => {
  await mockSeed(req, { n: 2, status: "running", progress: 0.2 });
  await mockSpeed(req, { step: 0.001, tickMs: 1000 });
  await page.goto("/");
  await waitForEngineOnline(page);
  await goTab(page, "jobs");
  await expect(jobRows(page)).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator("#job-clear-done")).toBeHidden();
});
