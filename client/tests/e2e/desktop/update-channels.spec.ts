// 桌面端功能类：更新渠道择优（内置国内加速渠道 + 自定义加速地址，谁快用谁；全不可用走官方直连+更新代理）
//  - 前置同 update.spec.ts（打包产物）；本文件清空 JAVSCRIBE_UPDATE_FEED 恒置钩子，
//    真实走「tag 解析 → 渠道探测 → 最优 feed」链路
//  - 渠道三态：8304=快（无延迟）、8303=慢（TTFB 2s，探测超时 3s 内可用但更慢）、8313/8314/8315=死（无监听）
//  - JAVSCRIBE_UPDATE_TAG_API_BASE → 8304 mock（GitHub Releases JSON，client-v9.9.9）；
//    指向死端口时验证渠道 atom 兜底 tag 解析
import { test, expect, type APIRequestContext } from "./helpers";
import { PACKED_BIN, relaunchPacked } from "./helpers";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FAST = "http://127.0.0.1:8304";
const SLOW = "http://127.0.0.1:8303";
const DEAD = "http://127.0.0.1:8313";
const DEAD2 = "http://127.0.0.1:8314";
const DEAD3 = "http://127.0.0.1:8315";
const CHANNEL_PREFIX = "/https://github.com/JavdBviewed/JavScribe/releases/download/";
const CHIP = "#up-chip";

test.skip(
  !existsSync(PACKED_BIN),
  "打包产物缺失——先 pnpm build:desktop && pnpm exec electron-builder --linux --x64 --dir --publish never",
);

/** 读 mock 已记录的「渠道前缀形」请求（清单 + 安装包都以该前缀开头） */
async function channelRequests(req: APIRequestContext, port: number): Promise<string[]> {
  const r = await req.post(`http://127.0.0.1:${port}/_mock/state`, {
    data: "{}",
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok()) throw new Error(`mock-update-feed(${port}) state -> ${r.status()}`);
  return ((await r.json()) as { requests: string[] }).requests.filter((u) =>
    u.startsWith(CHANNEL_PREFIX),
  );
}


const BASE_ENV: Record<string, string> = {
  JAVSCRIBE_UPDATE_FEED: "", // 清空 launchPackedApp 恒置钩子 → 真走 tag 解析 + 渠道择优
  JAVSCRIBE_UPDATE_TAG_API_BASE: FAST, // 直连 tag API → 本地 mock（client-v9.9.9，零外网）
  JAVSCRIBE_UPDATE_PROBE_TIMEOUT_MS: "3000",
};

test("谁快用谁：快/慢/死三态 → feed 与下载都走最快渠道，最优渠道落盘", async ({ userData, request }) => {
  const f0 = (await channelRequests(request, 8304)).length;
  const s0 = (await channelRequests(request, 8303)).length;
  const { app, page } = await relaunchPacked(userData, {
    ...BASE_ENV,
    JAVSCRIBE_UPDATE_CHANNELS: `${FAST},${SLOW},${DEAD}`,
  });
  try {
    const chip = page.locator(CHIP);
    await expect(chip).toHaveText("新版本 9.9.9", { timeout: 30_000 });

    // 探测：快/慢各 1 次清单、死渠道无请求；feed 拉取仅最快渠道 → 快=2（探测+拉取）、慢=1（仅探测）
    const fast = (await channelRequests(request, 8304)).length - f0;
    const slow = (await channelRequests(request, 8303)).length - s0;
    expect(fast).toBe(2);
    expect(slow).toBe(1);

    // 最优渠道落盘 settings.json（内部字段，TTL 内跨重启复用）
    const cfg = JSON.parse(readFileSync(join(userData, "settings.json"), "utf-8")) as {
      channel_best?: string;
      channel_best_at?: number;
    };
    expect(cfg.channel_best).toBe(FAST);
    expect(typeof cfg.channel_best_at).toBe("number");

    // 下载安装同样走最快渠道（渠道前缀形安装包请求）
    await chip.click();
    await expect(page.locator("#modal-title")).toHaveText("检查更新");
    await page.click("#up-dl");
    await expect(chip).toHaveText("重启安装 v9.9.9", { timeout: 30_000 });
    expect((await channelRequests(request, 8304)).length - (f0 + fast)).toBeGreaterThanOrEqual(1);
  } finally {
    await app.close().catch(() => {});
  }
});

test("最优渠道缓存：TTL 内二次启动不重探，直接复用落盘渠道", async ({ userData, request }) => {
  const f0 = (await channelRequests(request, 8304)).length;
  const s0 = (await channelRequests(request, 8303)).length;
  const env = { ...BASE_ENV, JAVSCRIBE_UPDATE_CHANNELS: `${FAST},${SLOW},${DEAD}` };
  const first = await relaunchPacked(userData, env);
  try {
    await expect(first.page.locator(CHIP)).toHaveText("新版本 9.9.9", { timeout: 30_000 });
  } finally {
    await first.app.close().catch(() => {});
  }
  // 同 userData 二次启动：TTL（默认 6h）内缓存命中 → 不探测，仅 feed 拉取
  const second = await relaunchPacked(userData, env);
  try {
    await expect(second.page.locator(CHIP)).toHaveText("新版本 9.9.9", { timeout: 30_000 });
  } finally {
    await second.app.close().catch(() => {});
  }
  const fast = (await channelRequests(request, 8304)).length - f0;
  const slow = (await channelRequests(request, 8303)).length - s0;
  expect(fast).toBe(3); // 一启：探测+拉取；二启：仅拉取
  expect(slow).toBe(1); // 仅一启探测
});

test("全部渠道不可用 → 回退官方直连 tag 目录（不落 best，无渠道前缀请求）", async ({ userData, request }) => {
  const f0 = (await channelRequests(request, 8304)).length;
  const { app, page } = await relaunchPacked(userData, {
    ...BASE_ENV,
    JAVSCRIBE_UPDATE_CHANNELS: `${DEAD},${DEAD2}`,
  });
  try {
    // tag 解析成功（9.9.9 来自直连 API mock）→ feed = 官方直连 client-v9.9.9/（真实 GitHub 无此 tag → 404）
    // → error 态：角标隐藏（default 分支静默降级，菜单仍可手动检查）
    await expect(page.locator(CHIP)).toBeHidden({ timeout: 60_000 });
  } finally {
    await app.close().catch(() => {});
  }
  const cfg = JSON.parse(readFileSync(join(userData, "settings.json"), "utf-8")) as {
    channel_best?: string;
  };
  expect(cfg.channel_best ?? "").toBe("");
  expect((await channelRequests(request, 8304)).length).toBe(f0); // 渠道零请求
});

test("自定义加速地址参与择优：比内置渠道快 → 胜出并落盘", async ({ userData, request }) => {
  // 内置渠道（env）= 慢 + 死；自定义地址（settings.mirror）= 快 → 预期快胜出
  writeFileSync(
    join(userData, "settings.json"),
    JSON.stringify({ update_check: { enabled: true, mirror: FAST, proxy: "" }, ignored_versions: [] }),
  );
  const f0 = (await channelRequests(request, 8304)).length;
  const s0 = (await channelRequests(request, 8303)).length;
  const { app, page } = await relaunchPacked(userData, {
    ...BASE_ENV,
    JAVSCRIBE_UPDATE_CHANNELS: `${SLOW},${DEAD}`,
  });
  try {
    await expect(page.locator(CHIP)).toHaveText("新版本 9.9.9", { timeout: 30_000 });
  } finally {
    await app.close().catch(() => {});
  }
  const cfg = JSON.parse(readFileSync(join(userData, "settings.json"), "utf-8")) as {
    channel_best?: string;
  };
  expect(cfg.channel_best).toBe(FAST);
  expect((await channelRequests(request, 8304)).length - f0).toBe(2);
  expect((await channelRequests(request, 8303)).length - s0).toBe(1);
});

test("直连 tag API 不可达 → 经渠道 atom 兜底解析 tag，feed 仍走渠道", async ({ userData, request }) => {
  const { app, page } = await relaunchPacked(userData, {
    ...BASE_ENV,
    JAVSCRIBE_UPDATE_TAG_API_BASE: DEAD3, // 直连 API 死 → 必须走渠道 atom
    JAVSCRIBE_UPDATE_CHANNELS: `${FAST},${DEAD}`,
  });
  try {
    await expect(page.locator(CHIP)).toHaveText("新版本 9.9.9", { timeout: 30_000 });
  } finally {
    await app.close().catch(() => {});
  }
  const r = await request.post(`${FAST}/_mock/state`, {
    data: "{}",
    headers: { "Content-Type": "application/json" },
  });
  const reqs = ((await r.json()) as { requests: string[] }).requests;
  expect(reqs.some((u) => u.endsWith("/releases/atom"))).toBe(true);
});
