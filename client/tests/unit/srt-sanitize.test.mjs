// client/core/srt-sanitize.ts 常驻单测（node 直接跑，无框架依赖）
// 运行：pnpm test:unit:client
// 背景：2026-09-09 发现 tsToMs 拆分冒号错位（[hm, sPart] = body.split(":")），
// 所有 SRT 时间戳被解析成 NaN 并写回用户磁盘（v0.2.0~0.2.2 桌面端）。
// 本测试用 esbuild 打包 TS 后对字节级行为做断言，防回归。
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build, context } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const tsSrc = resolve(here, "../../core/srt-sanitize.ts");

const tmp = await mkdtemp(resolve(tmpdir(), "san-"));
try {
  const out = resolve(tmp, "san.cjs");
  await build({ entryPoints: [tsSrc], bundle: true, format: "cjs", outfile: out, logLevel: "silent" });
  const mod = await import(`file://${out}`);
  const sanitizeSrtBytes = mod.sanitizeSrtBytes ?? mod.default.sanitizeSrtBytes;

  const enc = (s) => new TextEncoder().encode(s);
  const dec = (b) => new TextDecoder().decode(b);
  const cues = (s) =>
    s.trim().split("\n\n").map((b) => {
      const ts = b.split("\n").find((l) => l.includes("-->"));
      const ms = (hms) => {
        const [h, m, sp] = hms.split(":");
        const [sec, x] = sp.split(",");
        return (Number(h) * 3600 + Number(m) * 60 + Number(sec)) * 1000 + Number(x);
      };
      const [a, c] = ts.split(" --> ");
      return [ms(a), ms(c)];
    });
  const eq = (a, b, msg) => assert.equal(Buffer.from(a).compare(Buffer.from(b)), 0, msg);

  // 1. 合法输入必须字节原样（tsToMs 回归点：曾经全量 NaN）
  const V = "1\n00:00:01,000 --> 00:00:02,000\n甲\n\n2\n01:00:30,500 --> 01:00:40,250\n乙\n\n";
  eq(sanitizeSrtBytes(enc(V)), enc(V), "valid input must pass through byte-identical");

  // 2. 取证模式（PJAM-045 首部）：负值 clamp + 长 cue 删除 + 重叠截断
  const EVIDENCE =
    "1\n-1:45:55,320 --> 00:00:23,880\n毕竟科长你啊 只要喝醉了就肯定会搭讪的吧？\n\n" +
    "2\n-1:51:58,760 --> 00:01:58,300\n嘛 也是呢 确实是店长的本领\n\n" +
    "3\n00:00:09,300 --> 00:00:15,660\n之前啊 我去大阪喝了一点 虽然不是很想喝\n\n";
  const first = sanitizeSrtBytes(enc(EVIDENCE));
  const outText = dec(first);
  assert.deepEqual(cues(outText), [[0, 9300], [9300, 15660]], "evidence cues");
  assert.ok(!outText.includes("店长的本领"), "fallback 长 cue 必须被删");
  assert.ok(outText.startsWith("1\n00:00:00,000 --> 00:00:09,300"), "renumber + clamp");
  assert.ok(!outText.includes("NaN"), "no NaN leak");

  // 3. 幂等（二次字节一致）
  eq(sanitizeSrtBytes(first), first, "second pass byte-identical");

  // 4. 长 cue 被细 cue 覆盖 → 删；孤立长 cue → 保留
  const LC = "1\n00:00:10,000 --> 00:01:00,000\n长句\n\n2\n00:00:12,000 --> 00:00:15,000\n细A\n\n3\n00:00:16,000 --> 00:00:18,000\n细B\n\n";
  const oLc = dec(sanitizeSrtBytes(enc(LC)));
  assert.equal(cues(oLc).length, 2, "long covered dropped");
  assert.ok(!oLc.includes("长句"), "long text gone");
  const LI = "1\n00:00:10,000 --> 00:00:50,000\n长独白\n\n2\n00:02:00,000 --> 00:02:25,000\n下一句\n\n";
  eq(sanitizeSrtBytes(enc(LI)), enc(LI), "isolated long cue kept");

  // 5. 微重叠截断
  const OV = "1\n00:00:10,000 --> 00:00:11,000\n甲\n\n2\n00:00:10,800 --> 00:00:12,000\n乙\n\n";
  assert.deepEqual(cues(dec(sanitizeSrtBytes(enc(OV)))), [[10000, 10800], [10800, 12000]], "overlap truncated");

  // 6. 非法内容原样放行
  for (const bad of ["", "garbage", "1\n乱 --> 乱\nx\n\n"]) {
    eq(sanitizeSrtBytes(enc(bad)), enc(bad), `passthrough: ${JSON.stringify(bad)}`);
  }

  console.log("  srt-sanitize unit tests PASSED");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
