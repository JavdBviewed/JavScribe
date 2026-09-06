import { defineConfig } from "@playwright/test";

// 桌面端 e2e：pnpm test:e2e:desktop（xvfb-run 下跑，每 test 全新 userData 冷启动 Electron）
//  - mock serve：node（127.0.0.1:8302），与 web 同一 mock，协议忠实复刻 serve 8300
//  - 桌面端直连 mock（不经 8400 工作台），所以 webServer 只起 mock
//  - 前置：pnpm build:desktop（client 有改动时必须先重建，helpers 会检查产物并给出提示）
export default defineConfig({
  testDir: "client/tests/e2e",
  testMatch: /desktop\/.*\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-desktop" }]],
  outputDir: "test-results-desktop",
  use: {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
  },
  webServer: [
    {
      command: "node client/tests/e2e/mock-serve.mjs 8302",
      url: "http://127.0.0.1:8302/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // electron-updater generic feed（更新链路 e2e；8304）
      command: "node client/tests/e2e/mock-update-feed.mjs 8304",
      url: "http://127.0.0.1:8304/latest-linux.yml",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
