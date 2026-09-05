import { defineConfig } from "@playwright/test";

// e2e 一键：pnpm test:e2e
//  - mock serve：node（127.0.0.1:8301），忠实复刻 JavScribe serve 8300 协议
//  - web 应用：  真 FastAPI 工作台（127.0.0.1:8901），每次全新数据目录
// 桌面端 e2e（二期起）复用同一 mock serve，见 client/tests/e2e/desktop/
export default defineConfig({
  testDir: "client/tests/e2e",
  testMatch: /web\/.*\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:8901",
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  webServer: [
    {
      command: "node client/tests/e2e/mock-serve.mjs 8301",
      url: "http://127.0.0.1:8301/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command:
        "D=$(mktemp -d /tmp/javweb-e2e-data.XXXXXX) && cd web && " +
        "JAV_WEB_PORT=8901 JAV_WEB_TLS_PORT=0 JAV_DATA_DIR=$D " +
        "JAV_ENGINES='mock=http://127.0.0.1:8301' JAV_POLL_INTERVAL_S=1 " +
        "uv run jav-scribe-web",
      url: "http://127.0.0.1:8901/api/health",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
