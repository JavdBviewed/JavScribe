// 主任务（batch）管线 e2e：扫描 → 主任务行+子任务；运行中暂停（在跑跑完/排队冻结）→ 继续；
// 单文件上传无主任务壳；双 serve 一次 batch 跨 2 服务，暂停 fan-out 两台都冻结、继续都恢复。
// 对应 PRD 验收 a/b/c/d（serve 重启持久化=e 由单测覆盖；旧客户端兼容=f 由 ③b 回归覆盖）。
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  waitForEngineOnline, waitForEngineKey, mockReset, mockSpeed, cleanEngines, addEngine,
  MOCK_KEY, FIXTURES, waitForJobsEmpty, waitForJobRow, waitForEngineListed, resetPipelinePause, goTab,
} from "../helpers";
import path from "node:path";
import os from "node:os";
import { mkdirSync, copyFileSync, rmSync, readFileSync } from "node:fs";

const fx = (n: string) => path.join(FIXTURES, n);
// 第二台 mock serve（playwright webServer 与 8301 同批自启；本套件用它做双服务 fan-out）
const M2 = "http://127.0.0.1:8302";

let req: APIRequestContext;

/** 8302 控制口（helpers 的 mockControl 固定打 8301，此处局部同构） */
async function m2ctl(p: string, body?: unknown) {
  const r = await req.post(`${M2}/_mock/${p}`, {
    data: body === undefined ? "{}" : body,
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok()) throw new Error(`m2 control ${p} -> ${r.status()}`);
  return r.json();
}

/** N 个无字幕视频目录（无字幕 → 提交不弹 confirm）；目录名即主任务标签断言值 */
function makeBatchScanDir(name: string, n: number): string {
  const dir = path.join(os.tmpdir(), name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) {
    copyFileSync(fx("video-a.mp4"), path.join(dir, `B-${String(i).padStart(3, "0")}.mp4`));
  }
  return dir;
}

/** 轮询等指定文案 toast（8s 内多条 toast 共存，按文案匹配避免误中旧 toast） */
async function expectToast(page: Page, needle: string, timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const texts = await page.locator("#toasts .toast").allTextContents();
    if (texts.some((t) => t.includes(needle))) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`toast 未出现: ${needle}（当前: ${texts.join(" | ") || "无"}）`);
    await new Promise((rs) => setTimeout(rs, 100));
  }
}

/** 引擎在 poller 快照里在线（fan-out 只打在线服务；store 入列后 poller 1s tick 才见） */
async function engineOnlineApi(name: string, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const list: Array<{ name: string; online: boolean }> =
      await (await req.get("/api/engines")).json();
    if (list.some((e) => e.name === name && e.online === true)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`${name} 未在超时内上线（poller 快照）`);
    await new Promise((rs) => setTimeout(rs, 200));
  }
}

/** serve /health 的 batch_paused 集合断言（fan-out 双端冻结/恢复的直接证据） */
async function expectBatchPausedApi(url: string, bid: string, want: boolean, timeoutMs = 20_000) {
  const t0 = Date.now();
  for (;;) {
    const h: { batch_paused: string[] } = await (await req.get(`${url}/health`)).json();
    if ((h.batch_paused.includes(bid) ? true : false) === want) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`${url} batch_paused=${JSON.stringify(h.batch_paused)}（期望 ${want} ${bid}）`);
    }
    await new Promise((rs) => setTimeout(rs, 200));
  }
}

test.beforeEach(async ({ page, request }) => {
  req = request;
  await mockReset(request);
  await m2ctl("reset");
  await resetPipelinePause(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  // 8s/任务：保证页面 5s 轮询能观察到 running→done 迁移
  await mockSpeed(request, { step: 0.0125, tickMs: 100 });
  await m2ctl("speed", { step: 0.0125, tickMs: 100 });
  await page.goto("/");
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
});
// pipeline_paused 持久化在共享 web 数据目录：用例中途失败也要复位，防拖死后续本机管线用例
test.afterEach(async () => {
  await resetPipelinePause(req);
  // 扫描规则 minsize 在共享 client_config.json（跨套件持久）：统一还原默认 200
  await req.put("/api/client-config", { data: { scan_min_size_mb: 200 } }).catch(() => {});
});

test("a) 扫 5 视频 → 1 主任务（5 子任务）→ 全完成 → 主任务完成+总耗时", async ({ page }) => {
  const dir = makeBatchScanDir("javweb-batch-scan-a", 5);
  // 「忽略小于」默认 200MB 会把夹具小文件判成过小未选 → 服务端即时置 0（afterEach 还原 200）
  await req.put("/api/client-config", { data: { scan_min_size_mb: 0 } });
  page.on("dialog", (d) => d.accept());
  await page.locator("#scan-path").fill(dir);
  await page.click("#scan-go");
  await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".scan-name")).toHaveCount(5);
  await page.locator("#scan-select-all").check();
  const toast = page.locator("#toasts .toast.ok", { hasText: "已入队" }).last();
  await Promise.all([toast.waitFor({ state: "visible" }), page.click("#scan-submit")]);
  expect(await toast.textContent()).toContain("已入队 5 项");
  // 主任务行：标签=扫描目录名、子任务数
  const batchRow = page.locator(".job-batch-row").first();
  await expect(batchRow).toBeVisible({ timeout: 20_000 });
  await expect(batchRow.locator(".fn")).toHaveText("javweb-batch-scan-a");
  await expect(batchRow.locator(".batch-sub-n")).toHaveText("5 子任务");
  // 5 条子任务行陆续出现（本机管线 queued/提取/派发 → 服务行；提取并发 2）
  for (let i = 1; i <= 5; i++) {
    const fn = `B-${String(i).padStart(3, "0")}.mp4`;
    await expect(page.locator(".job-row .fn", { hasText: fn })).toBeVisible({ timeout: 60_000 });
  }
  // 全部子任务完成（mock 8s/任务；最慢一条也要等前序提取+派发）
  for (let i = 1; i <= 5; i++) {
    const fn = `B-${String(i).padStart(3, "0")}.mp4`;
    await waitForJobRow(req, (r) => r.file === fn && r.status === "done" && !!r.batch_id, 90_000);
  }
  // 主任务行：完成 + 总耗时（非 —）
  await expect(batchRow.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
  await expect(batchRow.locator(".cell-elapsed")).not.toHaveText("—", { timeout: 30_000 });
  rmSync(dir, { recursive: true, force: true });
});

test("b) 运行中暂停主任务：在跑跑完、其余停在排队；继续后恢复开跑", async ({ page }) => {
  const dir = makeBatchScanDir("javweb-batch-scan-b", 5);
  // 服务端即时置 0（afterEach 还原 200）
  await req.put("/api/client-config", { data: { scan_min_size_mb: 0 } });
  page.on("dialog", (d) => d.accept());
  await page.locator("#scan-path").fill(dir);
  await page.click("#scan-go");
  await expect(page.locator("#scan-table table")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".scan-name")).toHaveCount(5);
  await page.locator("#scan-select-all").check();
  const toast = page.locator("#toasts .toast.ok", { hasText: "已入队" }).last();
  await Promise.all([toast.waitFor({ state: "visible" }), page.click("#scan-submit")]);
  expect(await toast.textContent()).toContain("已入队 5 项");
  const batchRow = page.locator(".job-batch-row").first();
  await expect(batchRow).toBeVisible({ timeout: 20_000 });
  // 首个子任务进入服务侧 running（此时暂停：它=在跑，须跑完不被打断）
  const first = await waitForJobRow(
    req, (r) => r.file === "B-001.mp4" && !!r.job_id && r.status === "running", 60_000,
  );
  const bid: string = first.batch_id;
  expect(bid).toBeTruthy();
  // 主任务行「暂停」→ 本机闸+服务冻结
  await batchRow.locator(".batch-op[data-bact='pause']").click();
  await expectToast(page, "主任务暂停完成");
  // 主任务行 → 已暂停 + 「继续」按钮（行级 batch_paused 聚合）
  await expect(batchRow.locator(".pill.p-paused")).toBeVisible({ timeout: 20_000 });
  await expect(batchRow.locator(".batch-op[data-bact='resume']")).toBeVisible({ timeout: 20_000 });
  // 在跑子任务跑完（不被中断）
  await waitForJobRow(req, (r) => r.file === "B-001.mp4" && r.status === "done", 60_000);
  // 冻结证据（双形态等价）：① 本机闸冻结（无 job_id，phase=queued，batch_paused）② 服务侧 pending
  // （有 job_id，status=pending，晋升已被 batch 暂停阻断）。提取快的 5 文件场景暂停时多数已派发 → ② 为主。
  const t0 = Date.now();
  let frozen: any[] = [];
  for (;;) {
    const rows: any[] = await (await req.get("/api/jobs")).json();
    frozen = rows.filter(
      (r) => r.batch_id === bid &&
        ((!!r.job_id && r.status === "pending") || (!r.job_id && r.phase === "queued" && r.batch_paused === true)),
    );
    const busy = rows.filter(
      (r) => r.batch_id === bid &&
        ((r.status === "running" && !(r.phase === "queued" && r.batch_paused === true)) ||
          r.phase === "extracting" || r.phase === "dispatching"),
    );
    if (frozen.length >= 1 && busy.length === 0) break;
    if (Date.now() - t0 > 45_000) {
      throw new Error(`冻结证据未达成: frozen=${frozen.length} busy=${busy.length}`);
    }
    await new Promise((rs) => setTimeout(rs, 500));
  }
  expect(frozen.length).toBeGreaterThanOrEqual(1);
  // 继续 → 解除冻结恢复开跑
  await batchRow.locator(".batch-op[data-bact='resume']").click();
  await expectToast(page, "主任务继续完成");
  // 全部 5 条子任务完成
  for (let i = 1; i <= 5; i++) {
    const fn = `B-${String(i).padStart(3, "0")}.mp4`;
    await waitForJobRow(req, (r) => r.file === fn && r.status === "done", 120_000);
  }
  await expect(batchRow.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
  rmSync(dir, { recursive: true, force: true });
});

test("c) 单文件上传：任务区仍为单任务行，无主任务壳", async ({ page }) => {
  // 整片上传回退路径（服务端提取）：单文件不套 batch（startSingle 不生成 batch）
  await page.selectOption("#extract-select", "server");
  await page.setInputFiles("#file", fx("video-a.mp4"));
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator("#toasts .toast.ok", { hasText: "已提交到" })).toBeVisible({ timeout: 90_000 });
  await goTab(page, "jobs");
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) });
  await expect(row).toBeVisible({ timeout: 20_000 });
  // 本次上传无主任务壳（行级断言：同 run 前序用例残留的 stale 主行是本机 batch 记录持久化的展示口径，
  // 与本用例无关；API 侧行 batch_id=null 同样核对）
  const cBatchRow = page.locator(".job-batch-row", { hasText: "video-a.mp4" });
  await expect(cBatchRow).toHaveCount(0);
  const r = await waitForJobRow(
    req, (x) => (x.file === "video-a.mp4" || x.label === "video-a.mp4") && !!x.job_id, 60_000,
  );
  expect(r.batch_id ?? null).toBe(null);
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 60_000 });
});

test("d) 双 serve：一 batch 跨 2 服务，暂停→两台都冻结，继续→都恢复（在跑跑完）", async ({ page }) => {
  // 第二台 serve（8302）入引擎表并等 poller 见在线（fan-out 只打在线服务）
  await addEngine(req, { name: "mock2", url: M2, api_key: MOCK_KEY });
  await waitForEngineListed(req, "mock2");
  await engineOnlineApi("mock2");
  const bid = `b-e2e-dual-${Date.now().toString(36)}`;
  const audio = readFileSync(fx("sine.opus"));
  /** 显式指定引擎上传 opus 并等派发完成（拿 job_id）；同内容同引擎第 2 次起走缓存命中路径（batch 透传回归点） */
  const postAudio = async (engine: string, name: string) => {
    const r = await req.post("/api/upload-audio", {
      multipart: {
        audio: { name: "sine.opus", mimeType: "audio/ogg", buffer: audio },
        engine,
        name,
        size_mb: "0",
        batch_id: bid,
        batch_label: "e2e-dual",
      },
    });
    expect(r.status()).toBe(202);
    const d = (await r.json()) as { upload_id: string };
    const t0 = Date.now();
    for (;;) {
      const u = (await (await req.get(`/api/uploads/${d.upload_id}`)).json()) as any;
      if (u.phase === "done" && u.job_id) return u as { job_id: string; cached: boolean };
      if (u.phase === "error") throw new Error(`upload 失败: ${u.error}`);
      if (Date.now() - t0 > 30_000) throw new Error("upload 派发超时");
      await new Promise((rs) => setTimeout(rs, 200));
    }
  };
  // 两发跨双服务（同 batch_id；确定性优于 auto 分发时序——auto 均衡本身由 functional 套件覆盖）
  const a = await postAudio("mock", "dual-a.mp4");
  const b = await postAudio("mock2", "dual-b.mp4");
  expect(a.job_id).toBeTruthy();
  expect(b.job_id).toBeTruthy();
  // 两行同 batch、分属两服务，双双进入 running。
  // 注：mock/mock2 reset 后 job_id 序列命名空间撞车（同日同 seq，仅 engine 不同），
  // 本套件所有行匹配一律 (engine, job_id) 双限定
  const ra = await waitForJobRow(req, (x) => x.engine === "mock" && x.job_id === a.job_id && x.status === "running", 30_000);
  const rb = await waitForJobRow(req, (x) => x.engine === "mock2" && x.job_id === b.job_id && x.status === "running", 30_000);
  expect(ra.batch_id).toBe(bid);
  expect(rb.batch_id).toBe(bid);
  expect(ra.engine).toBe("mock");
  expect(rb.engine).toBe("mock2");
  // 暂停主任务：web fan-out 两台 + 本机闸
  const pr = await (await req.post(`/api/batch/${bid}/pause`)).json() as any;
  expect(pr.ok).toBe(true);
  const engines = (pr.engines || []) as Array<{ engine: string; ok: boolean }>;
  expect(engines.filter((e) => e.ok).length).toBe(2); // mock + mock2 均成功
  // 两台 /health 都记该 batch 暂停（fan-out 冻结核心断言）
  await Promise.all([
    expectBatchPausedApi("http://127.0.0.1:8301", bid, true),
    expectBatchPausedApi(M2, bid, true),
  ]);
  // UI：1 个主任务行（标签 e2e-dual）
  await goTab(page, "jobs");
  const batchRow = page.locator(".job-batch-row").first();
  await expect(batchRow).toBeVisible({ timeout: 20_000 });
  await expect(batchRow.locator(".fn")).toHaveText("e2e-dual");
  await expect(batchRow.locator(".batch-sub-n")).toHaveText("2 子任务");
  // 在跑子任务（a/b）跑完（暂停不打断在跑）
  await Promise.all([
    waitForJobRow(req, (x) => x.engine === "mock" && x.job_id === a.job_id && x.status === "done", 60_000),
    waitForJobRow(req, (x) => x.engine === "mock2" && x.job_id === b.job_id && x.status === "done", 60_000),
  ]);
  // 暂停中第三发 → mock（同内容：缓存命中路径，batch 透传回归点）；冻结不开跑
  const c = await postAudio("mock", "dual-c.mp4");
  expect(c.cached).toBe(true); // 走 /upload/submit（batch 参数随命中路径透传）
  const rc = await waitForJobRow(req, (x) => x.engine === "mock" && x.job_id === c.job_id && !!x.batch_id, 30_000);
  expect(rc.batch_id).toBe(bid);
  // 冻结证明：等 15 tick（1.5s）后 c 仍未开跑
  await new Promise((rs) => setTimeout(rs, 1500));
  const rc2 = (await (await req.get("/api/jobs")).json() as any[]).find((x) => x.engine === "mock" && x.job_id === c.job_id);
  expect(rc2.status).not.toBe("running");
  // 主任务行：c 行 batch_paused=true → 聚合「已暂停」+「继续」
  await expect(batchRow.locator(".pill.p-paused")).toBeVisible({ timeout: 20_000 });
  await expect(batchRow.locator(".batch-op[data-bact='resume']")).toBeVisible({ timeout: 20_000 });
  // 继续 → 两台解冻、c 恢复开跑并完成
  const rr = await (await req.post(`/api/batch/${bid}/resume`)).json() as any;
  expect(rr.ok).toBe(true);
  await Promise.all([
    expectBatchPausedApi("http://127.0.0.1:8301", bid, false),
    expectBatchPausedApi(M2, bid, false),
  ]);
  await waitForJobRow(req, (x) => x.engine === "mock" && x.job_id === c.job_id && x.status === "done", 60_000);
  await expect(batchRow.locator(".batch-sub-n")).toHaveText("3 子任务");
  await expect(batchRow.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
  // 环境归位：清 mock2 引擎与状态（afterEach 兜底 reset）
  await m2ctl("reset");
  await req.delete("/api/engines/mock2").catch(() => {});
});

test("e) 服务设置·应用到所有服务：fan-out 双端，Key 类留空 = 各端保持现值", async ({ page }) => {
  await addEngine(req, { name: "mock2", url: M2, api_key: MOCK_KEY });
  await engineOnlineApi("mock2");
  // 前置：两端 lang_tag 不同；mock2 的 polish Key 已有值（fan-out 不得覆盖）
  const jh = { "Content-Type": "application/json" };
  await (await req.put("/api/engines/mock2/config", { data: { values: { "subtitle.lang_tag": "ja", "polish.api_key": "m2-key" } }, headers: jh })).json();
  const getCfg = async (n: string): Promise<Record<string, unknown>> => {
    const d = (await (await req.get(`/api/engines/${n}/config`)).json()) as { items: Array<{ path: string; value: unknown }> };
    return Object.fromEntries(d.items.map((i) => [i.path, i.value]));
  };
  expect((await getCfg("mock2"))["subtitle.lang_tag"]).toBe("ja");

  await goTab(page, "engines");
  // applyAll 显隐只在弹窗渲染时按 state.engines 判一次：先等页面 poller 刷到双服务卡
  await expect(page.locator("article.eng")).toHaveCount(2, { timeout: 15_000 });
  try {
    await page.locator('button.set[data-name="mock"]').click();
    // 双服务 → 按钮出现；改 lang_tag（mock 现值 zh → en）；polish Key 留空 = 不发送
    const applyAll = page.locator("#cfg-apply-all");
    await expect(applyAll).toBeVisible({ timeout: 15_000 });
    // lang_tag 在「字幕」tab 页（弹窗默认激活总览），先切页再填
    await page.locator('#cfg-tabs .cfg-tab[data-pane="subtitle"]').click();
    await expect(page.locator("#cfg-subtitle-lang_tag")).toBeVisible();
    await page.locator("#cfg-subtitle-lang_tag").fill("en");
    await applyAll.click();
    await expectToast(page, "已应用到全部 2 个服务");
    // 两端 lang_tag 同步为 en；mock2 的 Key 保留（打码非空）
    expect((await getCfg("mock"))["subtitle.lang_tag"]).toBe("en");
    expect((await getCfg("mock2"))["subtitle.lang_tag"]).toBe("en");
    expect((await getCfg("mock2"))["polish.api_key"]).toBe("***");
  } finally {
    // 环境归位（失败也执行，防 mock2 注册 / 配置值残留共享目录与 8302 进程）
    await req.put("/api/engines/mock/config", { data: { values: { "subtitle.lang_tag": "zh" } }, headers: jh }).catch(() => {});
    await m2ctl("reset");
    await req.delete("/api/engines/mock2").catch(() => {});
  }
});
