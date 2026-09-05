// 把 Vite 构建产物 + vendor 资产镜像到 web/src/jav_scribe_web/static/
// （wheel 打包直接吃该目录；容器镜像流程不变）
import { cpSync, readdirSync, rmSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "client", "dist");
const vendor = join(root, "client", "vendor");
const out = join(root, "web", "src", "jav_scribe_web", "static");

if (!existsSync(join(dist, "index.html"))) {
  console.error("client/dist/index.html 不存在，先跑 pnpm build:web");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
// 全量镜像：先清空（static/ 只含前端资产，无其它数据）
for (const e of readdirSync(out)) rmSync(join(out, e), { recursive: true, force: true });
const copyDir = (src, dst) => {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name), d = join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : cpSync(s, d);
  }
};
copyDir(dist, out);
if (existsSync(vendor)) copyDir(vendor, out);
console.log(`sync:static 完成 -> ${relative(root, out)}`);
