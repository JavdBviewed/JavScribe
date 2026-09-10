// 音轨缓存 + 任务表「换服务重跑」e2e（09-10-client-audio-cache-rerun）
// 用户诉求：已有终态任务可复用本机音轨缓存，换一个服务端重新提交（免整片重传）；
// 本地提取的 opus 落 userData/audio-cache/（<sha1>.opus + .meta.json，7 天 / 20GB LRU）。
// 双在线引擎：mock 8302（playwright.desktop.config webServer）+ second 8305（本 spec 自起）。
import { test, expect, DIST, MOCK, MOCK_KEY, FIXTURES, goView, mockReset } from "./helpers";
import { _electron as electron } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "javscribe-rerun-"));
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
    },
  });
  const page = await app.firstWindow();
  await page.getByText(/服务 2\/2 在线/).first().waitFor({ timeout: 25_000 });
  return { app, page };
}

/** UI 单文件派发（默认 mock 引擎），到「提交生成 ✓」为止 */
async function dispatchFile(page: any, filePath: string) {
  await page.setInputFiles("#file", filePath);
  await page.selectOption("#engine-select", "mock");
  await page.click("#dispatch-go");
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#meta-dispatch", { hasText: /^任务 [\w-]+$/ })).toBeVisible({ timeout: 30_000 });
}

const cacheCount = (userData: string, suffix: string) =>
  (readdirSync(join(userData, "audio-cache")).filter((f) => f.endsWith(suffix)).length);

async function mockUploads(request: any, base: string): Promise<Array<{ source: string; size: number; head: string }>> {
  return (await (await request.get(`${base}/_mock/uploads`)).json());
}

/** 双 mock 复位（共享 8302 webServer：自起 app 的 test 必须清掉前序 test 的 job/upload 残留） */
async function resetMocks(request: any) {
  await mockReset(request);
  const r = await request.post(`${SECOND}/_mock/reset`, { data: "{}", headers: { "Content-Type": "application/json" } });
  if (!r.ok()) throw new Error(`second mock reset -> ${r.status()}`);
}

test("音轨缓存：本机提取落缓存；同影片二次派发命中缓存免重提（字节一致）", async ({ request }) => {
  const dir = freshUserData();
  const { app, page } = await launch(dir);
  try {
    await dispatchFile(page, join(FIXTURES, "video-a.mp4"));
    // 提取成功即落缓存：1 opus + 1 meta
    expect(cacheCount(dir, ".opus")).toBe(1);
    expect(cacheCount(dir, ".meta.json")).toBe(1);
    const up1 = await mockUploads(request, MOCK);
    expect(up1).toHaveLength(1);
    expect(up1[0].head).toBe(OGG_HEAD);

    // 同影片二次派发：本机缓存命中（免重提）+ 服务端缓存命中（免重传字节）
    await dispatchFile(page, join(FIXTURES, "video-a.mp4"));
    expect(cacheCount(dir, ".opus")).toBe(1); // 本机缓存复用，不产生第二个条目
    const up2 = await mockUploads(request, MOCK);
    expect(up2).toHaveLength(1); // 服务端命中 → 无第二次 PUT（字节天然一致）
    const jobs = (await (await request.get(`${MOCK}/jobs`)).json()) as Array<{ label: string }>;
    expect(jobs.filter((j) => j.label === "video-a.mp4")).toHaveLength(2); // 首传 + 命中建任务各一
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("换服务重跑：终态行 → 选第二服务 → 复用缓存音轨提交 → 任务表出现新服务任务", async ({ request }) => {
  const dir = freshUserData();
  const { app, page } = await launch(dir);
  try {
    await resetMocks(request);
    await dispatchFile(page, join(FIXTURES, "video-a.mp4"));
    await goView(page, "jobs");
    const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) }).first();
    await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
    const firstUp = await mockUploads(request, MOCK);
    expect(firstUp).toHaveLength(1);

    await row.locator(".rerun").click();
    await expect(page.locator("#modal-title")).toHaveText("换服务重跑 · video-a.mp4");
    await expect(page.locator("#modal-body .set-note", { hasText: "音轨缓存命中" })).toBeVisible();

    await page.locator('input[name="rerun-engine"][value="second"]').check();
    await page.click("#rerun-go");
    await expect(page.locator("#toasts .toast.ok", { hasText: "换服务重跑" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#modal-backdrop")).toBeHidden();

    // 第二服务收到的就是缓存 opus（与首次上传字节一致，源名保留）
    const up2 = await mockUploads(request, SECOND);
    expect(up2).toHaveLength(1);
    expect(up2[0].size).toBe(firstUp[0].size);
    expect(up2[0].head).toBe(OGG_HEAD);
    expect(up2[0].source).toBe("video-a.mp4");
    const jobs2 = (await (await request.get(`${SECOND}/jobs`)).json()) as any[];
    expect(jobs2).toHaveLength(1);

    // 任务表出现 second 的新任务行，跑到完成
    const secondRow = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) })
      .filter({ has: page.locator(".job-cell", { hasText: "second" }) });
    await expect(secondRow.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("换服务重跑：仅登记一个服务 → modal 提示无其他在线服务", async ({ page }) => {
  // 默认单引擎（mock）userData fixture
  await page.setInputFiles("#file", join(FIXTURES, "video-a.mp4"));
  await page.click("#dispatch-go");
  await expect(page.locator("#step-dispatch.done")).toBeVisible({ timeout: 30_000 });
  await goView(page, "jobs");
  const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: "video-a.mp4" }) }).first();
  await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });

  await row.locator(".rerun").click();
  await expect(page.locator("#modal-title")).toHaveText("换服务重跑 · video-a.mp4");
  await expect(page.locator("#modal-body .set-note.err", { hasText: "没有其他在线服务可选" })).toBeVisible();
});

test("换服务重跑：源视频已变更 → 缓存失效 → 重新提取音轨后提交", async ({ request }) => {
  const dir = freshUserData();
  // 复位必须在 launch 之前：app 首帧轮询会吞掉前序 test 留在双 mock 上的 job（mock 8302 ← test3、
  // second 8305 ← test2），任务表先渲染出残留「video-a.mp4」行，子串 + .first() 定位会误点残留行
  await resetMocks(request);
  const { app, page } = await launch(dir);
  try {
    const video = join(dir, "src-video-a.mp4");
    cpSync(join(FIXTURES, "video-a.mp4"), video);
    await dispatchFile(page, video);
    expect(cacheCount(dir, ".opus")).toBe(1);
    const firstUp = await mockUploads(request, MOCK);

    // 变更源视频 mtime → 缓存条目失效（源仍在 → 走重提分支）
    const t = new Date(Date.now() + 3600_000);
    utimesSync(video, t, t);

    await goView(page, "jobs");
    const row = page.locator(".job-row", { has: page.locator(".fn", { hasText: /^src-video-a\.mp4$/ }) }).first();
    await expect(row.locator(".pill.p-done")).toBeVisible({ timeout: 30_000 });

    await row.locator(".rerun").click();
    await expect(page.locator("#modal-body .set-note", { hasText: "无有效音轨缓存" })).toBeVisible();
    await page.locator('input[name="rerun-engine"][value="second"]').check();
    await page.click("#rerun-go");
    await expect(page.locator("#toasts .toast.ok", { hasText: "换服务重跑" })).toBeVisible({ timeout: 30_000 });

    const up2 = await mockUploads(request, SECOND);
    expect(up2).toHaveLength(1);
    expect(up2[0].head).toBe(OGG_HEAD);
    // 源字节未变（仅 mtime）→ 重提结果与首次提取一致
    expect(up2[0].size).toBe(firstUp[0].size);
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
