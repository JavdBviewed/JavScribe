// client/core/job-search.ts 单测（0.2.47 需求2：任务搜索 + 主名口径）
// 运行：pnpm test:unit:client
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = await mkdtemp(resolve(tmpdir(), "jobsearch-"));
try {
  const out = resolve(tmp, "jobsearch.cjs");
  await build({
    entryPoints: [resolve(here, "../../core/job-search.ts")],
    bundle: true, format: "cjs", outfile: out, logLevel: "silent",
  });
  const ex = (await import(`file://${out}`)).default ?? (await import(`file://${out}`));
  const { jobLabelMain, jobPrimaryName, matchJobSearch } = ex;

  // ---------- 主名口径 ----------
  // 本地任务：label 与 file 同值 → 主名=file
  assert.equal(jobPrimaryName({ file: "/media/jav/AAA-001.mp4", label: "/media/jav/AAA-001.mp4" }), "AAA-001.mp4");
  // 远端任务：file 是 opus hash、label 是原始视频名 → 主名=视频名（hash 不泄漏）
  assert.equal(jobPrimaryName({ file: "60d514bef136a97d6517d3d5d02cdb28cd72251b.opus", label: "DDD-004.mp4" }), "DDD-004.mp4");
  // 「文件夹扫描」批标占位 → 主名=file
  assert.equal(jobPrimaryName({ file: "EEE-005.mp4", label: "文件夹扫描 · 3 项" }), "EEE-005.mp4");
  // label 非视频扩展名 → 主名=file
  assert.equal(jobPrimaryName({ file: "FFF-006.mkv", label: "notes.txt" }), "FFF-006.mkv");
  // label 缺失 → 主名=file
  assert.equal(jobPrimaryName({ file: "GGG-007.mp4", label: null }), "GGG-007.mp4");
  assert.equal(jobLabelMain({ file: "a.opus", label: "DDD-004.mp4" }), true);
  assert.equal(jobLabelMain({ file: "a.opus", label: "文件夹扫描 · 3 项" }), false);
  console.log("ok 1 - jobPrimaryName 主名口径");

  // ---------- matchJobSearch：主名/file/job_id/task_id 小写子串 ----------
  const j = { file: "60d514.opus", label: "DDD-004.mp4", job_id: "20260905-seed-1", task_id: "t-42" };
  assert.equal(matchJobSearch(j, ""), true); // 空词=全量
  assert.equal(matchJobSearch(j, "ddd-004"), true);  // 主名小写子串
  assert.equal(matchJobSearch(j, "MP4"), true);      // 大小写不敏感
  assert.equal(matchJobSearch(j, "60d514"), true);   // file 子串
  assert.equal(matchJobSearch(j, "seed-1"), true);   // job_id 子串
  assert.equal(matchJobSearch(j, "t-42"), true);     // task_id 子串
  assert.equal(matchJobSearch(j, "no-such"), false);
  const batchRow = { file: "AAA-001.mp4", label: "文件夹扫描 · 3 项", job_id: "b-1", task_id: null };
  assert.equal(matchJobSearch(batchRow, "aaa"), true);
  assert.equal(matchJobSearch({ file: "", label: null, job_id: null, task_id: null }, "x"), false);
  console.log("ok 2 - matchJobSearch 四字段/大小写/空词");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log("job-search tests passed");
