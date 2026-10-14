// client/core/concurrency.ts pickAutoEngine / freeVramGb 常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
// 10-13-javscribe-client-writeback-guard 背景（F3④，run10 A4 实锤）：auto 均衡只看「在途最少」，
// 把任务发到显存不足的服务（158 空闲 9.3G 仍收 2 并发 → 后起进程 CUDA OOM）。
// 显存感知：候选按最近 metrics 采样空闲显存过滤；全不足回退在途最少；无数据不过滤。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/concurrency.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "ae-"));
try {
  const out = resolve(tmp, "ae.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const ex = mod.default ?? mod;
  const { pickAutoEngine, freeVramGb } = ex;
  const constsOut = resolve(tmp, "consts.cjs");
  await build({ entryPoints: [resolve(here, "../../core/constants.ts")], bundle: true, format: "cjs", outfile: constsOut, logLevel: "silent" });
  const cmod = await import(`file://${constsOut}`);
  const { MIN_FREE_VRAM_GB } = cmod.default ?? cmod;

  // ---------- freeVramGb ----------
  assert.equal(freeVramGb(null), null, "无 GPU → null（不过滤）");
  assert.equal(freeVramGb({ present: true }), null, "采样缺字段 → null（不过滤）");
  assert.equal(freeVramGb({ present: true, mem_used_mb: null, mem_total_mb: 24564 }), null, "used 缺失 → null");
  assert.ok(Math.abs(freeVramGb({ present: true, mem_used_mb: 14900, mem_total_mb: 24564 }) - 9.4375) < 1e-3,
    "free = (total - used) / 1024");
  assert.equal(MIN_FREE_VRAM_GB, 10, "阈值常量默认 10");
  console.log("ok 1 - freeVramGb");

  const A = { name: "158", online: true };
  const B = { name: "127", online: true };

  // 4a. A 显存不足但更闲、B 显存充足 → 选 B（PRD 用例 4-①）
  {
    const r = pickAutoEngine([A, B], {
      inFlight: (n) => (n === "158" ? 0 : 2),          // A 更闲
      freeVramOf: (n) => (n === "158" ? 9.3 : 22.2),   // A < 10 不足、B 充足
    });
    assert.equal(r, "127", "显存不足但更闲的 A 不作候选，选 B");
  }
  console.log("ok 2 - A 显存不足且更闲、B 显存充足 → 选 B");

  // 4b. A/B 显存均不足 → 回退在途最少（不卡派发）（PRD 用例 4-②）
  {
    const r = pickAutoEngine([A, B], {
      inFlight: (n) => (n === "158" ? 0 : 2),
      freeVramOf: (n) => (n === "158" ? 9.3 : 8.1),    // 双不足
    });
    assert.equal(r, "158", "全部不足 → 回退在途最少");
  }
  console.log("ok 3 - A/B 均显存不足 → 回退在途最少");

  // 4c. 无 metrics 数据 → 视为满足、不过滤（旧逻辑回归）（PRD 用例 4-③）
  {
    const r = pickAutoEngine([A, B], { inFlight: (n) => (n === "158" ? 0 : 2) });
    assert.equal(r, "158", "不传 freeVramOf → 不过滤，按在途最少");
    const r2 = pickAutoEngine([A, B], { inFlight: () => 1, freeVramOf: () => null });
    assert.equal(r2, "A".length ? "158" : "158", "全 null → 平手按注册序取首个");
    assert.equal(pickAutoEngine([A, B], { inFlight: () => 1, freeVramOf: () => null }), "158");
  }
  console.log("ok 4 - 无 metrics 数据不过滤（旧逻辑回归）");

  // 附加：online / enabled 过滤 + 阈值边界 + 空候选
  {
    assert.equal(
      pickAutoEngine([{ name: "X", online: false }, { name: "Y", online: true, enabled: false }], { inFlight: () => 0 }),
      null,
      "全离线/退出均衡 → null",
    );
    assert.equal(
      pickAutoEngine([A, B], { inFlight: () => 0, freeVramOf: (n) => (n === "158" ? 10 : 22.2) }),
      "158",
      "free 恰好 = 阈值 10 → 满足（< 才过滤）",
    );
    assert.equal(
      pickAutoEngine([A, B], { inFlight: () => 0, freeVramOf: (n) => (n === "158" ? 9.999 : 22.2) }),
      "127",
      "free 略低于阈值 → 过滤",
    );
    assert.equal(
      pickAutoEngine([A, B], { inFlight: (n) => (n === "158" ? 3 : 1), minFreeVramGb: 100, freeVramOf: () => 22.2 }),
      "127",
      "minFreeVramGb 覆盖：全不足回退在途最少",
    );
  }
  console.log("ok 5 - online/enabled 过滤、阈值边界、空候选");

  console.log("auto-engine: all ok");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
