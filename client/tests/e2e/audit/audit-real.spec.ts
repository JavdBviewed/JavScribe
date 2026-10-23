// 自检线（10-23-javscribe-selfaudit-ux）· audit-real：真实 serve 127/158（:8300）全管线
// 红线（只读使用）：不改服务配置 / 不重启 / 不 kill / 不清其队列与 batch_paused；
//   提交任务只用 /tmp KB 级夹具短片（GPU 秒级转译）；R2 的 24 文件批在验证提交后主动取消。
// 鉴权口径：serve 0.2.x 的 /config、/scan 系要 X-Api-Key，jobs 系免鉴权；
//   客户端 #scan-go 入口闸（has_key）拦截未登记 key 的引擎 → R1/R2 用 keys.env 登记 key
//   （~/.config/javscribe-audit/keys.env，chmod 600 不进 git；缺失 → test.skip）；
//   R3 故意不登记 key，验证「尚未登记 API Key」错误态质量。
import { test as base, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { goView } from "../desktop/helpers";
import type { ElectronApplication } from "@playwright/test";
import {
  E127, E158, log, shot, consoleCollector, attachDialogs, mkScanFiles, checkRow,
  freshUserData, launchRealPacked, waitForEnginesOnline, auditKeys,
} from "./audit-helpers";

const KIND = "real";
const test = base;

interface ServeInfo { base: string; name: string; health: any; gpuFreeGb: number | null }

async function probeServe(name: string, base: string): Promise<ServeInfo | null> {
  try {
    const h = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) })).json() as any;
    let gpuFreeGb: number | null = null;
    try {
      const m = await (await fetch(`${base}/metrics/json`, { signal: AbortSignal.timeout(8000) })).json() as any;
      const g = m.gpu || {};
      if (typeof g.mem_total_mb === "number" && typeof g.mem_used_mb === "number") {
        gpuFreeGb = Math.round(((g.mem_total_mb - g.mem_used_mb) / 1024) * 10) / 10;
      }
    } catch { /* metrics 不可用不影响管线 */ }
    return { base, name, health: h, gpuFreeGb };
  } catch (e) {
    log(KIND, `${name}(${base}) 探测失败：${(e as Error).message}`);
    return null;
  }
}

let s127: ServeInfo | null = null;
let s158: ServeInfo | null = null;

test.beforeAll(async () => {
  s127 = await probeServe("127", E127);
  s158 = await probeServe("158", E158);
  if (s127) log(KIND, `127 /health = version ${s127.health.version ?? "?"} · GPU 空闲 ${s127.gpuFreeGb ?? "?"}G`);
  if (s158) log(KIND, `158 /health = version ${s158.health.version ?? "?"} · GPU 空闲 ${s158.gpuFreeGb ?? "?"}G`);
});

async function requireBoth(): Promise<void> {
  test.skip(!s127 || !s158, "127/158 至少一台不可达，real 管线跳过");
}

const KEYS = auditKeys();

/** 真实引擎 userData（withKeys=true 时登记 keys.env 的 key；R3 传 false 测无 key 错误态） */
function realUserData(tag: string, cfg: Record<string, unknown> = {}, withKeys = true): string {
  return freshUserData(
    tag,
    [
      { name: "127", url: E127, api_key: withKeys ? KEYS.key127 || undefined : undefined },
      { name: "158", url: E158, api_key: withKeys ? KEYS.key158 || undefined : undefined },
    ],
    { scan_min_size_mb: 0, ...cfg },
  );
}

/** R1/R2 前置：真实管线需要两台可达 + 两 key 齐备（缺 key 时入口闸拦截，skip 而非 fail） */
async function requirePipeline(): Promise<void> {
  await requireBoth();
  test.skip(!KEYS.key127 || !KEYS.key158, "audit keys 缺失（AUDIT_KEY_127/158，~/.config/javscribe-audit/keys.env），real 管线跳过");
}

async function bootReal(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchRealPacked(userData);
  const page = await app.firstWindow();
  attachDialogs(KIND, page);
  // 先等任一在线（60s），未达 2/2 快速暴露而非干等
  await waitForEnginesOnline(page, 1, 60_000);
  const n = ((await page.locator("#health").textContent()) || "").match(/服务 (\d+)\/(\d+) 在线/);
  log(KIND, `真实引擎在线 = ${n ? n[0] : "未知"}`);
  if (!n || Number(n[1]) < 2) {
    await app.close().catch(() => {});
    throw new Error("real 引擎未达 2/2 在线（见 #health 文案），real 管线中止");
  }
  return { app, page };
}

// ---------------------------------------------------------------------------
// R1 全管线：auto 均衡建批 → 两服务分摊（显存阈值口径）→ 完成 → srt 落盘
// ---------------------------------------------------------------------------
test("R1 真实管线：auto 均衡 + 完成 + 字幕落盘", async () => {
  await requirePipeline();
  // 唯一文件名：scan-reconcile 按文件名对账服务端已完成任务，固定名会命中本线历史运行在 127/158 落下的任务
  // → 行被标「已生成」排选出 → 全选框 disabled（10-23 全量复跑 R1 实证）。文件名对账是 0.2.46 用户诉求功能，产品行为正确。
  const tag = Date.now().toString(36);
  const n1 = `RA-001-${tag}.mp4`, n2 = `RA-002-${tag}.mp4`;
  const dir = mkScanFiles("r1", [n1, n2]);
  const userData = realUserData("r1");
  let app: ElectronApplication | null = null;
  try {
    const { app: a, page } = await bootReal(userData);
    app = a;
    const sink = consoleCollector(KIND, page);
    try {
      // 引擎卡监控（用户诉求：「监控数据加载中…」不得 stuck）
      await goView(page, "engines");
      for (const nm of ["127", "158"]) {
        const m = ((await page.locator(`.eng[data-name="${nm}"] .eng-metrics`).textContent().catch(() => "")) || "").trim();
        log(KIND, `${nm} 引擎卡监控 = ${m || "(空)"}`);
        if (m.includes("监控数据加载中")) log(KIND, `FINDING: ${nm} 引擎卡停在「监控数据加载中…」`);
      }
      await shot(page, KIND, "r1-engines");

      // 扫描 2 文件 → auto 均衡建批
      await goView(page, "dispatch");
      await page.locator("#scan-path").fill(dir);
      await page.click("#scan-go");
      const rows = page.locator("#scan-table tbody tr");
      await expect(rows).toHaveCount(2, { timeout: 30_000 });
      await page.locator("#scan-page-all").check();
      await page.selectOption("#engine-select", "auto");
      log(KIND, `engine-select=auto 提交前选项文本 = ${await page.locator("#engine-select").inputValue()}`);
      await page.click("#scan-submit");
      await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/, { timeout: 30_000 });
      const row = page.locator(".job-batch-row").first();
      await expect(row).toContainText("2 子任务", { timeout: 30_000 });
      await shot(page, KIND, "r1-batch-created");
      await expect(row.locator(".pill").first()).toHaveText("运行中", { timeout: 120_000 });
      await shot(page, KIND, "r1-batch-running");
      await expect(row.locator(".pill").first()).toHaveText("完成", { timeout: 300_000 });
      log(KIND, "R1 批次完成");

      // 子行服务列分布（auto 均衡口径：默认显存阈值 5G 过滤）
      if (await page.locator("#job-list .job-row", { hasText: n1 }).count() === 0) {
        await row.locator(".batch-caret").first().click();
      }
      await expect(page.locator("#job-list .job-row", { hasText: n1 })).toBeVisible({ timeout: 15_000 });
      const dist: Record<string, number> = {};
      for (const nm of [n1, n2]) {
        const r = page.locator("#job-list .job-row", { hasText: nm }).first();
        const cell = ((await r.locator(".job-cell").first().textContent()) || "").trim();
        dist[cell] = (dist[cell] || 0) + 1;
      }
      log(KIND, `R1 子任务服务分布 = ${JSON.stringify(dist)}`);
      const free = (s: ServeInfo | null): number | null => (s ? s.gpuFreeGb : null);
      const f127 = free(s127), f158 = free(s158);
      const filtered = (f: number | null) => f != null && f < 5;
      if (Object.keys(dist).length === 1) {
        const only = Object.keys(dist)[0];
        const otherFree = only === "127" ? f158 : f127;
        if (filtered(otherFree)) {
          log(KIND, `R1 均衡单侧（全 ${only}）：符合预期 —— 另一台 GPU 空闲 ${otherFree}G < 默认阈值 5G 被过滤`);
        } else {
          log(KIND, "FINDING: R1 auto 均衡未分摊（2 文件全落同一服务，另一台空闲显存达标）");
        }
      }
      await shot(page, KIND, "r1-batch-done");

      // 字幕落盘（本地源任务完成即写回）
      const t0 = Date.now();
      let landed = false;
      while (Date.now() - t0 < 60_000) {
        if (existsSync(join(dir, n1.replace(/\.mp4$/, ".zh.srt"))) && existsSync(join(dir, n2.replace(/\.mp4$/, ".zh.srt")))) { landed = true; break; }
        await new Promise((r) => setTimeout(r, 500));
      }
      log(KIND, `R1 字幕落盘 = ${landed ? "OK" : "FINDING: 60s 内未见 srt 写回源目录"}`);
      expect(landed).toBe(true);
    } finally {
      await sink.finish().catch(() => []);
    }
  } finally {
    if (app) await app.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// R2 24 文件单批：提交不报「bad body size (max 1024KB)」（0.2.8+ 逐文件上传口径回归）
// 验证提交成功后主动取消（避免 24 条真实转译占服务）
// ---------------------------------------------------------------------------
test("R2 24文件单批提交无 bad body size + 主动取消", async () => {
  await requirePipeline();
  // 唯一文件名（同 R1：避开 scan-reconcile 命中历史运行的已完成任务 → 可选项 24-命中数）
  const tag = Date.now().toString(36);
  const names = Array.from({ length: 24 }, (_, i) => `RB-${String(i + 1).padStart(3, "0")}-${tag}.mp4`);
  const dir = mkScanFiles("r2", names);
  const userData = realUserData("r2");
  let app: ElectronApplication | null = null;
  try {
    const { app: a, page } = await bootReal(userData);
    app = a;
    const sink = consoleCollector(KIND, page);
    try {
      let bodySizeErr = "";
      page.on("console", (msg) => {
        const t = msg.text();
        if (/bad body size/i.test(t)) bodySizeErr = t;
      });
      await goView(page, "dispatch");
      await page.locator("#scan-path").fill(dir);
      await page.click("#scan-go");
      await expect(page.locator("#scan-table tbody tr")).toHaveCount(10, { timeout: 30_000 }); // 第 1 页 10 行
      // 逐页全选 24 项
      for (let pg = 0; pg < 3; pg++) {
        await page.locator("#scan-page-all").check().catch(() => {});
        if (pg < 2) await page.locator("#spg-next").click();
      }
      const selTxt = ((await page.locator("#scan-submit").textContent()) || "").trim();
      log(KIND, `24 文件提交按钮 = ${selTxt}`);
      expect(selTxt).toContain("已选择 24 项");
      await page.selectOption("#engine-select", "auto");
      await page.click("#scan-submit");
      await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/, { timeout: 30_000 });
      const row = page.locator(".job-batch-row").first();
      await expect(row).toContainText("24 子任务", { timeout: 30_000 });
      log(KIND, "R2 24 子任务主任务已建立（提交无 bad body size）");
      await shot(page, KIND, "r2-batch-24");
      // toast 侧证据
      const toastErr = (await page.locator("#toasts .toast.err").allInnerTexts()).join("|");
      log(KIND, `提交后 toast.err = ${toastErr || "(无)"}`);
      expect(toastErr).not.toMatch(/bad body size/i);
      expect(bodySizeErr).toBe("");
      // 主动取消（验证批次取消立即性：未开始子任务立即取消）
      const cancelBtn = row.locator('.batch-op[data-bact="cancel"]');
      if (await cancelBtn.count()) {
        await cancelBtn.click(); // confirm 自动受理
        await expect(row.locator(".pill").first()).toHaveText(/已取消|完成|部分失败/, { timeout: 120_000 });
        log(KIND, `R2 取消后主任务 pill = ${(await row.locator(".pill").first().textContent())?.trim()}`);
      } else {
        log(KIND, "R2 未见批次取消按钮（canOp=false？记录状态）");
        log(KIND, `R2 当前 pill = ${(await row.locator(".pill").first().textContent())?.trim()}`);
      }
      await shot(page, KIND, "r2-after-cancel");
    } finally {
      await sink.finish().catch(() => []);
    }
  } finally {
    if (app) await app.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// R3 服务端子 tab（无 key 登记）错误态质量：单端 = Key 登记表单；通用 = 403 错误 note
// ---------------------------------------------------------------------------
test("R3 服务端设置（无 key）错误态", async () => {
  await requireBoth();
  const userData = realUserData("r3", {}, false);
  let app: ElectronApplication | null = null;
  try {
    const { app: a, page } = await bootReal(userData);
    app = a;
    const sink = consoleCollector(KIND, page);
    try {
      await goView(page, "ccfg");
      await expect(page.locator("#ccfg-extract_workers")).toBeVisible({ timeout: 20_000 });
      await page.locator('#cc-body .cfg-tab[data-cctab="server"]').click();
      await expect(page.locator("#srv-sel")).toBeVisible({ timeout: 10_000 });
      // 通用（取值参考 = 第一个在线服务，无 key → getConfig 403 → 错误 note）
      await page.waitForTimeout(3000);
      const commonTxt = ((await page.locator("#srv-body").textContent()) || "").replace(/\s+/g, " ").trim();
      log(KIND, `通用设置 pane = ${commonTxt.slice(0, 200)}`);
      await shot(page, KIND, "r3-srv-common-nokey");
      // 单端 127：尚未登记 API Key + 登记表单
      await page.locator("#srv-sel").selectOption("127");
      await expect(page.locator("#srv-body")).toContainText("尚未登记 API Key", { timeout: 20_000 });
      await expect(page.locator("#key-input")).toBeVisible();
      log(KIND, "R3 单端无 key 态：登记表单就位（不填入、不保存）");
      await shot(page, KIND, "r3-srv-127-nokey");
    } finally {
      await sink.finish().catch(() => []);
    }
  } finally {
    if (app) await app.close().catch(() => {});
  }
});
