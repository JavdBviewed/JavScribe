// 任务表「换服务重跑」全阶段（cancel-first）e2e（10-19-javscribe-0247-scan-reconcile-job-search，需求2）
// 0.2.47：重跑行从终态放宽到 排队/运行/暂停——先取消原任务（排队中立即终止；运行中检查点中止，
// 已生成字幕保留；404/409 视同取消成功），再复用本地音轨缓存向所选服务重新提交（防双活）。
// 双在线引擎：mock 8302（playwright.desktop.config webServer）+ second 8305（本 spec 自起）。
// 造数口径：非 batch 上传=创建即 running（放慢 tick 保「运行中」）；batch 上传=文件 pending
// 起步（tick 冻结保「排队中」→ /jobs/<id>/pause 造「已暂停」）。
import { test, expect, DIST, MOCK, MOCK_KEY, FIXTURES, goView, mockReset, mockSpeed, mockPause, mockResume, mockSeed } from "./helpers";
import { _electron as electron } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const SECOND_PORT = 8305;
const SECOND = `http://127.0.0.1:${SECOND_PORT}`;
const ENGINES = `mock=${MOCK},second=${SECOND}`;
const OGG_HEAD = "4f676753"; // OggS

let secondMock: ChildProcess | null = null;

test.beforeAll(async () => {
  secondMock = spawn(
    process.execPath,
    [join(ROOT, "client", "tests", "e2e", "mock-serve.mjs"), String(SECOND_PORT)],
    { stdio: "ignore" },
  );
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${SECOND}/health`);
      if (r.ok) break;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 15_000) throw new Error("第二 mock serve 未就绪");
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(() => {
  secondMock?.kill();
});

function freshUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), "javscribe-rerunph-"));
  writeFileSync(
    join(dir, "engines.json"),
    JSON.stringify({
      engines: [
        { name: "mock", url: MOCK, api_key: MOCK_KEY },
        { name: "second", url: SECOND, api_key: MOCK_KEY },
      ],
    }, null, 1),
    "utf-8",
  );
  return dir;
}

async function launch(userData: string) {
  const app = await electron.launch({
    args: [DIST, "--no-sandbox"],
    env: {
      ...process.env,
      JAVSCRIBE_CLIENT_USERDATA: userData,
      JAVSCRIBE_ENGINES: ENGINES,
      JAVSCRIBE_CLIENT_FRAMELESS: "1",
      BROWSER: "/bin/true", // 外链交 /bin/true 秒退（防 mime-helper 孤儿持 stdio）
    },
  });
  const page = await app.firstWindow();
  await page.getByText(/服务 2\/2 在线/).first().waitFor({ timeout: 25_000 });
  return { app, page };
}

/** UI 单文件派发（显式 mock 引擎），到「提交生成 ✓」为止（提交即自动跳任务看板，回派发页断管线终态） */
async function dispatchFile(page: any, filePath: string) {
  await page.setInputFiles("#file", filePath);
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator("#sec-jobs")).toHaveClass(/view-on/);
  await goView(page, "dispatch");
  await expect(page.locator("#step-dispatch.done")).toBeVisible();
  await expect(page.locator("#meta-dispatch", { hasText: /^任务 [\w-]+$/ })).toBeVisible();
  await expect(page.locator("#dispatch-status")).toHaveClass(/ok/);
}

async function mockUploads(request: any, base: string): Promise<Array<{ source: string; size: number; head: string }>> {
  return (await (await request.get(`${base}/_mock/uploads`)).json());
}

/** 双 mock 复位（共享 8302 webServer：自起 app 的 test 必须清掉前序 test 的 job/upload 残留；reset 同时还原 speed） */
async function resetMocks(request: any) {
  await mockReset(request);
  const r = await request.post(`${SECOND}/_mock/reset`, { data: "{}", headers: { "Content-Type": "application/json" } });
  if (!r.ok()) throw new Error(`second mock reset -> ${r.status()}`);
}

/** batch 直传造排队中主任务 job（mock：query 带 batch_id → 文件 pending 起步） */
async function seedBatchJob(source: string, batchId: string): Promise<string> {
  const r = await fetch(
    `${MOCK}/upload?batch_id=${encodeURIComponent(batchId)}&batch_label=${encodeURIComponent("e2e 主任务")}&ext=opus`,
    {
      method: "PUT",
      headers: { "X-Source-Name": source, "x-api-key": MOCK_KEY, "Content-Type": "application/octet-stream" },
      body: Buffer.from("e2e-batch-pending-opus"),
    },
  );
  if (!r.ok) throw new Error(`mock batch upload -> ${r.status}`);
  return ((await r.json()) as { job_id: string }).job_id;
}

/** 轮询 mock /jobs?detail=1 到指定 job 全文件终态且 job 收口（协作式取消收口断言） */
async function waitForMockJobTerminal(request: any, base: string, jobId: string, want: string, timeoutMs = 30_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const jobs = (await (await request.get(`${base}/jobs?detail=1`)).json()) as any[];
    const j = jobs.find((x) => x.id === jobId);
    if (j && Array.isArray(j.files) && j.files.length && j.files.every((f: any) => f.status === want) && j.finished != null) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} 未收口到全 ${want}（last=${JSON.stringify(j)}）`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** 写回登记 rekey 迁移捕获（toast 后立即调，抢在新任务完成自动写回清键之前）：
 * 轮询快照到 新键（second|新 job，排除 pre 占位）出现且同一快照内旧键已消失（rekey 原子：同 tick set+delete）。
 * 返回捕获到的新键，供与 second 行 data-jid 交叉核对。 */
async function catchRekeyTransition(page: any, oldKey: string): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const keys: string[] = await page.evaluate(() => {
      const s = (window as unknown as { state?: { writeBackJobs?: Map<string, unknown> } }).state;
      return s?.writeBackJobs ? [...s.writeBackJobs.keys()] : [];
    });
    const hit = keys.find((k) => k.startsWith("second|") && !k.includes("|pre|"));
    if (hit && !keys.includes(oldKey)) return hit;
    if (Date.now() - t0 > 15_000) throw new Error(`rekey 迁移未捕获（oldKey=${oldKey}，last=${JSON.stringify(keys)}）`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("运行中行重跑：cancel-first（检查点中止）→ 重交第二服务，旧任务收口且无双活", async ({ request }) => {
  const dir = freshUserData();
  await resetMocks(request);
  const { app, page } = await launch(dir);
  try {
    // 放慢 mock：2%/500ms → 约 25s 才完成：旧任务在重跑流程期间恒「运行中」，
    // 换服务后的新任务也落在 60s 断言窗内（reset 会还原 speed）
    await mockSpeed(request, { step: 0.02, tickMs: 500 });
    await dispatchFile(page, join(FIXTURES, "video-a.mp4"));

    await goView(page, "jobs");
    const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: /^video-a\.mp4$/ }) })
      .filter({ has: page.locator(".job-cell", { hasText: "mock" }) });
    await expect(row.locator(".pill.p-running")).toBeVisible({ timeout: 20_000 });
    const rerunBtn = row.locator(".rerun");
    await expect(rerunBtn).toBeVisible();
    const oldJid = (await rerunBtn.getAttribute("data-jid")) || "";
    expect(oldJid).toBeTruthy();
    expect(await rerunBtn.getAttribute("data-status")).toBe("running");

    await rerunBtn.click();
    await expect(page.locator("#modal-title")).toHaveText("换服务重跑 · video-a.mp4");
    await expect(page.locator("#modal-body .set-note.err", { hasText: "该任务当前「运行中」" })).toBeVisible();
    await expect(page.locator("#modal-body .set-note", { hasText: "音轨缓存命中" })).toBeVisible();

    await page.locator('input[name="rerun-engine"][value="second"]').check();
    await page.click("#rerun-go");
    await expect(page.locator("#toasts .toast.ok", { hasText: "换服务重跑" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#toasts .toast.ok", { hasText: "已取消" })).toBeVisible();
    await expect(page.locator("#modal-backdrop")).toBeHidden();

    // 写回登记 rekey 迁移：toast 同 tick 完成，立刻捕获（新任务 ~4s 完成后自动写回会清键）
    const newKey = await catchRekeyTransition(page, "mock|" + oldJid);

    // 旧任务协作收口：mock 下一 tick 把非终态文件全收口为 canceled
    await waitForMockJobTerminal(request, MOCK, oldJid, "canceled");
    // second 收到缓存 opus（源名保留）；mock 仍只有首派 1 次上传（旧任务未再传字节=无双活）
    const up2 = await mockUploads(request, SECOND);
    expect(up2).toHaveLength(1);
    expect(up2[0].head).toBe(OGG_HEAD);
    expect(up2[0].source).toBe("video-a.mp4");
    expect(await mockUploads(request, MOCK)).toHaveLength(1);

    // 新服务任务行跑到完成
    const secondRow = page.locator(".job-row", { has: page.locator(".fn", { hasText: /^video-a\.mp4$/ }) })
      .filter({ has: page.locator(".job-cell", { hasText: "second" }) });
    await expect(secondRow.locator(".pill.p-done")).toBeVisible({ timeout: 60_000 });
    // 交叉核对：捕获到的新键 = second|新任务 id
    expect(newKey).toBe("second|" + ((await secondRow.locator(".rerun").getAttribute("data-jid")) || ""));
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("已暂停行重跑：cancel-first（排队立即终止）→ 重交第二服务", async ({ request }) => {
  const dir = freshUserData();
  await resetMocks(request);
  const { app, page } = await launch(dir);
  try {
    // 1) 派发 video-b 一次：建本地音轨缓存（跑到完成保缓存收口）
    await dispatchFile(page, join(FIXTURES, "video-b.mkv"));
    await goView(page, "jobs");
    const firstRow = page.locator(".job-row", { has: page.locator(".fn", { hasText: /^video-b\.mkv$/ }) })
      .filter({ has: page.locator(".job-cell", { hasText: "mock" }) });
    await expect(firstRow.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });

    // 2) 冻结 mock tick（防 batch pending 被晋升为 running 抢跑 pause 409），再 batch 直传造排队中 job
    await mockPause(request);
    const jobC = await seedBatchJob("video-b.mkv", "e2e-b1");
    const pendingRow = page.locator(".job-row", { has: page.locator(".fn", { hasText: /^video-b\.mkv$/ }) })
      .filter({ has: page.locator(".pill.p-pending") });
    await expect(pendingRow.locator(".rerun")).toBeVisible({ timeout: 20_000 });
    expect(await pendingRow.locator(".rerun").getAttribute("data-status")).toBe("pending");

    // 3) 单任务挂起（全 pending → 200 paused）→ 行转「已暂停」
    const pr = await fetch(`${MOCK}/jobs/${jobC}/pause`, {
      method: "POST",
      headers: { "x-api-key": MOCK_KEY, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!pr.ok) throw new Error(`pause -> ${pr.status}`);
    const pausedRow = page.locator(".job-row", { has: page.locator(".fn", { hasText: /^video-b\.mkv$/ }) })
      .filter({ has: page.locator(".pill.p-paused") });
    await expect(pausedRow.locator(".rerun")).toBeVisible({ timeout: 20_000 });
    expect(await pausedRow.locator(".rerun").getAttribute("data-status")).toBe("paused");
    await mockResume(request); // 解冻（job 已挂起，tick 自身会跳过）

    // 4) 重跑：已暂停行 → cancel-first 提示 + 缓存命中 → 提交到 second
    await pausedRow.locator(".rerun").click();
    await expect(page.locator("#modal-title")).toHaveText("换服务重跑 · video-b.mkv");
    await expect(page.locator("#modal-body .set-note.err", { hasText: "该任务当前「已暂停」" })).toBeVisible();
    await expect(page.locator("#modal-body .set-note", { hasText: "音轨缓存命中" })).toBeVisible();
    await page.locator('input[name="rerun-engine"][value="second"]').check();
    await page.click("#rerun-go");
    await expect(page.locator("#toasts .toast.ok", { hasText: "换服务重跑" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#toasts .toast.ok", { hasText: "已取消" })).toBeVisible();

    // 写回登记 rekey 迁移：toast 同 tick 完成，立刻捕获
    const newKey = await catchRekeyTransition(page, "mock|" + jobC);

    // 5) 旧任务立即收口（全 pending → canceled，不走 tick）；second 收 opus、新任务完成
    await waitForMockJobTerminal(request, MOCK, jobC, "canceled", 15_000);
    const up2 = await mockUploads(request, SECOND);
    expect(up2).toHaveLength(1);
    expect(up2[0].head).toBe(OGG_HEAD);
    expect(up2[0].source).toBe("video-b.mkv");
    const secondRow = page.locator(".job-row", { has: page.locator(".fn", { hasText: /^video-b\.mkv$/ }) })
      .filter({ has: page.locator(".job-cell", { hasText: "second" }) });
    await expect(secondRow.locator(".pill.p-done")).toBeVisible({ timeout: 60_000 });
    expect(newKey).toBe("second|" + ((await secondRow.locator(".rerun").getAttribute("data-jid")) || ""));
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("无缓存重跑：本地无音轨缓存且源视频不在本机 → modal 说明原因、不给提交按钮", async ({ request }) => {
  const dir = freshUserData();
  await resetMocks(request);
  // 先播 1 条 pending watch 任务（seed-001.mp4）：本机无缓存、源路径 /media/jav 不在本机
  await mockSeed(request, { n: 1, pending: 1 });
  const { app, page } = await launch(dir);
  try {
    await goView(page, "jobs");
    const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: /^seed-001\.mp4$/ }) });
    await expect(row.locator(".pill.p-pending")).toBeVisible({ timeout: 20_000 });
    await row.locator(".rerun").click();
    await expect(page.locator("#modal-title")).toHaveText("换服务重跑 · seed-001.mp4");
    await expect(page.locator("#modal-body .set-note.err", { hasText: "本地没有该影片的音轨缓存" })).toBeVisible();
    await expect(page.locator("#modal-body .set-note.err", { hasText: "源视频也不在本机" })).toBeVisible();
    await expect(page.locator("#rerun-go")).toHaveCount(0);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
