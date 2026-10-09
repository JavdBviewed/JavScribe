// 多客户端连同一服务端：任务归属（本机派发 / 他端任务）来源筛选 + 服务端级操作提示
// 语义：任务状态真源在 serve；工作台只区分「本工作台提交过的 job_id」（uploads.json 持久化）
// 与「他端提交」——后者打「他端」标，字幕不落回本机；来源筛选条在他端任务出现时才显示。
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  WEB_URL, MOCK_URL, FIXTURES, mockReset, mockSeed, mockPause, cleanEngines,
  waitForJobsEmpty, waitForEngineOnline, resetPipelinePause, waitForJobRow, goTab,
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
const srcBar = (page: Page) => page.locator("#job-source-filter");
const srcBtn = (page: Page, s: string) => page.locator(`#job-source-filter button[data-s="${s}"]`);

test("他端任务：来源筛选条出现 + 行打「他端」标，筛选双向生效", async ({ page }) => {
  // 2 个他端任务（mock seed = 非本工作台提交），冻结进度防计数漂移
  await mockSeed(req, { n: 2, status: "running" });
  await mockPause(req);
  await page.goto("/");
  await waitForEngineOnline(page);
  await goTab(page, "jobs");
  await expect(jobRows(page)).toHaveCount(2, { timeout: 15_000 });

  // 他端服务行：状态单元格打「他端」虚线标
  await expect(page.locator("#job-list .src-tag")).toHaveCount(2);

  // 来源筛选条出现：全部 2 / 本机派发 0 / 他端任务 2
  await expect(srcBar(page)).toBeVisible();
  await expect(srcBtn(page, "all")).toContainText("2");
  await expect(srcBtn(page, "local")).toContainText("0");
  await expect(srcBtn(page, "serve")).toContainText("2");

  // 筛选生效：他端任务 → 2 行；本机派发 → 0 行；全部 → 2 行
  await srcBtn(page, "serve").click();
  await expect(jobRows(page)).toHaveCount(2);
  await srcBtn(page, "local").click();
  await expect(jobRows(page)).toHaveCount(0);
  await srcBtn(page, "all").click();
  await expect(jobRows(page)).toHaveCount(2);
});

test("本机派发 + 他端混排：归属正确，本机行无他端标", async ({ page }) => {
  await mockSeed(req, { n: 1, status: "pending" });
  await mockPause(req);
  // 本工作台真实派发一个 opus（sine.opus）→ 服务行 local=true
  const opus = readFileSync(path.join(FIXTURES, "sine.opus"));
  const fd = new FormData();
  fd.append("audio", new Blob([opus]), "local-x.opus");
  fd.append("engine", "mock");
  fd.append("name", "local-x.mp4");
  fd.append("size_mb", "0");
  const resp = await fetch(`${WEB_URL}/api/upload-audio`, { method: "POST", body: fd });
  expect(resp.status).toBe(202);

  // API 口径：两条服务行，归属一真一假
  await expect.poll(async () => {
    const jobs = (await (await req.get(`${WEB_URL}/api/jobs`)).json()) as any[];
    return jobs.length;
  }, { timeout: 20_000 }).toBe(2);
  const jobs = (await (await req.get(`${WEB_URL}/api/jobs`)).json()) as any[];
  const localRow = jobs.find((j) => j.label === "local-x.mp4" || j.file === "local-x.mp4");
  expect(localRow).toBeTruthy();
  expect(localRow.local).toBe(true);
  const foreignRow = jobs.find((j) => j !== localRow);
  expect(foreignRow.local).toBe(false);

  await page.goto("/");
  await waitForEngineOnline(page);
  await goTab(page, "jobs");
  await expect(jobRows(page)).toHaveCount(2, { timeout: 20_000 });

  // 仅他端行有「他端」标；本机派发行无
  await expect(page.locator("#job-list .src-tag")).toHaveCount(1);
  const localRowEl = page.locator(".job-row", { hasText: "local-x.mp4" });
  await expect(localRowEl.locator(".src-tag")).toHaveCount(0);

  // 来源筛选：本机派发 → 只剩 local-x 行；他端任务 → 只剩 seed 行
  await expect(srcBar(page)).toBeVisible();
  await srcBtn(page, "local").click();
  await expect(jobRows(page)).toHaveCount(1);
  await expect(page.locator(".job-row", { hasText: "local-x.mp4" })).toBeVisible();
  await srcBtn(page, "serve").click();
  await expect(jobRows(page)).toHaveCount(1);
  await expect(page.locator(".job-row", { hasText: "seed-001" })).toBeVisible();
});

test("他端任务全部消失：来源条自动收起，筛选复位「全部」", async ({ page }) => {
  await mockSeed(req, { n: 1, status: "running" });
  await mockPause(req);
  await page.goto("/");
  await waitForEngineOnline(page);
  await goTab(page, "jobs");
  await expect(jobRows(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(srcBar(page)).toBeVisible();
  await srcBtn(page, "serve").click();
  await expect(jobRows(page)).toHaveCount(1);

  // 他端任务被清（mock reset），页面 5s 刷新后来源条收起、source 复位 all
  await mockReset(req);
  await expect(jobRows(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(srcBar(page)).toBeHidden({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      try {
        // @ts-expect-error 页面词法全局（app.ts 顶层 const），evaluate 全局作用域可解析
        const s = state;
        return s.source === "all";
      } catch (_e) { return false; }
    },
    undefined,
    { timeout: 15_000 },
  );
});

test("服务端级操作提示：暂停所有 tooltip + 服务设置弹窗横幅", async ({ page }) => {
  // 无在途任务时按钮隐藏 → seed 一个排队任务让「暂停所有」出现
  await mockSeed(req, { n: 1, status: "pending" });
  await page.goto("/");
  await waitForEngineOnline(page);
  await goTab(page, "jobs");

  // 暂停所有：tooltip 明示服务端级影响面
  const btn = page.locator("#job-pause-all");
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await expect(btn).toHaveAttribute("title", /服务端级操作/);

  // 服务设置弹窗：顶部服务端级设置横幅（客户端设置卡片除外说明）
  await goTab(page, "engines");
  await page.locator('button.set[data-name="mock"]').click();
  await expect(page.locator("#modal .cfg-global-note")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#modal .cfg-global-note")).toContainText("所有连接该服务的客户端");
  // 客户端设置已迁出弹窗（独立「客户端设置」tab）：弹窗内不再有客户端卡片，例外文案同步移除
  await expect(page.locator("#modal .cfg-sec-client")).toHaveCount(0);
  await expect(page.locator("#modal #ccfg-save")).toHaveCount(0);
  await expect(page.locator("#modal .cfg-global-note")).not.toContainText("下方「客户端设置」卡片例外");
});
