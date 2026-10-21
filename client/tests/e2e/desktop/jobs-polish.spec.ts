// 0.2.50 任务表 UI 打磨回归（F1-F6，10-21-javscribe-0250-ui-polish）：
//  - F1(P1) batch 父行 pill「部分失败」不越出状态列叠压进度条（label 缩短 + title 补语义）
//  - F2(P2) 终态行位置列不显陈旧「position / duration」时间轴对（折 2 行），error 保留失败位置
//  - F3(P2) batch 父行位置列恒「—」（完整时间进 cell title）
//  - F4(P2) 批量操作条 5 按钮按选中行状态启用/禁用（旧行为恒启用 → 点了必弹「暂无可操作任务」）
//  - F5(P3) done 行操作列 3 按钮缩标签后单行（top 一致，不折 2 行）
//  - F6(P3) <1MB 文件大小 fmtSize 人类可读（72KB 桩 → KB，非「0 MB」）
//
// 桌面端 e2e 直连 mock serve 协议（8302），任务行 = 服务行（job_id），无本机管线行（task_id）；
// F4 只覆盖服务行分支（本机行分支由 web e2e / 134 真机验证）。
import { test, expect, mockSeed, mockReset, mockPause, goView, waitForReady, FIXTURES } from "./helpers";
import { join } from "node:path";

const fx = (n: string) => join(FIXTURES, n);

/** seed → 冻结 mock tick → reload 后等「新 seed 真正渲染」。
 *  注意：main 进程 refresh 有 3s TTL 缓存（防重复轮询，by design），跨 reload 存活——
 *  同会话多场景复用 Electron 时，reload 后首拍可能回上一场景的旧行；
 *  必须等 5s 轮询把本场景行刷出来（行数 + 预期 pill）再操作，点击才不会命中旧行。 */
async function seedAndReload(
  page: import("@playwright/test").Page,
  body: { n: number } & Record<string, unknown>,
  request: import("@playwright/test").APIRequestContext,
  pill: "p-done" | "p-pending" | "p-error" | "p-paused",
): Promise<void> {
  await mockReset(request);
  await mockSeed(request, body);
  await mockPause(request);
  await page.reload();
  await waitForReady(page);
  await goView(page, "jobs");
  await expect(page.locator("#job-list .job-row")).toHaveCount(body.n, { timeout: 20_000 });
  await expect(page.locator(`#job-list .job-row .pill.${pill}`).first()).toBeVisible({ timeout: 20_000 });
}

test("F1：batch 父行 pill「部分失败」不叠压进度列", async ({ page, request }) => {
  await seedAndReload(page, { n: 3, status: "done", errors: 1, batch_id: "b-f1", batch_label: "F1 批次" }, request, "p-done");
  const prow = page.locator(".job-batch-row");
  await expect(prow).toHaveCount(1);
  const pill = prow.locator(".pill");
  await expect(pill).toHaveText("部分失败");
  await expect(pill).toHaveAttribute("title", /部分子任务失败或取消/);
  // pill 右缘不越出状态列（= 进度列左缘）：旧 label「完成（部分失败）」~119px 溢出 92px 列
  const r = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".job-batch-row")!;
    const p = row.querySelector<HTMLElement>(".pill")!.getBoundingClientRect();
    const prog = (row.children[4] as HTMLElement).getBoundingClientRect();
    return { right: p.right, left: prog.left };
  });
  expect(r.right, "pill 右缘应 ≤ 进度列左缘（不叠压）").toBeLessThanOrEqual(r.left + 0.5);
});

test("F2：终态行位置列「—」，error 行保留失败位置", async ({ page, request }) => {
  await seedAndReload(page, { n: 2, status: "done", errors: 1, position: "00:03:12" }, request, "p-done");
  const done = page.locator(".job-row", { has: page.locator(".pill.p-done") }).first();
  const err = page.locator(".job-row", { has: page.locator(".pill.p-error") }).first();
  // done 行：时间轴对（00:03:12 / 2:00）陈旧且 60px 列折 2 行 → 「—」
  await expect(done.locator(".cell-pos")).toHaveText("—");
  // error 行：保留失败位置（排障价值）
  await expect(err.locator(".cell-pos")).toHaveText("00:03:12 / 2:00");
});

test("F3：batch 父行位置列恒「—」，完整时间进 title", async ({ page, request }) => {
  await seedAndReload(page, { n: 2, status: "done", batch_id: "b-f3", batch_label: "F3 批次" }, request, "p-done");
  const cell = page.locator(".job-batch-row .cell-bt");
  await expect(cell).toHaveText("—");
  await expect(cell).toHaveAttribute("title", /开始 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
});

test("F4：批量按钮按选中行状态启用/禁用", async ({ page, request }) => {
  const expectBulk = (page: import("@playwright/test").Page, m: Record<string, boolean>) => {
    for (const act of ["pause", "resume", "retry", "cancel", "assign"]) {
      const btn = page.locator(`#job-bulk-bar .bulk-act[data-act="${act}"]`);
      if (m[act]) expect(btn, `${act} 应禁用`).toBeDisabled();
      else expect(btn, `${act} 应可用`).toBeEnabled();
    }
  };
  const selectAll = async (page: import("@playwright/test").Page) => {
    await page.click("#job-sel-all");
    await expect(page.locator("#job-bulk-bar")).toBeVisible();
  };

  // 全 done：5 按钮全禁用（点了必「暂无可操作任务」的旧行为根治）
  await seedAndReload(page, { n: 2, status: "done" }, request, "p-done");
  await selectAll(page);
  expectBulk(page, { pause: true, resume: true, retry: true, cancel: true, assign: true });

  // pending 行：暂停/取消可用（排队可挂起/可终止）
  await seedAndReload(page, { n: 1, status: "pending" }, request, "p-pending");
  await selectAll(page);
  expectBulk(page, { pause: false, resume: true, retry: true, cancel: false, assign: true });

  // error 行：仅重试可用
  await seedAndReload(page, { n: 1, status: "error" }, request, "p-error");
  await selectAll(page);
  expectBulk(page, { pause: true, resume: true, retry: false, cancel: true, assign: true });

  // 挂起行（pending + job.paused）：仅继续可用
  await seedAndReload(page, { n: 1, status: "pending", paused: 1 }, request, "p-paused");
  await selectAll(page);
  expectBulk(page, { pause: true, resume: false, retry: true, cancel: true, assign: true });
});

test("F5：done 行操作列 3 按钮单行（缩标签后不折行）", async ({ page, request }) => {
  await seedAndReload(page, { n: 1, status: "done" }, request, "p-done");
  const acts = page.locator(".job-row .job-actions > *");
  await expect(acts).toHaveCount(3); // 下载 / 预览 / 重跑
  const tops: number[] = [];
  for (let i = 0; i < 3; i++) {
    const b = (await acts.nth(i).boundingBox())!;
    tops.push(b.y);
  }
  // 容差 8px 的依据：同行混高（dl-btn 30px / srt-pv 24px 药丸）flex 居中 top 差恒 ≤3px；
  // 折行则第二行 top ≥ +30px（按钮高）+6px（row-gap）→ 8px 是两态间的安全分界
  expect(Math.max(...tops) - Math.min(...tops), "3 按钮应同一行（top 差 ≤8px）").toBeLessThan(8);
});

test("F6：<1MB 文件 chip 显 KB（非 0 MB）", async ({ page }) => {
  // video-a.mp4 = 72429 B → fmtSize = 71 KB（旧 mb() 四舍五入 → 0 MB）
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await expect(page.locator("#chip-name")).toHaveText("video-a.mp4");
  await expect(page.locator("#chip-size")).toHaveText("71 KB");
});
