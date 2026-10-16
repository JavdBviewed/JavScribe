// 版本四处对齐校验：package.json / web/pyproject.toml / web __init__.__version__ / web/uv.lock
// 用法：node scripts/check-version.mjs [期望版本]
//   不带参数 = 仅校验四处互相一致（本地发版前随手跑）
//   带参数   = 额外校验等于该值（CI 里传 tag 版本，refs/tags/client-v0.2.39 → 0.2.39）
// 历史背景：bump 漏改 web __init__ 已发生 3 次（0.2.30/0.2.33/0.2.39），
// editable 安装直读源码，__init__ 滞后会让 /api/health 报旧版本、e2e 版本基线错位。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf-8");

const vPkg = JSON.parse(read("package.json")).version;
const vPyproject = (read("web/pyproject.toml").match(/^version = "([^"]+)"/m) || [])[1];
const vInit = (read("web/src/jav_scribe_web/__init__.py").match(/__version__ = "([^"]+)"/) || [])[1];
const lockText = read("web/uv.lock");
const m = lockText.match(/name = "jav-scribe-web"\nversion = "([^"]+)"/);
const vLock = m ? m[1] : null;

const sources = [
  ["package.json", vPkg],
  ["web/pyproject.toml", vPyproject],
  ["web/src/jav_scribe_web/__init__.py", vInit],
  ["web/uv.lock (jav-scribe-web)", vLock],
];

const bad = sources.filter(([, v]) => !v);
if (bad.length) {
  console.error(`[check-version] 解析失败: ${bad.map(([n]) => n).join(", ")}`);
  process.exit(1);
}

const [label, ...vals] = sources.map(([n, v]) => [n, v]);
const distinct = [...new Set(sources.map(([, v]) => v))];
if (distinct.length > 1) {
  console.error(`[check-version] 版本不一致:\n  ${sources.map(([n, v]) => `${n} = ${v}`).join("\n  ")}`);
  process.exit(1);
}

const expected = process.argv[2];
if (expected && expected !== vPkg) {
  console.error(`[check-version] tag 版本 ${expected} 与 package.json 版本 ${vPkg} 不一致`);
  process.exit(1);
}
console.log(`[check-version] OK: 四处对齐 v${vPkg}`);
