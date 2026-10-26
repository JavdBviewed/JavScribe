// client/core/log-center.ts 常驻单测（node 直接跑，esbuild 打包 TS 后断言，与 disk-split 套件同模式）
// 0.2.62：日志中心——环形缓冲 / 过滤（源/最低级别/关键词/时间起）/ 格式化。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/log-center.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "logc-"));
try {
  const out = resolve(tmp, "logc.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const { LogRing, filterLines, formatLine, formatLines, formatTs, LEVEL_RANK, DEFAULT_RING_CAP } = mod.default ?? mod;

  // ---------- 环形缓冲 ----------
  const ring = new LogRing(5);
  for (let i = 0; i < 8; i++) ring.push("info", "main", `m${i}`);
  assert.equal(ring.size, 5, "超 cap 丢最旧");
  const t3 = ring.tail(3).map((l) => l.msg);
  assert.deepEqual(t3, ["m5", "m6", "m7"], "tail(3) = 最近 3 条");
  assert.equal(ring.tail(0).length, 5, "tail(0) = 全部");
  ring.push("warn", "ui", "u1");
  ring.push("error", "serve", "s1");
  ring.clear();
  assert.equal(ring.size, 0, "clear 清空");
  const r2 = new LogRing(0);
  r2.push("info", "main", "x");
  assert.equal(r2.size, 1, "cap<=0 回落默认值");
  assert.ok(DEFAULT_RING_CAP >= 10000, "默认容量足够大");
  console.log("ok 1 - LogRing cap/tail/clear");

  // ---------- 过滤 ----------
  const lines = [
    { t: "2026-10-26T10:00:00.000Z", level: "debug", src: "main", msg: "boot seq=1" },
    { t: "2026-10-26T10:00:01.000Z", level: "info", src: "main", msg: "engine ok" },
    { t: "2026-10-26T10:00:02.000Z", level: "warn", src: "ui", msg: "retry UPLOAD failed" },
    { t: "2026-10-26T10:00:03.000Z", level: "error", src: "serve", msg: "Traceback ffmpeg" },
    { t: "2026-10-26T10:00:04.000Z", level: "info", src: "ui", msg: "user clicked" },
  ];
  assert.deepEqual(filterLines(lines, { level: "error" }).map((l) => l.level), ["error"], "最低级别 error");
  assert.equal(filterLines(lines, { level: "warn" }).length, 2, "warn → warn+error");
  assert.equal(filterLines(lines, { level: "info" }).length, 4, "info → 除 debug");
  assert.equal(filterLines(lines, { level: "debug" }).length, 5, "debug → 全部");
  assert.equal(filterLines(lines, { source: "ui" }).length, 2, "源过滤 ui");
  assert.equal(filterLines(lines, { source: "main", level: "error" }).length, 0, "源+级别组合");
  assert.deepEqual(
    filterLines(lines, { q: "upload" }).map((l) => l.src),
    ["ui"],
    "关键词大小写不敏感子串",
  );
  assert.equal(
    filterLines(lines, { since: "2026-10-26T10:00:02.000Z" }).length,
    3,
    "since 含边界",
  );
  assert.equal(filterLines([], { q: "x" }).length, 0, "空集");
  console.log("ok 2 - filterLines 级别/源/关键词/时间");

  // ---------- 格式化 ----------
  assert.equal(LEVEL_RANK.debug, 0);
  assert.equal(LEVEL_RANK.error, 3);
  const iso = new Date(2026, 9, 26, 1, 2, 3, 4).toISOString();
  assert.equal(formatTs(iso), "2026-10-26 01:02:03.004", "本地时间格式化");
  assert.equal(formatTs(""), "", "空串 → 空");
  const ln = formatLine({ t: iso, level: "warn", src: "main", msg: "hello 世界" });
  assert.equal(ln, `2026-10-26 01:02:03.004 [warn] [main] hello 世界`);
  const ln2 = formatLine({ t: "", level: "error", src: "serve", msg: "raw serve line" });
  assert.match(ln2, /^\s+\[error\] \[serve\] raw serve line$/, "无时间戳补空白对齐");
  assert.equal(formatLines([{ t: iso, level: "info", src: "main", msg: "a" }, { t: iso, level: "info", src: "main", msg: "b" }]).split("\n").length, 2);
  console.log("ok 3 - formatTs / formatLine / formatLines");

  await rm(tmp, { recursive: true, force: true });
  console.log("log-center.test 全部通过");
} catch (e) {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
  throw e;
}
