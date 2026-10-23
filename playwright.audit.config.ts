import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";

// 自检线（10-23-javscribe-selfaudit-ux）：JavScribe 应用本体全量真机走查
//   audit-tour.spec.ts  — mock 后端全功能走查（linux-unpacked 打包形态，冷启动逐 tab 截图 + 控制台采集）
//   audit-real.spec.ts  — 真实 serve 127/158（:8300）全管线（只读使用：不改配置/不重启/不清其队列）
//   audit-web.spec.ts   — chromium → 8901 本地工作台走查
//
// 与回归门禁隔离：
//   - testDir = client/tests/e2e/audit（desktop 门禁 testMatch 只吃 desktop/，互不侵入）
//   - 截图 = 非基线式（page.screenshot → /tmp/js-audit-shots/<kind>/），供人工目检，不进 CI 基线
//
// webServer = 两套回归 config 的并集（8302 两边共用：本配置只起一份，无版本参 = 默认 0.1.0，
// 与桌面端 8306 mock-github 0.1.0 同版本基线；8301/8303 供 8901 工作台，版本 = web 当前版本）
// reuseExistingServer=false：审计要求干净后端状态（端口被占则先自行清理）
const WEB_VERSION =
  (readFileSync("web/pyproject.toml", "utf-8").match(/^version = "([^"]+)"/m) || [])[1] || "0.1.0";

export default defineConfig({
  testDir: "client/tests/e2e/audit",
  testMatch: /.*\.spec\.ts/,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-audit" }]],
  outputDir: "test-results-audit",
  use: {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
  },
  webServer: [
    // 8901 工作台的后端 mock（版本 = web 当前版本，与 8303 mock-github 同版本 → 无更新角标基线）
    {
      command: `node client/tests/e2e/mock-serve.mjs 8301 ${WEB_VERSION}`,
      url: "http://127.0.0.1:8301/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    // 桌面客户端 mock（无版本参 → 默认 0.1.0，与 8306 同版本基线）
    {
      command: "node client/tests/e2e/mock-serve.mjs 8302",
      url: "http://127.0.0.1:8302/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `node client/tests/e2e/mock-github.mjs 8303 ${WEB_VERSION}`,
      url: "http://127.0.0.1:8303/repos/JavdBviewed/JavScribe/releases",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node client/tests/e2e/mock-update-feed.mjs 8304",
      url: "http://127.0.0.1:8304/latest-linux.yml",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node client/tests/e2e/mock-github.mjs 8306 0.1.0",
      url: "http://127.0.0.1:8306/repos/JavdBviewed/JavScribe/releases",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "rm -rf /tmp/javweb-audit-data.* 2>/dev/null; D=$(mktemp -d /tmp/javweb-audit-data.XXXXXX) && cd web && " +
        "JAV_WEB_PORT=8901 JAV_WEB_TLS_PORT=0 JAV_DATA_DIR=$D " +
        "JAV_ENGINES='mock=http://127.0.0.1:8301' JAV_POLL_INTERVAL_S=1 " +
        "JAV_UPDATE_CHECK=on JAV_UPDATE_GITHUB_BASE=http://127.0.0.1:8303 JAV_UPDATE_INTERVAL_S=3 " +
        "JAV_LOCAL_WB_JOB_MISSING_S=3 JAV_UPLOAD_TTL_S=15 JAV_BATCH_RETAIN_S=15 " +
        "uv run --frozen jav-scribe-web",
      url: "http://127.0.0.1:8901/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
