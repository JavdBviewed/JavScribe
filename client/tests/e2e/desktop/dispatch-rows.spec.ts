// 桌面端派发「行优先」专测（10-10-javscribe-dispatch-row-first）
// 打的是用户 65 文件批量那条链：扫描目录 → 所选服务 400 读不到本机路径 → 回退本机提取
//   dispatchLocalScanPaths → runDispatchQueue（rowFirst）→ dispatchOne（本机提取 → 上传音频 → 提交）。
// 断言：① 提交即建主任务 + N 条 pending 子行（serve 此时还没有任务）② 派发页无流程节点、只剩一条
//   状态行且自动切任务看板 ③ 各阶段进度写进子行 ④ serve 真行出现后交棒去重（全程同一文件恒一行）
//   ⑤ 批次「取消」对 pending 子行生效：未开始 → 已取消、在跑 → 跑完当前阶段不提交 = 已跳过。
// 用假 ffmpeg（JAVSCRIBE_FFMPEG）把提取撑到 ~3s，好让「行先行 / serve 还没有任务」的窗口可测。
import { test, expect, goView, launchApp, waitForReady, makeScanDir, mockJobs, mockUploadDelay } from "./helpers";
import type { Page } from "@playwright/test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAMES = ["AKDL-001.mp4", "AKDL-002.mp4", "SUB-001.mkv"];
// rowSink 写进子行的阶段（pendingRank/phase 口径见 app.ts rowSink.phaseOf）
const QUEUE_PHASE = "queued"; // 只有没抢到 cap 槽的子行看得见：抢到槽的在提交那一拍就进 extracting
const RUN_PHASES = ["extracting", "uploading", "submitting"]; // 每个文件必经（进度写在子行上）
const ENQUEUE_PHASE = "enqueued"; // 与 serve 行交棒同刻发生，二者取一（见断言 ④）

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 假 ffmpeg：argv 末位 = 输出路径、第 3 位 = -i 的输入路径。
 * stderr 打 Duration/time= 供 main 算进度（10s 片长 → 2/4/6/8/10s = 20%..100%），每帧 sleep 0.6s。
 * 输出内容追加「本次输入路径」→ 三个文件的 opus 内容互不相同：同内容会命中 serve 内容缓存走
 * /upload/submit 免传字节，「上传中」帧就没了（用例要断的那一帧）。
 */
function makeFakeFfmpeg(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-e2e-fakeff-"));
  const bin = join(dir, "ffmpeg");
  const lines = [
    "#!/bin/bash",
    'out="${@: -1}"',
    'src="$3"',
    "printf 'Duration: 00:00:10.00, start: 0.000000, bitrate: 128 kb/s\\n' >&2",
    "printf 'size= 10kB time=00:00:02.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 20kB time=00:00:04.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 30kB time=00:00:06.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 40kB time=00:00:08.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    "printf 'size= 50kB time=00:00:10.00 bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.6",
    'head -c 4096 /dev/zero > "$out"',
    'printf %s "$src" >> "$out"',
    "exit 0",
  ];
  writeFileSync(bin, lines.join("\n") + "\n", "utf8");
  chmodSync(bin, 0o755);
  return { dir, bin };
}

/**
 * 页内采样器（100ms）：
 *  seen = 出现过的「文件名|phase」集合（累计不清）→ 阶段进度确实进了子行的证据；
 *  log  = 每拍记一次所有 pending 子行的「文件名|phase|status」（原始流水）；
 *  dup  = 每个文件名在任务表里同时出现过的最大行数（历史最大值）→ 交棒窗口若双行即 >1；
 *  pos  = 见过的所有 .cell-pos 文本（进度文案进任务表的证据）。
 * 累计量必须跨轮次保留：一次轮询只覆盖几百毫秒，而单条链的阶段前后要几秒，
 *  重置采样器就永远凑不齐「同一文件五种阶段」，断言必然假失败。
 */
async function installSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __log?: string[]; __dup?: Record<string, number>; __pos?: Record<string, 1>;
      __seen?: Record<string, 1>;
      __sampler?: number; state?: { _pending?: Map<string, { row: { file?: string; phase?: string; status?: string } }> };
    };
    if (w.__sampler) return; // 已在一跑：只补装，不重置累计量
    w.__log = [];
    w.__dup = {};
    w.__pos = {};
    w.__seen = {};
    w.__sampler = window.setInterval(() => {
      const pend = w.state?._pending;
      if (pend) {
        for (const p of pend.values()) {
          w.__log!.push(`${p.row.file || ""}|${p.row.phase || ""}|${p.row.status || ""}`);
          w.__seen![`${p.row.file || ""}|${p.row.phase || ""}`] = 1;
        }
      }
      const cnt: Record<string, number> = {};
      document.querySelectorAll(".job-row .fn").forEach((el) => {
        const t = (el.textContent || "").trim();
        if (t) cnt[t] = (cnt[t] || 0) + 1;
      });
      for (const k of Object.keys(cnt)) {
        if ((cnt[k] || 0) > (w.__dup![k] || 0)) w.__dup![k] = cnt[k] || 0;
      }
      document.querySelectorAll(".job-row .cell-pos").forEach((el) => {
        const t = (el.textContent || "").trim();
        if (t) w.__pos![t] = 1;
      });
    }, 100);
  });
}

type Sampler = { log: string[]; dup: Record<string, number>; pos: string[]; seen: string[] };

async function peekSampler(page: Page): Promise<Sampler> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __log?: string[]; __dup?: Record<string, number>; __pos?: Record<string, 1>;
      __seen?: Record<string, 1>;
    };
    return {
      log: (w.__log || []).slice(),
      dup: { ...(w.__dup || {}) },
      pos: Object.keys(w.__pos || {}),
      seen: Object.keys(w.__seen || {}),
    };
  });
}

/** 收尾读取：停掉采样器（之后可再 installSampler 续采，累计量会重置） */
async function readSampler(page: Page): Promise<Sampler> {
  const out = await page.evaluate(() => {
    const w = window as unknown as {
      __log?: string[]; __dup?: Record<string, number>; __pos?: Record<string, 1>;
      __seen?: Record<string, 1>; __sampler?: number;
    };
    if (w.__sampler) {
      window.clearInterval(w.__sampler);
      w.__sampler = 0;
    }
    return {
      log: (w.__log || []).slice(),
      dup: { ...(w.__dup || {}) },
      pos: Object.keys(w.__pos || {}),
      seen: Object.keys(w.__seen || {}),
    };
  });
  return out;
}

/** 扫描目录 → 全选 3 项 → 提交（serve 400 → 本机提取回退）。调用前须已装 dialog 自动接受。 */
async function submitScanBatch(page: Page, dir: string): Promise<void> {
  await page.selectOption("#engine-select", "mock");
  await page.locator("#scan-path").fill(dir);
  await page.click("#scan-go");
  await expect(page.locator("#scan-table tbody tr")).toHaveCount(3, { timeout: 20_000 });
  await page.locator("#scan-select-all").check();
  await expect(page.locator("#scan-count")).toContainText("已选 3 / 3");
  await installSampler(page);
  await page.click("#scan-submit");
}

test("批量本机提取回退（行优先）：提交即建主任务+3 子行 → 进度进子行 → serve 行交棒无双行 → 全部完成", async ({ userData, request }) => {
  const ff = makeFakeFfmpeg();
  // 「忽略小于」默认 200MB 会把夹具小文件全判成「过小」→ 扫描表没有可全选项，先置 0
  // queue_cap=2 < 3 项：留一条子行停在「排队提取」，排队帧才有得断（默认 4 会让三项同拍开跑）
  writeFileSync(join(userData, "client-config.json"), JSON.stringify({ scan_min_size_mb: 0, queue_cap: 2 }), "utf-8");
  await mockUploadDelay(request, 800); // 撑住「上传中」帧，采样器稳拿
  const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ff.bin });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    page.on("dialog", (d) => d.accept()); // AKDL-002 同目录已有 srt → 提交前确认
    await goView(page, "dispatch");
    await submitScanBatch(page, makeScanDir("javscribe-desktop-scan-__notfound__"));

    // ① 行先行：主任务 + 3 条子行即刻在册，serve 侧此刻还没有任何任务
    await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/); // ② 提交后自动切任务看板
    await expect(page.locator(".job-batch-row")).toHaveCount(1);
    await expect(page.locator(".job-batch-row .batch-sub-n")).toHaveText("3 子任务");
    await expect(page.locator(".job-row")).toHaveCount(3);
    expect(await mockJobs(request)).toHaveLength(0);

    // ② 派发页：流程节点取消，只剩一条状态行
    await goView(page, "dispatch");
    await expect(page.locator("#pipeline")).toBeHidden();
    await expect(page.locator("#dispatch-status")).toHaveText(/已创建主任务 .*：3 子任务/);
    await goView(page, "jobs");

    // ③ 三个文件都走完 提取中→上传中→提交中（进度写在子行上），且批内看得见「排队提取」
    await expect
      .poll(async () => {
        const { seen } = await peekSampler(page); // 采样器保持在一跑，累计量逐轮累加
        const hit = new Set(seen);
        const missing = NAMES
          .flatMap((n) => RUN_PHASES.filter((ph) => !hit.has(n + "|" + ph)).map((ph) => n + ":" + ph));
        if (!seen.some((k) => k.endsWith("|" + QUEUE_PHASE))) missing.push("批:" + QUEUE_PHASE);
        return missing.join(",");
      }, { timeout: 90_000, intervals: [500] })
      .toBe("");

    // ④ 进度文案进任务表 + 全程无双行（同文件行数历史最大值 = 1）
    const { dup, pos, seen } = await readSampler(page);
    expect(pos.some((t) => /^排队提取$/.test(t))).toBe(true);
    expect(pos.some((t) => /^本机提取 · \d+%$/.test(t))).toBe(true);
    expect(pos.some((t) => /^上传音频 .+ MB · [\d.]+%$/.test(t))).toBe(true);
    expect(pos.some((t) => /^提交中…$/.test(t))).toBe(true);
    // 「已入队」与「交棒」是同一件事的两种落法：refresh 落在 提交中→job_id 那一拍窗内，
    // pending 行不留「已入队」帧，直接让位给 serve 真行（ serve 侧已收满 3 项即算到达）。
    const hit = new Set(seen);
    const handedOver = (await mockJobs(request)).length === NAMES.length;
    for (const n of NAMES) expect(hit.has(n + "|" + ENQUEUE_PHASE) || handedOver).toBe(true);
    expect(Object.keys(dup).sort()).toEqual([...NAMES].sort());
    for (const n of NAMES) expect(dup[n]).toBe(1);

    // ⑤ serve 真行接管后全部跑完
    await expect(page.locator(".job-row .pill.p-done")).toHaveCount(3, { timeout: 60_000 });
    await expect(page.locator(".job-batch-row .pill")).toHaveText("完成", { timeout: 60_000 });
    expect(await mockJobs(request)).toHaveLength(3);
  } finally {
    await app.close().catch(() => {});
    rmSync(ff.dir, { recursive: true, force: true });
  }
});

test("批量取消：未开始子行「取消」=已取消、在跑链跑完当前阶段不提交=已跳过（全程不碰服务）", async ({ userData, request }) => {
  const ff = makeFakeFfmpeg();
  // queue_cap=1：批内只有第 1 个文件开跑，另 2 条子行停在「排队提取」= 未开始（取消语义要的那一半）
  // scan_min_size_mb=0：夹具小文件不判「过小」，否则扫描表「全选」不可用
  writeFileSync(join(userData, "client-config.json"), JSON.stringify({ extract_workers: 1, queue_cap: 1, scan_min_size_mb: 0 }), "utf-8");
  await mockUploadDelay(request, 1500);
  const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ff.bin });
  try {
    const page = await app.firstWindow();
    await waitForReady(page);
    page.on("dialog", (d) => d.accept());
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { state?: { ccfg?: { queue_cap?: number } } }).state?.ccfg?.queue_cap), { timeout: 20_000 })
      .toBe(1);
    await goView(page, "dispatch");
    await submitScanBatch(page, makeScanDir("javscribe-desktop-scan-__notfound__"));

    await expect(page.locator(".job-row")).toHaveCount(3);
    // 纯 pending 批：服务侧还不认识这个主任务 → 只给「取消」，不给暂停/继续/重试
    await expect(page.locator('.job-batch-row [data-bact="cancel"]')).toHaveCount(1);
    await expect(page.locator('.job-batch-row [data-bact="pause"]')).toHaveCount(0);
    await expect(page.locator('.job-batch-row [data-bact="retry"]')).toHaveCount(0);

    // 未开始的子行：单行取消 → 行转「已取消」，不进队列、不提交服务
    const one = page.locator(".job-row", { has: page.locator(".fn", { hasText: "SUB-001.mkv" }) });
    await expect(one.locator(".pend-cancel")).toBeVisible({ timeout: 10_000 });
    await one.locator(".pend-cancel").click();
    await expect(page.locator("#toasts .toast.ok", { hasText: "已取消该子任务" })).toBeVisible();
    await expect(one.locator(".pill.p-canceled")).toBeVisible();

    // 主任务取消：余下未开始的置「已取消」，在跑那条跑完当前阶段标「已跳过」
    await page.locator('.job-batch-row [data-bact="cancel"]').click();
    await expect(page.locator(".job-row .pill.p-canceled")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.locator(".job-row .pill.p-skipped")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator(".job-row", { hasText: "已跳过（主任务取消）" }).locator(".cell-pos").first())
      .toHaveText("已跳过（主任务取消）");
    await expect(page.locator(".job-batch-row .pill")).toHaveText("已取消", { timeout: 60_000 });
    await expect(page.locator(".job-batch-row .batch-op")).toHaveCount(0);

    // 队列停止：派发页汇总行说明没有任何一项提交服务
    await goView(page, "dispatch");
    await expect(page.locator("#pipeline")).toBeHidden();
    await expect(page.locator("#dispatch-status")).toHaveText(/已取消：已提交 0\/3 项，3 项已取消/, { timeout: 60_000 });

    const { log } = await readSampler(page);
    expect(log.some((l) => /\|uploading\|/.test(l))).toBe(false);
    expect(log.some((l) => /\|submitting\|/.test(l))).toBe(false);
    await sleep(3000); // 取消后再观察一拍：不应有任务落到服务侧
    expect(await mockJobs(request)).toHaveLength(0);
  } finally {
    await app.close().catch(() => {});
    rmSync(ff.dir, { recursive: true, force: true });
  }
});
