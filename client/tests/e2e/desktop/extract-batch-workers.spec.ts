// 桌面端「主任务级本机提取并发」e2e（0.2.53 需求③：batch.extractWorkers + 批预算闸）
//  T1 闸 N=1（ccfg=8）：该批运行期间任一时刻「提取中」≤1（泵入口闸不派发、
//    extractLocal .finally 计数归零 + pumpDispatch 立即重驱），3 项全部真实提取并提交；
//  T2 双批 N1=N2=1：每批在途 ≤1、全局 ≤2，且必存在两批同拍提取的 tick
//    （池上限 = 客户端设置基线 + N1 + N2，并行度真实达到 N1+N2）；
//  T3 池回落：ccfg=1 + 批 N=2 → 批运行期上限=基线+预算=3、两项并行；批结束注销后
//    回落 1 → 直接连发生产池（window.JavExtract.extractAudio，同 extract-disk-fair
//    打法）第二个必须等第一个完成才开跑（预算泄漏则上限≥3 并行 → 红）。
// 打法：主进程 pick-video-folder patch（同 batch-parallel）走真实派发链
//（勾选 → #batch-extract-workers 输入 → 开始生成）；tick 采样器 100ms 读
// state._pending 的 phase==="extracting" 子行（按 batch_id 分桶）；假 ffmpeg
// 控制提取时长（同 dispatch-rows / extract-disk-fair 口径）。
import { test, expect, FIXTURES, launchApp, waitForReady, mockJobs, goView, type ElectronApp } from "./helpers";
import type { Page, Locator } from "@playwright/test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// walkVideos/PickFolderItem 同构（main 侧 IPC patch 返回形状）
interface PdItem {
  path: string; name: string; size: number; rel: string;
  sub_status: "none"; sub_name: null; sub_token: null; no_sub_token: null;
  too_small: boolean;
}
const mkDir = (tag: string, names: string[], tooSmall: boolean): { dir: string; items: PdItem[] } => {
  const dir = mkdtempSync(join(tmpdir(), `javscribe-bew-${tag}-`));
  const items = names.map((name) => {
    const p = join(dir, name);
    copyFileSync(join(FIXTURES, "video-a.mp4"), p);
    return {
      path: p, name, size: statSync(p).size,
      rel: `${basename(dir)}/${name}`,
      sub_status: "none" as const, sub_name: null, sub_token: null, no_sub_token: null,
      too_small: tooSmall,
    };
  });
  return { dir, items };
};
const patchPick = (app: ElectronApp, items: PdItem[]) =>
  app.evaluate((el: any, its: PdItem[]) => {
    el.ipcMain.removeHandler("pick-video-folder");
    el.ipcMain.handle("pick-video-folder", () => its);
  }, items);
const checkRow = async (page: Page, tableSel: string, name: string) =>
  page.locator(`${tableSel} tbody tr`, { hasText: name }).locator("input[type=checkbox]").check();
const waitBatchDone = (row: Locator): Promise<void> =>
  expect(row.locator(".pill")).toHaveText("完成", { timeout: 120_000 });

/** 假 ffmpeg（时长版）：按 basename 帧数 n 定时长 = n × 0.2s（stderr time= 口径同 dispatch-rows） */
function makeFakeFfmpeg(frames: Record<string, number>): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-e2e-bewff-"));
  const bin = join(dir, "ffmpeg");
  const ts2 = (sec: number): string => `00:00:${(sec * 1).toFixed(2).padStart(5, "0")}`;
  const lines = [
    "#!/bin/bash",
    'out="${@: -1}"',
    'src="$3"',
    'case "$(basename "$src")" in',
  ];
  for (const [name, n] of Object.entries(frames)) {
    lines.push(`  "${name}")`);
    lines.push(`    printf 'Duration: ${ts2(n * 0.2)}, start: 0.000000, bitrate: 128 kb/s\\n' >&2`);
    for (let i = 1; i <= n; i++) {
      lines.push(`    printf 'size= ${i * 10}kB time=${ts2(i * 0.2)} bitrate= 40.0kbits/s speed=0.6x \\r' >&2; sleep 0.2`);
    }
    lines.push("    ;;");
  }
  lines.push("  *) exit 1 ;;", "esac", 'head -c 4096 /dev/zero > "$out"', 'printf %s "$src" >> "$out"', "exit 0");
  writeFileSync(bin, lines.join("\n") + "\n", "utf8");
  chmodSync(bin, 0o755);
  return { dir, bin };
}

// ---------------------------------------------------------------------------
// tick 采样器：每 100ms 记一次 state._pending 中 phase==="extracting" 子行
//（按 batch_id 分桶）。extracting 只在提取池内出现（rowSink 阶段写子行），
// 分桶计数即「该批池内在途提取数」= 批预算闸的受控量。
// ---------------------------------------------------------------------------
type Tick = { per: Record<string, number>; total: number };
async function installTickSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __bewTicks?: Tick[]; __bewSampler?: number;
      state?: { _pending?: Map<string, { row: { batch_id?: string; phase?: string } }> };
    };
    if (w.__bewSampler) return;
    w.__bewTicks = [];
    w.__bewSampler = window.setInterval(() => {
      const per: Record<string, number> = {};
      let total = 0;
      const pend = w.state?._pending;
      if (pend) {
        for (const p of pend.values()) {
          if (p.row.phase !== "extracting") continue;
          const k = p.row.batch_id || "?";
          per[k] = (per[k] || 0) + 1;
          total += 1;
        }
      }
      w.__bewTicks!.push({ per, total });
    }, 100);
  });
}
async function readTicks(page: Page): Promise<Tick[]> {
  return await page.evaluate(() => {
    const w = window as unknown as { __bewTicks?: Tick[]; __bewSampler?: number };
    if (w.__bewSampler) { clearInterval(w.__bewSampler); w.__bewSampler = 0; }
    return w.__bewTicks || [];
  });
}
const maxOf = (ticks: Tick[], key: string): number =>
  ticks.reduce((m, tk) => Math.max(m, key === "__all__" ? tk.total : (tk.per[key] || 0)), 0);
const sawAny = (ticks: Tick[], key: string): boolean =>
  ticks.some((tk) => (key === "__all__" ? tk.total : (tk.per[key] || 0)) >= 1);

/** 等 mock 侧指定文件名（job.label）全部 finished */
async function waitMockLabelsFinished(
  request: Parameters<typeof mockJobs>[0],
  names: string[],
  timeoutMs = 90_000,
): Promise<void> {
  const want = new Set(names);
  const t0 = Date.now();
  for (;;) {
    const jobs = (await mockJobs(request)) as any[];
    const done = jobs.filter((j) => want.has(j.label) && j.state === "finished").length;
    if (done >= names.length) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`期望 ${names.length} 项 finished，当前 ${done}（${jobs.map((j) => `${j.label}:${j.state}`).join(", ") || "无任务"}）`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 预置 client-config 并冷启动（userData 写入须先于 launch） */
async function bootWithCcfg(userData: string, extractWorkers: number, ffBin: string) {
  writeFileSync(join(userData, "client-config.json"), JSON.stringify({ extract_workers: extractWorkers }), "utf-8");
  const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ffBin });
  const page = await app.firstWindow();
  await waitForReady(page);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { state?: { ccfg?: { extract_workers?: number } } }).state?.ccfg?.extract_workers), { timeout: 20_000 })
    .toBe(extractWorkers);
  return { app, page };
}

test("闸 N=1：批内提取中恒 ≤1（.finally 重驱补位），3 项全部提交", async ({ request, userData }) => {
  const ff = makeFakeFfmpeg({ "BW1-001.mp4": 15, "BW1-002.mp4": 15, "BW1-003.mp4": 15 });
  const D = mkDir("bw1", ["BW1-001.mp4", "BW1-002.mp4", "BW1-003.mp4"], true);
  try {
    const { app, page } = await bootWithCcfg(userData, 8, ff.bin);
    try {
      await installTickSampler(page);
      await patchPick(app, D.items);
      await page.click("#pick-folder");
      await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 3");
      for (const n of ["BW1-001.mp4", "BW1-002.mp4", "BW1-003.mp4"]) await checkRow(page, "#folder-table", n);
      await page.selectOption("#engine-select", "mock");
      await page.selectOption("#extract-select", "local");
      await page.locator("#batch-extract-workers").fill("1");
      await page.click("#dispatch-go");
      await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
      const row = page.locator(".job-batch-row", { hasText: basename(D.dir) });
      await waitBatchDone(row);
      const ticks = await readTicks(page);
      // 真实走过本机提取（非 server 模式空转）：见过提取中
      expect(sawAny(ticks, "__all__"), `无提取中采样（ticks=${ticks.length}）`).toBe(true);
      // 闸：任一时刻该批提取中 ≤1
      expect(maxOf(ticks, "__all__"), JSON.stringify(ticks.filter((t) => t.total > 1))).toBeLessThanOrEqual(1);
      // 3 项全部提交并 finished
      await waitMockLabelsFinished(request, ["BW1-001.mp4", "BW1-002.mp4", "BW1-003.mp4"]);
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
    rmSync(D.dir, { recursive: true, force: true });
  }
});

test("双批 N1=N2=1：每批 ≤1、全局 ≤2，且存在两批同拍提取（N1+N2 并行度）", async ({ request, userData }) => {
  const ff = makeFakeFfmpeg({
    "BW2A-001.mp4": 15, "BW2A-002.mp4": 15, "BW2B-001.mp4": 15, "BW2B-002.mp4": 15,
  });
  const A = mkDir("bw2a", ["BW2A-001.mp4", "BW2A-002.mp4"], true);
  const B = mkDir("bw2b", ["BW2B-001.mp4", "BW2B-002.mp4"], true);
  try {
    const { app, page } = await bootWithCcfg(userData, 8, ff.bin);
    try {
      await installTickSampler(page);
      // 批 A（2 文件，N=1）
      await patchPick(app, A.items);
      await page.click("#pick-folder");
      await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 2");
      for (const n of ["BW2A-001.mp4", "BW2A-002.mp4"]) await checkRow(page, "#folder-table", n);
      await page.selectOption("#engine-select", "mock");
      await page.selectOption("#extract-select", "local");
      await page.locator("#batch-extract-workers").fill("1");
      await page.click("#dispatch-go");
      await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
      const rowA = page.locator(".job-batch-row", { hasText: basename(A.dir) });
      await expect(rowA).toHaveCount(1);
      // A 运行中 → 批 B（2 文件，N=1）并发建批（0.2.53 需求① 入口已放开）
      await goView(page, "dispatch");
      await patchPick(app, B.items);
      await page.click("#pick-folder");
      await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 2");
      for (const n of ["BW2B-001.mp4", "BW2B-002.mp4"]) await checkRow(page, "#folder-table", n);
      await page.locator("#batch-extract-workers").fill("1");
      await page.click("#dispatch-go");
      const rowB = page.locator(".job-batch-row", { hasText: basename(B.dir) });
      await expect(rowB).toHaveCount(1);
      await waitBatchDone(rowA);
      await waitBatchDone(rowB);
      const ticks = await readTicks(page);
      const bids = [...new Set(ticks.flatMap((t) => Object.keys(t.per)))].filter((k) => k !== "?");
      expect(bids.length, JSON.stringify(ticks.filter((t) => t.total > 0).slice(0, 5))).toBe(2);
      // 每批在途恒 ≤1；全局恒 ≤2（池上限 = 8 + 1 + 1，闸把各自圈在自己预算内）
      for (const bid of bids) {
        expect(maxOf(ticks, bid), `批 ${bid} 超预算`).toBeLessThanOrEqual(1);
        expect(sawAny(ticks, bid), `批 ${bid} 未见提取中`).toBe(true);
      }
      expect(maxOf(ticks, "__all__")).toBeLessThanOrEqual(2);
      // 并行度真实达到 N1+N2：存在两批同拍各 ≥1 提取中的 tick
      const overlap = ticks.some((t) => Object.values(t.per).filter((v) => v >= 1).length >= 2);
      expect(overlap, "无双批同拍提取（重叠窗未覆盖或闸误停单批）").toBe(true);
      await waitMockLabelsFinished(request, ["BW2A-001.mp4", "BW2A-002.mp4", "BW2B-001.mp4", "BW2B-002.mp4"]);
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
    rmSync(A.dir, { recursive: true, force: true });
    rmSync(B.dir, { recursive: true, force: true });
  }
});

// 页内直驱生产提取池（同 extract-disk-fair drivePool 打法）
type PoolEvent = { name: string; ev: "queue" | "start" | "done"; t: number };
async function drivePool(
  page: Page,
  specs: { name: string; path: string }[],
): Promise<{ log: PoolEvent[]; blobs: number }> {
  return await page.evaluate(async (specList) => {
    const w = window as unknown as {
      JavExtract?: { extractAudio: (f: File, o?: { onQueue?: () => void; onStart?: () => void }) => Promise<unknown> };
    };
    if (!w.JavExtract) throw new Error("window.JavExtract 未挂载（应为 desktop 形态）");
    const t0 = performance.now();
    const log: PoolEvent[] = [];
    let blobs = 0;
    await Promise.all(specList.map((sp) => new Promise<void>((resolve, reject) => {
      const f = new File([new Uint8Array(1024)], sp.name, { type: "video/mp4" });
      (f as unknown as { _localPath?: string })._localPath = sp.path;
      w.JavExtract!.extractAudio(f, {
        onQueue: () => log.push({ name: sp.name, ev: "queue", t: performance.now() - t0 }),
        onStart: () => log.push({ name: sp.name, ev: "start", t: performance.now() - t0 }),
      }).then((r) => {
        log.push({ name: sp.name, ev: "done", t: performance.now() - t0 });
        if (r && typeof r === "object" && "skipped" in (r as Record<string, unknown>)) {
          reject(new Error(`${sp.name} 被 skip（池未真实执行）`));
          return;
        }
        blobs += 1;
        resolve();
      }, (e: unknown) => {
        log.push({ name: sp.name, ev: "done", t: performance.now() - t0 });
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    })));
    return { log, blobs };
  }, specs);
}
const startOf = (log: PoolEvent[], name: string): number => {
  const e = log.find((x) => x.name === name && x.ev === "start");
  if (!e) throw new Error(`${name} 无 start 事件（log=${JSON.stringify(log)}）`);
  return e.t;
};
const doneOf = (log: PoolEvent[], name: string): number => {
  const e = log.find((x) => x.name === name && x.ev === "done");
  if (!e) throw new Error(`${name} 无 done 事件`);
  return e.t;
};

test("池回落：批 N=2 期上限=基线1+预算2（两项并行），批结束回落 1（直驱池串行）", async ({ request, userData }) => {
  const ff = makeFakeFfmpeg({
    "BW3-001.mp4": 6, "BW3-002.mp4": 6, "BW3D-001.mp4": 6, "BW3D-002.mp4": 6,
  });
  const D = mkDir("bw3", ["BW3-001.mp4", "BW3-002.mp4"], true);
  const dd = mkdtempSync(join(tmpdir(), "javscribe-bew3d-"));
  try {
    const { app, page } = await bootWithCcfg(userData, 1, ff.bin);
    try {
      await installTickSampler(page);
      await patchPick(app, D.items);
      await page.click("#pick-folder");
      await expect(page.locator("#folder-chip-text")).toHaveText("已选 0 / 2");
      for (const n of ["BW3-001.mp4", "BW3-002.mp4"]) await checkRow(page, "#folder-table", n);
      await page.selectOption("#engine-select", "mock");
      await page.selectOption("#extract-select", "local");
      await page.locator("#batch-extract-workers").fill("2");
      await page.click("#dispatch-go");
      await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
      const row = page.locator(".job-batch-row", { hasText: basename(D.dir) });
      await waitBatchDone(row);
      await waitMockLabelsFinished(request, ["BW3-001.mp4", "BW3-002.mp4"]);
      const ticks = await readTicks(page);
      // 批运行期上限 = 基线 1 + 预算 2 = 3 ≥ 2 → 两项并行（曾同拍 2 提取中）
      expect(maxOf(ticks, "__all__"), JSON.stringify(ticks.filter((t) => t.total > 0).slice(0, 8))).toBeGreaterThanOrEqual(2);
      // 批已注销预算：直驱生产池连发 2 个（各 1.2s）——上限回落 1 则第二个必须等第一个完成
      const direct = [
        { name: "BW3D-001.mp4", path: join(dd, "BW3D-001.mp4") },
        { name: "BW3D-002.mp4", path: join(dd, "BW3D-002.mp4") },
      ];
      for (const sp of direct) copyFileSync(join(FIXTURES, "video-a.mp4"), sp.path);
      const { log, blobs } = await drivePool(page, direct);
      expect(blobs).toBe(2);
      const s1 = startOf(log, "BW3D-001.mp4"), d1 = doneOf(log, "BW3D-001.mp4");
      const s2 = startOf(log, "BW3D-002.mp4");
      // 串行口径：第二个 start 与第一个 done 同拍（±50ms 事件记录偏差容差）；
      // 预算泄漏 → 上限≥3 → 两者同拍 start（s2-s1≈0）→ 红
      expect(s2 - s1, JSON.stringify(log)).toBeGreaterThanOrEqual(1000 * 0.9);
      expect(s2, JSON.stringify(log)).toBeGreaterThanOrEqual(d1 - 50);
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
    rmSync(D.dir, { recursive: true, force: true });
    rmSync(dd, { recursive: true, force: true });
  }
});
