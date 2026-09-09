// 桌面端功能类：IPC 直调（t-call / upload / extract / write-srt，main 进程直连 mock serve）
// 不经过 8400 工作台——这是桌面端的核心数据链路，全部走 window.javDesktop
import { test, expect, type APIRequestContext } from "./helpers";
import {
  MOCK, MOCK_KEY, FIXTURES,
  mockPause, mockResume, mockConfigMode, mockJobs, waitForMockJobFinished,
} from "./helpers";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const fx = (n: string) => join(FIXTURES, n);
const jh = { "Content-Type": "application/json" };

/** renderer 侧 t-call 助手（返回原始结果对象，便于断言错误文案） */
const icall = (page: any, method: string, ...args: string[]) =>
  page.evaluate(async ([m, a]: [string, string[]]) => {
    const r = await (window as any).javDesktop.call(m, a);
    return { ok: r.ok, data: r.data, error: r.error, network: r.network };
  }, [method, args]);

test("getHealth：app 名 / 版本 / 在线数", async ({ page }) => {
  const r = await icall(page, "getHealth");
  expect(r.ok).toBe(true);
  expect(r.data).toMatchObject({ ok: true, app: "JavScribe Client", version: "0.2.3", engines: 1, online: 1 });
});

test("addEngine / putEngineKey / deleteEngine 全路径（IPC）", async ({ page }) => {
  expect((await icall(page, "addEngine", "srv-b", MOCK, "")).ok).toBe(true);

  // 重名异址
  const dup = await icall(page, "addEngine", "srv-b", "http://127.0.0.1:9999", "");
  expect(dup.ok).toBe(false);
  expect(dup.error).toBe("name/url 无效，或该名称已指向其它地址");
  // 非法 URL
  const bad = await icall(page, "addEngine", "srv-x", "notaurl", "");
  expect(bad.ok).toBe(false);
  expect(bad.error).toBe("name/url 无效，或该名称已指向其它地址");

  // 登记 key 后 listEngines 可见 has_key
  expect((await icall(page, "putEngineKey", "srv-b", "k1")).ok).toBe(true);
  const list = (await icall(page, "listEngines")).data as Array<{ name: string; has_key: boolean; url: string; online: boolean }>;
  const b = list.find((e) => e.name === "srv-b")!;
  expect(b.has_key).toBe(true);
  expect(b.url).toBe(MOCK);
  expect(b.online).toBe(true);

  // 删除幂等
  expect((await icall(page, "deleteEngine", "srv-b")).ok).toBe(true);
  expect((await icall(page, "deleteEngine", "srv-b")).ok).toBe(true);
  const list2 = (await icall(page, "listEngines")).data as Array<{ name: string }>;
  expect(list2.some((e) => e.name === "srv-b")).toBe(false);
});

test("upload-audio IPC 全链路：opus 字节流 → 201 job → finished → srt 字节", async ({ page, request }) => {
  const opus = readFileSync(fx("sine.opus"));
  const d = await page.evaluate(async (p) => {
    return await (window as any).javDesktop.upload.audio({ id: "t-audio-path", engine: "mock", name: "test-a.mp4", opusPath: p });
  }, fx("sine.opus"));
  expect(d.ok).toBe(true);
  expect(d.job_id).toBeTruthy();
  expect(d.file).toBe("test-a.mp4");

  // mock 收到的就是 opus 本身（字节级）→ 证明「只传音频」
  const up = (await (await request.get(`${MOCK}/_mock/uploads`)).json()) as Array<{ source: string; size: number; head: string }>;
  expect(up).toHaveLength(1);
  expect(up[0].size).toBe(opus.length);
  expect(up[0].head).toBe("4f676753"); // OggS
  expect(up[0].source).toBe("test-a.mp4");

  await waitForMockJobFinished(request, d.job_id);

  const rd = await page.evaluate(async (jid) => {
    const r = await (window as any).javDesktop.call("getResultData", ["mock", jid]);
    if (!r.ok || !(r.data instanceof Uint8Array)) return { ok: false as const, error: r.error };
    const u8 = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    return { ok: true as const, text: new TextDecoder().decode(u8) };
  }, d.job_id);
  expect(rd.ok).toBe(true);
  expect((rd as { text: string }).text).toContain("テスト字幕 test-a.mp4");
});

test("upload-audio data 通道（无路径 File）+ upload-file 整片直传", async ({ page, request }) => {
  // data 通道：字节经 IPC 传 main（e2e setInputFiles 的合成 File 走这里）
  const d1 = await page.evaluate(async () => {
    const b = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4, 5]);
    return await (window as any).javDesktop.upload.audio({ id: "t-audio-data", engine: "mock", name: "test-b.mp4", data: b });
  });
  expect(d1.ok).toBe(true);
  let up: Array<{ size: number; head?: string; source: string }> = await (await request.get(`${MOCK}/_mock/uploads`)).json();
  expect(up).toHaveLength(1);
  expect(up[0].size).toBe(9);
  expect(up[0].head).toBe("4f676753");
  expect(up[0].source).toBe("test-b.mp4");

  // 整片直传（逃生通道）：本地路径流式 → mock 收到的是原始视频字节
  const d2 = await page.evaluate(async (p) => {
    return await (window as any).javDesktop.upload.file({ id: "t-file", engine: "mock", name: "video-b.mkv", ext: "mkv", localPath: p });
  }, fx("video-b.mkv"));
  expect(d2.ok, JSON.stringify(d2)).toBe(true);
  expect(d2.file).toBe("video-b.mkv");
  up = await (await request.get(`${MOCK}/_mock/uploads`)).json();
  expect(up).toHaveLength(2);
  expect(up[1].size).toBe(readFileSync(fx("video-b.mkv")).length);
  expect(up[1].source).toBe("video-b.mkv");
});

test("extract-audio IPC：mp4 → 真 opus（OggS 头）→ 流式上传后 tmp 清理；坏路径报错", async ({ page, request }) => {
  const ex = await page.evaluate(
    async (p) => await (window as any).javDesktop.extractAudio({ videoPath: p }),
    fx("video-a.mp4"),
  );
  expect(ex.ok, JSON.stringify(ex)).toBe(true);
  expect(ex.sizeBytes).toBeGreaterThan(1000);
  expect(readFileSync(ex.opusPath).subarray(0, 4).toString("hex")).toBe("4f676753");

  const up = await page.evaluate(
    async (e) => await (window as any).javDesktop.upload.audio({ id: "t-ex-up", engine: "mock", name: "video-a.mp4", opusPath: e.opusPath }),
    ex,
  );
  expect(up.ok).toBe(true);
  const ups = (await (await request.get(`${MOCK}/_mock/uploads`)).json()) as Array<{ size: number }>;
  expect(ups[0].size).toBe(ex.sizeBytes);
  expect(existsSync(ex.opusPath)).toBe(false); // upload 流式读完后 main 清理 tmp 目录

  const bad = await page.evaluate(
    async (p) => await (window as any).javDesktop.extractAudio({ videoPath: p }),
    "/nonexistent-dir-xyz/none.mp4",
  );
  expect(bad.ok).toBe(false);
  expect(typeof bad.error).toBe("string");
  expect(bad.error.length).toBeGreaterThan(0);
});

test("getResultData：未完成 → ok:false；未知 job → ok:false", async ({ page, request }) => {
  await mockPause(request);
  try {
    await (await request.post(`${MOCK}/_mock/seed`, { data: { n: 1, status: "running" }, headers: jh })).json();
    const jobs = await mockJobs(request);
    const r1 = await icall(page, "getResultData", "mock", jobs[0].id);
    expect(r1.ok).toBe(false);
    const r2 = await icall(page, "getResultData", "mock", "nojob-404");
    expect(r2.ok).toBe(false);
  } finally {
    await mockResume(request);
  }
});

test("retryJob IPC：201 新任务 / 409 无可重试 / 404 不存在（文案对齐工作台）", async ({ page, request }) => {
  await (await request.post(`${MOCK}/_mock/seed`, { data: { n: 1, status: "skipped", skipped: 1 }, headers: jh })).json();
  const jobs = await mockJobs(request);
  const skippedId = jobs[0].id;

  const r1 = await icall(page, "retryJob", "mock", skippedId);
  expect(r1.ok).toBe(true);
  const newId = (r1.data as { jobId: string }).jobId;
  expect(newId).toBeTruthy();

  const r2 = await icall(page, "retryJob", "mock", newId);
  expect(r2.ok).toBe(false);
  expect(r2.error).toBe("无可重新生成的文件（非跳过或已处理）");

  const r3 = await icall(page, "retryJob", "mock", "nojob-404");
  expect(r3.ok).toBe(false);
  expect(r3.error).toBe("任务不存在（已过期）");
});

test("config IPC：getConfig 23 项 + putConfig 成功/校验/坏 JSON", async ({ page }) => {
  const g = await icall(page, "getConfig", "mock");
  expect(g.ok).toBe(true);
  const items = g.data as Array<{ path: string; value: unknown; secret?: boolean }>;
  expect(items).toHaveLength(23);
  const byPath = Object.fromEntries(items.map((i) => [i.path, i]));
  expect(byPath["vad.threshold"].value).toBe(0.5);
  expect(byPath["storage.retention_days"].value).toBe(7);
  expect(byPath["polish.api_key"].secret).toBe(true);

  expect((await icall(page, "putConfig", "mock", JSON.stringify({ "vad.threshold": 0.7 }))).ok).toBe(true);
  const g2 = (await icall(page, "getConfig", "mock")).data as Array<{ path: string; value: unknown }>;
  expect(Object.fromEntries(g2.map((i) => [i.path, i]))["vad.threshold"].value).toBe(0.7);

  // 未知路径 / 类型错（mock 400 → main serveError 文案）
  const p2 = await icall(page, "putConfig", "mock", JSON.stringify({ "infer.cwd": "/x" }));
  expect(p2.ok).toBe(false);
  expect(p2.error).toContain("不支持的配置项");
  const p3 = await icall(page, "putConfig", "mock", JSON.stringify({ "infer.max_batch_size": 0 }));
  expect(p3.ok).toBe(false);
  expect(p3.error).toContain("需要正整数");
  // 坏 JSON
  const p4 = await icall(page, "putConfig", "mock", "not-json");
  expect(p4.ok).toBe(false);
  expect(p4.error).toBe("values 不能为空");
});

test("config 错误文案：服务端未设 Key → 403 文案；Key 不符 → 401 文案", async ({ page, request }) => {
  await mockConfigMode(request, "no-key");
  const r1 = await icall(page, "getConfig", "mock");
  expect(r1.ok).toBe(false);
  expect(r1.error).toBe("该服务尚未设置 API Key（需在服务端配置 JAVSCRIBE_API_KEY）");

  await mockConfigMode(request, "ok");
  expect((await icall(page, "putEngineKey", "mock", "wrong")).ok).toBe(true);
  const r2 = await icall(page, "getConfig", "mock");
  expect(r2.ok).toBe(false);
  expect(r2.error).toBe("API Key 不正确：请核对服务端的 JAVSCRIBE_API_KEY 与登记的 Key");
  // 恢复
  expect((await icall(page, "putEngineKey", "mock", MOCK_KEY)).ok).toBe(true);
});

test("scan + submitScan IPC：三项（1 有字幕）/ Windows 路径 / 不存在 / 空 files", async ({ page, request }) => {
  const ok = await icall(page, "scan", "mock", "/media/jav");
  expect(ok.ok).toBe(true);
  const d = ok.data as { mapped: boolean; items: Array<{ name: string; has_subtitle: boolean; subtitle: string }> };
  expect(d.mapped).toBe(false);
  expect(d.items).toHaveLength(3);
  const sub = d.items.find((i) => i.name === "AKDL-002.mp4")!;
  expect(sub.has_subtitle).toBe(true);
  expect(sub.subtitle).toBe("AKDL-002.zh.srt");

  const win = await icall(page, "scan", "mock", "D:\\Videos");
  expect(win.ok).toBe(false);
  expect(win.error).toContain("需要绝对路径");
  const nope = await icall(page, "scan", "mock", "/nope");
  expect(nope.ok).toBe(false);
  expect(nope.error).toContain("路径不存在");

  const sub2 = await icall(page, "submitScan", "mock", JSON.stringify(["/media/jav/AKDL-001.mp4", "/media/jav/SUB-001.mkv"]));
  expect(sub2.ok).toBe(true);
  const sd = sub2.data as { files: number; jobId: string };
  expect(sd.files).toBe(2);
  expect(sd.jobId).toBeTruthy();
  const jobs = await mockJobs(request);
  expect(jobs.find((j) => j.id === sd.jobId)?.label).toBe("文件夹扫描 · 2 项");

  const empty = await icall(page, "submitScan", "mock", "[]");
  expect(empty.ok).toBe(false);
  expect(empty.error).toBe("files 需要非空数组（绝对路径列表）");
});

test("listJobs IPC：展平 + running 优先 + created 降序", async ({ page, request }) => {
  // 冻结 ticker：默认 100ms×0.25 → 400ms 内 running seed 会被自动跑完，
  // 而 main 侧 3s 快照 TTL 轮询窗口里 running 必然消失（web 同款用例同法）
  await mockPause(request);
  try {
    await (await request.post(`${MOCK}/_mock/seed`, { data: { n: 2, status: "running" }, headers: jh })).json();
    await (await request.post(`${MOCK}/_mock/seed`, { data: { n: 2, status: "done" }, headers: jh })).json();
    // main 侧有 3s 快照 TTL 缓存：轮询等缓存刷新（UI 5s 轮询同理）
    let r = await icall(page, "listJobs");
    const t0 = Date.now();
    while ((r.data as unknown[]).length < 4) {
      if (Date.now() - t0 > 10_000) break;
      await new Promise((res) => setTimeout(res, 500));
      r = await icall(page, "listJobs");
    }
    expect(r.ok).toBe(true);
    const rows = r.data as Array<{ engine: string; job_id: string | null; file: string; status: string; progress: number }>;
    expect(rows).toHaveLength(4);
    expect(rows.map((x) => x.status)).toEqual(["running", "running", "done", "done"]);
    for (const x of rows) {
      expect(x.engine).toBe("mock");
      expect(x.job_id).toBeTruthy();
      expect(x.file).toMatch(/seed-\d{3}\.mp4/);
    }
  } finally {
    await mockResume(request);
  }
});

test("writeSrt IPC：srt 写盘（影片同目录）+ 非法名/缺路径拒绝", async ({ page }) => {
  const dir = test.info().outputDir;
  const w1 = await page.evaluate(async (a: string[]) => {
    return await (window as any).javDesktop.writeSrt(a[0], a[1], new TextEncoder().encode(a[2]));
  }, [join(dir, "video-a.mp4"), "video-a.zh.srt", "1\nテスト字幕\n"]);
  expect(w1.ok).toBe(true);
  expect(w1.path).toBe(join(dir, "video-a.zh.srt"));
  expect(readFileSync(join(dir, "video-a.zh.srt"), "utf-8")).toContain("テスト字幕");

  const bad1 = await page.evaluate(async (a: string[]) => {
    return await (window as any).javDesktop.writeSrt(a[0], a[1], new TextEncoder().encode("x"));
  }, [join(dir, "v.mp4"), "../evil.srt"]);
  expect(bad1.ok).toBe(false);
  expect(bad1.error).toBe("文件名非法");

  const bad2 = await page.evaluate(async (a: string[]) => {
    return await (window as any).javDesktop.writeSrt(a[0], a[1], new TextEncoder().encode("x"));
  }, ["", "x.zh.srt"]);
  expect(bad2.ok).toBe(false);
  expect(bad2.error).toBe("缺少路径");
});

test("engines.json 持久化：IPC 增引擎落盘（userData）", async ({ page, userData }) => {
  expect((await icall(page, "addEngine", "srv-c", MOCK, "kc")).ok).toBe(true);
  const raw = JSON.parse(readFileSync(join(userData, "engines.json"), "utf-8"));
  const byName = Object.fromEntries(raw.engines.map((e: { name: string }) => [e.name, e]));
  expect(byName.mock.api_key).toBe(MOCK_KEY); // 预置 Key 未被 env 合并冲掉
  expect(byName["srv-c"].api_key).toBe("kc");
});
