// 主任务（batch）记录过期剪枝 e2e（playwright.config webServer env：JAV_BATCH_RETAIN_S=15，poll tick 1s）：
// a) 孤儿记录生命周期：子 job 被 reset 清出快照 → 看板出现 0 子任务兜底行（对账语义保留）
//    → 超过保留期后下一个 tick 剪枝 → batches.json 记录消失、看板行消失（style-07 同链路）
// b) 孤儿行「清除」入口：显式点击删本地记录，不必等保留期；记录 404 后再清报「不存在」
// 时序控制：reset 后 page.reload() 强制页面首拉（5s 轮询周期太慢，不可依赖自然轮询拍到兜底行）；
// 兜底行出现时记录年龄 ~4s < 保留期 15s，自动剪枝最早在 created+15s，断言窗留足余量。
import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  waitForEngineOnline, waitForEngineKey, mockReset, cleanEngines,
  FIXTURES, waitForJobsEmpty, waitForJobRow, goTab,
} from "../helpers";

let req: APIRequestContext;

test.beforeEach(async ({ page, request }) => {
  req = request;
  await mockReset(request);
  await cleanEngines(request);
  await waitForJobsEmpty(request);
  await page.goto("/");
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
});

/** upload-audio 带 batch 参数派发（web 侧登记 batches.json）；等派发完成返回 job_id */
async function uploadWithBatch(bid: string, label: string, name: string): Promise<string> {
  const audio = readFileSync(path.join(FIXTURES, "sine.opus"));
  const r = await req.post("/api/upload-audio", {
    multipart: {
      audio: { name: "sine.opus", mimeType: "audio/ogg", buffer: audio },
      engine: "mock",
      name,
      size_mb: "0",
      batch_id: bid,
      batch_label: label,
    },
  });
  expect(r.status()).toBe(202);
  const d = (await r.json()) as { upload_id: string };
  const t0 = Date.now();
  for (;;) {
    const u = (await (await req.get(`/api/uploads/${d.upload_id}`)).json()) as any;
    if (u.phase === "done" && u.job_id) return String(u.job_id);
    if (u.phase === "error") throw new Error(`upload 失败: ${u.error}`);
    if (Date.now() - t0 > 30_000) throw new Error("upload 派发超时");
    await new Promise((rs) => setTimeout(rs, 200));
  }
}

const batchRecord = async (bid: string) => {
  const list = (await (await req.get("/api/batches")).json()) as any[];
  return list.find((r) => r.batch_id === bid) || null;
};

test("a) 孤儿记录超保留期被剪：job 消失 → 兜底行出现 → 记录剪枝 → 行消失", async ({ page }) => {
  const bid = `prune-a-${Date.now().toString(36)}`;
  const jobId = await uploadWithBatch(bid, "prune-a", "prune-a.mp4");
  // 登记确认：batches.json 有记录，子 job 已进 live 快照（带 batch 归属）
  expect(await batchRecord(bid)).toBeTruthy();
  await waitForJobRow(req, (x) => x.job_id === jobId && x.batch_id === bid, 15_000);
  // reset 清出全部子 job → 孤儿记录（兜底行渲染前提成立）
  await mockReset(req);
  await waitForJobsEmpty(req);
  // reload 强制首拉：兜底行确定出现（记录年龄 ~4s < 保留期 15s，自动剪枝未触发）
  await page.reload();
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
  await goTab(page, "jobs");
  const staleRow = page.locator(".job-batch-row", { hasText: "prune-a" });
  await expect(staleRow).toBeVisible({ timeout: 15_000 });
  await expect(staleRow.locator(".batch-sub-n")).toHaveText("0 子任务");
  await expect(staleRow.locator(".sub", { hasText: "子任务已过期（记录保留）" })).toBeVisible();
  // 保留期（created+15s）+ tick → 剪枝：API 记录消失 + 看板行消失（UI 5s 轮询跟进）
  await expect.poll(() => batchRecord(bid), { timeout: 30_000, message: "batches.json 记录应被剪枝" })
    .toBeNull();
  await expect(staleRow).toHaveCount(0, { timeout: 30_000 });
});

test("b) 孤儿行「清除」入口：点击即删本地记录，404 语义正确", async ({ page }) => {
  const bid = `prune-b-${Date.now().toString(36)}`;
  await uploadWithBatch(bid, "prune-b", "prune-b.mp4");
  expect(await batchRecord(bid)).toBeTruthy();
  await mockReset(req);
  await waitForJobsEmpty(req);
  await page.reload();
  await waitForEngineOnline(page);
  await waitForEngineKey(page, "mock");
  await goTab(page, "jobs");
  const staleRow = page.locator(".job-batch-row", { hasText: "prune-b" });
  const clearBtn = staleRow.locator(".batch-op.batch-clear");
  await expect(clearBtn).toBeVisible({ timeout: 15_000 });
  // 点击 → 本地记录立即删除（不等保留期）+ 提示 + 行消失（refresh 即时重拉）
  await clearBtn.click();
  await expect(page.locator("#toasts .toast.ok", { hasText: "已清除过期主任务记录" })).toBeVisible({ timeout: 10_000 });
  expect(await batchRecord(bid)).toBeNull();
  await expect(staleRow).toHaveCount(0, { timeout: 10_000 });
  // 再清：记录已不存在 → 404
  const again = await req.post(`/api/batches/${encodeURIComponent(bid)}/clear`);
  expect(again.status()).toBe(404);
});
