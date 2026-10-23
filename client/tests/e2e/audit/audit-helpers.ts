// 自检线（10-23-javscribe-selfaudit-ux）审计公共 helpers
// 与回归 helpers 的差异：截图 = 非基线式 page.screenshot（供人工目检，不进 CI 基线）；
// 日志/DOM dump/console 采集统一落 /tmp/js-audit-shots/，findings 引证据。
//
// 后端两态：
//  - mock：复用 desktop/helpers 的 launchPackedApp（JAVSCRIBE_ENGINES=mock=8302 预置）
//  - real：launchRealPacked（同 launchPackedApp env 但去掉 JAVSCRIBE_ENGINES，
//    引擎只来自 userData/engines.json —— 真实 127/158 只读使用）
import { expect, _electron as electron, type Page } from "@playwright/test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFixtures, FIXTURES, PACKED_BIN, type ElectronApp } from "../desktop/helpers";

export { expect };

export const SHOTS_ROOT = "/tmp/js-audit-shots";

/** 真实 serve（127/158 = 尾段命名，:8300；jobs 系免鉴权，仅 /config、/scan 系需 X-Api-Key） */
export const E127 = "http://192.168.0.127:8300";
export const E158 = "http://192.168.0.158:8300";

export interface EngSpec { name: string; url: string; api_key?: string }

// ---------------------------------------------------------------------------
// 截图 / 日志 / console 采集
// ---------------------------------------------------------------------------

export function shotsDir(kind: string): string {
  const d = join(SHOTS_ROOT, kind);
  mkdirSync(d, { recursive: true });
  return d;
}

export function log(kind: string, ...msgs: unknown[]): void {
  mkdirSync(SHOTS_ROOT, { recursive: true });
  const line = `[${new Date().toISOString()}] ${msgs.map((m) => String(m)).join(" ")}\n`;
  appendFileSync(join(SHOTS_ROOT, `audit-${kind}-log.txt`), line, "utf8");
  process.stdout.write(line);
}

/** 非基线式截图（审计证据，不进 CI 基线对比） */
export async function shot(page: Page, kind: string, name: string): Promise<string> {
  const p = name.endsWith(".png") ? name : `${name}.png`;
  const path = join(shotsDir(kind), p);
  await page.screenshot({ path, fullPage: false });
  log(kind, `[shot] ${path}`);
  return path;
}

export interface ConsoleSink { errors: string[]; finish(): Promise<string[]> }

/** console error + pageerror 采集（结束 finish() 落盘 console-<kind>-errors.txt） */
export function consoleCollector(kind: string, page: Page): ConsoleSink {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return {
    errors,
    async finish() {
      const f = join(SHOTS_ROOT, `console-${kind}-errors.txt`);
      writeFileSync(f, errors.length ? errors.join("\n") + "\n" : "(无 console error / pageerror)\n", "utf8");
      log(kind, `console/pageerror 采集：${errors.length} 条 → ${f}`);
      return errors;
    },
  };
}

/** confirm()/prompt() 统一受理（删服务/取消批次/清完成/换服务重跑确认…），留痕 */
export function attachDialogs(kind: string, page: Page): void {
  page.on("dialog", (d) => {
    log(kind, `[dialog] ${d.type()}: ${d.message().slice(0, 120)} → accept`);
    void d.accept();
  });
}

/** 指定选择器 innerHTML 前 max 字落日志（审计 DOM 证据） */
export async function dumpDom(page: Page, sel: string, kind: string, tag: string, max = 3000): Promise<void> {
  const html = await page.locator(sel).first().innerHTML().catch(() => "<(元素缺失或不可读)>");
  log(kind, `[dom:${tag}] ${sel}\n--- 8<---\n${html.slice(0, max)}\n---> 8---`);
}

// ---------------------------------------------------------------------------
// 真实 serve 鉴权（R1/R2 管线需要；R3 故意不用）
// ---------------------------------------------------------------------------

/** 审计专用 key（~/.config/javscribe-audit/keys.env，chmod 600，绝不进 git）：
 *  AUDIT_KEY_127 / AUDIT_KEY_158。serve 0.2.x 的 /config、/scan 系要 X-Api-Key，
 *  客户端 #scan-go 入口闸（has_key）会拦截未登记 key 的引擎 → 无 key 跑不了管线。
 *  缺失时调用方 test.skip（R3 无 key 是设计内：测「尚未登记 API Key」错误态）。 */
export function auditKeys(): { key127: string; key158: string } {
  const p = join(homedir(), ".config", "javscribe-audit", "keys.env");
  try {
    const kv: Record<string, string> = {};
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const m = line.match(/^AUDIT_KEY_(127|158)=(\S+)$/);
      if (m) kv[m[1]] = m[2];
    }
    return { key127: kv["127"] || "", key158: kv["158"] || "" };
  } catch {
    return { key127: "", key158: "" };
  }
}

// ---------------------------------------------------------------------------
// fixtures / 启动
// ---------------------------------------------------------------------------

/** 扫描目录夹具：video-a.mp4 复制成指定文件名（KB 级，配 scan_min_size_mb=0 进勾选域） */
export function mkScanFiles(tag: string, names: string[]): string {
  ensureFixtures();
  const dir = mkdtempSync(join(tmpdir(), `js-audit-scan-${tag}-`));
  for (const n of names) copyFileSync(join(FIXTURES, "video-a.mp4"), join(dir, n));
  return dir;
}

/** 勾选表格行（按文件名定位行内 checkbox） */
export async function checkRow(page: Page, tableSel: string, name: string): Promise<void> {
  await page.locator(`${tableSel} tbody tr`, { hasText: name }).locator("input[type=checkbox]").first().check();
}

/** 全新 userData（engines.json 预置 + 可选 client-config.json） */
export function freshUserData(tag: string, engines: EngSpec[], extraClientCfg: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), `js-audit-ud-${tag}-`));
  writeFileSync(
    join(dir, "engines.json"),
    JSON.stringify({ engines: engines.map((e) => ({ name: e.name, url: e.url, api_key: e.api_key ?? "" })) }, null, 1),
    "utf8",
  );
  if (Object.keys(extraClientCfg).length) {
    writeFileSync(join(dir, "client-config.json"), JSON.stringify(extraClientCfg, null, 1), "utf8");
  }
  return dir;
}

/**
 * 真实引擎形态启动（linux-unpacked）：env 复刻 desktop/helpers.launchPackedApp，
 * 但去掉 JAVSCRIBE_ENGINES —— 引擎表只来自 userData/engines.json。
 * 更新链路仍指向本地 mock（8304/8306），零外网。
 */
export async function launchRealPacked(userData: string, extraEnv: Record<string, string> = {}): Promise<ElectronApp> {
  return electron.launch({
    executablePath: PACKED_BIN,
    args: ["--no-sandbox"],
    env: {
      ...process.env,
      JAVSCRIBE_CLIENT_USERDATA: userData,
      JAVSCRIBE_CLIENT_FRAMELESS: "1",
      JAVSCRIBE_UPDATE_FEED: "http://127.0.0.1:8304/",
      JAVSCRIBE_NO_UPDATE_RELUNCH: "1",
      JAVSCRIBE_UPDATE_GITHUB_BASE: "http://127.0.0.1:8306",
      JAVSCRIBE_UPDATE_INTERVAL_S: "3",
      JAVSCRIBE_OPEN_EXTERNAL_CAPTURE: "1",
      APPIMAGE: PACKED_BIN,
      BROWSER: "/bin/true",
      ...extraEnv,
    },
  });
}

/** 等「服务 N/N 在线」（N = 当前登记表引擎数；解析 #health 文案） */
export async function waitForEnginesOnline(page: Page, n: number, timeoutMs = 45_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const m = (await page.locator("#health").textContent().catch(() => "")) || "";
    const mm = m.match(/服务 (\d+)\/(\d+) 在线/);
    if (mm && Number(mm[1]) >= n) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等 服务 ${n}/N 在线 超时（当前文案：${m.trim() || "空"}）`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
