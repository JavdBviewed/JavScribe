// 自检线（10-23-javscribe-selfaudit-ux）· audit-web：chromium → 8901 本地工作台走查
// 口径：当前构建的工作台 UI（134 生产实例滞后属 serve 线范畴，本 spec 只评代码态）。
// mock 后端 8301（web 当前版本）；seed 40 条完成看密集任务列表。
import { test as base, expect } from "@playwright/test";
import { log, shot, consoleCollector, dumpDom } from "./audit-helpers";

const KIND = "web";
const WEB_URL = "http://127.0.0.1:8901";
const MOCK8301 = "http://127.0.0.1:8301";
const test = base;

async function mockControl8301(path: string, body?: unknown): Promise<void> {
  const r = await fetch(`${MOCK8301}/_mock/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`mock8301 ${path} -> ${r.status}`);
}

test("W1 工作台：四视图走查 + 引擎监控 + 密集任务列表 + console 采集", async ({ page }) => {
  const sink = consoleCollector(KIND, page);
  try {
    await page.goto(WEB_URL + "/", { waitUntil: "domcontentloaded" });
    const healthEl = page.locator("#health");
    await healthEl.waitFor({ timeout: 30_000 });
    const health = ((await healthEl.textContent()) || "").trim();
    log(KIND, `工作台 #health = ${health}`);
    await expect(healthEl).toHaveText(/服务 1\/1 在线/, { timeout: 30_000 });
    await shot(page, KIND, "w1-default");

    // 侧边栏（与桌面端同构；记录实际顺序）
    const navTexts = (await page.locator("#nav .view-tab").allInnerTexts()).map((t) => t.trim());
    log(KIND, `工作台侧边栏 = ${JSON.stringify(navTexts)}`);

    // 字幕服务：mock 提供 /metrics/json → 不应 stuck
    await page.locator('.view-tab[data-view="engines"]').click();
    await expect(page.locator('.eng[data-name="mock"]')).toBeVisible({ timeout: 15_000 });
    const m = ((await page.locator('.eng[data-name="mock"] .eng-metrics').textContent().catch(() => "")) || "").trim();
    log(KIND, `工作台引擎卡监控 = ${m || "(空)"}`);
    if (m.includes("监控数据加载中")) log(KIND, "FINDING: 工作台引擎卡停在「监控数据加载中…」");
    await dumpDom(page, "#engine-grid", KIND, "wb-engine-grid", 2000);
    await shot(page, KIND, "w1-engines");

    // 生成字幕（工作台形态：本地扫描 + 派单）
    await page.locator('.view-tab[data-view="dispatch"]').click();
    await page.waitForTimeout(800);
    await shot(page, KIND, "w1-dispatch");

    // 字幕任务：seed 40 完成 → 密集列表（人工目检交叉/重叠）
    await mockControl8301("seed", { n: 40, status: "done" });
    await page.locator('.view-tab[data-view="jobs"]').click();
    await expect(page.locator(".pg-info")).toBeVisible({ timeout: 20_000 });
    log(KIND, `工作台任务分页 = ${((await page.locator(".pg-info").textContent()) || "").trim()}`);
    await shot(page, KIND, "w1-jobs-dense-p1");
    const next = page.locator("#pg-next");
    if (await next.isEnabled().catch(() => false)) {
      await next.click();
      await page.waitForTimeout(500);
      await shot(page, KIND, "w1-jobs-dense-p2");
    }

    // 设置（工作台形态：客户端 tab 可能收敛，记录实际）
    await page.locator('.view-tab[data-view="ccfg"]').click();
    await page.waitForTimeout(1500);
    await shot(page, KIND, "w1-ccfg");
    const tabs = (await page.locator('#cc-body .cfg-tab').allInnerTexts().catch(() => [])).map((t) => t.trim());
    log(KIND, `工作台设置子 tab = ${JSON.stringify(tabs)}`);

    const errs = await sink.finish();
    log(KIND, `工作台 console/pageerror 汇总：${errs.length} 条`);
  } finally {
    // finish 已落盘；兜底
  }
});
