// 功能类：API 直调（/api 层，mock serve）+ UI 持久化行为
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  WEB_URL, MOCK_URL, MOCK_KEY, FIXTURES, makeScanDir,
  mockReset, mockSeed, mockPause, mockResume, mockConfigMode, mockControl, addEngine, cleanEngines, waitForJobRow, waitForEngineListed, waitForJobsEmpty,
  resetPipelinePause, mockSpeed,
} from "../helpers";
import path from "node:path";
import http from "node:http";
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";

const fx = (n: string) => path.join(FIXTURES, n);
const jh = { "Content-Type": "application/json" };

// 本地扫描夹具（工作台本机临时目录，3 项：2 无字幕 + 1 外部 srt）
const SCAN_DIR = makeScanDir();

let req: APIRequestContext;
test.beforeEach(async ({ request }) => {
  req = request;
  await mockReset(request);
  await resetPipelinePause(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
});
// pipeline_paused 持久化在共享 web 数据目录：用例中途失败也要复位，防拖死后续本机管线用例
test.afterEach(async () => {
  await resetPipelinePause(req);
});

test("服务 CRUD 全路径", async () => {
  const add = await req.post(`${WEB_URL}/api/engines`, { data: { name: "srv-b", url: "http://127.0.0.1:8301" }, headers: jh });
  expect(add.status()).toBe(201);
  await waitForEngineListed(req, "srv-b");
  const list = await req.get(`${WEB_URL}/api/engines`);
  const names = (await list.json()).map((e: { name: string }) => e.name);
  expect(names).toContain("srv-b");
  // 重名异址
  const dup = await req.post(`${WEB_URL}/api/engines`, { data: { name: "srv-b", url: "http://127.0.0.1:9999" }, headers: jh });
  expect(dup.status()).toBe(400);
  // 非法 URL
  const bad = await req.post(`${WEB_URL}/api/engines`, { data: { name: "srv-x", url: "notaurl" }, headers: jh });
  expect(bad.status()).toBe(400);
  // 改 key
  const put = await req.put(`${WEB_URL}/api/engines/srv-b`, { data: { api_key: "k1" }, headers: jh });
  expect(put.status()).toBe(200);
  expect((await put.json()).has_key).toBe(true);
  // 删
  expect((await req.delete(`${WEB_URL}/api/engines/srv-b`)).status()).toBe(200);
  expect((await req.delete(`${WEB_URL}/api/engines/srv-b`)).status()).toBe(404);
});

test("upload-audio 全链路：只传 opus → 202 → done → srt 可下载", async () => {
  const opus = readFileSync(fx("sine.opus"));
  const fd = new FormData();
  fd.append("audio", new Blob([opus]), "test-a.opus");
  fd.append("engine", "mock");
  fd.append("name", "test-a.mp4");
  fd.append("size_mb", "0");
  const resp = await fetch(`${WEB_URL}/api/upload-audio`, { method: "POST", body: fd });
  expect(resp.status).toBe(202);
  const { upload_id } = await resp.json();

  // mock 收到的就是 opus 本身（字节级相等）→ 证明「只传音频」
  // 202 是受理应答，派发是 web 后台异步任务 → 轮询等派发落 mock（防竞态）
  await expect
    .poll(async () => (await (await req.get(`${MOCK_URL}/_mock/uploads`)).json() as unknown[]).length, {
      timeout: 10_000,
    })
    .toBe(1);
  const up = await (await req.get(`${MOCK_URL}/_mock/uploads`)).json();
  expect(up[0].size).toBe(opus.length);
  expect(up[0].source).toBe("test-a.mp4");

  // 轮询到 done
  let d: any = null;
  for (let i = 0; i < 30; i++) {
    d = await (await req.get(`${WEB_URL}/api/uploads/${upload_id}`)).json();
    if (d.phase === "done" || d.phase === "error") break;
    await new Promise((rs) => setTimeout(rs, 300));
  }
  expect(d.phase).toBe("done");
  expect(d.job_id).toBeTruthy();

  // upload 的 done 只表示「派发成功」；等 mock 侧任务真正跑完再取 result
  let jd: any = null;
  for (let i = 0; i < 40; i++) {
    jd = await (await req.get(`${MOCK_URL}/jobs/${d.job_id}`)).json();
    if (jd.state === "finished") break;
    await new Promise((rs) => setTimeout(rs, 150));
  }
  expect(jd.state).toBe("finished");
  // 再等 job 进入工作台 poller 快照（CD 文件名依赖快照里的 label）
  await waitForJobRow(req, (j: any) => j.job_id === d.job_id);

  const srt = await req.get(`${WEB_URL}/api/jobs/mock/${d.job_id}/result`);
  expect(srt.status()).toBe(200);
  expect(await srt.text()).toContain("テスト字幕 test-a.mp4");
  expect(srt.headers()["content-disposition"]).toContain("test-a.zh.srt");
});

test("服务端音轨缓存：同 opus 二次派发命中（workbench→serve 免传字节）", async () => {
  const opus = readFileSync(fx("sine.opus"));
  const postAudio = async (name: string) => {
    const fd = new FormData();
    fd.append("audio", new Blob([opus]), "x.opus");
    fd.append("engine", "mock");
    fd.append("name", name);
    fd.append("size_mb", "0");
    const r = await fetch(`${WEB_URL}/api/upload-audio`, { method: "POST", body: fd });
    expect(r.status).toBe(202);
    return (await r.json()).upload_id as string;
  };
  const waitPhase = async (id: string) => {
    let d: any = null;
    for (let i = 0; i < 30; i++) {
      d = await (await req.get(`${WEB_URL}/api/uploads/${id}`)).json();
      if (d.phase === "done" || d.phase === "error") break;
      await new Promise((rs) => setTimeout(rs, 300));
    }
    return d;
  };

  const d1 = await waitPhase(await postAudio("cache-web-a.mp4"));
  expect(d1.phase).toBe("done");
  expect(d1.cached).toBeFalsy();
  let ups = await (await req.get(`${MOCK_URL}/_mock/uploads`)).json();
  expect(ups).toHaveLength(1);

  const d2 = await waitPhase(await postAudio("cache-web-b.mp4"));
  expect(d2.phase).toBe("done");
  expect(d2.cached).toBe(true);
  expect(d2.job_id).toBeTruthy();
  expect(d2.job_id).not.toBe(d1.job_id);
  ups = await (await req.get(`${MOCK_URL}/_mock/uploads`)).json();
  expect(ups).toHaveLength(1); // 第二次派发没有向 serve 传字节
});

test("result 未完成 → 404；未知 upload → 404", async () => {
  await mockPause(req);
  try {
    await (await req.post(`${MOCK_URL}/_mock/seed`, { data: { n: 1, status: "running" }, headers: jh })).json();
    const row = await waitForJobRow(req, (j: any) => j.status === "running");
    const r = await req.get(`${WEB_URL}/api/jobs/mock/${row.job_id}/result`);
    expect(r.status()).toBe(404);
  } finally {
    await mockResume(req);
  }
  expect((await req.get(`${WEB_URL}/api/uploads/nope`)).status()).toBe(404);
});

test("retry：跳过任务 → 201 新任务；无跳过文件 → 409", async () => {
  await mockSeed(req, { n: 1, status: "skipped", skipped: 1 });
  const skipped = await waitForJobRow(req, (j: any) => j.status === "skipped");
  const r1 = await req.post(`${WEB_URL}/api/jobs/mock/${skipped.job_id}/retry`, { data: {} });
  expect(r1.status()).toBe(201); // 成功重试 = 新建任务（serve 契约）
  const { job_id: newId } = await r1.json();
  expect(newId).toBeTruthy();
  // 新任务是 running（非 skipped）→ 再 retry 409
  const r2 = await req.post(`${WEB_URL}/api/jobs/mock/${newId}/retry`, { data: {} });
  expect(r2.status()).toBe(409);
  // 不存在的任务
  expect((await req.post(`${WEB_URL}/api/jobs/mock/nojob/retry`, { data: {} })).status()).toBe(404);
});

test("config：23 项白名单 + PUT 校验全路径", async () => {
  await mockConfigMode(req, "ok");
  await addEngine(req, { name: "mock", url: "http://127.0.0.1:8301", api_key: MOCK_KEY });

  const g = await req.get(`${WEB_URL}/api/engines/mock/config`);
  expect(g.status()).toBe(200);
  const items = (await g.json()).items as any[];
  expect(items).toHaveLength(23);
  const byPath = Object.fromEntries(items.map((i) => [i.path, i]));
  expect(byPath["vad.threshold"].value).toBe(0.5);
  expect(byPath["storage.retention_days"].value).toBe(7);
  expect(byPath["polish.api_key"].secret).toBe(true);
  expect(byPath["subtitle.naming"].options).toEqual(["rename", "keep"]);

  // 正常 PUT：float + 空 secret（保持）
  const p1 = await req.put(`${WEB_URL}/api/engines/mock/config`, { data: { values: { "vad.threshold": 0.7, "polish.api_key": "" } }, headers: jh });
  expect(p1.status()).toBe(200);
  expect((await p1.json()).updated).toEqual(["vad.threshold"]);
  const g2 = await (await req.get(`${WEB_URL}/api/engines/mock/config`)).json();
  expect(Object.fromEntries(g2.items.map((i: any) => [i.path, i]))["vad.threshold"].value).toBe(0.7);

  // 未知路径
  const p2 = await req.put(`${WEB_URL}/api/engines/mock/config`, { data: { values: { "infer.cwd": "/x" } }, headers: jh });
  expect(p2.status()).toBe(400);
  expect((await p2.json()).detail).toContain("不支持的配置项");
  // 类型错
  expect((await req.put(`${WEB_URL}/api/engines/mock/config`, { data: { values: { "infer.max_batch_size": 0 } }, headers: jh })).status()).toBe(400);
  expect((await req.put(`${WEB_URL}/api/engines/mock/config`, { data: { values: { "subtitle.naming": "bad" } }, headers: jh })).status()).toBe(400);
  // values 空
  expect((await req.put(`${WEB_URL}/api/engines/mock/config`, { data: { values: {} }, headers: jh })).status()).toBe(400);
});

test("config：服务端未设 Key → 400（web 映射 403）；Key 不符 → 400（映射 401）", async () => {
  // 未设 key
  await mockConfigMode(req, "no-key");
  await addEngine(req, { name: "mock", url: "http://127.0.0.1:8301", api_key: MOCK_KEY });
  const r1 = await req.get(`${WEB_URL}/api/engines/mock/config`);
  expect(r1.status()).toBe(400);
  expect((await r1.json()).detail).toContain("尚未设置 API Key");
  // key 不符（服务端要求 mock-key-123，登记另一个）
  await mockConfigMode(req, "ok");
  const r2 = await req.put(`${WEB_URL}/api/engines/mock`, { data: { api_key: "wrong" }, headers: jh });
  expect(r2.status()).toBe(200);
  const r3 = await req.get(`${WEB_URL}/api/engines/mock/config`);
  expect(r3.status()).toBe(400);
  expect((await r3.json()).detail).toContain("API Key 不正确");
});

test("scan：本地扫描目录三项（1 个有字幕）；Windows 路径 400；不存在 400", async () => {
  const r = await req.get(
    `${WEB_URL}/api/scan/local?engine=mock&path=${encodeURIComponent(SCAN_DIR)}&min_size_mb=0`,
  );
  expect(r.status()).toBe(200);
  const d = await r.json();
  expect(d.mapped).toBe(false);
  expect(d.items).toHaveLength(3);
  const sub = d.items.find((i: any) => i.name === "AKDL-002.mp4");
  expect(sub.has_subtitle).toBe(true);
  expect(sub.subtitle).toBe("AKDL-002.zh.srt");
  // Windows 路径（浏览器电脑本地磁盘语义，客户端部署机读不到，直接拒）
  const rw = await req.get(`${WEB_URL}/api/scan/local?engine=mock&path=${encodeURIComponent("D:\\Videos")}`);
  expect(rw.status()).toBe(400);
  expect((await rw.json()).detail).toContain("需要绝对路径");
  // 不存在
  const rn = await req.get(`${WEB_URL}/api/scan/local?engine=mock&path=/nope`);
  expect(rn.status()).toBe(400);
  expect((await rn.json()).detail).toContain("路径不存在");
});

test("scan/submit：本机扫描提交 → 200 两条本地任务 → 派发到 mock；空 files → 400", async () => {
  const r = await req.post(`${WEB_URL}/api/scan/local/submit`, {
    data: {
      engine: "mock",
      files: [path.join(SCAN_DIR, "AKDL-001.mp4"), path.join(SCAN_DIR, "SUB-001.mkv")],
    },
    headers: jh,
  });
  expect(r.status()).toBe(200);
  const d = await r.json();
  expect(d.files).toBe(2);
  expect(d.upload_ids).toHaveLength(2);
  // 本地管线：读本机视频 → 提 opus → 派发；job label = 原始视频名
  await waitForJobRow(req, (j: any) => j.file === "AKDL-001.mp4");
  await waitForJobRow(req, (j: any) => j.file === "SUB-001.mkv");
  // 必须等两条任务回写完成并关闭：本测试不 mockReset 隔离，下一条用例的
  // mockReset 会抹掉 serve 任务表，本地任务将滞留回写表（僵尸 15min），
  // 之后同目录再提交（interaction 扫描全流程）会被防重跳过 → 已入队数漂移。
  const want = ["AKDL-001.zh.srt", "SUB-001.zh.srt"];
  const t0 = Date.now();
  while (!want.every((n) => existsSync(path.join(SCAN_DIR, n))) && Date.now() - t0 < 90_000) {
    await new Promise((rs) => setTimeout(rs, 500));
  }
  for (const n of want) expect(existsSync(path.join(SCAN_DIR, n))).toBe(true);
  // 还原夹具干净态：扫描表用例断言仅 AKDL-002 带字幕
  for (const n of want) unlinkSync(path.join(SCAN_DIR, n));
  expect((await req.post(`${WEB_URL}/api/scan/local/submit`, {
    data: { engine: "mock", files: [] }, headers: jh,
  })).status()).toBe(400);
});

test("pause API：全局暂停/继续（本机管线持久化 + 服务队列代理 + 离线引擎明细）", async () => {
  // 暂停
  const p1 = await req.post(`${WEB_URL}/api/pause`, { data: { paused: true }, headers: jh });
  expect(p1.status()).toBe(200);
  const d1 = await p1.json();
  expect(d1.ok).toBe(true);
  expect(d1.paused).toBe(true);
  expect(d1.engines).toEqual([{ engine: "mock", ok: true, paused: true }]);
  // mock 侧队列确实冻结（/health 带 paused，与 serve 0.2.3 契约一致）
  const h1 = await (await req.get(`${MOCK_URL}/health`, { headers: { "x-api-key": MOCK_KEY } })).json();
  expect(h1.paused).toBe(true);
  // summary：paused_all 立即生效；engines_paused 走 poller 快照（1s tick）等一拍
  await expect.poll(async () => {
    const s2 = await (await req.get(`${WEB_URL}/api/jobs/summary`)).json();
    return s2.paused_all === true && s2.engines_paused?.mock === true;
  }, { timeout: 10_000 }).toBe(true);
  // 幂等：重复暂停不报错
  expect((await req.post(`${WEB_URL}/api/pause`, { data: { paused: true }, headers: jh })).status()).toBe(200);
  // 离线引擎：条目带原因，不阻塞整体
  await addEngine(req, { name: "offline-x", url: "http://127.0.0.1:9999" });
  await waitForEngineListed(req, "offline-x");
  const d3 = await (await req.post(`${WEB_URL}/api/pause`, { data: { paused: true }, headers: jh })).json();
  const off = d3.engines.find((e: any) => e.engine === "offline-x");
  expect(off.ok).toBe(false);
  expect(off.error).toContain("服务离线");
  const mok = d3.engines.find((e: any) => e.engine === "mock");
  expect(mok.ok).toBe(true);
  expect(mok.paused).toBe(true);
  // 继续
  const d4 = await (await req.post(`${WEB_URL}/api/pause`, { data: { paused: false }, headers: jh })).json();
  expect(d4.paused).toBe(false);
  const h2 = await (await req.get(`${MOCK_URL}/health`, { headers: { "x-api-key": MOCK_KEY } })).json();
  expect(h2.paused).toBe(false);
  await expect.poll(async () => {
    const s2 = await (await req.get(`${WEB_URL}/api/jobs/summary`)).json();
    return s2.paused_all === false && s2.engines_paused?.mock === false;
  }, { timeout: 10_000 }).toBe(true);
});

test("job pause/resume API：排队可挂起；运行中 409；未挂起 resume 409", async () => {
  // 慢速推进：保证 running 行在整个用例期间不会跑完（409 文案依赖「运行中」判定）
  await mockSpeed(req, { step: 0.005, tickMs: 100 });
  await mockSeed(req, { n: 2, status: "running", progress: 0.3, pending: 1 });
  const pend = await waitForJobRow(req, (j: any) => j.status === "pending" && j.job_id);
  const run = await waitForJobRow(req, (j: any) => j.status === "running" && j.job_id && j.job_id !== pend.job_id);
  // 排队 → 挂起
  const p1 = await req.post(`${WEB_URL}/api/jobs/mock/${pend.job_id}/pause`);
  expect(p1.status()).toBe(200);
  expect((await p1.json()).status).toBe("paused");
  // 快照行带 paused 标记（status 仍 pending，展示态归一「已暂停」）
  const pausedRow = await waitForJobRow(req, (j: any) => j.job_id === pend.job_id && j.paused === true);
  expect(pausedRow.status).toBe("pending");
  // 运行中 → 409（文案透传服务侧）
  const p2 = await req.post(`${WEB_URL}/api/jobs/mock/${run.job_id}/pause`);
  expect(p2.status()).toBe(409);
  expect((await p2.json()).detail).toContain("任务运行中");
  // 未挂起 → resume 409
  const p3 = await req.post(`${WEB_URL}/api/jobs/mock/${run.job_id}/resume`);
  expect(p3.status()).toBe(409);
  expect((await p3.json()).detail).toContain("任务未在挂起状态");
  // 恢复
  const p4 = await req.post(`${WEB_URL}/api/jobs/mock/${pend.job_id}/resume`);
  expect(p4.status()).toBe(200);
  expect((await p4.json()).status).toBe("resumed");
  await waitForJobRow(req, (j: any) => j.job_id === pend.job_id && j.paused === false);
});

test("error 任务 retry API：201 新任务重新入队；无重试项（已完成）409", async () => {
  await mockSpeed(req, { step: 0.005, tickMs: 100 });
  await mockSeed(req, { n: 2, status: "done", errors: 1 });
  const errRow = await waitForJobRow(req, (j: any) => j.status === "error" && j.job_id);
  expect(errRow.message).toContain("转写失败");
  const r1 = await req.post(`${WEB_URL}/api/jobs/mock/${errRow.job_id}/retry`);
  expect(r1.status()).toBe(201);
  const d1 = await r1.json();
  expect(d1.ok).toBe(true);
  expect(d1.job_id).toBeTruthy();
  expect(d1.job_id).not.toBe(errRow.job_id);
  // 新任务同文件重新入队（running）
  const nj = await waitForJobRow(req, (j: any) => j.job_id === d1.job_id && j.status === "running");
  expect(nj.file).toBe("seed-001.mp4");
  // 已完成任务无可重试项 → 409
  const doneRow = await waitForJobRow(req, (j: any) => j.status === "done" && j.job_id && j.job_id !== errRow.job_id);
  const r2 = await req.post(`${WEB_URL}/api/jobs/mock/${doneRow.job_id}/retry`);
  expect(r2.status()).toBe(409);
  // web 代理统一中文映射（serve 原文在 error 字段，不透传 detail）
  expect((await r2.json()).detail).toContain("重新生成");
});

test("全局暂停闸：暂停期间提交停在 paused，恢复后提取+派发完成并回写", async () => {
  await req.post(`${WEB_URL}/api/pause`, { data: { paused: true }, headers: jh });
  const r = await req.post(`${WEB_URL}/api/scan/local/submit`, {
    data: { engine: "mock", files: [path.join(SCAN_DIR, "AKDL-001.mp4")] },
    headers: jh,
  });
  expect(r.status()).toBe(200);
  const { upload_ids } = await r.json();
  expect(upload_ids).toHaveLength(1);
  const tid = upload_ids[0];
  // 暂停中：任务停在闸前（phase=paused，不提取、不派发）
  await expect.poll(
    async () => (await (await req.get(`${WEB_URL}/api/uploads/${tid}`)).json()).phase,
    { timeout: 10_000 },
  ).toBe("paused");
  expect(await (await req.get(`${MOCK_URL}/_mock/uploads`)).json()).toHaveLength(0);
  // 恢复 → 提取 → 派发（phase=done 即服务已受理，job_id 就位）
  await req.post(`${WEB_URL}/api/pause`, { data: { paused: false }, headers: jh });
  let d: any = null;
  for (let i = 0; i < 60; i++) {
    d = await (await req.get(`${WEB_URL}/api/uploads/${tid}`)).json();
    if (d.phase === "done" || d.phase === "error") break;
    await new Promise((rs) => setTimeout(rs, 300));
  }
  expect(d.phase).toBe("done");
  expect(d.job_id).toBeTruthy();
  // 本机回写：字幕落回视频旁（与 scan/submit 用例同款还原）
  const srtPath = path.join(SCAN_DIR, "AKDL-001.zh.srt");
  const t0 = Date.now();
  while (!existsSync(srtPath) && Date.now() - t0 < 90_000) await new Promise((rs) => setTimeout(rs, 500));
  expect(existsSync(srtPath)).toBe(true);
  unlinkSync(srtPath);
});

test("UI 持久化：autosave / 提取模式 / 所选服务 刷新后保持", async ({ page }) => {
  await page.goto("/");
  await page.locator("#autosave").check();
  await page.selectOption("#extract-select", "server");
  await page.reload();
  await expect(page.locator("#autosave")).toBeChecked();
  await expect(page.locator("#extract-select")).toHaveValue("server");
  await page.selectOption("#engine-select", "mock");
  await page.reload();
  await expect(page.locator("#engine-select")).toHaveValue("mock");
});

test("多服务自动均衡（auto）：派发时刻选最闲服务；UI 出现自动均衡选项", async ({ page }) => {
  const M2 = "http://127.0.0.1:8302";
  const m2ctl = (p: string, body?: unknown) =>
    req.post(`${M2}/_mock/${p}`, {
      data: body === undefined ? "{}" : body,
      headers: { "Content-Type": "application/json" },
    });

  await addEngine(req, { name: "mock2", url: M2, api_key: MOCK_KEY });
  await waitForEngineListed(req, "mock2");

  try {
    // UI：≥2 台服务时 select 出现「自动均衡」选项（单服务时不出现，见 style 基线）
    await page.goto("/");
    await expect(page.locator("#engine-select")).toContainText("自动均衡");

    // mock2 压 1 个在途任务（先 pause 冻结 tick，负载稳定不流失）
    await m2ctl("pause");
    await m2ctl("seed", { n: 1, status: "running" });
    // 等 poller 快照体现 mock2 负载（jobs_running 是均衡决策源）
    await waitForJobRow(req, (j: any) => j.engine === "mock2" && j.status === "running");

    const postAudio = async (name: string) => {
      const opus = readFileSync(fx("sine.opus"));
      const fd = new FormData();
      fd.append("audio", new Blob([opus]), "bal.opus");
      fd.append("engine", "auto");
      fd.append("name", name);
      fd.append("size_mb", "0");
      const r = await fetch(`${WEB_URL}/api/upload-audio`, { method: "POST", body: fd });
      expect(r.status).toBe(202);
      const { upload_id } = await r.json();
      let d: any = null;
      for (let i = 0; i < 40; i++) {
        d = await (await req.get(`${WEB_URL}/api/uploads/${upload_id}`)).json();
        if (d.phase === "done" || d.phase === "error") break;
        await new Promise((rs) => setTimeout(rs, 300));
      }
      expect(d.phase).toBe("done");
      expect(d.job_id).toBeTruthy();
      return d;
    };

    // 第一发：mock2 在途 1、mock 在途 0 → 落 mock；字节不进 mock2
    const d1 = await postAudio("bal-a.mp4");
    expect(d1.engine).toBe("mock");
    expect(await (await req.get(`${M2}/_mock/uploads`)).json()).toHaveLength(0);
    expect(await (await req.get(`${MOCK_URL}/_mock/uploads`)).json()).toHaveLength(1);

    // 第二发：mock 压 3 个在途并冻结（含 bal-a 则 4 个）→ 反转向 mock2 分流
    await mockSeed(req, { n: 3, status: "running" });
    await mockPause(req);
    // 等 poller 快照体现 mock 新负载（均衡决策源是快照；不等则派发放行旧值）
    await waitForJobRow(req, (j: any) => j.engine === "mock" && j.file === "seed-001.mp4" && j.status === "running");
    const d2 = await postAudio("bal-b.mp4");
    expect(d2.engine).toBe("mock2");
    expect(await (await req.get(`${M2}/_mock/uploads`)).json()).toHaveLength(1);
    expect(await (await req.get(`${MOCK_URL}/_mock/uploads`)).json()).toHaveLength(1);
  } finally {
    // 复位两台 mock + 删 mock2：冻结的 seeded 任务不能滞留 poller 快照（拖死后续 waitForJobsEmpty）
    await mockResume(req).catch(() => {});
    await m2ctl("resume").catch(() => {});
    await m2ctl("reset").catch(() => {});
    await req.delete(`${WEB_URL}/api/engines/mock2`).catch(() => {});
  }
});

test("本机任务 暂停/继续：单任务 + 批量（暂停态落盘持久化，继续后全部完成回写）", async () => {
  const extra = path.join(SCAN_DIR, "EXTRA-001.mp4");
  copyFileSync(fx("video-a.mp4"), extra);
  try {
    // 在途封顶 1：首个任务持槽到回写完成，其余停在排队
    expect((await req.put(`${WEB_URL}/api/client-config`, { data: { queue_cap: 1 }, headers: jh })).status()).toBe(200);
    // mock 转译 ~10s/条：A 有充足在途窗口让 B/C 稳定停在排队
    await mockSpeed(req, { step: 0.01, tickMs: 100 });

    const r = await req.post(`${WEB_URL}/api/scan/local/submit`, {
      data: { engine: "mock", files: [path.join(SCAN_DIR, "AKDL-001.mp4"), path.join(SCAN_DIR, "SUB-001.mkv"), extra] },
      headers: jh,
    });
    expect(r.status()).toBe(200);
    const { upload_ids } = await r.json();
    expect(upload_ids).toHaveLength(3);
    const [tidA, tidB, tidC] = upload_ids as string[];
    const up = async (id: string) => (await (await req.get(`${WEB_URL}/api/uploads/${id}`)).json()) as any;

    // A 进入管线（job_id 就位 = 服务已受理）；B/C 停在排队（在途封顶 1）
    await expect.poll(async () => (await up(tidA)).job_id, { timeout: 30_000 }).toBeTruthy();
    await expect.poll(
      async () => (await up(tidB)).phase === "queued" && (await up(tidC)).phase === "queued",
      { timeout: 10_000 },
    ).toBe(true);

    // 单任务暂停 B；重复暂停幂等 → already；A 已入服务队列 → 409
    expect((await req.post(`${WEB_URL}/api/local/${tidB}/pause`)).status()).toBe(200);
    const p1b = await req.post(`${WEB_URL}/api/local/${tidB}/pause`);
    expect(p1b.status()).toBe(200);
    expect((await p1b.json()).already).toBe(true);
    const pA = await req.post(`${WEB_URL}/api/local/${tidA}/pause`);
    expect(pA.status()).toBe(409);
    expect((await pA.json()).detail).toContain("已提交服务队列");

    // 批量暂停 C
    const d1 = await (await req.post(`${WEB_URL}/api/jobs/bulk`, { data: { action: "pause", task_ids: [tidC] }, headers: jh })).json();
    expect(d1.succeeded).toBe(1);
    expect(d1.failed).toBe(0);

    // B/C 暂停中，且落盘 uploads.json（task_paused：下次工作台重启可恢复）
    for (const id of [tidB, tidC]) {
      const d = await up(id);
      expect(d.phase).toBe("paused");
      expect(d.task_paused).toBe(true);
    }
    const dataDirs = readdirSync("/tmp").filter((n) => n.startsWith("javweb-e2e-data."));
    const uploadsJson = dataDirs.map((d) => path.join("/tmp", d, "uploads.json")).find((p) => existsSync(p));
    expect(uploadsJson).toBeTruthy();
    const persisted = (JSON.parse(readFileSync(uploadsJson!, "utf-8")) as { uploads: any[] }).uploads;
    for (const id of [tidB, tidC]) {
      const e = persisted.find((x) => x.id === id);
      expect(e?.task_paused).toBe(true);
    }

    // 本机「取消」无语义 → 单条 error，不拖垮整批
    const d2 = await (await req.post(`${WEB_URL}/api/jobs/bulk`, { data: { action: "cancel", task_ids: [tidC] }, headers: jh })).json();
    expect(d2.succeeded).toBe(0);
    expect(d2.failed).toBe(1);

    // 批量继续 B/C → 三条全部完成、字幕回写视频旁
    const d3 = await (await req.post(`${WEB_URL}/api/jobs/bulk`, { data: { action: "resume", task_ids: [tidB, tidC] }, headers: jh })).json();
    expect(d3.succeeded).toBe(2);
    expect(d3.failed).toBe(0);
    const want = ["AKDL-001.zh.srt", "SUB-001.zh.srt", "EXTRA-001.zh.srt"];
    const t0 = Date.now();
    while (!want.every((n) => existsSync(path.join(SCAN_DIR, n))) && Date.now() - t0 < 90_000) {
      await new Promise((rs) => setTimeout(rs, 500));
    }
    for (const n of want) expect(existsSync(path.join(SCAN_DIR, n))).toBe(true);
  } finally {
    for (const n of ["AKDL-001.zh.srt", "SUB-001.zh.srt", "EXTRA-001.zh.srt"]) rmSync(path.join(SCAN_DIR, n), { force: true });
    rmSync(extra, { force: true });
    await req.put(`${WEB_URL}/api/client-config`, { data: { queue_cap: 4 }, headers: jh }).catch(() => {});
  }
});

test("metrics：/api/engines/{name}/metrics（GPU 快照 / 旧版服务 unsupported / 不可达 unreachable）", async () => {
  // mock 默认无 GPU → gpu=null（前端降级队列深度曲线）；历史预填 40 点
  const g1 = await (await req.get(`${WEB_URL}/api/engines/mock/metrics`)).json() as any;
  expect(g1.ok).toBe(true);
  expect(g1.metrics.gpu).toBeNull();
  expect(g1.metrics.jobs.running).toBe(0);
  expect(g1.metrics.history.length).toBeGreaterThanOrEqual(2);

  // 开启 GPU → 快照带 GPU 指标（工作台侧 2s 内存缓存，需等待过期）
  await mockControl(req, "metrics", { gpu_present: true, gpu_util: 43, mem_used_mb: 5400, mem_total_mb: 8192 });
  await new Promise((rs) => setTimeout(rs, 2300));
  const g2 = await (await req.get(`${WEB_URL}/api/engines/mock/metrics`)).json() as any;
  expect(g2.metrics.gpu.present).toBe(true);
  expect(g2.metrics.gpu.util_pct).toBe(43);
  expect(g2.metrics.gpu.mem_used_mb).toBe(5400);

  // 旧版服务（无 /metrics/json → 404）→ unsupported
  const srv = http.createServer((_q, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((rs) => srv.listen(8305, "127.0.0.1", () => rs()));
  try {
    await addEngine(req, { name: "legacy-x", url: "http://127.0.0.1:8305" });
    await waitForEngineListed(req, "legacy-x");
    expect(await (await req.get(`${WEB_URL}/api/engines/legacy-x/metrics`)).json()).toEqual({ ok: false, error: "unsupported" });
  } finally {
    await req.delete(`${WEB_URL}/api/engines/legacy-x`).catch(() => {});
    await new Promise<void>((rs) => srv.close(() => rs()));
  }
  // 不可达服务 → unreachable
  await addEngine(req, { name: "dead-x", url: "http://127.0.0.1:9998" });
  await waitForEngineListed(req, "dead-x");
  try {
    expect(await (await req.get(`${WEB_URL}/api/engines/dead-x/metrics`)).json()).toEqual({ ok: false, error: "unreachable" });
  } finally {
    await req.delete(`${WEB_URL}/api/engines/dead-x`);
  }
});
