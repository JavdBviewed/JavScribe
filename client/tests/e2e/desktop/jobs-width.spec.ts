// 桌面端样式类：任务表横滚收敛（P3-3：列宽收敛 + 移除 min-width: 1300px）
//  - 1440px 视口（playwright.desktop.config 默认 1440x1000）：scrollWidth ≤ clientWidth，无横滚
//  - 1024px 视口：允许横滚，但前四列（服务/文件/状态/进度）不横滚（进度列右缘不出视口）
//  - 行结构 child 索引：0 勾选 / 1 服务 / 2 文件 / 3 状态 / 4 进度 / 5 位置 / 6 耗时 / 7 添加于 / 8 完成于 / 9 操作
import { test, expect } from "./helpers";
import { mockPause, mockSeed, goView } from "./helpers";

test("1440px 无横滚；1024px 前四列不横滚", async ({ page, request }) => {
  await mockPause(request);
  await mockSeed(request, { n: 4, status: "running", progress: 40 });
  await goView(page, "jobs");

  const list = page.locator("#job-list");
  const row = list.locator(".job-row").first();
  await expect(row).toBeVisible();

  // 显式 1440x1000 内容：本机 Xvfb 默认屏幕 1280x1024，Chromium 会把窗口钳制到屏幕宽，
  // 环境视口不等于测试意图的 1440 → 显式 setViewportSize 保证断言与环境屏幕无关
  //（Electron 下走 webContents 尺寸，可超屏幕，walk 同口径）
  await page.setViewportSize({ width: 1440, height: 1000 });
  // 1440px：表体不产生横滚
  const w1440 = await list.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(w1440.sw, "1440px 视口任务表不应横滚").toBeLessThanOrEqual(w1440.cw);
  // 表头模板与表体同步（固定列宽逐一相等；1fr 文件列随各容器宽浮动，跳过）
  const headCols = await page.locator(".job-head").evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(" ").map(parseFloat));
  const rowCols = await row.evaluate(
    (el) => getComputedStyle(el as HTMLElement).gridTemplateColumns.split(" ").map(parseFloat));
  expect(headCols.length).toBe(rowCols.length);
  for (let i = 0; i < headCols.length; i++) {
    if (i === 2) continue;
    expect(headCols[i], `列 ${i} 表头/表体列宽应一致（模板同步）`).toBe(rowCols[i]);
  }

  // 1024px：允许横滚，但前四列（服务/文件/状态/进度）完整可见
  await page.setViewportSize({ width: 1024, height: 800 });
  const w1024 = await list.evaluate((el) => {
    const rowEl = el.querySelector<HTMLElement>(".job-row");
    const cell = rowEl ? (rowEl.children[4] as HTMLElement) : null; // 进度列
    if (!cell) return null;
    const r = cell.getBoundingClientRect();
    const c = el.getBoundingClientRect();
    return { sw: el.scrollWidth, progRight: r.right, contRight: c.right };
  });
  expect(w1024, "1024px 视口下应仍有任务行").not.toBeNull();
  // 收敛后最小内容宽 1074px > 1024 窗口下容器宽 → 横滚仍属预期（前四列之外的次要列被挤出）
  expect(w1024!.sw).toBeGreaterThan(715);
  expect(w1024!.progRight, "1024px 视口前四列（服务/文件/状态/进度）不应横滚").toBeLessThanOrEqual(w1024!.contRight);
});
