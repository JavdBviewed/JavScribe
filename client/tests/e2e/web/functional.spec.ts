// 功能类：API 直调（/api 层，mock serve）+ UI 持久化行为
import { test, expect, type APIRequestContext } from "@playwright/test";
import {
  WEB_URL, MOCK_URL, MOCK_KEY, FIXTURES,
  mockReset, mockSeed, mockPause, mockResume, mockConfigMode, addEngine, cleanEngines, waitForJobRow, waitForEngineListed, waitForJobsEmpty,
} from "../helpers";
import path from "node:path";
import { readFileSync } from "node:fs";

const fx = (n: string) => path.join(FIXTURES, n);
const jh = { "Content-Type": "application/json" };

let req: APIRequestContext;
test.beforeEach(async ({ request }) => {
  req = request;
  await mockReset(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
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
  const up = await (await req.get(`${MOCK_URL}/_mock/uploads`)).json();
  expect(up).toHaveLength(1);
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
  expect(r1.status()).toBe(200);
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

test("scan：/media/jav 三项（1 个有字幕）；Windows 路径 400；不存在 400", async () => {
  await addEngine(req, { name: "mock", url: "http://127.0.0.1:8301", api_key: MOCK_KEY });
  const r = await req.get(`${WEB_URL}/api/engines/mock/scan?path=/media/jav`);
  expect(r.status()).toBe(200);
  const d = await r.json();
  expect(d.mapped).toBe(false);
  expect(d.items).toHaveLength(3);
  const sub = d.items.find((i: any) => i.name === "AKDL-002.mp4");
  expect(sub.has_subtitle).toBe(true);
  expect(sub.subtitle).toBe("AKDL-002.zh.srt");
  // Windows 路径（本机磁盘语义，服务端拒）
  const rw = await req.get(`${WEB_URL}/api/engines/mock/scan?path=${encodeURIComponent("D:\\Videos")}`);
  expect(rw.status()).toBe(400);
  expect((await rw.json()).detail).toContain("需要绝对路径");
  // 不存在
  const rn = await req.get(`${WEB_URL}/api/engines/mock/scan?path=/nope`);
  expect(rn.status()).toBe(400);
  expect((await rn.json()).detail).toContain("路径不存在");
});

test("scan/submit：勾选入队 → 201；空 files → 400", async () => {
  await addEngine(req, { name: "mock", url: "http://127.0.0.1:8301", api_key: MOCK_KEY });
  const r = await req.post(`${WEB_URL}/api/engines/mock/scan/submit`, {
    data: { files: ["/media/jav/AKDL-001.mp4", "/media/jav/SUB-001.mkv"] }, headers: jh,
  });
  expect(r.status()).toBe(200);
  const d = await r.json();
  expect(d.files).toBe(2);
  expect(d.job_id).toBeTruthy();
  const row = await waitForJobRow(req, (j: any) => j.job_id === d.job_id);
  expect(row.label).toBe("文件夹扫描 · 2 项");
  expect((await req.post(`${WEB_URL}/api/engines/mock/scan/submit`, { data: { files: [] }, headers: jh })).status()).toBe(400);
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
