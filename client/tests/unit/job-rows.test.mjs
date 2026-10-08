// client/core/job-rows.ts 常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
// 10-09-javscribe-phantom-job-row 背景：desktop 形态 refreshOne 对 /jobs/{id} 明细
// 404（任务被挤出 serve 内存窗 / 重启）时 httpJson 不抛错，错误体 {ok:false,error}
// 被当 job 入库，jobRows 展平出 file=String(undefined)="undefined"、status=running、
// 0/0 的幻行。两道防御：
//   1. pickJobDetail：仅 200 且带 id 的明细响应才采纳，否则回退列表摘要
//   2. jobRows：无 id 且无 files 的残缺条目不产行
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/job-rows.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "jr-"));
try {
  const out = resolve(tmp, "jr.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const ex = mod.default ?? mod;
  const { pickJobDetail, jobRows } = ex;

  const summary = (id = "j1", state = "running") => ({ id, label: "j1", state, total: 2, done: 1 });
  const NOT_FOUND_BODY = { ok: false, error: "job not found: j1" };

  // ---------- pickJobDetail ----------
  {
    const detail = { id: "j1", state: "running", total: 2, done: 1 };
    const sum = summary();
    assert.equal(pickJobDetail(200, detail, sum), detail, "200 + 带 id → 采纳明细");

    assert.equal(pickJobDetail(404, NOT_FOUND_BODY, sum), sum, "404 错误体 → 回退摘要");
    assert.equal(pickJobDetail(500, detail, sum), sum, "500（即便带 id）→ 回退摘要");
    assert.equal(pickJobDetail(200, { ok: true }, sum), sum, "200 无 id 对象 → 回退摘要");
    assert.equal(pickJobDetail(200, "job not found", sum), sum, "200 字符串体 → 回退摘要");
    assert.equal(pickJobDetail(200, [detail], sum), sum, "200 数组体 → 回退摘要");
    assert.equal(pickJobDetail(200, null, sum), sum, "200 空体 → 回退摘要");
    assert.equal(pickJobDetail(200, { id: null }, sum), sum, "200 id=null → 回退摘要");
  }
  console.log("ok 1 - pickJobDetail 明细采纳条件");

  // ---------- jobRows：残缺条目不产行 ----------
  {
    const rows = jobRows([{ name: "127", batch_paused: [], _details: [NOT_FOUND_BODY] }]);
    assert.deepEqual(rows, [], "404 错误体不产行（幻行根因）");
    const rows2 = jobRows([{ name: "127", batch_paused: [], _details: [null, undefined, "x", 42, { ok: false }] }]);
    assert.deepEqual(rows2, [], "null/非对象/无 id 无 files 条目一律不产行");
  }
  console.log("ok 2 - jobRows 残缺条目跳过");

  // ---------- jobRows：摘要兜底行（无 files 分支） ----------
  {
    const rows = jobRows([{ name: "127", batch_paused: [], _details: [{ id: "j9", state: "running", total: 2, done: 1 }] }]);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.file, "j9", "无 label → file=String(id)");
    assert.equal(r.status, "running", "state=running → running");
    assert.equal(r.message, "1/2", "message=done/total");
    assert.equal(r.progress, 0.5, "progress=done/total");
    assert.equal(r.job_id, "j9");
    assert.equal(r.position, "", "无明细 → 位置空");
    assert.equal(r.duration_s, null, "无明细 → 耗时空");

    const done = jobRows([{ name: "127", batch_paused: [], _details: [{ id: "j2", state: "finished", total: 3, done: 3 }] }]);
    assert.equal(done[0].status, "done", "state=finished → done");
    assert.equal(done[0].progress, 1, "finished → 进度 1");

    const unlabeled = jobRows([{ name: "127", batch_paused: [], _details: [{ id: 7, state: "running" }] }]);
    assert.equal(unlabeled[0].file, "7", "无 label 数字 id → file='7'（不再出现 undefined 字面量）");
  }
  console.log("ok 3 - jobRows 摘要兜底行");

  // ---------- jobRows：files 分支多行 ----------
  {
    const job = {
      id: "jb", state: "running",
      files: [
        { name: "a.mp4", status: "running", phase: "extracting", progress: 0.5, position: "00:10:00", message: "提取中" },
        { name: "b.mp4", status: "done", phase: "finished", progress: 1, position: "", message: "完成", output_files: ["a.srt"] },
      ],
    };
    const rows = jobRows([{ name: "127", batch_paused: [], _details: [job] }]);
    assert.equal(rows.length, 2, "files 分支每文件一行");
    assert.equal(rows[0].file, "a.mp4");
    assert.equal(rows[0].status, "running");
    assert.equal(rows[0].position, "00:10:00");
    assert.equal(rows[1].file, "b.mp4");
    assert.equal(rows[1].status, "done");
    assert.deepEqual(rows[1].output_files, ["a.srt"]);
    assert.equal(rows[0].job_id, "jb", "行携带 job_id");
  }
  console.log("ok 4 - jobRows files 分支");

  // ---------- jobRows：排序（running 优先 + created 降序） ----------
  {
    const details = [
      { id: "old-done", state: "finished", created: 100 },
      { id: "old-run", state: "running", created: 100 },
      { id: "new-run", state: "running", created: 200 },
    ];
    const rows = jobRows([{ name: "127", batch_paused: [], _details: details }]);
    assert.deepEqual(rows.map((r) => r.job_id), ["new-run", "old-run", "old-done"],
      "running 优先；同 running created 降序");
  }
  console.log("ok 5 - jobRows 排序");

  // ---------- jobRows：batch_paused 命中 ----------
  {
    const details = [
      { id: "j1", state: "running", batch_id: "b1" },
      { id: "j2", state: "running" },
      { id: "j3", state: "running", batch_id: "b2" },
    ];
    const rows = jobRows([{ name: "127", batch_paused: ["b1"], _details: details }]);
    const byId = Object.fromEntries(rows.map((r) => [r.job_id, r]));
    assert.equal(byId.j1.batch_paused, true, "batch_id 在 batch_paused → true");
    assert.equal(byId.j3.batch_paused, false, "batch_id 不在 → false");
    assert.equal(byId.j2.batch_paused, false, "无 batch_id → false");
  }
  console.log("ok 6 - jobRows batch_paused 归属");

  console.log("job-rows.test: 6/6 组断言全过");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
