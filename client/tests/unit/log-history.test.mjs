import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = await mkdtemp(resolve(tmpdir(), "log-history-"));
try {
  const out = resolve(dir, "history.cjs");
  await build({ entryPoints: [resolve(fileURLToPath(new URL("../../core/log-history.ts", import.meta.url)))],
    bundle: true, platform: "node", format: "cjs", outfile: out, logLevel: "silent" });
  const { parseDailyLine, queryHistory, managedLogName } = await import(`file://${out}`);
  assert.equal(managedLogName("jav-scribe-2026-11-06.log"), true);
  assert.equal(managedLogName("../jav-scribe-2026-11-06.log"), false);
  assert.equal(managedLogName("jav-scribe-2026-11-06.log.bak"), false);
  const a = parseDailyLine("2026-11-05 14:01:02.003 [warn] [ui] older", "2026-11-05");
  const b = parseDailyLine("2026-11-06 14:01:02.003 [error] [main] newer", "2026-11-06");
  const c = parseDailyLine("2026-11-06 14:01:03.003 [info] [main] newest", "2026-11-06");
  assert.ok(a && b && c);
  assert.equal(parseDailyLine("broken", "2026-11-05")?.date, "2026-11-05");
  const entries = [a, b, c];
  assert.deepEqual(queryHistory(entries, { from: "2026-11-05", to: "2026-11-05", page: 1, pageSize: 1 }).lines, [a.text]);
  assert.deepEqual(queryHistory(entries, { source: "main", level: "warn", q: "NEW", page: 1, pageSize: 1 }).lines, [b.text]);
  assert.deepEqual(queryHistory(entries, { page: 2, pageSize: 1 }).lines, [b.text]);
  const tieA = parseDailyLine("2026-11-06 14:01:03.003 [info] [ui] earlier", "2026-11-06");
  const tieB = parseDailyLine("2026-11-06 14:01:03.003 [info] [ui] later", "2026-11-06");
  assert.deepEqual(queryHistory([tieA, tieB], { page: 1, pageSize: 10 }).lines, [tieB.text, tieA.text]);
  assert.equal(queryHistory(entries, { page: 200, pageSize: 1 }).page, 3);
  assert.equal(queryHistory(entries, { from: "2026-11-07", page: 1, pageSize: 1 }).total, 0);
  console.log("log-history.test OK");
} finally { await rm(dir, { recursive: true, force: true }); }
