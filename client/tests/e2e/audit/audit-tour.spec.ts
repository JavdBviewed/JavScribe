// 自检线（10-23-javscribe-selfaudit-ux）· audit-tour：mock 后端全功能走查
// 打包形态（release/linux-unpacked）冷启动，逐 tab 截图 + DOM dump + 控制台采集。
// 断言口径：用户历史诉求逐条验证（0.2.33→0.2.53 声称修复项）；失败即 finding，证据=截图+日志。
// 第二台 mock（8305）仅供 T3「换服务重跑」（与 scan-auto-balance 同口径）。
import { test as base, expect, _electron as electron, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mockReset, mockSeed, mockSpeed,
  launchPackedApp, relaunchPacked, goView, waitForReady,
} from "../desktop/helpers";
import type { APIRequestContext, ElectronApplication } from "@playwright/test";
import {
  log, shot, consoleCollector, attachDialogs, dumpDom, mkScanFiles, checkRow,
  freshUserData, waitForEnginesOnline, type ConsoleSink,
} from "./audit-helpers";

const KIND = "tour";
const MOCK = "http://127.0.0.1:8302";
const MOCK_KEY = "mock-key-123";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const SECOND_PORT = 8305;
const SECOND = `http://127.0.0.1:${SECOND_PORT}`;

const test = base;

let secondMock: ChildProcess | null = null;
test.beforeAll(async () => {
  secondMock = spawn(process.execPath, [join(ROOT, "client", "tests", "e2e", "mock-serve.mjs"), String(SECOND_PORT)], { stdio: "ignore" });
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${SECOND}/health`);
      if (r.ok) break;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 15_000) throw new Error("第二 mock serve 未就绪");
    await new Promise((r) => setTimeout(r, 100));
  }
  log(KIND, "第二 mock serve 就绪（8305）");
});
test.afterAll(() => { secondMock?.kill(); });

async function resetSecond(): Promise<void> {
  await fetch(`${SECOND}/_mock/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

async function secondSpeed(body: { step: number; tickMs?: number }): Promise<void> {
  await fetch(`${SECOND}/_mock/speed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

interface Ctx { app: ElectronApplication; page: Page; userData: string; sink: ConsoleSink }

async function boot(engines: Array<{ name: string; url: string; api_key?: string }>, cfg: Record<string, unknown> = {}): Promise<Ctx> {
  const userData = freshUserData(KIND, engines, cfg);
  const app = await launchPackedApp(userData);
  const page = await app.firstWindow();
  const sink = consoleCollector(KIND, page);
  attachDialogs(KIND, page);
  await waitForEnginesOnline(page, engines.length);
  return { app, page, userData, sink };
}

async function closeCtx(ctx: Ctx): Promise<void> {
  await ctx.sink.finish().catch(() => []);
  await ctx.app.close().catch(() => {});
}

/** 批次行 pill 文本（批次行 = .job-batch-row 内 .pill） */
async function batchPill(page: Page, row: ReturnType<Page["locator"]>): Promise<string> {
  return ((await row.locator(".pill").first().textContent()) || "").trim();
}

// ---------------------------------------------------------------------------
// T1 冷启动 + 侧边栏 + 引擎卡（增/改/删）+ URL 锚点
// ---------------------------------------------------------------------------
test("T1 冷启动+侧边栏顺序+引擎卡增删改+URL 锚点", async ({ request }) => {
  await mockReset(request);
  const ctx = await boot([{ name: "mock", url: MOCK, api_key: MOCK_KEY }]);
  const { app, page } = ctx;
  try {
    const health = ((await page.locator("#health").textContent()) || "").trim();
    log(KIND, `#health = ${health}`);
    expect(health).toMatch(/服务 1\/1 在线/);
    await shot(page, KIND, "01-boot-dispatch");

    // 侧边栏顺序（0.2.45 诉求：字幕服务/生成字幕/字幕任务/设置）
    const navTexts = (await page.locator("#nav .view-tab").allInnerTexts()).map((t) => t.trim());
    log(KIND, `侧边栏顺序 = ${JSON.stringify(navTexts)}`);
    expect(navTexts).toEqual(["字幕服务", "生成字幕", "字幕任务", "设置"]);

    // 默认视图 = 生成字幕
    await expect(page.locator("#sec-dispatch")).toHaveClass(/view-on/);

    // URL 锚点：view→hash
    const hashes: Record<string, string> = {};
    const views: Array<"engines" | "jobs" | "ccfg" | "dispatch"> = ["engines", "jobs", "ccfg", "dispatch"];
    for (const v of views) {
      await goView(page, v);
      hashes[v] = await page.evaluate(() => location.hash);
    }
    log(KIND, `view→hash = ${JSON.stringify(hashes)}`);
    for (const v of Object.keys(hashes)) expect(hashes[v], `切到 ${v} 后 hash`).toBe("#" + v);
    // 反向：hash→view
    await page.evaluate(() => { location.hash = "engines"; });
    await expect(page.locator("#sec-engines")).toHaveClass(/view-on/);
    await page.evaluate(() => { location.hash = "jobs"; });
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
    log(KIND, "hash→view 反向切换 OK");

    // 引擎卡（mock 在线 + 监控指标）
    await goView(page, "engines");
    await expect(page.locator('.eng[data-name="mock"]')).toBeVisible();
    const metrics = ((await page.locator('.eng[data-name="mock"] .eng-metrics').textContent()) || "").trim();
    log(KIND, `引擎卡监控 = ${metrics}`);
    if (metrics.includes("监控数据加载中")) log(KIND, "FINDING: mock 提供 /metrics/json 但引擎卡停在「监控数据加载中…」");
    await dumpDom(page, "#engine-grid", KIND, "engine-grid");
    await shot(page, KIND, "02-engines");

    // 刷新服务状态按钮（用户诉求：字幕服务页加刷新按钮）
    await page.locator("#engine-refresh-btn").click();
    await page.waitForTimeout(2500);
    const errTxt = (await page.locator(".eng-err").allInnerTexts()).join("|").trim();
    log(KIND, `刷新后 .eng-err = ${errTxt || "(无)"}`);
    await shot(page, KIND, "03-engines-after-refresh");

    // 添加服务（离线假服务）
    await page.locator("#engine-add-btn").click();
    await expect(page.locator("#engine-add-backdrop")).toBeVisible();
    log(KIND, `添加 modal 标题 = ${(await page.locator("#engine-add-title").textContent())?.trim()}`);
    await page.locator("#engine-name").fill("auditdead");
    await page.locator("#engine-url").fill("http://127.0.0.1:9");
    await page.locator("#engine-add-submit").click();
    await expect(page.locator('.eng[data-name="auditdead"]')).toBeVisible({ timeout: 20_000 });
    await shot(page, KIND, "04-engine-added-offline");

    // 编辑服务（用户诉求：改 IP / 查看 key / 复制 IP；0.2.33+ 已加复制控件）
    await page.locator('.icon-btn.edit[data-name="auditdead"]').click();
    await expect(page.locator("#engine-add-backdrop")).toBeVisible();
    log(KIND, `编辑 modal 标题 = ${(await page.locator("#engine-add-title").textContent())?.trim()}`);
    await expect(page.locator("#engine-edit-copies")).toBeVisible();
    await page.locator("#engine-key").fill("secret-audit-key");
    await page.locator("#engine-add-submit").click();
    await expect(page.locator("#toasts .toast.ok").first()).toBeVisible({ timeout: 10_000 });
    // 再开编辑：查看 key（reveal 后 input 明文）+ 复制控件在盘
    await page.locator('.icon-btn.edit[data-name="auditdead"]').click();
    await expect(page.locator("#engine-key-reveal")).toBeVisible();
    await page.locator("#engine-key-reveal").click();
    await expect(page.locator("#engine-key")).toHaveValue("secret-audit-key");
    await dumpDom(page, "#engine-edit-copies", KIND, "engine-edit-copies");
    // 改 IP 保存
    await page.locator("#engine-url").fill("http://192.168.0.199:8300");
    await page.locator("#engine-add-submit").click();
    await expect(page.locator("#toasts .toast.ok").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.eng[data-name="auditdead"] .eng-url-txt')).toContainText("192.168.0.199");
    await shot(page, KIND, "05-engine-edited");

    // 删除服务（卡片编辑/删除功能保持现状，可正常删；mock 卡不受影响）
    await page.locator('.icon-btn.del[data-name="auditdead"]').click();
    await expect(page.locator('.eng[data-name="auditdead"]')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('.eng[data-name="mock"]')).toBeVisible();
    log(KIND, "auditdead 已删除；mock 卡保留");
    await shot(page, KIND, "06-engine-deleted");
  } finally {
    await closeCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// T2 扫描 12 文件（>1 页）+ 文件名 C 规则 + 本页全选/半选 + 建主任务
// ---------------------------------------------------------------------------
test("T2 扫描12文件+文件名C规则+本页全选+建主任务", async ({ request }) => {
  await mockReset(request);
  const names = Array.from({ length: 12 }, (_, i) => `TA-${String(i + 1).padStart(3, "0")}.mp4`);
  names[2] = "AC-003-C.mp4"; // token「C」→ 疑似已压字幕（标记（名）），默认不选
  const dir = mkScanFiles("t2", names);
  const ctx = await boot([{ name: "mock", url: MOCK, api_key: MOCK_KEY }], { scan_min_size_mb: 0 });
  const { page } = ctx;
  try {
    await mockSpeed(request, { step: 0.0125, tickMs: 100 }); // 8s/任务：建批后仍在途，截图可见运行态
    await goView(page, "dispatch");
    await page.locator("#scan-path").fill(dir);
    await page.click("#scan-go");
    const rows = page.locator("#scan-table tbody tr");
    await expect(rows).toHaveCount(10, { timeout: 20_000 }); // 默认 10/页
    log(KIND, `#scan-count = ${((await page.locator("#scan-count").textContent()) || "").trim()}`);

    // C 规则：行内「标记（名）」tag + 默认不勾选
    const crow = page.locator("#scan-table tbody tr", { hasText: "AC-003-C.mp4" });
    await expect(crow).toContainText("标记（名）");
    const cChecked = await crow.locator("input[type=checkbox]").first().isChecked();
    log(KIND, `C 规则行 AC-003-C.mp4：默认勾选=${cChecked}（期望 false）`);
    expect(cChecked).toBe(false);
    await shot(page, KIND, "07-scan-page1-c-rule");

    // 本页全选：勾本页全部可选行（仅排除 too_small/已对账行）；C 规则行默不勾但可勾
    await page.locator("#scan-page-all").check();
    const checkedN = await page.locator("#scan-table tbody tr input[type=checkbox]:checked").count();
    log(KIND, `本页全选后勾选数 = ${checkedN}（期望 10：含 C 规则行）`);
    expect(checkedN).toBe(10);

    // 半选态：取消一个普通行
    const rowA = page.locator("#scan-table tbody tr", { hasText: names[0] });
    await rowA.locator("input[type=checkbox]").first().uncheck();
    await expect(page.locator("#scan-page-all")).toHaveJSProperty("indeterminate", true);
    log(KIND, "半选态 indeterminate OK");

    // 翻页（第 2 页 2 行）：本页全选第 2 页，第 1 页勾选保持
    await page.locator("#spg-next").click();
    const rows2 = page.locator("#scan-table tbody tr");
    await expect(rows2).toHaveCount(2, { timeout: 10_000 });
    await page.locator("#scan-page-all").check();
    const checked2 = await rows2.locator("input[type=checkbox]:checked").count();
    log(KIND, `第 2 页本页全选后勾选数 = ${checked2}（期望 2）`);
    expect(checked2).toBe(2);
    await shot(page, KIND, "08-scan-page2");
    await page.locator("#spg-prev").click();
    await expect(rows).toHaveCount(10, { timeout: 10_000 });
    const kept = await page.locator("#scan-table tbody tr input[type=checkbox]:checked").count();
    log(KIND, `翻回第 1 页：勾选保持 = ${kept}（期望 9：10-取消的 1）`);
    expect(kept).toBe(9);

    // 清掉前序步骤残留勾选（两页）：行级 uncheck 触发 change → scanChecked 正确减项；
    // #scan-page-all 处 indeterminate 时 DOM checked=false，Playwright uncheck() 是 no-op 不触发 change，不可靠；
    // 且 uncheck 会触发扫描表重渲，.all() 快照 handle 随即失效（detach 超时）→ 每轮重新查询 :checked
    const clearChecked = async () => {
      const loc = page.locator("#scan-table tbody tr input[type=checkbox]:checked");
      while ((await loc.count()) > 0) await loc.first().uncheck();
    };
    await clearChecked();
    await page.locator("#spg-next").click();
    await expect(page.locator("#scan-table tbody tr")).toHaveCount(2, { timeout: 10_000 });
    await clearChecked();
    await page.locator("#spg-prev").click();
    await expect(rows).toHaveCount(10, { timeout: 10_000 });

    // 只勾 2 个提交建主任务
    for (const n of ["TA-001.mp4", "TA-002.mp4"]) {
      if (!(await page.locator("#scan-table tbody tr", { hasText: n }).locator("input[type=checkbox]").first().isChecked())) {
        await page.locator("#scan-table tbody tr", { hasText: n }).locator("input[type=checkbox]").first().check();
      }
    }
    await expect(page.locator("#scan-submit")).toContainText("生成字幕（已选择 2 项）");
    await page.click("#scan-submit");
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/, { timeout: 20_000 });
    const batchRow = page.locator(".job-batch-row", { hasText: "TA-001.mp4" }).or(page.locator(".job-batch-row").first());
    const row = page.locator(".job-batch-row").first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText("2 子任务");
    log(KIND, `建批后主任务 pill = ${(await batchPill(page, row))}`);
    await shot(page, KIND, "09-batch-created");
  } finally {
    await closeCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// T3 任务表：暂停/继续立即性 + 换服务重跑 + 搜索 + 双时间列 + 清理已完成 + 密集列表
// ---------------------------------------------------------------------------
test("T3 任务表（暂停立即性/换服务重跑/搜索/双时间列/清理/密集列表）", async ({ request }) => {
  await mockReset(request);
  await resetSecond();
  const dir = mkScanFiles("t3", ["TB-001.mp4", "TB-002.mp4", "TB-003.mp4", "TB-004.mp4"]);
  // auto 均衡按提交时刻逐文件选机（queue_cap=1 限每服务在途），文件可能摊到两台 mock；
  // 暂停闸可见对象 = 本机排队 pending 行（全局暂停显示副本）+ 挂起队列服务的排队中行（队列暂停显示副本）
  const ctx = await boot(
    [{ name: "mock", url: MOCK, api_key: MOCK_KEY }, { name: "second", url: SECOND, api_key: MOCK_KEY }],
    { scan_min_size_mb: 0, queue_cap: 1 },
  );
  const { page } = ctx;
  try {
    await mockSpeed(request, { step: 0.005, tickMs: 200 }); // 每任务 ~40s：保证暂停/恢复观察窗
    await secondSpeed({ step: 0.005, tickMs: 200 }); // 第二台同口径（默认速度 8 倍快，暂停时刻其任务已终态，排队行缺位）
    await goView(page, "dispatch");
    await page.locator("#scan-path").fill(dir);
    await page.click("#scan-go");
    const rows = page.locator("#scan-table tbody tr");
    await expect(rows).toHaveCount(4, { timeout: 20_000 });
    for (const n of ["TB-001.mp4", "TB-002.mp4", "TB-003.mp4", "TB-004.mp4"]) {
      await checkRow(page, "#scan-table", n);
    }
    await expect(page.locator("#scan-submit")).toContainText("生成字幕（已选择 4 项）");
    await page.click("#scan-submit");
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/, { timeout: 20_000 });
    const row = page.locator(".job-batch-row").first();
    await expect(row).toContainText("4 子任务", { timeout: 20_000 });

    // 等批次进入运行中（提取→上传→服务在途）
    await expect(row.locator(".pill").first()).toHaveText("运行中", { timeout: 120_000 });
    log(KIND, "批次进入运行中");

    // ---- 暂停所有：立即性（点按 → 批次 pill 已暂停 ≤ 5s）----
    const t0 = Date.now();
    await page.locator("#job-pause-all").click(); // confirm 自动受理
    await expect(row.locator(".pill").first()).toHaveText("已暂停", { timeout: 5_000 });
    const pauseMs = Date.now() - t0;
    log(KIND, `「暂停所有」→ 主任务 pill 已暂停 耗时 ${pauseMs}ms（≤5s 达标）`);
    await shot(page, KIND, "10-batch-paused");

    // ---- 继续所有：恢复 ----
    const t1 = Date.now();
    await page.locator("#job-pause-all").click();
    await expect(row.locator(".pill").first()).toHaveText("运行中", { timeout: 5_000 });
    log(KIND, `「继续所有」→ 恢复运行中 耗时 ${Date.now() - t1}ms`);

    // ---- 提速跑完（换服务重跑前提：本地音轨缓存 + 终态行）----
    await mockSpeed(request, { step: 1, tickMs: 50 });
    await secondSpeed({ step: 1, tickMs: 50 });
    await expect(row.locator(".pill").first()).toHaveText("完成", { timeout: 120_000 });
    log(KIND, "批次完成");

    // 展开子行（若收起）→ 换服务重跑
    if (await page.locator("#job-list .job-row", { hasText: "TB-001.mp4" }).count() === 0) {
      await row.locator(".batch-caret").first().click();
    }
    await expect(page.locator("#job-list .job-row", { hasText: "TB-001.mp4" })).toBeVisible({ timeout: 10_000 });
    const childRow = page.locator("#job-list .job-row", { hasText: "TB-001.mp4" });
    await childRow.locator(".rerun").click();
    // 「换服务重跑 · <名>」在 modal 标题（#modal-title）；body 是检测提示/状态文案
    await expect(page.locator("#modal-title")).toContainText("换服务重跑", { timeout: 10_000 });
    await expect(page.locator('input[name="rerun-engine"][value="second"]')).toBeVisible();
    log(KIND, `重跑 modal 音轨缓存提示 = ${((await page.locator("#modal-body .set-note").first().textContent()) || "").trim()}`);
    await page.locator("#rerun-go").click();
    // 第二台 mock 收到该文件的 job
    let secondFiles: string[] = [];
    for (let i = 0; i < 30; i++) {
      // mock /jobs 需 ?detail=1 才有 files[]；task 键是 path/name（无 file）
      secondFiles = (await (await fetch(`${SECOND}/jobs?detail=1`)).json() as any[])
        .flatMap((j: any) => (j.files || []).map((t: any) => t.path || ""));
      if (secondFiles.some((f: string) => f.includes("TB-001"))) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    log(KIND, `second(8305) 收到任务 = ${JSON.stringify(secondFiles)}`);
    expect(secondFiles.some((f) => f.includes("TB-001"))).toBe(true);
    await expect(page.locator("#job-list .job-row", { hasText: "TB-001.mp4" }).filter({ hasText: "second" })).toBeVisible({ timeout: 20_000 });
    log(KIND, "换服务重跑 OK：新行服务列 = second");
    await shot(page, KIND, "11-rerun-to-second");

    // ---- 搜索（文件名）----
    await page.locator("#job-search").fill("TB-002");
    await expect(page.locator("#job-list .job-row", { hasText: "TB-002.mp4" })).toBeVisible();
    const searchRows = await page.locator("#job-list tr, #job-list .job-grid").count();
    log(KIND, `搜索 TB-002 后可见行数 = ${searchRows}`);
    await page.locator("#job-search").fill("");
    await expect(page.locator("#job-list .job-row", { hasText: "TB-003.mp4" })).toBeVisible({ timeout: 10_000 });
    log(KIND, "清空搜索恢复全量 OK");

    // ---- 双时间列（0.2.45 诉求：添加于/完成于独立成列）----
    // 任务表是 CSS grid：表头 = .job-head > span（index.html 静态），非 table/thead
    const headers = (await page.locator(".job-head > span").allInnerTexts()).map((t) => t.trim());
    log(KIND, `任务表头 = ${JSON.stringify(headers)}`);
    expect(headers).toContain("添加于");
    expect(headers).toContain("完成于");
    // 终态行的独立列单元格（与 desktop ui-structure 同选择器）
    const doneRow = page.locator(".job-row", { hasText: "TB-003.mp4" }).first();
    await expect(doneRow.locator(".cell-created")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await expect(doneRow.locator(".cell-finished")).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // ---- 任务统计（旧 #job-stats 行已删：计数内嵌筛选按钮，与 desktop 契约一致）----
    expect(await page.locator("#job-stats").count()).toBe(0);
    const filterTxt = ((await page.locator("#job-filter").allInnerTexts()).join(" ")).replace(/\s+/g, " ").trim();
    log(KIND, `筛选桶计数 = [${filterTxt}]`);

    // ---- 清理已完成（终态行：本机账本 + 服务端同步清理）----
    await page.locator("#job-clear-done").click(); // confirm 自动受理
    await expect(page.locator("#job-list")).not.toContainText("TB-001.mp4", { timeout: 30_000 });
    log(KIND, "清理已完成：TB 批次行消失");
    await shot(page, KIND, "12-after-clear-done");

    // ---- 密集列表（40 条完成，分页截图，人工目检 UI 交叉/重叠）----
    await mockSeed(request, { n: 40, status: "done" });
    await expect(page.locator(".pg-info")).toBeVisible({ timeout: 20_000 });
    log(KIND, `分页信息 = ${((await page.locator(".pg-info").textContent()) || "").trim()}`);
    await shot(page, KIND, "13-jobs-dense-p1");
    // 全窗级横滚条元凶 probe（F-02 跟进）：找「不在任何 overflow-x 滚动容器内、却越出视口右缘」的元素
    const probe = await page.evaluate(() => {
      const winW = window.innerWidth;
      const docW = document.documentElement.scrollWidth;
      const out: string[] = [];
      if (docW > winW) out.push(`documentElement.scrollWidth=${docW} > innerWidth=${winW}`);
      const inScroller = (el: HTMLElement): boolean => {
        for (let pp = el.parentElement; pp; pp = pp.parentElement) {
          const ox = getComputedStyle(pp).overflowX;
          if (ox === "auto" || ox === "scroll") return true;
        }
        return false;
      };
      let n = 0;
      document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
        if (n >= 12) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > winW + 1 && !inScroller(el)) {
          const cls = typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
          out.push(`${el.tagName}${cls} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
          n++;
        }
      });
      return out;
    });
    log(KIND, `横滚条 probe = ${probe.length ? probe.join(" | ") : "无越界元素（横滚条另有来源，仅记录）"}`);
    await page.locator("#pg-next").click();
    await page.waitForTimeout(500);
    await shot(page, KIND, "13-jobs-dense-p2");
  } finally {
    await closeCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// T4 全管线：扫描 → 建批 → 逐阶段 → 完成 → 字幕自动落盘（fs 验证）
// ---------------------------------------------------------------------------
test("T4 全管线 + 字幕自动落盘", async ({ request }) => {
  await mockReset(request);
  const dir = mkScanFiles("t4", ["TP-001.mp4", "TP-002.mp4"]);
  const ctx = await boot([{ name: "mock", url: MOCK, api_key: MOCK_KEY }], { scan_min_size_mb: 0 });
  const { page } = ctx;
  try {
    await mockSpeed(request, { step: 0.05, tickMs: 200 }); // 每任务 ~4s：阶段截图窗口
    await goView(page, "dispatch");
    await page.locator("#scan-path").fill(dir);
    await page.click("#scan-go");
    const rows = page.locator("#scan-table tbody tr");
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await page.locator("#scan-page-all").check();
    // autosave 勾选状态记录（桌面端本地源任务写回不受该开关门控，见设置帮助文案）
    log(KIND, `#autosave 默认 = ${await page.locator("#autosave").isChecked()}`);
    await page.locator("#scan-submit").click();
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/, { timeout: 20_000 });
    const row = page.locator(".job-batch-row").first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    // 在途阶段截图
    await expect(row.locator(".pill").first()).toHaveText("运行中", { timeout: 60_000 });
    await shot(page, KIND, "14-pipeline-running");
    await expect(row.locator(".pill").first()).toHaveText("完成", { timeout: 120_000 });
    await shot(page, KIND, "15-pipeline-done");
    // 字幕落盘（本地源任务完成即写回影片旁，不等人工下载）
    const t0 = Date.now();
    let landed = false;
    while (Date.now() - t0 < 60_000) {
      if (existsSync(join(dir, "TP-001.zh.srt")) && existsSync(join(dir, "TP-002.zh.srt"))) { landed = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    log(KIND, `字幕落盘 = ${landed ? "OK（两文件 .zh.srt 均写回源目录）" : "FINDING: 60s 内未见 srt 落盘"}`);
    expect(landed).toBe(true);
  } finally {
    await closeCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// T5 设置页：客户端/服务端子 tab + 脏值 + 保存（热重载口径）+ 服务端通用/单端
// ---------------------------------------------------------------------------
test("T5 设置页（客户端/服务端子 tab + 保存 + 服务端通用与单端）", async ({ request }) => {
  await mockReset(request);
  const ctx = await boot([{ name: "mock", url: MOCK, api_key: MOCK_KEY }]);
  const { page } = ctx;
  try {
    await goView(page, "ccfg");
    await expect(page.locator("#ccfg-extract_workers")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#cc-body .cfg-tab[data-cctab="client"]')).toHaveClass(/on/);
    await shot(page, KIND, "16-ccfg-client-tab");
    await dumpDom(page, "#cc-body", KIND, "ccfg-client-pane", 2500);

    // 脏值 + 保存（热重载口径：toast 文案）
    const base = await page.locator("#ccfg-extract_workers").inputValue();
    await page.locator("#ccfg-extract_workers").fill(String(Math.min(8, Number(base) + 1)));
    await expect(page.locator("#ccfg-dirty")).not.toHaveText("无改动", { timeout: 5_000 });
    log(KIND, `脏值提示 = ${((await page.locator("#ccfg-dirty").textContent()) || "").trim()}`);
    await expect(page.locator("#ccfg-save")).toBeVisible();
    await page.locator("#ccfg-save").click();
    await expect(page.locator("#toasts .toast.ok").first()).toBeVisible({ timeout: 10_000 });
    log(KIND, `保存 toast = ${((await page.locator("#toasts .toast.ok").first().textContent()) || "").trim()}`);
    await expect(page.locator("#ccfg-dirty")).toHaveText("无改动", { timeout: 5_000 });

    // 扫描规则卡
    await dumpDom(page, '#cc-body [data-sec="ccfg-scan"]', KIND, "ccfg-scan-card", 2000);
    await shot(page, KIND, "17-ccfg-scan-card");

    // 服务端子 tab：通用（__all__）+ 单端（mock，已登记 key → 拉配置）
    await page.locator('#cc-body .cfg-tab[data-cctab="server"]').click();
    await expect(page.locator('#srv-sel')).toBeVisible({ timeout: 10_000 });
    const opts = await page.locator("#srv-sel option").allInnerTexts();
    log(KIND, `服务端选择项 = ${JSON.stringify(opts.map((t) => t.trim()))}`);
    await expect(page.locator("#srv-body")).toContainText("加载设置中…|", { timeout: 5_000 }).catch(() => {});
    // 等待配置表单或错误态（mock 有 key → 表单）
    await expect(page.locator("#srv-body .cfg-row").first()).toBeVisible({ timeout: 20_000 });
    await shot(page, KIND, "18-ccfg-server-common");
    await dumpDom(page, "#srv-body", KIND, "srv-pane-common", 2500);
    // 切到单端
    await page.locator("#srv-sel").selectOption("mock");
    await expect(page.locator("#srv-body .cfg-row").first()).toBeVisible({ timeout: 20_000 });
    log(KIND, `单端 note = ${((await page.locator("#srv-note").textContent()) || "").trim()}`);
    await shot(page, KIND, "19-ccfg-server-single");
    await dumpDom(page, "#srv-body", KIND, "srv-pane-single", 2500);
  } finally {
    await closeCtx(ctx);
  }
});

// ---------------------------------------------------------------------------
// T6 历史持久化：批次完成 → 退出 → 同 userData 重启 → 父任务+子任务+状态仍在
// ---------------------------------------------------------------------------
test("T6 重启后主任务/子任务历史仍在", async ({ request }) => {
  await mockReset(request);
  const dir = mkScanFiles("t6", ["TQ-001.mp4", "TQ-002.mp4"]);
  const userData = freshUserData(KIND, [{ name: "mock", url: MOCK, api_key: MOCK_KEY }], { scan_min_size_mb: 0 });
  let app: ElectronApplication | null = null;
  try {
    await mockSpeed(request, { step: 1, tickMs: 50 }); // 秒级完成
    app = await launchPackedApp(userData);
    const page = await app.firstWindow();
    attachDialogs(KIND, page);
    const sink = consoleCollector(KIND, page);
    await waitForReady(page);
    await goView(page, "dispatch");
    await page.locator("#scan-path").fill(dir);
    await page.click("#scan-go");
    const rows = page.locator("#scan-table tbody tr");
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    await page.locator("#scan-page-all").check();
    await page.locator("#scan-submit").click();
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/, { timeout: 20_000 });
    const row = page.locator(".job-batch-row").first();
    await expect(row.locator(".pill").first()).toHaveText("完成", { timeout: 120_000 });
    log(KIND, "批次完成，退出应用…");
    await sink.finish().catch(() => []);
    await app.close();
    app = null;

    // 同 userData 重启（mock 不 reset：服务端行也还在，验证双向校准不丢本地父任务）
    const r = await relaunchPacked(userData);
    const page2 = r.page;
    attachDialogs(KIND, page2);
    await goView(page2, "jobs");
    const row2 = page2.locator(".job-batch-row").first();
    await expect(row2).toBeVisible({ timeout: 20_000 });
    await expect(row2).toContainText("2 子任务");
    log(KIND, `重启后主任务 pill = ${(await batchPill(page2, row2))}`);
    // 展开子行
    if (!(await row2.locator("~ .job-row, + .job-row").count())) {
      await row2.locator(".batch-caret").first().click();
    }
    await expect(page2.locator("#job-list .job-row", { hasText: "TQ-001.mp4" })).toBeVisible({ timeout: 15_000 });
    await shot(page2, KIND, "20-restart-history");
    await r.app.close().catch(() => {});
  } finally {
    if (app) await app.close().catch(() => {});
  }
});
