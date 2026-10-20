// 0.2.48（10-20-javscribe-health-grace-vram-hint）：
//  项A 健康采样宽限期 —— /health 单次失败不踢引擎，卡片软警告行，采样恢复后消失；
//  项B 显存阈值剔除提示 —— 空闲显存低于阈值时卡片可见「未参与均衡」，显存恢复后消失。
import { test, expect, goView, waitForReady, mockControl } from "./helpers";

const card = (page: any) => page.locator("#engine-grid article.eng").first();

test("健康宽限期：单次 /health 失败不踢引擎（软警告行），恢复采样后消失", async ({ page, request }) => {
  await goView(page, "engines");
  await waitForReady(page);
  await expect(card(page)).toHaveClass(/on/);
  await expect(card(page).locator(".eng-err-warn")).toHaveCount(0);

  // 注入一轮 /health 503（单次采样失败）
  await mockControl(request, "health-fail", { count: 1 });
  await page.click("#engine-refresh-btn");
  // 宽限期：仍在线（toast 口径 1 台在线），卡片出软警告行，且不是离线红条
  await expect(page.locator("#toasts .toast", { hasText: "1 台" })).toBeVisible({ timeout: 10_000 });
  await expect(card(page)).toHaveClass(/on/);
  await expect(card(page).locator(".eng-err-warn")).toBeVisible({ timeout: 10_000 });
  await expect(card(page).locator(".eng-err-warn")).toContainText("宽限期");
  await expect(card(page).locator(".eng-err")).toHaveCount(0);

  // 注入次数耗尽 → 下一轮采样成功：警告行消失，恢复常态
  await page.click("#engine-refresh-btn");
  await expect(card(page).locator(".eng-err-warn")).toHaveCount(0, { timeout: 10_000 });
  await expect(card(page)).toHaveClass(/on/);
});

test("健康宽限期：连续两次 /health 失败仍会离线（宽限只给一次）", async ({ page, request }) => {
  await goView(page, "engines");
  await waitForReady(page);
  await expect(card(page)).toHaveClass(/on/);

  await mockControl(request, "health-fail", { count: 2 });
  await page.click("#engine-refresh-btn");
  await page.click("#engine-refresh-btn");
  // 连续第 2 次失败 → 离线红条（非软警告）
  await expect(card(page)).toHaveClass(/off/, { timeout: 10_000 });
  await expect(card(page).locator(".eng-err")).toBeVisible();
  await expect(card(page).locator(".eng-err-warn")).toHaveCount(0);

  // 恢复采样 → 重新在线（清 failStreak 由成功路径归零）
  await page.click("#engine-refresh-btn");
  await expect(card(page)).toHaveClass(/on/, { timeout: 10_000 });
});

test("显存阈值剔除提示：空闲显存低于阈值卡片可见，显存充足后消失", async ({ page, request }) => {
  await goView(page, "engines");
  await waitForReady(page);
  await expect(card(page)).toHaveClass(/on/);
  await expect(card(page).locator(".eng-excl")).toBeHidden();

  // 空闲 1576MB ≈ 1.5G < 缺省阈值 5G（gpu_present 才有显存采样）
  await mockControl(request, "metrics", { gpu_present: true, gpu_util: 30, mem_used_mb: 23000, mem_total_mb: 24576 });
  // 渲染端 5s 轮询采样 metrics → 提示出现（含实际空闲与阈值数值）
  await expect(card(page).locator(".eng-excl")).toBeVisible({ timeout: 20_000 });
  await expect(card(page).locator(".eng-excl")).toContainText("未参与均衡");
  await expect(card(page).locator(".eng-excl")).toContainText("1.5G");
  await expect(card(page).locator(".eng-excl")).toContainText("阈值 5G");

  // 显存充足（空闲 ≈21.1G ≥ 5G）→ 下一轮采样后提示消失
  await mockControl(request, "metrics", { gpu_present: true, gpu_util: 30, mem_used_mb: 3000, mem_total_mb: 24576 });
  await expect(card(page).locator(".eng-excl")).toBeHidden({ timeout: 20_000 });
});
