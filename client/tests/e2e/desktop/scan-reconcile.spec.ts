// 扫描 × 已完成任务对账 + 回写 e2e（10-19-javscribe-0247-scan-reconcile-job-search，需求1）
// 背景：直播/远端任务 done 后字幕未落盘影片旁 → 再「扫描目录」该影片被当「无字幕」重复生成。
// 对账命中（带扩展名 basename 小写精确匹配）→「已生成未落盘」tag + 独立分类 tab（计数 0 隐藏）
// + 默认不勾选/不进全选域 + 行级「回写」（取任务结果 srt 落扫描项同目录，不重跑生成）。
//
// mock seed 任务形态：单文件 watch job，file=/media/jav/seed-NNN.mp4、label「监听目录 · seed-N」
// （label 非视频名 → 主名/对账键回退 file basename=seed-NNN.mp4）。扫描目录文件名与 seed 文件
// basename 完全一致才命中（精确口径；同目录已有 srt 的项天然 has_subtitle=true 不参与）。
import { test, expect, _electron as electron } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOCK, MOCK_KEY, DIST, FIXTURES, type ElectronApp } from "./helpers";

/** 扫描目录：seed-001/seed-002（无 srt，待对账命中）+ AKDL-002（同目录已有 srt，回归不受影响） */
function makeScanDir(tag: string): string {
  const dir = join(tmpdir(), `javscribe-scanrec-${tag}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIXTURES, "video-a.mp4"), join(dir, "seed-001.mp4"));
  copyFileSync(join(FIXTURES, "video-b.mkv"), join(dir, "seed-002.mp4"));
  copyFileSync(join(FIXTURES, "video-a.mp4"), join(dir, "AKDL-002.mp4"));
  writeFileSync(join(dir, "AKDL-002.zh.srt"), "1\n00:00:00,000 --> 00:00:02,000\n已有字幕\n", "utf8");
  return dir;
}

function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-scanrec-ud-"));
  writeFileSync(
    join(dir, "engines.json"),
    JSON.stringify({ engines: [{ name: "mock", url: MOCK, api_key: MOCK_KEY }] }, null, 1),
    "utf-8",
  );
  // fixture 视频是 KB 级小文件：「忽略小于」默认 200MB 会全标过小（出勾选域），置 0 测对账本意
  writeFileSync(join(dir, "client-config.json"), JSON.stringify({ scan_min_size_mb: 0 }), "utf-8");
  return dir;
}

async function launch(userData: string): Promise<{ app: ElectronApp; page: import("@playwright/test").Page }> {
  const app = await electron.launch({
    args: [DIST, "--no-sandbox"],
    env: {
      ...process.env,
      JAVSCRIBE_CLIENT_USERDATA: userData,
      JAVSCRIBE_CLIENT_FRAMELESS: "1",
      BROWSER: "/bin/true", // 外链交 /bin/true 秒退（防 mime-helper 孤儿持 stdio）
    },
  });
  const page = await app.firstWindow();
  await page.getByText(/服务 1\/1 在线/).first().waitFor({ timeout: 25_000 });
  return { app, page };
}

const mockPost = async (path: string, body?: unknown): Promise<void> => {
  const r = await fetch(`http://127.0.0.1:8302/_mock/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`mock ${path} -> ${r.status}`);
};

const rowOf = (page: import("@playwright/test").Page, name: string) =>
  page.locator("#scan-table tbody tr", { has: page.locator(".scan-name", { hasText: new RegExp(`^${name}$`) }) });

test("动态对账：先扫描后出 done 行 → tag/独立 tab/自动移出勾选域 + 单项与批量回写落盘", async () => {
  const dir = freshUserData();
  await mockPost("reset");
  const scanDir = makeScanDir("dyn");
  const { app, page } = await launch(dir);
  try {
    await page.locator(".view-tab[data-view=\"dispatch\"]").click();
    await page.locator("#scan-path").fill(scanDir);
    await page.click("#scan-go");
    await expect(page.locator("#scan-table tbody tr")).toHaveCount(3, { timeout: 20_000 });

    // 初始态：无 done 任务 → 无 tag/回写按钮；默认勾选=seed-001+seed-002（AKDL-002 已有 srt 不勾）
    await expect(page.locator(".scan-wb")).toHaveCount(0);
    await expect(page.locator("#scan-count")).toContainText("已选 2 / 3");

    // 播种 2 条 done watch 任务（seed-001/seed-002，与扫描项 basename 精确对应）
    await mockPost("seed", { n: 2, status: "done" });

    // 等 5s 轮询 refresh 触发动态对账（E8 路径：scanItems 非空 → rebuild + reconcile）
    await page.waitForFunction(
      () => {
        const s = (window as unknown as { state?: { scanItems?: Array<{ reconciled_job_id?: string | null }> } }).state;
        return !!s && !!s.scanItems && s.scanItems.filter((i) => i.reconciled_job_id).length === 2;
      },
      { timeout: 20_000 },
    );
    await expect(page.locator("#scan-table .subtag.warn", { hasText: "已生成未落盘" })).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator(".scan-wb")).toHaveCount(2);
    // 第 5 分类 tab：计数 2
    await expect(page.locator('#scan-tabs button.scan-tab[data-f="unwritten"]')).toHaveText("已生成未落盘 2");
    // 动态命中同步移出勾选域（与「默认不勾选」同口径，防点「生成字幕」重跑已生成影片）
    await expect(page.locator("#scan-count")).toContainText("已选 0 / 3");
    await expect(page.locator("#scan-count")).toContainText("2 个已生成未落盘默认不勾选");
    // AKDL-002 回归：已有 srt 不参与对账、无回写按钮
    const akdl = rowOf(page, "AKDL-002.mp4");
    await expect(akdl.locator(".subtag", { hasText: "外部 srt" })).toHaveCount(1);
    await expect(akdl.locator(".scan-wb")).toHaveCount(0);

    // 独立 tab 过滤：切「已生成未落盘」只余 2 行
    await page.locator('#scan-tabs button.scan-tab[data-f="unwritten"]').click();
    await expect(page.locator("#scan-table tbody tr")).toHaveCount(2);
    await page.locator('#scan-tabs button.scan-tab[data-f="all"]').click();
    await expect(page.locator("#scan-table tbody tr")).toHaveCount(3);

    // ---- 单项回写：seed-001 行「回写」→ 任务结果 srt 落影片同目录 ----
    const s1 = rowOf(page, "seed-001.mp4");
    await s1.locator(".scan-wb").click();
    await expect(page.locator("#toasts .toast.ok", { hasText: "已回写" })).toBeVisible({ timeout: 15_000 });
    const srt1 = readFileSync(join(scanDir, "seed-001.zh.srt"), "utf8");
    expect(srt1).toContain("テスト字幕 seed-001.mp4");
    // 行转「外部 srt」：tag/回写按钮消失、tab 计数 1
    await expect(s1.locator(".subtag", { hasText: "外部 srt" })).toHaveCount(1, { timeout: 5_000 });
    await expect(s1.locator(".scan-wb")).toHaveCount(0);
    await expect(page.locator('#scan-tabs button.scan-tab[data-f="unwritten"]')).toHaveText("已生成未落盘 1");

    // ---- 批量回写：勾 seed-002 → 「回写所选（1）」→ 落盘 + tab 清空后隐藏 ----
    const s2 = rowOf(page, "seed-002.mp4");
    await s2.locator("input[type=checkbox]").check();
    const wbBtn = page.locator("#scan-writeback");
    await expect(wbBtn).toBeVisible();
    await expect(wbBtn).toHaveText(/回写所选（1）/);
    // 清掉即将过期的单项回写 toast，只计本批结果（toast 3-4s 自动过期，断言两条共存脆弱）
    await page.locator("#toasts").evaluate((el) => { (el as HTMLElement).innerHTML = ""; });
    await wbBtn.click();
    await expect(page.locator("#toasts .toast.ok", { hasText: "已回写" })).toHaveCount(1, { timeout: 15_000 });
    const srt2 = readFileSync(join(scanDir, "seed-002.zh.srt"), "utf8");
    expect(srt2).toContain("テスト字幕 seed-002.mp4");
    await expect(page.locator(".scan-wb")).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('#scan-tabs button.scan-tab[data-f="unwritten"]')).toHaveCount(0); // 计数 0 隐藏
    await expect(wbBtn).toBeHidden();
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    rmSync(scanDir, { recursive: true, force: true });
  }
});

test("非 done 行不参与对账：pending 任务 + 扫描同名影片 → 无 tag、默认勾选不变", async () => {
  const dir = freshUserData();
  await mockPost("reset");
  const scanDir = makeScanDir("pend");
  const { app, page } = await launch(dir);
  try {
    // 先播 1 条 pending watch 任务（seed-001 排队中）再扫描：客户端拉到 job 列表也不得命中
    await mockPost("seed", { n: 1, pending: 1 });
    await page.locator(".view-tab[data-view=\"dispatch\"]").click();
    await page.locator("#scan-path").fill(scanDir);
    await page.click("#scan-go");
    await expect(page.locator("#scan-table tbody tr")).toHaveCount(3, { timeout: 20_000 });
    await expect(page.locator("#scan-count")).toContainText("已选 2 / 3");

    // 等客户端确已拉到 pending 任务（state._jobs 有 seed-001 行）
    await page.waitForFunction(
      () => {
        const s = (window as unknown as { state?: { _jobs?: Array<{ file?: string | null }> } }).state;
        return !!s && !!s._jobs && s._jobs.some((j) => (j.file || "").includes("seed-001.mp4"));
      },
      { timeout: 20_000 },
    );
    // 再等一轮 refresh（动态对账若误配会在此现形）
    await new Promise((r) => setTimeout(r, 6000));
    await expect(page.locator(".scan-wb")).toHaveCount(0);
    await expect(page.locator("#scan-table .subtag.warn", { hasText: "已生成未落盘" })).toHaveCount(0);
    await expect(page.locator('#scan-tabs button.scan-tab[data-f="unwritten"]')).toHaveCount(0);
    await expect(page.locator("#scan-count")).toContainText("已选 2 / 3");
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    rmSync(scanDir, { recursive: true, force: true });
  }
});
