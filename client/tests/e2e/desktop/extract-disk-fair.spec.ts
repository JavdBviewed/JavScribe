// 桌面端本机提取池「按盘公平准入」e2e（0.2.52 M2：createPool groupKey）
// 打法：经 window.JavExtract.extractAudio 直接驱动生产提取池（File 打 _localPath 标签
//   → IPC → main 进程假 ffmpeg），enqueue 顺序与时长完全受控——断言准入顺序：
//   1) 两盘（/tmp、/home 两个顶层目录 = 两个盘）：双空槽释放时各盘各 1 个（保底），
//      单盘不独占双槽（FIFO 旧码会让先入队的同盘 2 个占满 → 红）
//   2) 单盘：同组行为 = 原 FIFO（同组不限并发、顺序不变 → 回归守卫）
// 不走扫描/派发 UI 的原因：state.busy 在批次 pump 全周期门控所有派发入口，
//   两顶层目录无法组成一个批次重叠入池；派发 UI 链的回归由 dispatch-rows /
//   scan-auto-balance 既有 spec 承担（本 spec 测的是同一生产池 + groupKey 接线）。
import { test, expect, FIXTURES, launchApp, waitForReady } from "./helpers";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

type PoolEvent = { name: string; ev: "queue" | "start" | "done"; t: number };

/**
 * 假 ffmpeg（时长版，dispatch-rows 同款的 argv 口径）：
 *   argv = -hide_banner -i <src> ... -y <out>（$3=src、末位=out，runExtract spawn 布局）；
 *   按 basename 的帧数 n 定时长 = n × 0.2s；stderr 每帧一行 time=（尾随空格，
 *   runExtract /time=(\d+):(\d+):(\d+(?:\.\d+)?)\s/ 口径）+ 首行 Duration。
 */
function makeFakeFfmpeg(frames: Record<string, number>): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-e2e-fairff-"));
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

/** 页内驱动生产提取池：按序 enqueue（同步连发 = 确定入队序），采集 queue/start/done 时刻 */
async function drivePool(
  page: import("@playwright/test").Page,
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
const queued = (log: PoolEvent[], name: string): boolean =>
  log.some((x) => x.name === name && x.ev === "queue");
/** 滑窗并发上界：任意 windowMs 内的 start 事件数（任务真实时长 ≫ window）。
 *  不用 start/done 事件重放：池内部 active 恒 ≤ limit（finally 先减槽再 tryWake），
 *  但事件流里 done(N) 可能晚于 start(N+1) 一个微任务（重放会虚高 1）。
 *  泄漏第 3 槽 ⇒ 同波次 ≥3 个 start 挤在毫秒级 ⇒ 滑窗可判红。 */
function maxConcurrent(log: PoolEvent[], windowMs = 100): number {
  const starts = log.filter((x) => x.ev === "start").map((x) => x.t).sort((a, b) => a - b);
  let mx = 0, lo = 0;
  for (let hi = 0; hi < starts.length; hi++) {
    while (starts[hi] - starts[lo] >= windowMs) lo++;
    mx = Math.max(mx, hi - lo + 1);
  }
  return mx;
}

/** 在指定目录落一份视频夹具（main 侧 statSync 要求文件真实存在） */
function stageFile(dir: string, name: string): { name: string; path: string } {
  const p = join(dir, name);
  copyFileSync(join(FIXTURES, "video-a.mp4"), p);
  return { name, path: p };
}

test("两盘公平：双空槽各盘各 1 个保底，单盘不独占双槽", async ({ userData }) => {
  const ff = makeFakeFfmpeg({ "A-fast.mp4": 6, "A-slow1.mp4": 15, "A-slow2.mp4": 15, "B-fast.mp4": 6, "B-slow.mp4": 15 });
  const dirA = mkdtempSync(join(tmpdir(), "jsm2-fair-a-"));     // 盘 A = /tmp
  const dirB = mkdtempSync(join(homedir(), "jsm2-fair-b-"));    // 盘 B = /home
  try {
    const files = [
      stageFile(dirA, "A-fast.mp4"), stageFile(dirB, "B-fast.mp4"),
      stageFile(dirA, "A-slow1.mp4"), stageFile(dirA, "A-slow2.mp4"), stageFile(dirB, "B-slow.mp4"),
    ];
    writeFileSync(join(userData, "client-config.json"), JSON.stringify({ extract_workers: 2 }), "utf-8");
    const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ff.bin });
    try {
      const page = await app.firstWindow();
      await waitForReady(page);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { state?: { ccfg?: { extract_workers?: number } } }).state?.ccfg?.extract_workers), { timeout: 20_000 })
        .toBe(2);
      const { log, blobs } = await drivePool(page, files);
      // 5 个文件全部真实提取完成（Blob，无 skip）
      expect(blobs).toBe(5);
      // 首波：两盘各 1 个直通（limit=2，无排队事件）
      expect(startOf(log, "A-fast.mp4")).toBeLessThan(300);
      expect(startOf(log, "B-fast.mp4")).toBeLessThan(300);
      expect(queued(log, "A-fast.mp4")).toBe(false);
      expect(queued(log, "B-fast.mp4")).toBe(false);
      // 二波（≈1.2s，fast 双双完成、两槽同拍释放）：
      //   公平准入 = A-slow1（A 盘在跑归零）+ B-slow（B 盘在跑归零）各保底 1 个
      //   FIFO 旧码 = A-slow1 + A-slow2（单盘占双槽，B-slow 饿到 ≈4.2s）→ 下面两条断言红
      expect(startOf(log, "A-slow1.mp4")).toBeGreaterThan(900);
      expect(startOf(log, "A-slow1.mp4")).toBeLessThan(2000);
      // B-slow 不是首波直通（当时池满，必须入队）
      expect(startOf(log, "B-slow.mp4")).toBeGreaterThan(900);
      expect(startOf(log, "B-slow.mp4")).toBeLessThan(2000);
      // 三波：A-slow2 只能等 3s 波次跑完（≈4.2s）——FIFO 旧码 ≈1.2s 就开跑（单盘占双槽）
      expect(startOf(log, "A-slow2.mp4")).toBeGreaterThan(3500);
      // 全程并发 ≤ limit=2；三个慢文件都真实排过队
      expect(maxConcurrent(log)).toBeLessThanOrEqual(2);
      for (const n of ["A-slow1.mp4", "A-slow2.mp4", "B-slow.mp4"]) expect(queued(log, n)).toBe(true);
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("单盘回归：同组 = 原 FIFO（同组不限并发、入队顺序不变）", async ({ userData }) => {
  const ff = makeFakeFfmpeg({ "S-fast1.mp4": 6, "S-fast2.mp4": 6, "S-slow1.mp4": 15, "S-slow2.mp4": 15 });
  const dir = mkdtempSync(join(tmpdir(), "jsm2-fair-solo-"));
  try {
    const files = ["S-fast1.mp4", "S-fast2.mp4", "S-slow1.mp4", "S-slow2.mp4"].map((n) => stageFile(dir, n));
    writeFileSync(join(userData, "client-config.json"), JSON.stringify({ extract_workers: 2 }), "utf-8");
    const app = await launchApp(userData, { JAVSCRIBE_FFMPEG: ff.bin });
    try {
      const page = await app.firstWindow();
      await waitForReady(page);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { state?: { ccfg?: { extract_workers?: number } } }).state?.ccfg?.extract_workers), { timeout: 20_000 })
        .toBe(2);
      const { log, blobs } = await drivePool(page, files);
      // 4 个文件全部真实提取完成
      expect(blobs).toBe(4);
      // 首波 2 个直通（同组不限并发）
      expect(startOf(log, "S-fast1.mp4")).toBeLessThan(300);
      expect(startOf(log, "S-fast2.mp4")).toBeLessThan(300);
      expect(queued(log, "S-fast1.mp4")).toBe(false);
      expect(queued(log, "S-fast2.mp4")).toBe(false);
      // 慢文件等槽到 fast 完成（≈1.2s）才开跑，且保持入队顺序（FIFO，同组不重排、不延迟）
      for (const n of ["S-slow1.mp4", "S-slow2.mp4"]) {
        expect(startOf(log, n)).toBeGreaterThan(900);
        expect(startOf(log, n)).toBeLessThan(2000);
        expect(queued(log, n)).toBe(true);
      }
      expect(startOf(log, "S-slow1.mp4")).toBeLessThanOrEqual(startOf(log, "S-slow2.mp4"));
      expect(maxConcurrent(log)).toBeLessThanOrEqual(2);
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    rmSync(ff.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
